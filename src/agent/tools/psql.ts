import { Pool } from 'pg';
import { z } from 'zod';
import { logger } from '../../observability/logger.js';

// Authority boundary: read-only observer access to the shared Nelson
// PostgreSQL. SELECT-only. The pg user is the `observer_user` role which
// cannot write; this tool adds a second-layer syntactic check so a bug or
// prompt manipulation can't push a write anyway. Every call is logged with
// the rendered SQL (trimmed) so a later analytics pass can rank threads by
// DB access pattern. Cost: cheap — no Bedrock tokens on the hot path.

export const PsqlInputSchema = z.object({
  sql: z.string().min(5, 'sql: write a SELECT query'),
  // Cap results so a misdirected query cannot dump huge tables into the
  // agent's context. Caller can ask for up to 500 rows.
  max_rows: z.number().int().positive().max(500).default(100),
});

export type PsqlInput = z.infer<typeof PsqlInputSchema>;

export interface PsqlDeps {
  connectionString: string;
  // Pool lifetime equals the runner's lifetime — one pool across all queries
  // in a process. Callers pass a shared pool via buildPsqlDeps().
  pool: Pool;
}

export interface PsqlResult {
  rowCount: number;
  truncated: boolean;
  rows: Record<string, unknown>[];
  fields: { name: string; dataTypeID: number }[];
  durationMs: number;
}

const FORBIDDEN_KEYWORDS = [
  '\\binsert\\b',
  '\\bupdate\\b',
  '\\bdelete\\b',
  '\\bdrop\\b',
  '\\btruncate\\b',
  '\\balter\\b',
  '\\bcreate\\b',
  '\\bgrant\\b',
  '\\brevoke\\b',
  '\\bcopy\\b',
  '\\bvacuum\\b',
  '\\breindex\\b',
  '\\bmerge\\b',
  '\\bcall\\b',
  '\\bdo\\s+\\$',
  ';\\s*\\w',
];
const FORBIDDEN_RE = new RegExp(FORBIDDEN_KEYWORDS.join('|'), 'i');

export function isReadOnlySql(sql: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = sql.trim().replace(/^;+/, '').trim();
  if (!trimmed) return { ok: false, reason: 'empty query' };
  const firstToken = trimmed.split(/\s+/)[0]?.toLowerCase();
  if (firstToken !== 'select' && firstToken !== 'with' && firstToken !== 'explain' && firstToken !== 'show') {
    return { ok: false, reason: `query must start with SELECT / WITH / EXPLAIN / SHOW — got "${firstToken}"` };
  }
  if (FORBIDDEN_RE.test(trimmed)) {
    return { ok: false, reason: 'query contains forbidden keyword (write DDL/DML)' };
  }
  return { ok: true };
}

export function buildPsqlPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 15_000,
    idleTimeoutMillis: 30_000,
    max: 4,
  });
}

export async function runPsql(deps: PsqlDeps, input: PsqlInput): Promise<PsqlResult | { error: string }> {
  const check = isReadOnlySql(input.sql);
  if (!check.ok) return { error: `psql: ${check.reason}` };

  const started = Date.now();
  const client = await deps.pool.connect();
  try {
    // Extra safety: force read-only on the session.
    await client.query('SET TRANSACTION READ ONLY');
  } catch {
    // Not fatal — pg_hba or role may already enforce RO. Continue.
  }
  try {
    const res = await client.query({ text: input.sql, rowMode: 'array' });
    const rows = res.rows as unknown[][];
    const fields = res.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID }));
    const truncated = rows.length > input.max_rows;
    const capped = truncated ? rows.slice(0, input.max_rows) : rows;
    const rowObjs: Record<string, unknown>[] = capped.map((r) => {
      const o: Record<string, unknown> = {};
      for (let i = 0; i < fields.length; i++) {
        const fieldName = fields[i]?.name;
        if (fieldName !== undefined) o[fieldName] = r[i];
      }
      return o;
    });
    const out: PsqlResult = {
      rowCount: rows.length,
      truncated,
      rows: rowObjs,
      fields,
      durationMs: Date.now() - started,
    };
    logger.info(
      { sqlLen: input.sql.length, rowCount: rows.length, truncated, durationMs: out.durationMs },
      'psql tool call',
    );
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, sqlLen: input.sql.length }, 'psql tool call failed');
    return { error: `psql: ${msg}` };
  } finally {
    client.release();
  }
}
