import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { putMediaObject, readMediaS3Config } from '../lib/media-s3.ts';

interface Captured { method: string; url: string; contentType: string; body: Buffer }

/** Stand up a throwaway HTTP server that records one S3-style PUT. */
async function withFakeS3(
  endpointSuffix: string,
  publicBase: string,
  fn: (captured: Captured[]) => Promise<void>,
): Promise<void> {
  const captured: Captured[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      captured.push({
        method: req.method || '',
        url: req.url || '',
        contentType: String(req.headers['content-type'] || ''),
        body: Buffer.concat(chunks),
      });
      res.writeHead(200).end('OK');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;

  process.env.MEDIA_S3_ACCESS_KEY_ID = 'AKIATESTKEY';
  process.env.MEDIA_S3_SECRET_ACCESS_KEY = 'testsecret';
  process.env.MEDIA_BUCKET = 'test-bucket';
  process.env.MEDIA_S3_ENDPOINT = `http://127.0.0.1:${port}${endpointSuffix}`;
  process.env.MEDIA_S3_PUBLIC_BASE_URL = publicBase;

  try {
    await fn(captured);
  } finally {
    server.close();
  }
}

const PNG = Buffer.from('89504e470d0a1a0a46414b45494d414745', 'hex');
const KEY = 'products/cool-shoe/deadbeef.png';

test('putMediaObject: signs and PUTs to /<bucket>/<key> against a bare endpoint', async () => {
  await withFakeS3('', 'https://cdn.example.com', async (captured) => {
    const url = await putMediaObject(readMediaS3Config()!, KEY, new Uint8Array(PNG), 'image/png');
    assert.equal(captured.length, 1);
    const [got] = captured;
    assert.equal(got.method, 'PUT');
    // REGRESSION GUARD: the pre-extraction implementation built the upload URL
    // independently of the signed path and dropped the bucket, so every
    // path-style (R2) upload was signed for /bucket/key but sent to /key.
    assert.equal(got.url.split('?')[0], `/test-bucket/${KEY}`);
    assert.match(got.url, /X-Amz-Signature=[0-9a-f]{64}/);
    assert.match(decodeURIComponent(got.url), /X-Amz-Credential=AKIATESTKEY/);
    assert.equal(got.contentType, 'image/png');
    assert.equal(Buffer.compare(got.body, PNG), 0, 'bytes must arrive unmodified');
    assert.equal(url, `https://cdn.example.com/${KEY}`);
  });
});

test('putMediaObject: an endpoint that already includes /bucket is not doubled', async () => {
  await withFakeS3('/test-bucket', '', async (captured) => {
    const url = await putMediaObject(readMediaS3Config()!, KEY, new Uint8Array(PNG), 'image/png');
    assert.equal(captured[0].url.split('?')[0], `/test-bucket/${KEY}`);
    assert.match(url, /\/test-bucket\/products\/cool-shoe\/deadbeef\.png$/);
  });
});

test('putMediaObject: a storage error surfaces as a throw, never a silent success', async () => {
  const server = createServer((_req, res) => res.writeHead(403).end('AccessDenied'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  process.env.MEDIA_S3_ENDPOINT = `http://127.0.0.1:${port}`;
  try {
    await assert.rejects(
      () => putMediaObject(readMediaS3Config()!, KEY, new Uint8Array(PNG), 'image/png'),
      /403/,
    );
  } finally {
    server.close();
  }
});
