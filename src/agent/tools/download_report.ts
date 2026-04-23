import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { request } from 'undici';
import { z } from 'zod';
import * as XLSX from 'xlsx';
import type { ClientRecord } from '../../auth/clients.js';
import { logger } from '../../observability/logger.js';

// Authority boundary: GET-only fetch of Nelson report endpoints that return
// binary files (XLSX / CSV / PDF / JSON). Same auth model as nelson_api — the
// asking user's fresh IdToken, so Nelson's RBAC applies. Agent cannot override
// base URL or token.

export const DownloadReportInputSchema = z.object({
  path: z.string().regex(/^\/api\//, 'path must start with /api/'),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  // Max rows to include in the inline preview. The file is always fully
  // downloaded to disk; this only limits what's returned to the agent.
  max_preview_rows: z.number().int().positive().max(200).default(20),
});
export type DownloadReportInput = z.infer<typeof DownloadReportInputSchema>;

export interface DownloadReportContext {
  client: ClientRecord;
  idToken: string;
  slackUserId: string;
}

export interface ReportSheetSummary {
  name: string;
  rowCount: number;
  columnNames: string[];
  sampleRows: Record<string, unknown>[];
}

export interface DownloadReportResult {
  status: number;
  contentType: string | undefined;
  sizeBytes: number;
  filename: string;
  filePath: string;
  durationMs: number;
  format: 'xlsx' | 'csv' | 'json' | 'pdf' | 'other';
  // Populated when the file format is parseable.
  sheets?: ReportSheetSummary[];
  jsonPreview?: unknown;
}

const MAX_BYTES = 25 * 1024 * 1024; // 25MB — guards against unbounded downloads

function filenameFromContentDisposition(header: string | undefined, fallback: string): string {
  if (!header) return fallback;
  const match = header.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return match?.[1] ? decodeURIComponent(match[1]) : fallback;
}

function inferFormat(contentType: string | undefined, filename: string): DownloadReportResult['format'] {
  const ct = (contentType ?? '').toLowerCase();
  const name = filename.toLowerCase();
  if (ct.includes('spreadsheet') || name.endsWith('.xlsx') || name.endsWith('.xls')) return 'xlsx';
  if (ct.includes('csv') || name.endsWith('.csv')) return 'csv';
  if (ct.includes('json') || name.endsWith('.json')) return 'json';
  if (ct.includes('pdf') || name.endsWith('.pdf')) return 'pdf';
  return 'other';
}

function summariseWorkbook(
  buffer: Buffer,
  sampleRows: number,
  parseCsv = false,
): ReportSheetSummary[] {
  const wb = parseCsv
    ? XLSX.read(buffer.toString('utf-8'), { type: 'string' })
    : XLSX.read(buffer, { type: 'buffer' });
  return wb.SheetNames.map((name) => {
    const sheet = wb.Sheets[name];
    if (!sheet) return { name, rowCount: 0, columnNames: [], sampleRows: [] };
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
    const columnNames = rows.length > 0 ? Object.keys(rows[0]!) : [];
    return {
      name,
      rowCount: rows.length,
      columnNames,
      sampleRows: rows.slice(0, sampleRows),
    };
  });
}

export async function downloadReport(
  ctx: DownloadReportContext,
  input: DownloadReportInput,
): Promise<DownloadReportResult> {
  const parsed = DownloadReportInputSchema.parse(input);
  const url = new URL(parsed.path, ctx.client.nelsonApiBaseUrl);
  if (parsed.query) {
    for (const [k, v] of Object.entries(parsed.query)) url.searchParams.set(k, String(v));
  }
  const startedAt = Date.now();
  const res = await request(url.toString(), {
    method: 'GET',
    headers: {
      authorization: `Bearer ${ctx.idToken}`,
      accept: '*/*',
    },
  });

  const buf = Buffer.from(await res.body.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) {
    throw new Error(`download_report: response too large (${buf.byteLength} bytes, max ${MAX_BYTES})`);
  }

  const contentType = typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : undefined;
  const disposition = typeof res.headers['content-disposition'] === 'string' ? res.headers['content-disposition'] : undefined;
  const fallbackName = path.basename(parsed.path) + suffixFromContentType(contentType);
  const filename = filenameFromContentDisposition(disposition, fallbackName);

  const dir = path.join(os.tmpdir(), 'nelson-reports', randomUUID());
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  await writeFile(filePath, buf);

  const format = inferFormat(contentType, filename);
  const result: DownloadReportResult = {
    status: res.statusCode,
    contentType,
    sizeBytes: buf.byteLength,
    filename,
    filePath,
    durationMs: Date.now() - startedAt,
    format,
  };

  try {
    if (format === 'xlsx') result.sheets = summariseWorkbook(buf, parsed.max_preview_rows);
    else if (format === 'csv') result.sheets = summariseWorkbook(buf, parsed.max_preview_rows, true);
    else if (format === 'json') {
      const text = buf.toString('utf-8');
      result.jsonPreview = JSON.parse(text);
    }
  } catch (err) {
    logger.warn({ err, filename, format }, 'download_report: failed to parse preview — returning metadata only');
  }

  logger.info(
    { slackUserId: ctx.slackUserId, path: parsed.path, status: res.statusCode, sizeBytes: buf.byteLength, format, filename },
    'download_report',
  );
  return result;
}

function suffixFromContentType(ct: string | undefined): string {
  const s = (ct ?? '').toLowerCase();
  if (s.includes('spreadsheet')) return '.xlsx';
  if (s.includes('csv')) return '.csv';
  if (s.includes('pdf')) return '.pdf';
  if (s.includes('json')) return '.json';
  return '';
}
