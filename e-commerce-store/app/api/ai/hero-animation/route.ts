import { NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { createRedisClient, safeParseRedisItem, PRODUCTS_KEY } from '@/lib/server-config';
import { AiFactory } from '@/services/ai';
import {
  buildAnimationPrompt,
  parseAnimationResult,
  fallbackAnimation,
  type AnimationResult,
} from '@/lib/ai-animation';
import { isImageMedia } from '@/lib/media';
import { aiHeroAnimationKey } from '@/lib/redis-keys';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const HERO_ANIMATION_TTL_SECONDS = 24 * 60 * 60; // 24h

/** Pick the featured product the home-page hero mirrors: the first active,
 *  non-archived, non-upcoming release (same sort used by the storefront), then
 *  the first upcoming, then the first archived, then anything with an image. */
function pickFeatured(products: any[]): any | null {
  const sortFn = (a: any, b: any) =>
    Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || String(a.name || '').localeCompare(String(b.name || ''));
  const live = [...products]
    .filter((p) => p.isActive === true && p.isArchived !== true && p.isUpcoming !== true)
    .sort(sortFn);
  if (live[0]) return live[0];
  const upcoming = [...products]
    .filter((p) => p.isUpcoming === true && p.isArchived !== true)
    .sort(sortFn);
  if (upcoming[0]) return upcoming[0];
  const archived = [...products].filter((p) => p.isArchived === true).sort(sortFn);
  if (archived[0]) return archived[0];
  const anyWithImage = [...products]
    .filter((p) => Array.isArray(p.images) && p.images.some((src: unknown) => isImageMedia(String(src || ''))))
    .sort(sortFn);
  return anyWithImage[0] || products.sort(sortFn)[0] || null;
}

/** First image asset on a product (videos are skipped — hero animation is image-only). */
function coverImageOf(product: any): string {
  const images: unknown[] = Array.isArray(product?.images) ? product.images : [];
  return images.map((src) => String(src || '').trim()).find((src) => isImageMedia(src)) || '';
}

/**
 * GET /api/ai/hero-animation — PUBLIC. Returns the AI-generated hero animation
 * for the featured product's cover image so the home-page hero renders a real
 * AI animation (not the built-in CSS drift preset).
 *
 * Resolution order:
 *   1. Cached result (`cache:ai-hero:<productId>`) keyed by the product + cover
 *      image — regenerated only when the image changes.
 *   2. Live generation through the active `services/ai` driver (image → CSS/SVG
 *      keyframes). Cached for 24h.
 *   3. Built-in fallback preset ONLY when no AI provider is configured or the
 *      call fails (never cached, so it upgrades as soon as a provider appears).
 */
export async function GET(request: Request) {
  const limited = await rateLimitedResponse('ai_hero_animation', request, 60, 60);
  if (limited) return limited;

  const redis = createRedisClient();
  if (!redis) {
    return NextResponse.json({ ok: true, result: fallbackAnimation('drift'), cached: false });
  }

  try {
    const raw = await redis.hgetall(PRODUCTS_KEY);
    const products: any[] = [];
    if (raw) {
      for (const value of Object.values(raw)) {
        const p = safeParseRedisItem<any>(value);
        if (p) products.push(p);
      }
    }
    const featured = pickFeatured(products);
    const image = featured ? coverImageOf(featured) : '';
    if (!featured || !image) {
      return NextResponse.json({ ok: true, result: fallbackAnimation('drift'), cached: false });
    }

    const productId = String(featured.id || 'featured');
    const cacheKey = aiHeroAnimationKey(productId);
    // Fingerprint the cover image so swapping the photo regenerates the motion.
    const imageFingerprint = createHash('sha1').update(image).digest('hex').slice(0, 16);

    const cachedRaw = await redis.get(cacheKey).catch(() => null);
    if (cachedRaw) {
      const cached = safeParseRedisItem<{ imageFingerprint?: string; result?: AnimationResult }>(cachedRaw);
      if (cached && cached.imageFingerprint === imageFingerprint && cached.result) {
        return NextResponse.json({ ok: true, result: cached.result, cached: true, productId });
      }
    }

    const driver = await AiFactory.getDriver();
    let result: AnimationResult;
    if (driver?.configured) {
      const prompt = buildAnimationPrompt({
        assetRef: image,
        prompt: [
          featured.name ? `Product: ${String(featured.name).trim()}` : '',
          featured.tagline ? `Tagline: ${String(featured.tagline).trim()}` : '',
          'Create a subtle, premium, looping hero animation for this product photo.',
        ].filter(Boolean).join('. ') || undefined,
      });
      const completion = await driver.complete(prompt);
      result = completion.ok
        ? parseAnimationResult(completion.text, driver.provider) ?? fallbackAnimation('drift')
        : fallbackAnimation('drift');
      // Only cache a real AI result (never the fallback) so a later provider
      // change can upgrade the hero without an explicit invalidation.
      if (result.source === 'ai') {
        await redis
          .setex(cacheKey, HERO_ANIMATION_TTL_SECONDS, JSON.stringify({ imageFingerprint, result }))
          .catch(() => {});
      }
    } else {
      result = fallbackAnimation('drift');
    }

    return NextResponse.json({ ok: true, result, cached: false, productId });
  } catch (err: any) {
    console.error('[hero-animation] failed', err?.message || err);
    return NextResponse.json({ ok: true, result: fallbackAnimation('drift'), cached: false });
  }
}
