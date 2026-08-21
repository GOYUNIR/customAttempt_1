import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAiDriver, AI_DRIVER_CATALOG } from '../services/ai/registry.ts';
import { maskApiKey } from '../services/ai/types.ts';
import { FallbackAiDriver } from '../services/ai/fallback.driver.ts';
import { sanitizeAiProvider, AI_PROVIDERS } from '../services/config/types.ts';

test('ai provider enum matches the catalog + SQL check constraint', () => {
  assert.deepEqual(
    [...AI_PROVIDERS].sort(),
    ['anthropic', 'deepseek', 'deepseek_lite', 'google_gemini', 'groq', 'mistral', 'openai', 'openrouter', 'replicate', 'workers_ai'].sort(),
  );
  assert.equal(AI_DRIVER_CATALOG.length, 10);
});

test('sanitizeAiProvider only accepts the enumerated providers', () => {
  assert.equal(sanitizeAiProvider('deepseek'), 'deepseek');
  assert.equal(sanitizeAiProvider('DEEPSEEK'), 'deepseek');
  assert.equal(sanitizeAiProvider('deepseek_lite'), 'deepseek_lite');
  assert.equal(sanitizeAiProvider('workers_ai'), 'workers_ai');
  assert.equal(sanitizeAiProvider('openai'), 'openai');
  assert.equal(sanitizeAiProvider('anthropic'), 'anthropic');
  assert.equal(sanitizeAiProvider('replicate'), 'replicate');
  assert.equal(sanitizeAiProvider('openrouter'), 'openrouter');
  assert.equal(sanitizeAiProvider('groq'), 'groq');
  assert.equal(sanitizeAiProvider('mistral'), 'mistral');
  assert.equal(sanitizeAiProvider('google_gemini'), 'google_gemini');
  assert.equal(sanitizeAiProvider('chatgpt'), null);
});

test('maskApiKey formats sk-ds-••••••••1234 style masks', () => {
  assert.equal(maskApiKey('sk-ds-abcdefgh1234'), 'sk-ds-••••••••1234');
  assert.equal(maskApiKey(''), '');
});

test('createAiDriver maps every catalog provider and is not configured without a key', () => {
  const deepseek = createAiDriver('deepseek', 'sk-ds-x');
  assert.equal(deepseek?.provider, 'deepseek');
  assert.equal(deepseek?.configured, true);

  const noKey = createAiDriver('openai', '');
  assert.equal(noKey?.configured, false);

  const workers = createAiDriver('workers_ai', '', { runImpl: async () => ({ response: 'hi' }) });
  assert.equal(workers?.provider, 'workers_ai');
  assert.equal(workers?.configured, true);

  assert.equal(createAiDriver('carrier-pigeon' as any, 'x'), null);
});

test('deepseek driver posts an OpenAI-compatible chat completion', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ choices: [{ message: { content: '  hello  ' } }] }), { status: 200 });
  }) as typeof fetch;

  const driver = createAiDriver('deepseek', 'sk-ds-x', { fetchImpl: fn })!;
  const result = await driver.complete('animate');
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.text, 'hello');
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.ok(headers.Authorization.includes('sk-ds-x'));
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.model, 'deepseek-chat');
  assert.equal(body.messages[0].content, 'animate');
});

test('anthropic driver posts to Messages API with x-api-key header', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 });
  }) as typeof fetch;

  const driver = createAiDriver('anthropic', 'sk-ant-x', { fetchImpl: fn })!;
  const result = await driver.complete('hi');
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], 'sk-ant-x');
  assert.equal(headers['anthropic-version'], '2023-06-01');
});

test('openrouter driver posts an OpenAI-compatible chat completion', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), { status: 200 });
  }) as typeof fetch;

  const driver = createAiDriver('openrouter', 'sk-or-x', { fetchImpl: fn })!;
  assert.equal(driver?.configured, true);
  const result = await driver.complete('animate');
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.ok(headers.Authorization.includes('sk-or-x'));
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.model, 'openrouter/auto');
});

test('google gemini driver posts to generateContent with the key as a query param', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: ' ok ' }] } }] }), { status: 200 });
  }) as typeof fetch;

  const driver = createAiDriver('google_gemini', 'AIza-x', { fetchImpl: fn })!;
  assert.equal(driver?.configured, true);
  const result = await driver.complete('hi');
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.text, 'ok');
  assert.ok(calls[0].url.includes('gemini-1.5-flash:generateContent'));
  assert.ok(calls[0].url.includes('key=AIza-x'));
});

test('FallbackAiDriver returns primary success and fails over to secondary', async () => {
  const primary = createAiDriver('deepseek', 'sk-ds-x', {
    fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'primary' } }] }), { status: 200 })) as typeof fetch,
  })!;
  const secondary = createAiDriver('openrouter', 'sk-or-x', {
    fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'secondary' } }] }), { status: 200 })) as typeof fetch,
  })!;

  const fallback = new FallbackAiDriver(primary, secondary);
  assert.equal(fallback.configured, true);
  assert.equal(fallback.provider, 'deepseek');

  const okResult = await fallback.complete('hi');
  assert.equal(okResult.ok, true);
  if (okResult.ok) assert.equal(okResult.text, 'primary');

  const failingPrimary = createAiDriver('deepseek', 'sk-ds-x', {
    fetchImpl: (async () => new Response('boom', { status: 500 })) as typeof fetch,
  })!;
  const failsOver = new FallbackAiDriver(failingPrimary, secondary);
  const secondaryResult = await failsOver.complete('hi');
  assert.equal(secondaryResult.ok, true);
  if (secondaryResult.ok) {
    assert.equal(secondaryResult.text, 'secondary');
    assert.equal(secondaryResult.provider, 'openrouter');
  }
});
