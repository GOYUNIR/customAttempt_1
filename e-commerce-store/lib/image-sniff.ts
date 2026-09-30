/**
 * What an uploaded file REALLY is, from its first bytes. A browser-supplied
 * type or file name proves nothing; these signatures do. Only the photo
 * formats a product page shows are accepted.
 */
export type SniffedImage = { ext: 'jpg' | 'png' | 'webp' | 'avif'; contentType: string };

export const MAX_PRODUCT_PHOTO_BYTES = 8 * 1024 * 1024;

export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  const b = (i: number) => bytes[i];
  const ascii = (from: number, to: number) => String.fromCharCode(...Array.from(bytes.subarray(from, to)));
  if (bytes.length < 12) return null;
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return { ext: 'jpg', contentType: 'image/jpeg' };
  if (b(0) === 0x89 && ascii(1, 4) === 'PNG' && b(4) === 0x0d && b(5) === 0x0a && b(6) === 0x1a && b(7) === 0x0a) return { ext: 'png', contentType: 'image/png' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { ext: 'webp', contentType: 'image/webp' };
  if (ascii(4, 8) === 'ftyp' && /^avi[fs]$/.test(ascii(8, 12))) return { ext: 'avif', contentType: 'image/avif' };
  return null;
}
