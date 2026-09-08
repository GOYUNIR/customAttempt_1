import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMeshDriver, MESH_DRIVER_CATALOG } from '../services/ai/mesh-registry.ts';
import { normalizeMeshFormat } from '../services/ai/mesh-driver.ts';
import { sanitizeAi3dProvider, AI3D_PROVIDERS } from '../services/config/types.ts';

test('ai3d provider enum matches the catalog + SQL check constraint', () => {
  assert.deepEqual(
    [...AI3D_PROVIDERS].sort(),
    ['custom_webhook', 'meshy', 'stability_3d', 'tripo3d'].sort(),
  );
  assert.equal(MESH_DRIVER_CATALOG.length, 4);
});

test('sanitizeAi3dProvider only accepts the enumerated providers', () => {
  assert.equal(sanitizeAi3dProvider('tripo3d'), 'tripo3d');
  assert.equal(sanitizeAi3dProvider('TRIPO3D'), 'tripo3d');
  assert.equal(sanitizeAi3dProvider('meshy'), 'meshy');
  assert.equal(sanitizeAi3dProvider('stability_3d'), 'stability_3d');
  assert.equal(sanitizeAi3dProvider('custom_webhook'), 'custom_webhook');
  assert.equal(sanitizeAi3dProvider('blender'), null);
});

test('normalizeMeshFormat maps file names / mimes to known formats', () => {
  assert.equal(normalizeMeshFormat('model.glb'), 'glb');
  assert.equal(normalizeMeshFormat('model.gltf'), 'gltf');
  assert.equal(normalizeMeshFormat('model.obj'), 'obj');
  assert.equal(normalizeMeshFormat('model.usdz'), 'usdz');
  assert.equal(normalizeMeshFormat('model.ply'), 'ply');
  assert.equal(normalizeMeshFormat('model.unknown'), 'unknown');
});

test('createMeshDriver maps every catalog provider and is not configured without a key', () => {
  const tripo = createMeshDriver('tripo3d', 'tsk_xxx');
  assert.equal(tripo?.provider, 'tripo3d');
  assert.equal(tripo?.configured, true);

  const noKey = createMeshDriver('meshy', '');
  assert.equal(noKey?.configured, false);

  const webhook = createMeshDriver('custom_webhook', '', {}, 'https://example.com/3d');
  assert.equal(webhook?.provider, 'custom_webhook');
  assert.equal(webhook?.configured, true);

  const noEndpoint = createMeshDriver('custom_webhook', '', {});
  assert.equal(noEndpoint?.configured, false);

  assert.equal(createMeshDriver('carrier-pigeon' as any, 'x'), null);
});

test('Tripo3D driver posts a task then polls until success', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (init.method === 'POST') {
      return new Response(JSON.stringify({ code: 0, data: { task_id: 'task-123' } }), { status: 200 });
    }
    // Poll: first poll is "running", second is "success".
    const running = calls.filter((c) => c.init.method === 'GET').length <= 1;
    return new Response(
      JSON.stringify(
        running
          ? { code: 0, data: { status: 'running' } }
          : { code: 0, data: { status: 'success', output: { model: { url: 'https://cdn/model.glb', format: 'glb' }, rendered_image: { url: 'https://cdn/thumb.png' } } } },
      ),
      { status: 200 },
    );
  }) as typeof fetch;

  const driver = createMeshDriver('tripo3d', 'tsk_xxx', { fetchImpl: fn, pollDelayMs: 0 })!;
  const result = await driver.generate('https://store/media/product', 'a perfume bottle');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.modelUrl, 'https://cdn/model.glb');
    assert.equal(result.format, 'glb');
    assert.equal(result.thumbnailUrl, 'https://cdn/thumb.png');
  }
  const post = calls[0];
  assert.ok(post.url.endsWith('/v2/openapi/task'));
  assert.ok((post.init.headers as Record<string, string>).Authorization.includes('tsk_xxx'));
});

test('Tripo3D driver returns ok:false when the task fails', async () => {
  const fn = (async (url: string, init: RequestInit) => {
    if (init.method === 'POST') {
      return new Response(JSON.stringify({ code: 0, data: { task_id: 'task-x' } }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0, data: { status: 'failed' } }), { status: 200 });
  }) as typeof fetch;

  const driver = createMeshDriver('tripo3d', 'tsk_xxx', { fetchImpl: fn, pollDelayMs: 0 })!;
  const result = await driver.generate('img', 'prompt');
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(String(result.error).includes('failed'));
});

test('Meshy driver posts image-to-3d and polls until SUCCEEDED', async () => {
  const fn = (async (url: string, init: RequestInit) => {
    if (init.method === 'POST') {
      return new Response(JSON.stringify({ result: 'mesh-1' }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: 'SUCCEEDED', model_urls: { glb: 'https://cdn/m.glb' } }), { status: 200 });
  }) as typeof fetch;

  const driver = createMeshDriver('meshy', 'msy_xxx', { fetchImpl: fn, pollDelayMs: 0 })!;
  const result = await driver.generate('img', 'prompt');
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.modelUrl, 'https://cdn/m.glb');
});

test('Custom webhook driver POSTs the endpoint and returns a model URL', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ modelUrl: 'https://cdn/w.glb', status: 'complete' }), { status: 200 });
  }) as typeof fetch;

  const driver = createMeshDriver('custom_webhook', 'secret', { fetchImpl: fn, pollDelayMs: 0 }, 'https://hooks.example.com/3d')!;
  const result = await driver.generate('img', 'prompt');
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.modelUrl, 'https://cdn/w.glb');
  assert.equal(calls[0].url, 'https://hooks.example.com/3d');
  assert.ok((calls[0].init.headers as Record<string, string>).Authorization.includes('secret'));
});
