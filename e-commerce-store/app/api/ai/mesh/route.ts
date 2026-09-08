import { NextResponse } from 'next/server';
import { adminRequestAuthorized } from '@/lib/server-config';
import { isSuperAdminSession } from '@/lib/admin-verify';
import { MeshFactory } from '@/services/ai';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { uploadHeroModel } from '@/lib/supabase-storage';

export const dynamic = 'force-dynamic';

async function authorized(request: Request): Promise<boolean> {
  try {
    if (adminRequestAuthorized(request)) return true;
    return await isSuperAdminSession(request);
  } catch {
    return false;
  }
}

/**
 * Race a promise against a deadline so a hung 3D provider can never wedge the
 * route. The mesh task polling runs server-side (bounded by the driver), so this
 * ceiling is a last-resort safety net.
 */
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

/** A filesystem-safe id for the generated model file in `hero-models/`. */
function heroModelId(imageUrl: string): string {
  const base = (imageUrl || '').split('/').pop() || '';
  const slug = base.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'hero';
  return `${slug}-${Date.now().toString(36)}`;
}

/**
 * POST /api/ai/mesh — route an Image-to-3D task to the configured 3D mesh engine
 * (Tripo3D / Meshy / Stability 3D / a custom webhook). Admin-only.
 *
 * When no 3D provider key is set the route returns `{ ok: true, configured:
 * false }` so the client seamlessly degrades to the 2D image-texture WebGL
 * shader WITHOUT throwing. A configured provider whose task fails returns a
 * masked `meshError` so the hero still falls back to the 2D shader.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  try {
    const limited = await rateLimitedResponse('ai_mesh', request, 10, 60);
    if (limited) return limited;

    if (!(await authorized(request))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const imageUrl = String(body.imageUrl || '').trim();
    const prompt = String(body.prompt || '').trim();
    const mode = String(body.mode || 'sync').trim().toLowerCase();
    const taskId = String(body.taskId || '').trim();

    const driver = await MeshFactory.getDriver().catch(() => null);
    if (!driver?.configured) {
      return NextResponse.json({ ok: true, configured: false, provider: null, modelUrl: null });
    }

    if (!imageUrl) {
      return NextResponse.json({ error: 'A product image URL is required.' }, { status: 400 });
    }

    // Two-step ASYNC flow (Tripo3D / Meshy): `submit` returns the task id
    // immediately so the client can poll progress without hitting an Edge
    // worker's ~10s timeout; `poll` resolves the task, downloads the GLTF/GLB on
    // the server and re-hosts it permanently in Supabase Storage.
    if (mode === 'submit') {
      if (!driver.submitTask) {
        return NextResponse.json({ ok: true, configured: true, provider: driver.provider, syncOnly: true });
      }
      const submitted = await withTimeout(driver.submitTask(imageUrl, prompt), 30_000);
      if (submitted.ok) {
        return NextResponse.json({
          ok: true,
          configured: true,
          provider: submitted.provider,
          taskId: submitted.taskId,
          status: 'processing',
        });
      }
      const message = submitted.error instanceof Error ? submitted.error.message : String(submitted.error ?? 'submit failed');
      return NextResponse.json({
        ok: true,
        configured: true,
        provider: submitted.provider,
        meshError: `The 3D engine could not start the task (${message.slice(0, 240)}) — falling back to the 2D image shader.`,
      });
    }

    if (mode === 'poll') {
      if (!driver.pollTask || !taskId) {
        return NextResponse.json({ ok: true, configured: true, provider: driver.provider, status: 'processing', modelUrl: null });
      }
      const result = await withTimeout(driver.pollTask(taskId), 120_000);
      if (result.ok) {
        const storedUrl = await uploadHeroModel(result.modelUrl || '', heroModelId(imageUrl), result.format);
        return NextResponse.json({
          ok: true,
          configured: true,
          provider: result.provider,
          modelUrl: storedUrl || result.modelUrl || null,
          storedUrl: storedUrl || null,
          thumbnailUrl: result.thumbnailUrl || null,
          format: result.format,
          status: 'complete',
        });
      }
      const message = result.error instanceof Error ? result.error.message : String(result.error ?? 'poll failed');
      return NextResponse.json({
        ok: true,
        configured: true,
        provider: result.provider,
        status: 'failed',
        meshError: `The 3D engine failed (${message.slice(0, 240)}) — falling back to the 2D image shader.`,
      });
    }

    // Synchronous (legacy) flow — generate, then re-host permanently.
    const result = await withTimeout(driver.generate(imageUrl, prompt), 120_000);
    if (result.ok) {
      const storedUrl = await uploadHeroModel(result.modelUrl || '', heroModelId(imageUrl), result.format);
      return NextResponse.json({
        ok: true,
        configured: true,
        provider: result.provider,
        modelUrl: storedUrl || result.modelUrl || null,
        storedUrl: storedUrl || null,
        thumbnailUrl: result.thumbnailUrl || null,
        format: result.format,
      });
    }

    const message =
      result.error instanceof Error ? result.error.message : String(result.error ?? 'The 3D engine could not complete the task.');
    return NextResponse.json({
      ok: true,
      configured: true,
      provider: result.provider,
      modelUrl: null,
      meshError: `The 3D engine failed (${message.slice(0, 240)}) — falling back to the 2D image shader.`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected error in the mesh engine.';
    return NextResponse.json(
      { ok: true, configured: false, provider: null, modelUrl: null, meshError: `The 3D engine could not complete (${message.slice(0, 240)}) — falling back to the 2D image shader.` },
      { status: 200 },
    );
  }
}
