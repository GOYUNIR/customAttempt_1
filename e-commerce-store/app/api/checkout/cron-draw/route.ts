import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import Stripe from 'stripe';
import { GOYUNIR_STORE_SUITE } from '../../../../goyunir.config';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-01-27.acacia' as any,
});

// Connected cleanly to your Upstash cloud cluster memory cache
const redis = Redis.fromEnv();

export async function GET(request: Request) {
  // SECURITY HANDSHAKE: Validates that incoming triggers match your specific Vercel configuration string
  const authHeader = request.headers.get('authorization');
  const targetSecret = `Bearer ${process.env.CRON_SECRET}`;

  if (!authHeader || authHeader !== targetSecret) {
    return NextResponse.json({ error: "Unauthorized background clock execution." }, { status: 401 });
  }

  try {
    console.log("🚀 Starting background automated lottery drawing...");
    const resultsSummary: any[] = [];

    for (const prod of GOYUNIR_STORE_SUITE.productCatalog) {
      for (const size of ['50ml', '100ml']) {
        const poolKey = `drop_pool:${prod.name}:${size}`;
        const totalEntries = await redis.llen(poolKey);

        if (totalEntries === 0) continue;

        const allRegistrations = await redis.lrange(poolKey, 0, -1);
        const parsedPool = allRegistrations.map((entry: any) => typeof entry === 'string' ? JSON.parse(entry) : entry);

        // Fisher-Yates Random Lottery Selection Math Loop
        for (let i = parsedPool.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [parsedPool[i], parsedPool[j]] = [parsedPool[j], parsedPool[i]];
        }

        const targetLimit = size === '100ml' ? 5 : 10;
        const winnersCount = Math.min(targetLimit, parsedPool.length);
        const chosenWinners = parsedPool.slice(0, winnersCount);

        const targetStripeId = size === '100ml' ? prod.stripeId100ml : prod.stripeId50ml;

        for (const winner of chosenWinners) {
          const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: winner.email,
            line_items: [{ price: targetStripeId, quantity: 1 }],
            mode: 'payment',
            allow_promotion_codes: true,
            expires_at: Math.floor(Date.now() / 1000) + 1800, // 30-Minute expiration
            success_url: `${process.env.NEXT_PUBLIC_URL}/?session=success`,
            cancel_url: `${process.env.NEXT_PUBLIC_URL}/?session=cancel`,
          });

          // Output logs directly to your secure Vercel production logs dashboard!
          console.log(`✉️ WINNING TICKET DISPATCHED -> Email: ${winner.email} | Link: ${session.url}`);
          resultsSummary.push({ email: winner.email, scent: prod.name, size, checkout: session.url });
        }

        // Clean cache so your site is ready for the next release drop
        await redis.del(poolKey);
      }
    }

    return NextResponse.json({ success: true, processedWinners: resultsSummary });
  } catch (err: any) {
    console.error("❌ Background Cron Logic Failure:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
