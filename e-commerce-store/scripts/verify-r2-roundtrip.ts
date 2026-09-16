/**
 * R2 ROUND-TRIP VERIFICATION (Phase H1, before the backfill runs).
 *
 *   npx tsx scripts/verify-r2-roundtrip.ts
 *
 * Proves the REAL bucket works end to end against the REAL credentials:
 * presign -> PUT the bytes -> fetch them back through the public custom
 * domain -> compare byte for byte -> clean up.
 *
 * This exists because "the config parses" and "presign returns a URL" are
 * both true of a misconfigured bucket. The Phase B SigV4 bug produced a
 * perfectly well-formed upload URL that signed a different path than it
 * addressed; only an actual upload caught it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

function loadEnv() {
  const p = join(process.cwd(), '.env.local');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();

let fail = 0;
function check(ok: boolean, name: string, detail = '') {
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? '\n     ' + detail : ''));
}
const sha = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex');

async function main() {
  const { readMediaS3Config, presignPut, presignDelete, putMediaObject, publicUrlForKey, newMediaObjectKey } =
    await import('../lib/media-s3');

  // Where to fetch the object back from. Defaults to production; pass
  // --base http://127.0.0.1:PORT to exercise a local dev server instead.
  const baseArg = process.argv.indexOf('--base');
  const serveBase = (baseArg > -1 ? process.argv[baseArg + 1] : '') || '';

  console.log('\nR2 round trip - real bucket, real credentials\n' + '='.repeat(60));

  const config = readMediaS3Config();
  check(Boolean(config), 'R2 config resolves from the environment');
  if (!config) { console.log('\n' + fail + ' FAILURE(S)\n'); process.exit(1); }
  console.log('     bucket=' + config.bucket + ' region=' + config.region);
  console.log('     endpoint=' + config.endpoint);
  console.log('     publicBase=' + (config.publicBaseUrl || '(none)'));

  check(Boolean(config.publicBaseUrl), 'MEDIA_S3_PUBLIC_BASE_URL is set');
  check(
    config.publicBaseUrl.includes('/media/r2'),
    'the public base points at the WORKER media route, not the bucket root',
    config.publicBaseUrl + ' -- the R2 custom domain is shadowed by this Worker route',
  );
  check(
    !/\/goyunir-media\/?$/.test(config.endpoint),
    'endpoint does NOT already contain the bucket (the Phase B signature/URL mismatch)',
    config.endpoint,
  );

  // A real, unique payload so a stale object can never make this pass.
  const payload = Buffer.concat([Buffer.from('goyunir-r2-verify:'), randomBytes(2048)]);
  const key = newMediaObjectKey('verify-roundtrip', 'probe.bin');
  console.log('     key=' + key);

  const { uploadUrl, objectUrl } = presignPut({ config, key, expiresSeconds: 300 });
  check(uploadUrl.includes('X-Amz-Signature'), 'presign produced a signed upload URL');
  check(
    new URL(uploadUrl).pathname === new URL(objectUrl).pathname,
    'the signed path and the object path are the SAME (Phase B regression guard)',
    'upload=' + new URL(uploadUrl).pathname + ' object=' + new URL(objectUrl).pathname,
  );

  let uploadedUrl = '';
  try {
    uploadedUrl = await putMediaObject(config, key, payload, 'application/octet-stream');
    check(true, 'PUT to the real bucket succeeded');
  } catch (e) {
    check(false, 'PUT to the real bucket succeeded', (e as Error)?.message || String(e));
  }

  const publicUrl = publicUrlForKey(config, key, objectUrl);
  check(
    publicUrl.includes('/media/r2/'),
    'the public URL routes through the Worker media path, not the S3 endpoint',
    publicUrl,
  );
  const fetchUrl = serveBase
    ? serveBase.replace(new RegExp('/+$'), '') + '/media/r2/' + key
    : publicUrl;
  console.log('     publicUrl=' + publicUrl);
  if (serveBase) console.log('     fetching from=' + fetchUrl);

  // Fetch it back the way a browser would: no credentials at all.
  const res = await fetch(fetchUrl, { headers: { 'Cache-Control': 'no-cache' } });
  check(res.ok, 'the object is readable with NO credentials through the Worker (HTTP ' + res.status + ')');
  if (res.ok) {
    const cc = res.headers.get('cache-control') || '';
    check(/immutable/.test(cc) && /max-age=31536000/.test(cc), 'served with immutable 1-year cache headers', cc);
  }
  if (res.ok) {
    const got = Buffer.from(await res.arrayBuffer());
    check(got.length === payload.length, 'byte length matches', got.length + ' vs ' + payload.length);
    check(sha(got) === sha(payload), 'content hash matches - the bytes round-tripped intact');
  }

  // Clean up: this is a probe object, not real media.
  try {
    const d = await fetch(presignDelete(config, key), { method: 'DELETE' });
    check(d.ok || d.status === 204, 'probe object deleted from the bucket (HTTP ' + d.status + ')');
  } catch (e) {
    check(false, 'probe object deleted from the bucket', (e as Error)?.message || String(e));
  }

  console.log('='.repeat(60));
  console.log(fail === 0 ? 'R2 ROUND TRIP VERIFIED\n' : fail + ' FAILURE(S)\n');
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('harness crashed:', e); process.exit(1); });