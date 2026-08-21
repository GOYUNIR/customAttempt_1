import { NextResponse } from 'next/server';
import { resolveStripeClient } from '@/services/payment/factory';

export async function GET() {
  try {
    const stripe = await resolveStripeClient();
    if (!stripe) {
      return NextResponse.json({
        activePriceMap: {},
        message: 'Stripe is not configured. Availability status is unavailable.',
      });
    }

    const prices = await stripe.prices.list({ limit: 20 });
    const availabilityMap: Record<string, boolean> = {};

    prices.data.forEach((price) => {
      availabilityMap[price.id] = price.active === true;
    });

    return NextResponse.json({ activePriceMap: availabilityMap });
  } catch (error: unknown) {
    console.error('Stripe Automation Fetch Error:', error instanceof Error ? error.message : error);
    return NextResponse.json({ activePriceMap: {}, error: 'Availability status is unavailable.' });
  }
}
