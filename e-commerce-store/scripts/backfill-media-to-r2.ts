/**
 * BACKFILL: base64 media in Redis -> object storage (R2 / S3).   Phase B item 4.
 *
 * New uploads already go straight to R2 via /api/admin/media/presign. This
 * migrates the media that predates that path: product galleries and the brand
 * logo currently held as base64 `data:` URLs inside Redis.
 *
 * Why it matters (ARCHITECTURE.md SEV-1): base64 inflates payloads ~33%,
 * `loadProducts()` pulls every image's bytes on every call, and Upstash bills
 * per command AND per byte of egress.
 *
 *   npx tsx scripts/backfill-media-to-r2.ts            # DRY RUN (default)
 *   npx tsx scripts/backfill-media-to-r2.ts --commit   # upload + rewrite Postgres
 *   npx tsx scripts/backfill-media-to-r2.ts --limit 5  # cap items processed
 *
 * Safety properties:
 *  - DRY RUN BY DEFAULT. Nothing is uploaded or written without --commit.
 *  - IDEMPOTENT. Object keys are derived from a content hash, so re-running
 *    re-uses the same key instead of duplicating objects, and values that are
 *    already URLs are skipped (parseDataUrl returns null for them).
 *  - PER-ITEM ISOLATION. One bad image logs and is skipped; it never aborts
 *    the run or corrupts the product it belongs to.
 *  - WRITE-AFTER-UPLOAD. Postgres is only rewritten once every image in that
 *    product uploaded successfully, so a product is never left pointing at an
 *    object that does not exist.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'crypto';

function loadDotEnvLocal(): void {
  const path = join(process.cwd(), '.env.local');
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
}
loadDotEnvLocal();

import { createKvClient, loadStoreConfig, STORE_CONFIG_KEY } from '@/lib/server-config';
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { ensureDefaultTenant } from '@/lib/tenant-context';
import { buildMediaObjectKey, parseDataUrl } from '@/lib/media-s3-keys';
import { mimeToMediaExtension } from '@/lib/media';
import { putMediaObject, readMediaS3Config, type MediaS3Config } from '@/lib/media-s3';

const COMMIT = process.argv.includes('--commit');
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  if (i === -1) return Infinity;
  const n = parseInt(process.argv[i + 1] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();

let processed = 0;
let uploaded = 0;
let skipped = 0;
let failed = 0;
let bytesBefore = 0;
let bytesAfter = 0;

const fmtBytes = (n: number): string =>
  n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)}MB` : n > 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`;

/**
 * Migrate ONE data-URL media value. Returns the new public URL, or null when
 * the value needs no migration / could not be migrated.
 */
async function migrateOne(
  config: MediaS3Config,
  slug: string,
  dataUrl: string,
  label: string,
): Promise<string | null> {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    skipped++;
    return null; // already a URL, or junk — never touched
  }
  if (processed >= LIMIT) return null;
  processed++;

  let bytes: Buffer;
  try {
    bytes = Buffer.from(parsed.base64, 'base64');
  } catch {
    console.log(`  ! ${label}: undecodable base64 — skipped`);
    failed++;
    return null;
  }
  if (bytes.length === 0) {
    console.log(`  ! ${label}: empty payload — skipped`);
    failed++;
    return null;
  }

  // Content-addressed key => re-running never duplicates an object.
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
  const ext = mimeToMediaExtension(parsed.mime) || '.bin';
  const key = buildMediaObjectKey(slug, hash, `x${ext}`);

  bytesBefore += dataUrl.length;

  if (!COMMIT) {
    console.log(`  ~ ${label}: would upload ${fmtBytes(bytes.length)} -> ${key}`);
    bytesAfter += key.length + 40;
    return null;
  }

  try {
    const url = await putMediaObject(config, key, bytes, parsed.mime);
    uploaded++;
    bytesAfter += url.length;
    console.log(`  + ${label}: ${fmtBytes(bytes.length)} -> ${url}`);
    return url;
  } catch (err) {
    failed++;
    console.log(`  ! ${label}: upload failed — ${(err as Error).message}`);
    return null;
  }
}

/**
 * Set a value at a path like `a.b[0].c`. Only ever walks structure that the
 * finder already traversed, so every segment is known to exist.
 */
function setByPath(root: Record<string, unknown>, path: string, value: string): void {
  const segs = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let node: any = root;
  for (let i = 0; i < segs.length - 1; i++) node = node?.[segs[i]];
  if (node && typeof node === 'object') node[segs[segs.length - 1]] = value;
}

async function main() {
  console.log(`\nMedia backfill — ${COMMIT ? 'COMMIT (will upload and rewrite Postgres)' : 'DRY RUN (no writes)'}`);
  console.log('='.repeat(64));

  const config = readMediaS3Config();
  if (!config) {
    console.error(
      '\nObject storage is not configured. Set MEDIA_BUCKET, MEDIA_S3_ACCESS_KEY_ID,\n' +
        'MEDIA_S3_SECRET_ACCESS_KEY (and MEDIA_S3_ENDPOINT + MEDIA_S3_PUBLIC_BASE_URL for R2).',
    );
    process.exit(2);
  }
  const redis = createKvClient();
  if (!redis) {
    console.error('\nNo storage client configured — cannot read the catalog.');
    process.exit(2);
  }

  // ── Products (POSTGRES is authoritative) ─────────────────────────────────
  // This block used to rewrite the KV blob. That is now the WRONG target and
  // running it would have BROKEN every image: the storefront reads
  // products.media_gallery from Postgres, and publicMediaRef turns a base64
  // data: URL into a /media/<productId>/<index> ref whose bytes the /media
  // route then looks up in the KV blob. Rewriting KV to R2 URLs while
  // Postgres still held base64 would leave the ref pointing at a KV entry
  // that is no longer a data: URL -> decodeDataUrl returns null -> 404.
  //
  // Writing the R2 URL into Postgres instead is what actually works:
  // publicMediaRef passes a non-data: URL through untouched, so the browser
  // requests https://media.goyunir.com/media/r2/<key> directly and the Worker
  // serves it from the binding. The KV blob is left alone on purpose -- the
  // admin panel still reads it, and H3 deletes it wholesale.
  const db = getDb();
  if (!db.configured) {
    console.error('Supabase is not configured - cannot read the authoritative catalog.');
    process.exit(2);
  }
  const products = (await db.select<{ id: string; slug: string; external_id: string; media_gallery: unknown }>(
    'products',
    { where: { tenant_id: eq(await ensureDefaultTenant()) }, select: ['id', 'slug', 'external_id', 'media_gallery'] },
  )) as Array<{ id: string; slug: string; external_id: string; media_gallery: unknown }>;
  console.log(`
${products.length} product(s) in Postgres
`);

  for (const row of products) {
    if (processed >= LIMIT) break;
    const gallery = Array.isArray(row.media_gallery) ? [...(row.media_gallery as Array<Record<string, unknown>>)] : [];
    if (gallery.length === 0) continue;

    const pending = gallery.filter((m) => parseDataUrl(m?.url) !== null).length;
    if (pending === 0) continue;

    const label = row.slug || row.external_id || row.id;
    console.log(`${label} (${pending} base64 image(s))`);
    const slug = String(row.slug || row.external_id || row.id);
    let changed = 0;
    let anyFailed = false;

    for (let i = 0; i < gallery.length; i++) {
      if (processed >= LIMIT) break;
      const before = gallery[i]?.url;
      if (parseDataUrl(before) === null) continue;
      const url = await migrateOne(config, slug, String(before), `${label}[${i}]`);
      if (url) {
        gallery[i] = { ...gallery[i], url };
        changed++;
      } else if (COMMIT) {
        anyFailed = true;
      }
    }

    // WRITE-AFTER-UPLOAD, per product: a product is never left half-rewritten
    // pointing at an object that does not exist.
    if (COMMIT && changed > 0 && !anyFailed) {
      await db.update('products', { where: { id: eq(row.id) } }, { media_gallery: gallery }, { returning: 'minimal' });
      console.log(`  = ${label}: rewrote ${changed} image ref(s) in products.media_gallery`);
    } else if (COMMIT && anyFailed) {
      console.log(`  = ${label}: NOT rewritten — an upload failed, leaving this product untouched`);
    }
  }


  // ── Store config assets (RECURSIVE) ──────────────────────────────────────
  // Was: the brand logo only, by hardcoded path. That missed the two biggest
  // assets in the whole system, because they are nested deeper:
  //
  //   catalogPreview.upcomingDrops[].image   119KB + 144KB  jpeg
  //   aiHero.clips[].url                     681KB          webm
  //
  // 945KB of base64 sitting in the config blob that /api/store returns. A
  // hardcoded path list would have missed them and will miss the next one, so
  // this walks the whole config and migrates EVERY data: URL it finds,
  // wherever it lives. Already-migrated values are plain URLs and are skipped
  // by parseDataUrl, so re-running is a no-op.
  const config_ = await loadStoreConfig(redis);
  if (config_ && typeof config_ === 'object') {
    const found: Array<{ path: string; value: string }> = [];
    const find = (node: unknown, path: string) => {
      if (typeof node === 'string') {
        if (parseDataUrl(node) !== null) found.push({ path, value: node });
        return;
      }
      if (Array.isArray(node)) { node.forEach((v, i) => find(v, path + '[' + i + ']')); return; }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) find(v, path ? path + '.' + k : k);
      }
    };
    find(config_, '');

    if (found.length > 0) {
      console.log(`
store config — ${found.length} base64 asset(s)`);
      const replacements = new Map<string, string>();
      let anyFailed = false;
      for (const hit of found) {
        if (processed >= LIMIT) break;
        const url = await migrateOne(config, '_config', hit.value, hit.path);
        if (url) replacements.set(hit.path, url);
        else if (COMMIT) anyFailed = true;
      }

      // Apply by path, then WRITE ONCE. Same write-after-upload contract as
      // products: a partial failure leaves the config completely untouched
      // rather than half-pointing at objects that may not exist.
      if (COMMIT && replacements.size > 0 && !anyFailed) {
        const next = JSON.parse(JSON.stringify(config_)) as Record<string, unknown>;
        for (const [path, url] of replacements) setByPath(next, path, url);
        await redis.set(STORE_CONFIG_KEY, JSON.stringify(next));
        console.log(`  = store config: rewrote ${replacements.size} asset ref(s)`);
      } else if (COMMIT && anyFailed) {
        console.log('  = store config: NOT rewritten — an upload failed, leaving it untouched');
      }
    }
  }


  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(64)}`);
  console.log(`processed: ${processed}   uploaded: ${uploaded}   failed: ${failed}   already-migrated (skipped): ${skipped}`);
  if (bytesBefore > 0) {
    const pct = ((1 - bytesAfter / bytesBefore) * 100).toFixed(1);
    console.log(`catalog media payload: ${fmtBytes(bytesBefore)} -> ${fmtBytes(bytesAfter)} of refs (${pct}% smaller)`);
  }
  if (!COMMIT) {
    console.log('\nDRY RUN — nothing was uploaded or written. Re-run with --commit to apply.');
  }
  if (failed > 0) {
    console.log(`\n${failed} item(s) failed. Products containing them were left untouched; re-run to retry.`);
    process.exit(1);
  }
  console.log('');
  process.exit(0);
}

main().catch((err) => {
  console.error('Backfill crashed:', err);
  process.exit(1);
});
