import { describe, it, expect, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as XLSX from 'xlsx';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { downloadReport, DownloadReportInputSchema } from '../src/agent/tools/download_report.js';
import type { ClientRecord } from '../src/auth/clients.js';

const cleanup: string[] = [];
afterAll(async () => {
  for (const dir of cleanup) await rm(path.dirname(dir), { recursive: true, force: true });
});

function tenant(baseUrl: string): ClientRecord {
  return {
    tenantId: 't',
    nelsonApiBaseUrl: baseUrl,
  } as unknown as ClientRecord;
}

function makeXlsxBuffer(rows: Record<string, unknown>[]): Buffer {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('DownloadReportInputSchema', () => {
  it('requires path starting with /api/', () => {
    expect(() => DownloadReportInputSchema.parse({ path: '/admin/x' })).toThrow();
    expect(DownloadReportInputSchema.parse({ path: '/api/reports/x' }).path).toBe('/api/reports/x');
  });

  it('caps max_preview_rows at 200 and defaults to 20', () => {
    expect(DownloadReportInputSchema.parse({ path: '/api/x' }).max_preview_rows).toBe(20);
    expect(() => DownloadReportInputSchema.parse({ path: '/api/x', max_preview_rows: 500 })).toThrow();
  });
});

describe('downloadReport over a local HTTP server', () => {
  it('fetches XLSX, persists the file, returns a per-sheet preview', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `row ${i + 1}`, amount: (i + 1) * 100 }));
    const xlsxBuf = makeXlsxBuffer(rows);
    const server = createServer((req, res) => {
      expect(req.headers.authorization).toBe('Bearer fake-token');
      res.writeHead(200, {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': 'attachment; filename="sales-forecast-daily-2026-05-01.xlsx"',
      });
      res.end(xlsxBuf);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const result = await downloadReport(
        { client: tenant(`http://127.0.0.1:${port}`), idToken: 'fake-token', slackUserId: 'U1' },
        { path: '/api/reports/sales-forecast-daily', max_preview_rows: 5 },
      );

      expect(result.status).toBe(200);
      expect(result.format).toBe('xlsx');
      expect(result.filename).toBe('sales-forecast-daily-2026-05-01.xlsx');
      expect(result.sheets).toHaveLength(1);
      expect(result.sheets?.[0]!.rowCount).toBe(30);
      expect(result.sheets?.[0]!.sampleRows).toHaveLength(5);
      expect(result.sheets?.[0]!.columnNames).toEqual(['id', 'name', 'amount']);
      cleanup.push(result.filePath);
      const onDisk = await readFile(result.filePath);
      expect(onDisk.byteLength).toBe(xlsxBuf.byteLength);
    } finally {
      server.close();
    }
  });

  it('fetches CSV with a preview slice', async () => {
    const csv = 'id,name\n1,alice\n2,bob\n3,carol\n';
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/csv' });
      res.end(csv);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const result = await downloadReport(
        { client: tenant(`http://127.0.0.1:${port}`), idToken: 't', slackUserId: 'U1' },
        { path: '/api/reports/members.csv' },
      );
      expect(result.format).toBe('csv');
      expect(result.sheets?.[0]!.rowCount).toBe(3);
      cleanup.push(result.filePath);
    } finally {
      server.close();
    }
  });

  it('returns jsonPreview for JSON endpoints', async () => {
    const payload = { total: 42, items: [{ id: 1 }, { id: 2 }] };
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const result = await downloadReport(
        { client: tenant(`http://127.0.0.1:${port}`), idToken: 't', slackUserId: 'U1' },
        { path: '/api/reports/summary.json' },
      );
      expect(result.format).toBe('json');
      expect(result.jsonPreview).toEqual(payload);
      cleanup.push(result.filePath);
    } finally {
      server.close();
    }
  });

  it('returns metadata only for PDF (no parser yet)', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(Buffer.from('%PDF-1.4 fake content'));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const result = await downloadReport(
        { client: tenant(`http://127.0.0.1:${port}`), idToken: 't', slackUserId: 'U1' },
        { path: '/api/invoices/1/pdf' },
      );
      expect(result.format).toBe('pdf');
      expect(result.sheets).toBeUndefined();
      expect(result.jsonPreview).toBeUndefined();
      expect(result.sizeBytes).toBeGreaterThan(0);
      cleanup.push(result.filePath);
    } finally {
      server.close();
    }
  });
});
