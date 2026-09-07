import { NextResponse } from 'next/server';
import { adminRequestAuthorized, createRedisClient } from '@/lib/server-config';
import { isSuperAdminSession } from '@/lib/admin-verify';
import { getLicenseStatus, isWriteAllowed } from '@/lib/license';
import { AiFactory } from '@/services/ai';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { trackUsage } from '@/lib/analytics';
import { ANALYTICS_USAGE_PREFIX } from '@/lib/redis-keys';
import {
  compileShaderParams,
  buildShaderPrompt,
  parseShaderParamsResult,
  paramsToPreset,
  type ShaderParams,
} from '@/lib/shaders/promptParser';
import { buildProductTarget, normalizeSilhouette } from '@/lib/shaders/productTarget';

export const dynamic = 'force-dynamic';

async function authorized(request: Request): Promise<boolean> {
  try {
    if (adminRequestAuthorized(request)) return true;
    return await isSuperAdminSession(request);
  } catch {
    // A transient Redis/Supabase read must never 503 the route — deny safely.
    return false;
  }
}

/** Race a promise against a hard timeout so a hung AI provider can't wedge. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * POST /api/ai/shader-prompt — compile a hero-shader prompt (with an optional
 * live product target) into bounded render uniforms. Admin-only + license-gated.
 *
 * The deterministic compiler (`compileShaderParams`) is always the safety floor;
 * when an AI provider is configured the active driver is asked to refine the
 * params, and its (bounded, re-validated) JSON output is merged over the floor.
 * A hallucinated key can never reach the GPU.
 */
export async function POST(request: Request) {
  // Every failure inside this route is caught and returned as HTTP 200 fallback
  // JSON — a transient Redis/Supabase/AI-provider error must never surface as an
  // unhandled 503/500 to the admin client.
  try {
  const limited = await rateLimitedResponse('ai_shader_prompt', request, 30, 60);
  if (limited) return limited;

  if (!(await authorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Resolve the AI driver up front so a REAL API key (DeepSeek/OpenAI/… in
  // settings or env, or a Workers AI binding) can bypass Demo Mode. Wrapped so a
  // transient Supabase read can never 503 the whole route.
  let driver: Awaited<ReturnType<typeof AiFactory.getDriver>> = null;
  try {
    driver = await AiFactory.getDriver();
  } catch {
    driver = null;
  }
  const aiConfigured = Boolean(driver?.configured);

  // Demo Mode only blocks AI generation when NO AI provider is configured — an
  // operator who wired a paid key has effectively unlocked the model and must
  // not be locked out of the prompt compiler.
  let license: Awaited<ReturnType<typeof getLicenseStatus>>;
  try {
    license = await getLicenseStatus();
  } catch {
    // A license-server/Redis hiccup is not a reason to 503 the admin — the AI
    // compiler is non-destructive, so fall back to a permissive local verdict.
    license = { status: 'ACTIVE', keyMasked: '', graceDaysRemaining: 0, reason: '', writesAllowed: true };
  }
  if (!isWriteAllowed(license.status) && !aiConfigured) {
    return NextResponse.json(
      { error: 'Demo Mode: AI generation is disabled until a license is active.', license: license.status },
      { status: 403 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const prompt = String(body.prompt || '').trim().slice(0, 4000);
  const product = buildProductTarget((body.product as Record<string, any>) ?? null);

  // Deterministic floor — always produces bounded params, never a hardcoded
  // product (the target's silhouette is derived from its own metadata).
  const floor = compileShaderParams(prompt, product);

  let params: ShaderParams = floor;
  let source: 'ai' | 'fallback' = 'fallback';
  let provider: string | null = null;
  let aiError: string | null = null;

  // Reuse the driver resolved above (a second read would double the Supabase
  // round-trips and re-risk a transient failure). When the provider IS wired up
  // but the call fails or returns garbage, surface a masked `aiError` so the
  // admin sees WHY the refinement fell back to the deterministic floor.
  if (driver?.configured) {
    try {
      const completion = await withTimeout(
        driver.complete(buildShaderPrompt({ prompt, product })),
        20_000,
      );
      if (completion.ok) {
        const parsed = parseShaderParamsResult(completion.text);
        if (parsed) {
          // Merge the AI refinement over the deterministic floor (never trust the
          // model to fully replace a safe, bounded compile).
          params = { ...floor, ...parsed, productSilhouette: parsed.productSilhouette || floor.productSilhouette };
          source = 'ai';
          provider = completion.provider;
        } else {
          aiError = 'The AI provider returned an unusable response — using the deterministic compile.';
        }
      } else {
        aiError = 'The AI provider failed — using the deterministic compile.';
      }
    } catch (err) {
      // AI provider failed (or timed out) — keep the deterministic floor; never 503.
      aiError =
        err instanceof Error && err.message === 'timeout'
          ? 'The AI provider timed out — using the deterministic compile.'
          : 'The AI provider errored — using the deterministic compile.';
    }
  }

  const storage = createRedisClient();
  if (storage) {
    await trackUsage(storage, { prefix: ANALYTICS_USAGE_PREFIX, metric: 'ai_generations' }).catch(() => {});
  }

  return NextResponse.json({
    ok: true,
    success: true,
    source,
    provider,
    aiError,
    preset: paramsToPreset(params),
    params,
    silhouette: normalizeSilhouette(params.productSilhouette ?? product?.silhouette),
    product: product ? { id: product.id, name: product.name, slug: product.slug, category: product.category, silhouette: product.silhouette } : null,
  });
  } catch (err) {
    // Never 503 the admin — degrade to the deterministic floor and report a
    // masked `aiError` so the UI can explain WHY the refinement didn't run.
    const message =
      err instanceof Error ? err.message : 'Unexpected error in the shader compiler.';
    const floor = compileShaderParams('', null);
    return NextResponse.json(
      {
        ok: false,
        success: false,
        source: 'fallback',
        provider: null,
        aiError: `The AI shader compiler could not complete (${message.slice(0, 240)}) — using the deterministic fallback.`,
        preset: paramsToPreset(floor),
        params: floor,
        silhouette: normalizeSilhouette(floor.productSilhouette),
        product: null,
      },
      { status: 200 },
    );
  }
}
