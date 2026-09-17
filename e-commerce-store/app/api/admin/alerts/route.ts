import { NextResponse } from 'next/server';
import { createKvClient, loadProducts } from '@/lib/server-config';
import { adminAuthorized } from '@/lib/admin-verify';
import { sendReleaseAnnouncementEmail } from '@/lib/email';
import { listSubscribers, removeSubscriber, markNotified } from '@/lib/alert-subscribers';
import { ensureDefaultTenant } from '@/lib/tenant-context';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const password = String(url.searchParams.get('password') || '');
  if (!(await adminAuthorized(request, password))) return NextResponse.json({ error: 'Invalid password' }, { status: 403 });

  // H8: read from public.alert_subscribers (00023). The list arrives already
  // sorted newest-activity-first from the index, so there is no in-memory sort
  // of a string date to get wrong.
  const tenantId = await ensureDefaultTenant();
  const subscribers = await listSubscribers(tenantId);

  return NextResponse.json({
    // The UI reads `notifications`, so the field keeps that name on the wire
    // even though the column is `notified_slugs`. Renaming the API shape is a
    // separate change from moving the storage.
    subscribers: subscribers.map((s) => ({
      email: s.email,
      status: s.status,
      sources: s.sources,
      interests: s.interests,
      notifications: s.notifiedSlugs,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    })),
    activeCount: subscribers.filter((item) => item.status !== 'unsubscribed').length,
  });
}

export async function POST(request: Request) {
  const redis = createKvClient();
  if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

  const body = await request.json();
  const password = String(body?.password || '');
  if (!(await adminAuthorized(request, password))) return NextResponse.json({ error: 'Invalid password' }, { status: 403 });

  const action = String(body?.action || '');
  const tenantId = await ensureDefaultTenant();

  if (action === 'remove') {
    const email = String(body?.email || '').trim().toLowerCase();
    if (!email) return NextResponse.json({ error: 'Email required' }, { status: 400 });
    const removed = await removeSubscriber(tenantId, email);
    if (!removed) return NextResponse.json({ error: 'Could not remove that subscriber.' }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  if (action === 'notifyProduct') {
    const productId = String(body?.productId || '').trim();
    if (!productId) return NextResponse.json({ error: 'productId required' }, { status: 400 });

    const products = Object.values(await loadProducts(redis));
    const product = (products as any[]).find((item) => String(item.id) === productId);
    if (!product) return NextResponse.json({ error: 'Product not found' }, { status: 404 });

    const slug = String(product.slug || product.id);
    const subscribers = await listSubscribers(tenantId);
    let sent = 0;
    let skipped = 0;

    for (const subscriber of subscribers) {
      if (subscriber.status === 'unsubscribed') {
        skipped++;
        continue;
      }
      // Already told about this product — the whole point of notifiedSlugs.
      if (subscriber.notifiedSlugs[slug]) {
        skipped++;
        continue;
      }
      const result = await sendReleaseAnnouncementEmail({
        to: subscriber.email,
        productName: String(product.name || 'New release'),
        slug,
        tagline: String(product.tagline || ''),
      });
      if (result.ok || result.skipped) {
        // Marked only AFTER the send resolved. Writing it first would suppress
        // a retry of an announcement that never actually went out.
        await markNotified(tenantId, subscriber, slug);
        if (result.ok) sent++;
      } else {
        skipped++;
      }
    }

    return NextResponse.json({ success: true, sent, skipped });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}