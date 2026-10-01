import { merchantSession, merchantJson, auditMerchant } from '@/lib/merchant-session';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { parseExportRequest, csvRows } from '@/lib/export-format';
import { exportPage, exportPageRows, EXPORT_COLUMNS } from '@/lib/merchant-export';

export const dynamic = 'force-dynamic';

/**
 * Export THIS store's products, orders (with lines) or customers (with
 * marketing consent), as CSV or JSON, one page per call
 * (?dataset=&format=&page=). The dashboard fetches the pages and builds the
 * file. OWNER ONLY: it is the store's whole customer list. Rate-limited;
 * the start of every export is audited.
 */
export async function GET(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  if (gate.session.role !== 'owner') return merchantJson({ error: 'Only the store owner can export the store\'s data.' }, 403);
  const limited = await rateLimitedResponse('merchant_export', request, 120, 60);
  if (limited) return limited;
  const req = parseExportRequest(new URL(request.url).searchParams);
  if (!req.ok) return merchantJson({ error: req.error }, 400);
  const size = await exportPageRows();
  const { rows, more, nested } = await exportPage(gate.session.tenantId, req.dataset, req.page, size);
  if (req.page === 0) await auditMerchant(gate.session, request, 'DATA_EXPORTED', req.dataset + ' as ' + req.format);
  const columns = EXPORT_COLUMNS[req.dataset];
  return merchantJson({
    dataset: req.dataset, format: req.format, page: req.page, more, count: rows.length, columns,
    ...(req.format === 'csv' ? { csv: csvRows(columns, rows, req.page === 0) } : { rows: nested || rows }),
  });
}
