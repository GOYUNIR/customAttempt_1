import { NextResponse } from 'next/server';
import { adminRequestAuthorized } from '@/lib/server-config';
import { isSuperAdminSession } from '@/lib/admin-verify';
import { MeshFactory } from '@/services/ai';
import { rateLimitedResponse } from '@/lib/rate-limit';

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

    const driver = await MeshFactory.getDriver().catch(() => null);
    if (!driver?.configured) {
      return NextResponse.json({ ok: true, configured: false, provider: null, modelUrl: null });
    }

    if (!imageUrl) {
      return NextResponse.json({ error: 'A product image URL is required.' }, { status: 400 });
    }

    const result = await withTimeout(driver.generate(imageUrl, prompt), 120_000);
    if (result.ok) {
      return NextResponse.json({
        ok: true,
        configured: true,
        provider: result.provider,
        modelUrl: result.modelUrl || null,
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
