import { NextResponse } from 'next/server';
import { createRedisClient, ARCHIVE_LEDGER_KEY, safeParseRedisItem } from '@/lib/server-config';
import { adminAuthorized } from '@/lib/admin-verify';

export const dynamic = 'force-dynamic';

/** CSV cell sanitation: quote the value AND defuse spreadsheet formula
 *  injection (=, +, -, @, tab, CR) so a customer-supplied email/address can
 *  never execute as a formula in Excel/Sheets when the admin opens the file. */
function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const password = url.searchParams.get('password') || '';
  if (!(await adminAuthorized(request, password))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

  const rows = await redis.lrange(ARCHIVE_LEDGER_KEY, 0, -1);
  const winners = rows
    .map((r) => safeParseRedisItem<any>(r))
    .filter((e) => e && e.type === 'WINNER_CHARGED');

  const header = ['email', 'variant', 'size', 'shippingAddress', 'shippingStatus', 'registeredAt', 'id'];
  const lines = [header.join(',')];
  for (const w of winners) {
    const cols = [
      w.email,
      w.variant,
      w.size,
      w.shippingAddress,
      w.shippingStatus || 'PENDING_FULFILLMENT',
      w.registeredAt,
      w.id,
    ].map(csvCell);
    lines.push(cols.join(','));
  }

  return new NextResponse(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="winners-${Date.now()}.csv"`,
    },
  });
}