import { NextResponse } from 'next/server';
import {
  createRedisClient,
  safeParseRedisItem,
  loadProducts,
  STORE_CONFIG_KEY,
  PROMO_CODES_KEY,
  ARCHIVE_LEDGER_KEY,
} from '@/lib/server-config';
import { adminAuthorized } from '@/lib/admin-verify';
import { AiFactory } from '@/services/ai';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { sortSanityIssues, checkProductSanity } from '@/lib/product-sanity';

export const dynamic = 'force-dynamic';

/**
 * ADMIN PORTAL HELPER — a comprehensive, permission-bounded AI assistant.
 *
 * Two clear operation modes:
 *   - `inquiry` ("Tell-Only Mode") — reads the live store (products, config,
 *     promos, ledger) and answers / diagnoses. NEVER writes.
 *   - `edit`    ("Verified Edit Mode")  — proposes bounded setting changes but
 *     does NOT apply them; the admin must explicitly confirm via `apply`.
 *   - `apply`   — applies a previously-proposed set of changes, re-validating
 *     every entry against the allowlist (defense-in-depth vs hallucination).
 *
 * This helper is COMPLETELY separate from the storefront hero-animation AI
 * (`/api/ai/hero-animation`) — that path only processes cover images.
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

function toggleListText(): string {
  return ALLOWED_TOGGLES.map((t) => `- ${t.key} (${t.label})`).join('\n');
}

/** Build a small, safe store snapshot for the AI to read + diagnose. */
async function buildStoreSnapshot(redis: any): Promise<Record<string, unknown>> {
  const snapshot: Record<string, unknown> = {};
  try {
    const products = await loadProducts(redis);
    const list = Object.values(products || {});
    snapshot.productCount = list.length;
    snapshot.products = list.slice(0, 50).map((p: any) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      isActive: p.isActive === true,
      isArchived: p.isArchived === true,
      isUpcoming: p.isUpcoming === true,
      checkoutMode: p.checkoutMode || (p.isRaffle === false ? 'FCFS' : 'RAFFLE'),
      totalInventory: Number(p.totalInventory || 0),
      priceCategories: Array.isArray(p.priceCategories)
        ? p.priceCategories.map((c: any) => ({ size: c.size, price: c.price, stripeId: c.stripeId, winnerTiers: c.winnerTiers, checkoutMode: c.checkoutMode || '' }))
        : [],
      categories: Array.isArray(p.categories) ? p.categories : [],
      releaseEndsAt: p.releaseEndsAt || '',
      goLiveAt: p.goLiveAt || '',
      samplerSizes: Array.isArray(p.samplerSizes) ? p.samplerSizes.map((s: any) => s?.size).filter(Boolean) : [],
    }));
    const issues: Array<{ product: string; code: string; message: string; severity: string }> = [];
    for (const p of list) {
      for (const issue of sortSanityIssues(checkProductSanity(p, {}))) {
        issues.push({ product: String(p.name || p.id || ''), code: issue.code, message: issue.message, severity: issue.severity });
      }
    }
    snapshot.sanityIssues = issues.slice(0, 60);
  } catch {
    snapshot.productCount = 'unavailable';
  }
  try {
    const configRaw = await redis.get(STORE_CONFIG_KEY);
    const config = safeParseRedisItem<any>(configRaw) || {};
    snapshot.config = {
      requireSignup2FA: config.requireSignup2FA !== false,
      checkout: { requireAddressAutofill: config.checkout?.requireAddressAutofill },
      behavior: { scrollToTopOnLoad: config.behavior?.scrollToTopOnLoad },
      socialProof: {
        showSection: config.socialProof?.showSection !== false,
        showCaption: config.socialProof?.showCaption !== false,
      },
      brandName: config.branding?.brandName || config.brandName || '',
      dropSchedule: config.dropSchedule || null,
      categories: Array.isArray(config.catalog?.categories) ? config.catalog.categories : [],
    };
  } catch {
    snapshot.config = { unavailable: true };
  }
  try {
    const promosRaw = await redis.hgetall(PROMO_CODES_KEY);
    snapshot.promoCount = promosRaw ? Object.keys(promosRaw).length : 0;
  } catch {
    snapshot.promoCount = 'unavailable';
  }
  try {
    const ledger = await redis.lrange(ARCHIVE_LEDGER_KEY, 0, -1);
    snapshot.ledgerEntries = Array.isArray(ledger) ? ledger.length : 'unavailable';
  } catch {
    snapshot.ledgerEntries = 'unavailable';
  }
  return snapshot;
}

export async function POST(request: Request) {
  const limited = await rateLimitedResponse('ai_admin_helper', request, 20, 60);
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

  const mode = String(body?.mode || 'inquiry').toLowerCase();
  const instruction = String(body?.instruction || '').trim().slice(0, 1500);

  // ── APPLY — the explicit confirmation step for Verified Edit Mode ──
  if (mode === 'apply') {
    const changes = Array.isArray(body?.changes) ? body.changes : [];
    const applied: Array<{ key: string; value: boolean }> = [];
    for (const change of changes) {
      const allowed = ALLOWED_TOGGLES.find((t) => t.key === String(change?.key || '').trim());
      if (!allowed) continue;
      const value = readBoolean(change?.value);
      if (value === null) continue;
      applied.push({ key: allowed.key, value });
    }
    if (applied.length === 0) {
      return NextResponse.json({ ok: true, applied: [], message: 'No valid changes to apply.' });
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
      .map((c) => `${ALLOWED_TOGGLES.find((t) => t.key === c.key)?.label || c.key} → ${c.value ? 'ON' : 'OFF'}`)
      .join('; ');
    return NextResponse.json({ ok: true, applied, message: `Applied: ${summary}` });
  }

  if (!instruction) return NextResponse.json({ error: 'Enter an instruction or question.' }, { status: 400 });

  const driver = await AiFactory.getDriver();
  if (!driver?.configured) {
    return NextResponse.json(
      { error: 'No AI provider is configured. Set one in /admin → Setup (or an env key like DEEPSEEK_API_KEY).' },
      { status: 400 },
    );
  }

  const snapshot = await buildStoreSnapshot(redis);

  if (mode === 'edit') {
    const prompt = [
      'You are a store-admin assistant. Read the store snapshot and map the operator instruction onto setting changes.',
      'Allowed keys (boolean only):',
      toggleListText(),
      '',
      'Store snapshot (JSON):',
      JSON.stringify(snapshot).slice(0, 6000),
      '',
      `Operator instruction: "${instruction}"`,
      '',
      'Return ONLY a JSON object (no markdown fences) shaped as:',
      '  { "reply": "<one short sentence explaining what you propose>", "changes": [ { "key": "<exact allowed key>", "value": true|false } ] }',
      'If the instruction does not map to any allowed key, return { "reply": "<explanation>", "changes": [] }.',
    ].join('\n');

    const completion = await driver.complete(prompt);
    if (!completion.ok) return NextResponse.json({ error: 'The AI provider failed to respond.' }, { status: 502 });

    const proposed = parseChangesJson(completion.text);
    if (!proposed) return NextResponse.json({ error: 'Could not interpret the instruction. Try rephrasing it.' }, { status: 422 });

    const replyMatch = String(completion.text).match(/"reply"\s*:\s*"([^"]*)"/);
    const reply = replyMatch ? replyMatch[1] : '';

    const validated: Array<{ key: string; label: string; value: boolean }> = [];
    for (const change of proposed) {
      const allowed = ALLOWED_TOGGLES.find((t) => t.key === change.key);
      if (!allowed) continue;
      const value = readBoolean(change.value);
      if (value === null) continue;
      validated.push({ key: allowed.key, label: allowed.label, value });
    }

    return NextResponse.json({
      ok: true,
      mode: 'edit',
      reply: reply || (validated.length ? `${validated.length} change(s) proposed — confirm to apply.` : 'No matching setting change found.'),
      proposedChanges: validated,
      notApplied: true,
    });
  }

  // Inquiry / Tell-Only Mode — read + diagnose, NEVER write.
  const prompt = [
    'You are a store-admin assistant in TELL-ONLY mode. You may read and diagnose but never propose edits.',
    'Answer the operator in plain English, citing concrete numbers from the snapshot.',
    '',
    'Store snapshot (JSON):',
    JSON.stringify(snapshot).slice(0, 8000),
    '',
    `Operator question/instruction: "${instruction}"`,
    '',
    'Reply with a concise, factual answer (3-6 sentences max). Flag anything broken (missing prices, missing Stripe IDs, zero inventory on active products, sanity issues).',
  ].join('\n');

  const completion = await driver.complete(prompt);
  if (!completion.ok) return NextResponse.json({ error: 'The AI provider failed to respond.' }, { status: 502 });

  return NextResponse.json({ ok: true, mode: 'inquiry', reply: String(completion.text || '').trim(), proposedChanges: [] });
}

/** GET — the helper's capability surface (allowed edit keys) for the admin UI. */
export async function GET(request: Request) {
  if (!(await adminAuthorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }
  return NextResponse.json({
    modes: ['inquiry', 'edit'],
    allowedEdits: ALLOWED_TOGGLES,
    description: 'Inquiry (tell-only) reads and diagnoses the store. Edit mode proposes bounded setting changes that require explicit confirmation before applying.',
  });
}


