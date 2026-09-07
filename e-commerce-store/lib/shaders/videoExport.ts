// Hero WebGL → video capture + the mobile / low-power video-fallback heuristic.
//
// This module is BROWSER-ONLY (MediaRecorder / HTMLCanvasElement / matchMedia)
// but remains importable from `node --test` because every DOM access is
// guarded by `typeof window !== 'undefined'` / `typeof document !== 'undefined'`.
// The actual clip storage + admin UI live in the `aiHero.clips` config array
// (see `lib/shaders/presets.ts`), so no new Redis keys are introduced.

export interface HeroVideoCapture {
  dataUrl: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  durationMs: number;
}

/** Whether the browser can record a canvas stream at all. */
export function mediaRecorderSupported(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof MediaRecorder !== 'undefined' &&
      typeof HTMLCanvasElement !== 'undefined' &&
      'captureStream' in HTMLCanvasElement.prototype
    );
  } catch {
    return false;
  }
}

/** Pick the best supported container/codec (WebM preferred, MP4 fallback). */
export function pickSupportedMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return '';
}

/** Mobile viewport heuristic (smallest screen dimension ≤ 768px). */
export function isMobileViewport(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    return (
      window.matchMedia('(max-width: 768px)').matches ||
      Math.min(window.innerWidth || Infinity, window.innerHeight || Infinity) <= 768
    );
  } catch {
    return false;
  }
}

/** Low-power GPU heuristic (mirrors `HeroShaderCanvas.isLowPower`). */
export function isLowPowerDevice(): boolean {
  try {
    if (typeof navigator === 'undefined') return false;
    const cores = Number((navigator as any)?.hardwareConcurrency);
    return Number.isFinite(cores) && cores > 0 && cores <= 1;
  } catch {
    return false;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Record a short looping clip of a canvas. Defaults to ~3s of WebM — long
 * enough for a seamless loop without shipping a huge data URL. Returns null
 * when the browser can't record (so the admin can show a clear message).
 */
export async function recordCanvasVideo(
  canvas: HTMLCanvasElement,
  opts: { durationMs?: number; mimeType?: string } = {},
): Promise<HeroVideoCapture | null> {
  if (typeof window === 'undefined' || !canvas) return null;
  if (!mediaRecorderSupported()) return null;

  const durationMs = Math.max(500, Math.min(10_000, opts.durationMs || 3000));
  const mime = opts.mimeType || pickSupportedMime();
  if (!mime) return null;

  const fps = 30;
  let stream: MediaStream;
  try {
    stream = (canvas as any).captureStream(fps);
  } catch {
    return null;
  }

  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 });
  const done = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime.split(';')[0] }));
    recorder.onerror = () => reject(new Error('recording failed'));
  });

  try {
    recorder.start(100);
    await new Promise((r) => setTimeout(r, durationMs));
    if (recorder.state !== 'inactive') recorder.stop();
    const blob = await done;
    // Stop all tracks so the canvas isn't pinned to a hidden stream.
    stream.getTracks().forEach((t) => t.stop());
    const dataUrl = await blobToDataUrl(blob);
    return {
      dataUrl,
      mime: blob.type || mime.split(';')[0] || 'video/webm',
      bytes: blob.size,
      width: canvas.width || canvas.clientWidth || 0,
      height: canvas.height || canvas.clientHeight || 0,
      durationMs,
    };
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    return null;
  }
}
