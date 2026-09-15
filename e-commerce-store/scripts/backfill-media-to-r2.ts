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
 *   npx tsx scripts/backfill-media-to-r2.ts --commit   # upload + rewrite Redis
 *   npx tsx scripts/backfill-media-to-r2.ts --limit 5  # cap items processed
 *
 * Safety properties:
 *  - DRY RUN BY DEFAULT. Nothing is uploaded or written without --commit.
 *  - IDEMPOTENT. Object keys are derived from a content hash, so re-running
 *    re-uses the same key instead of duplicating objects, and values that are
 *    already URLs are skipped (parseDataUrl returns null for them).
 *  - PER-ITEM ISOLATION. One bad image logs and is skipped; it never aborts
 *    the run or corrupts the product it belongs to.
 *  - WRITE-AFTER-UPLOAD. Redis is only rewritten once every image in that
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

import { createRedisClient, loadStoreConfig, safeParseRedisItem, PRODUCTS_KEY, STORE_CONFIG_KEY } from '@/lib/server-config';
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

async function main() {
  console.log(`\nMedia backfill — ${COMMIT ? 'COMMIT (will upload and rewrite Redis)' : 'DRY RUN (no writes)'}`);
  console.log('='.repeat(64));

  const config = readMediaS3Config();
  if (!config) {
    console.error(
      '\nObject storage is not configured. Set MEDIA_BUCKET, MEDIA_S3_ACCESS_KEY_ID,\n' +
        'MEDIA_S3_SECRET_ACCESS_KEY (and MEDIA_S3_ENDPOINT + MEDIA_S3_PUBLIC_BASE_URL for R2).',
    );
    process.exit(2);
  }
  const redis = createRedisClient();
  if (!redis) {
    console.error('\nNo storage client configured — cannot read the catalog.');
    process.exit(2);
  }

  // ── Products ─────────────────────────────────────────────────────────────
  const all = (await redis.hgetall(PRODUCTS_KEY)) || {};
  const ids = Object.keys(all);
  console.log(`\n${ids.length} product(s) in ${PRODUCTS_KEY}\n`);

  for (const id of ids) {
    if (processed >= LIMIT) break;
    const product = safeParseRedisItem<any>(all[id]);
    if (!product || !Array.isArray(product.images) || product.images.length === 0) continue;

    const pending = product.images.filter((img: unknown) => parseDataUrl(img) !== null).length;
    if (pending === 0) continue;

    console.log(`${id} (${pending} base64 image(s))`);
    const slug = String(product.slug || product.handle || id);
    const nextImages = [...product.images];
    let changed = 0;
    let anyFailed = false;

    for (let i = 0; i < nextImages.length; i++) {
      if (processed >= LIMIT) break;
      const before = nextImages[i];
      if (parseDataUrl(before) === null) continue;
      const url = await migrateOne(config, slug, String(before), `${id}[${i}]`);
      if (url) {
        nextImages[i] = url;
        changed++;
      } else if (COMMIT) {
        anyFailed = true;
      }
    }

    if (COMMIT && changed > 0 && !anyFailed) {
      await redis.hset(PRODUCTS_KEY, { [id]: JSON.stringify({ ...product, images: nextImages }) });
      console.log(`  = ${id}: rewrote ${changed} image ref(s)`);
    } else if (COMMIT && anyFailed) {
      console.log(`  = ${id}: NOT rewritten — an upload failed, leaving this product untouched`);
    }
  }

  // ── Brand logo (store config) ────────────────────────────────────────────
  const config_ = await loadStoreConfig(redis);
  const logo = config_?.branding?.logoUrl;
  if (parseDataUrl(logo) !== null && processed < LIMIT) {
    console.log('\nbrand logo');
    const url = await migrateOne(config, '_brand', String(logo), 'branding.logoUrl');
    if (COMMIT && url) {
      const next = { ...config_, branding: { ...(config_.branding || {}), logoUrl: url } };
      await redis.set(STORE_CONFIG_KEY, JSON.stringify(next));
      console.log('  = store config: logo ref rewritten');
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
