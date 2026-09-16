/**
 * In-memory PostgREST stand-in for round-trip verification (Phase G).
 *
 * Enough of PostgREST to exercise the real write and read paths: upsert via
 * POST + on_conflict, filtered GET with eq/in, select projection, limit and
 * order. Not a database — a fixture that behaves like one for the handful of
 * query shapes lib/catalog-write.ts and lib/postgres-catalog-read.ts emit.
 *
 * Used by scripts/verify-catalog-roundtrip.ts. Deliberately separate so the
 * verification reads as a test, not as plumbing.
 */
import { createServer, type Server } from 'node:http';

type Row = Record<string, unknown>;

export interface FakeDb {
  server: Server;
  port: number;
  tables: Record<string, Row[]>;
  requests: Array<{ method: string; url: string }>;
  close(): void;
}

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${String(idCounter).padStart(12, '0')}`;
}

/** Decode one `col=op.value` filter into a predicate. */
function parseFilter(key: string, raw: string): (row: Row) => boolean {
  const dot = raw.indexOf('.');
  const op = raw.slice(0, dot);
  let value = decodeURIComponent(raw.slice(dot + 1));
  const unquote = (v: string) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

  if (op === 'in') {
    const inner = value.replace(/^\(|\)$/g, '');
    const wanted = inner ? inner.split(',').map((v) => unquote(decodeURIComponent(v))) : [];
    return (row) => wanted.includes(String(row[key]));
  }
  if (op === 'is') return (row) => (value === 'null' ? row[key] == null : String(row[key]) === value);
  value = unquote(value);
  switch (op) {
    case 'eq':
      return (row) => {
        const cell = row[key];
        if (typeof cell === 'boolean') return String(cell) === value;
        if (typeof cell === 'number') return String(cell) === value;
        return String(cell ?? '') === value;
      };
    case 'neq': return (row) => String(row[key] ?? '') !== value;
    case 'gte': return (row) => String(row[key] ?? '') >= value;
    case 'lte': return (row) => String(row[key] ?? '') <= value;
    case 'gt': return (row) => String(row[key] ?? '') > value;
    case 'lt': return (row) => String(row[key] ?? '') < value;
    default: return () => true;
  }
}

/** Apply a PostgREST select list, including one level of embedded relation. */
function project(row: Row, select: string | null, tables: Record<string, Row[]>): Row {
  if (!select || select === '*') return { ...row };
  const out: Row = {};
  // Split on commas that are not inside parentheses.
  const parts: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of select) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf) parts.push(buf);

  for (const part of parts) {
    const embed = part.match(/^([a-z_]+)\((.*)\)$/);
    if (embed) {
      const [, relation, inner] = embed;
      // products(name) from a variant row → look up by product_id.
      const parent = (tables[relation] || []).find((r) => r.id === row.product_id);
      out[relation] = parent ? project(parent, inner, tables) : null;
      continue;
    }
    out[part] = row[part];
  }
  return out;
}

export async function startFakePostgrest(preferredPort = 0): Promise<FakeDb> {
  const tables: Record<string, Row[]> = {};
  const requests: Array<{ method: string; url: string }> = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const url = req.url || '';
      requests.push({ method: req.method || '', url });
      const afterPrefix = url.split('/rest/v1/')[1] || '';
      const [tableName, queryString = ''] = afterPrefix.split('?');
      const table = decodeURIComponent(tableName);
      tables[table] = tables[table] || [];
      const params = new URLSearchParams(queryString);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;

      const respond = (payload: unknown, status = 200) =>
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));

      if (req.method === 'POST') {
        const incoming: Row[] = Array.isArray(body) ? body : [body];
        const onConflict = (params.get('on_conflict') || '').split(',').map((c) => c.trim()).filter(Boolean);
        const written: Row[] = [];
        for (const row of incoming) {
          let existing: Row | undefined;
          if (onConflict.length > 0) {
            existing = tables[table].find((r) => onConflict.every((c) => String(r[c]) === String(row[c])));
          }
          if (existing) {
            Object.assign(existing, row);
            written.push(existing);
          } else {
            const created = { id: newId(), ...row };
            tables[table].push(created);
            written.push(created);
          }
        }
        return respond(written);
      }

      // Filters are every param that is not a PostgREST keyword.
      const reserved = new Set(['select', 'limit', 'offset', 'order', 'on_conflict']);
      let rows = tables[table].filter((row) =>
        [...params.entries()].every(([k, v]) => (reserved.has(k) ? true : parseFilter(k, v)(row))),
      );

      const order = params.get('order');
      if (order) {
        const [col, dir] = order.split('.');
        rows = [...rows].sort((a, b) => {
          const av = String(a[col] ?? '');
          const bv = String(b[col] ?? '');
          return dir === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv);
        });
      }
      const limit = params.get('limit');
      if (limit) rows = rows.slice(0, Number(limit));

      if (req.method === 'PATCH') {
        for (const row of rows) Object.assign(row, body);
        return respond(rows);
      }
      if (req.method === 'DELETE') {
        tables[table] = tables[table].filter((r) => !rows.includes(r));
        return respond([]);
      }
      return respond(rows.map((r) => project(r, params.get('select'), tables)));
    });
  });

  await new Promise<void>((r) => server.listen(preferredPort, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { server, port, tables, requests, close: () => server.close() };
}
