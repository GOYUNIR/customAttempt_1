import { NextResponse } from 'next/server';
import { createStripeClient } from '../../../../lib/server-config';

const stripe = createStripeClient();

export async function GET() {
  try {
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
    const message = error instanceof Error ? error.message : 'Unknown Stripe error';
    console.error('Stripe Automation Fetch Error:', message);
    return NextResponse.json({ activePriceMap: {}, error: message });
  }
}
