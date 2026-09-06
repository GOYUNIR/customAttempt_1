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
  if (adminRequestAuthorized(request)) return true;
  return isSuperAdminSession(request);
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
  const limited = await rateLimitedResponse('ai_shader_prompt', request, 30, 60);
  if (limited) return limited;

  if (!(await authorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const license = await getLicenseStatus();
  if (!isWriteAllowed(license.status)) {
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

  const driver = await AiFactory.getDriver();
  if (driver?.configured) {
    const completion = await driver.complete(buildShaderPrompt({ prompt, product }));
    if (completion.ok) {
      const parsed = parseShaderParamsResult(completion.text);
      if (parsed) {
        // Merge the AI refinement over the deterministic floor (never trust the
        // model to fully replace a safe, bounded compile).
        params = { ...floor, ...parsed, productSilhouette: parsed.productSilhouette || floor.productSilhouette };
        source = 'ai';
        provider = completion.provider;
      }
    }
  }

  const storage = createRedisClient();
  if (storage) {
    await trackUsage(storage, { prefix: ANALYTICS_USAGE_PREFIX, metric: 'ai_generations' }).catch(() => {});
  }

  return NextResponse.json({
    ok: true,
    source,
    provider,
    preset: paramsToPreset(params),
    params,
    silhouette: normalizeSilhouette(params.productSilhouette ?? product?.silhouette),
    product: product ? { id: product.id, name: product.name, slug: product.slug, category: product.category, silhouette: product.silhouette } : null,
  });
}
