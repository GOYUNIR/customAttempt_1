/**
 * EXPORT FORMAT — the pure half of a store's data export (no imports;
 * tests/export-format.test.ts).
 *
 * CSV cells are quoted when needed, and any cell that a spreadsheet would run
 * as a formula (starting with = + - @, tab or carriage return) is prefixed
 * with an apostrophe. A product name or a customer's address is typed by
 * someone else, so "=HYPERLINK(...)" must arrive as text, not as a formula
 * in the merchant's spreadsheet.
 */
export type ExportDataset = 'products' | 'orders' | 'customers';
export type ExportFormat = 'csv' | 'json';
export const EXPORT_DATASETS: ExportDataset[] = ['products', 'orders', 'customers'];

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function csvRows(columns: string[], rows: Array<Record<string, unknown>>, withHeader: boolean): string {
  const lines = rows.map((r) => columns.map((c) => csvCell(r[c])).join(','));
  return (withHeader ? [columns.join(',')] : []).concat(lines).map((l) => l + '\r\n').join('');
}

export function parseExportRequest(params: URLSearchParams): { ok: true; dataset: ExportDataset; format: ExportFormat; page: number } | { ok: false; error: string } {
  const dataset = String(params.get('dataset') || '') as ExportDataset;
  const format = String(params.get('format') || 'csv') as ExportFormat;
  const page = Number(params.get('page') || 0);
  if (!EXPORT_DATASETS.includes(dataset)) return { ok: false, error: 'Choose products, orders or customers.' };
  if (format !== 'csv' && format !== 'json') return { ok: false, error: 'Choose CSV or JSON.' };
  if (!Number.isInteger(page) || page < 0 || page > 100_000) return { ok: false, error: 'Bad page.' };
  return { ok: true, dataset, format, page };
}

/** Marketing consent as a merchant reads it (NULL is "never asked", not "no"). */
export function consentLabel(optIn: boolean | null | undefined): 'opted_in' | 'declined' | 'never_asked' {
  return optIn === true ? 'opted_in' : optIn === false ? 'declined' : 'never_asked';
}
