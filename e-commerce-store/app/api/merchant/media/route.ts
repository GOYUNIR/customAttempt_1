import { merchantSession, merchantJson, auditMerchant } from '@/lib/merchant-session';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { writeMediaObject } from '@/lib/media-r2';
import { sniffImage, MAX_PRODUCT_PHOTO_BYTES } from '@/lib/image-sniff';
import { merchantPhotoPrefix } from '@/lib/merchant-product-input';

export const dynamic = 'force-dynamic';

/**
 * Upload one product photo for THIS store (multipart field "file").
 *
 * The file comes through this server, never straight to storage, so it is
 * checked before anything is kept: an image by its own bytes (not its name or
 * claimed type), at most 8 MB. The server picks the key, under this store's
 * own prefix (tenants/<id>/products/…), so a store cannot write, overwrite or
 * name anything outside its own folder. Returns the public URL to put in the
 * product's photos; products accept only their own store's uploads.
 */
export async function POST(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  const limited = await rateLimitedResponse('merchant_media', request, 30, 60);
  if (limited) return limited;
  const base = String(process.env.MEDIA_S3_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base) return merchantJson({ error: 'Photo uploads are not available right now.' }, 503);

  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') return merchantJson({ error: 'Choose a photo to upload.' }, 400);
  if (file.size > MAX_PRODUCT_PHOTO_BYTES) return merchantJson({ error: 'That photo is over 8 MB. Use a smaller one.' }, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) return merchantJson({ error: 'That file is not a JPEG, PNG, WebP or AVIF photo.' }, 415);

  const tenantId = gate.session.tenantId;
  const key = merchantPhotoPrefix(tenantId) + crypto.randomUUID().replace(/-/g, '') + '.' + kind.ext;
  if (!(await writeMediaObject(key, bytes, kind.contentType))) {
    console.error('[merchant/media] write failed for ' + tenantId);
    return merchantJson({ error: 'The photo could not be saved. Try again.' }, 502);
  }
  await auditMerchant(gate.session, request, 'PHOTO_UPLOADED', key + ' (' + bytes.length + ' bytes)');
  return merchantJson({ url: base + '/' + key }, 201);
}
