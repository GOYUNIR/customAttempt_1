/**
 * SUPABASE STORAGE — permanent hosting for generated 3D hero models.
 *
 * Image-to-3D providers (Tripo3D / Meshy) return TEMPORARY CDN URLs that expire
 * (often within hours). To prevent the hero model from 404ing later, the mesh
 * route downloads the generated GLB/GLTF on the server and re-uploads it into a
 * PUBLIC Supabase Storage bucket (`hero-models/`). The permanent URL is then
 * persisted to store-config instead of the provider's ephemeral link.
 *
 * The upload uses the service-role key (which bypasses bucket RLS), so the
 * bucket must be PUBLIC for the storefront `<model-viewer>` / GLTF loader to
 * fetch it anonymously. When Supabase Storage is not configured the helper
 * returns the original URL unchanged (fail-open: the hero still renders from the
 * provider CDN for the short term).
 */

import { readSupabaseEnv, supabaseServiceConfigured } from '@/services/config/supabase-client';

export const HERO_MODELS_BUCKET = 'hero-models';

/** Content type for a mesh format (bounded to the formats the pipeline knows). */
export function modelContentType(format: string): string {
  switch (format) {
    case 'gltf':
      return 'model/gltf+json';
    case 'obj':
      return 'text/plain';
    default:
      return 'model/gltf-binary';
  }
}

/**
 * Download `modelUrl` and upload the bytes to `hero-models/<id>.<ext>`. Returns
 * the permanent public Supabase CDN URL on success, or the original `modelUrl`
 * when Storage is unavailable / the upload fails (so callers never crash).
 */
export async function uploadHeroModel(modelUrl: string, id: string, format: string): Promise<string> {
  if (!supabaseServiceConfigured()) return modelUrl;
  try {
    const download = await fetch(modelUrl);
    if (!download.ok) return modelUrl;
    const bytes = new Uint8Array(await download.arrayBuffer());
    if (bytes.byteLength === 0) return modelUrl;

    const { url, serviceRoleKey } = readSupabaseEnv();
    const ext = format === 'gltf' ? 'gltf' : format === 'obj' ? 'obj' : 'glb';
    const path = `${id}.${ext}`;
    const upload = await fetch(`${url}/storage/v1/object/${HERO_MODELS_BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        'Content-Type': modelContentType(format),
        'x-upsert': 'true',
      },
      body: bytes as unknown as BodyInit,
    });
    if (!upload.ok) return modelUrl;
    return `${url}/storage/v1/object/public/${HERO_MODELS_BUCKET}/${path}`;
  } catch {
    return modelUrl;
  }
}
