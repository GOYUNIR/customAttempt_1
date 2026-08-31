import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem, STORE_CONFIG_KEY } from '@/lib/server-config';
import { adminAuthorized } from '@/lib/admin-verify';
import { AiFactory } from '@/services/ai';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * The bounded permission surface the AI assistant may touch. Each entry is an
 * exact dot-path into `store:config` plus the ONLY accepted value type. The AI
 * is asked to map a natural-language instruction onto these keys; the route
 * re-validates EVERY change against this allowlist and coerces/drops anything
 * outside it, so a hallucinated key can never mutate settings the operator
 * hasn't exposed. Adding a key here is the only way to widen the assistant.
 */
const ALLOWED_TOGGLES: Array<{ key: string; label: string; type: 'boolean' }> = [
  { key: 'requireSignup2FA', label: 'Require customer signup email verification (2FA)', type: 'boolean' },
  { key: 'checkout.requireAddressAutofill', label: 'Require shipping address at checkout', type: 'boolean' },
  { key: 'behavior.scrollToTopOnLoad', label: 'Scroll to top when a page loads', type: 'boolean' },
  { key: 'socialProof.showSection', label: 'Show the social-proof counter section', type: 'boolean' },
  { key: 'socialProof.showCaption', label: 'Show the social-proof counter caption', type: 'boolean' },
];

function readBoolean(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1;
  return null;
}

function setNested(obj: any, path: string, value: unknown): any {
  const parts = path.split('.');
  const root = { ...obj };
  let cursor = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    const next = cursor[key];
    cursor[key] = next && typeof next === 'object' && !Array.isArray(next) ? { ...next } : {};
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
  return root;
}

/** Strip a ```json fence / leading prose and parse a `{ changes: [{key,value}] }` object. */
function parseChangesJson(text: string): Array<{ key: string; value: unknown }> | null {
  const raw = String(text || '').trim();
  if (!raw) return null;
  let jsonText = raw;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) jsonText = fence[1].trim();
  else {
    const start = jsonText.indexOf('{');
    const end = jsonText.lastIndexOf('}');
    if (start >= 0 && end > start) jsonText = jsonText.slice(start, end + 1);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const changes = Array.isArray(parsed?.changes) ? parsed.changes : (Array.isArray(parsed) ? parsed : null);
  if (!changes) return null;
  return changes
    .filter((c: any) => c && typeof c.key === 'string')
    .map((c: any) => ({ key: String(c.key).trim(), value: c.value }));
}

/**
 * POST /api/admin/ai-settings — natural-language setting changes via the AI
 * assistant, strictly bounded by ALLOWED_TOGGLES above. Admin-only.
 */
export async function POST(request: Request) {
  const limited = await rateLimitedResponse('ai_admin_settings', request, 20, 60);
  if (limited) return limited;

  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ error: 'Data store offline' }, { status: 500 });

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const password = String(body?.password || '');
  if (!(await adminAuthorized(request, password))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const instruction = String(body?.instruction || '').trim().slice(0, 1000);
  if (!instruction) return NextResponse.json({ error: 'Enter an instruction.' }, { status: 400 });

  const driver = await AiFactory.getDriver();
  if (!driver?.configured) {
    return NextResponse.json(
      { error: 'No AI provider is configured. Set an AI provider in /admin → Setup (or an env key like DEEPSEEK_API_KEY).' },
      { status: 400 },
    );
  }

  const toggleList = ALLOWED_TOGGLES.map((t) => `- ${t.key} (${t.label})`).join('\n');
  const prompt = [
    'You are a store-admin assistant. Map the operator instruction to settings changes.',
    'Allowed keys (boolean only):',
    toggleList,
    '',
    `Operator instruction: "${instruction}"`,
    '',
    'Return ONLY a JSON object (no markdown fences) shaped as:',
    '  { "changes": [ { "key": "<exact allowed key>", "value": true|false } ] }',
    'If the instruction does not map to any allowed key, return { "changes": [] }.',
  ].join('\n');

  const completion = await driver.complete(prompt);
  if (!completion.ok) {
    return NextResponse.json({ error: 'The AI provider failed to respond.' }, { status: 502 });
  }

  const proposed = parseChangesJson(completion.text);
  if (!proposed) {
    return NextResponse.json({ error: 'Could not interpret the instruction. Try rephrasing it.' }, { status: 422 });
  }

  // Re-validate against the allowlist (defense-in-depth against hallucination).
  const applied: Array<{ key: string; value: boolean }> = [];
  for (const change of proposed) {
    const allowed = ALLOWED_TOGGLES.find((t) => t.key === change.key);
    if (!allowed) continue;
    const value = readBoolean(change.value);
    if (value === null) continue;
    applied.push({ key: change.key, value });
  }

  if (applied.length === 0) {
    return NextResponse.json({ ok: true, applied: [], message: 'No matching settings change found for that instruction.' });
  }

  const currentRaw = await redis.get(STORE_CONFIG_KEY);
  const current = safeParseRedisItem<any>(currentRaw) || {};
  let next = current;
  for (const change of applied) {
    next = setNested(next, change.key, change.value);
  }
  next = { ...next, updatedAt: new Date().toISOString() };
  await redis.set(STORE_CONFIG_KEY, JSON.stringify(next));

  const summary = applied
    .map((c) => {
      const label = ALLOWED_TOGGLES.find((t) => t.key === c.key)?.label || c.key;
      return `${label} → ${c.value ? 'ON' : 'OFF'}`;
    })
    .join('; ');

  return NextResponse.json({ ok: true, applied, message: `Updated: ${summary}` });
}

/** GET — list the toggles the assistant may change (for the admin UI). */
export async function GET(request: Request) {
  if (!(await adminAuthorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }
  return NextResponse.json({ allowed: ALLOWED_TOGGLES });
}

