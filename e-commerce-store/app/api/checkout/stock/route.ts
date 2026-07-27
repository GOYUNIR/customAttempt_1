import { NextResponse } from 'next/server';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-01-27.acacia' as any,
});

export async function GET() {
  try {
    // 1. Ask Stripe directly for the real-time status of all price tokens
    const prices = await stripe.prices.list({ limit: 20 });
    const availabilityMap: Record<string, boolean> = {};

    prices.data.forEach((price) => {
      // 2. Stripe automatically reports "active: false" if an item sells out or is toggled off
      // We map the unique Price ID token directly to its active status flag
      availabilityMap[price.id] = price.active === true;
    });

    return NextResponse.json({ activePriceMap: availabilityMap });
  } catch (err: any) {
    console.error("Stripe Automation Fetch Error:", err.message);
    return NextResponse.json({ activePriceMap: {}, error: err.message });
  }
}
