import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  downloadSlackAttachments,
  extractSlackFilesFromMessage,
  type SlackFile,
  type LocalAttachment,
} from '../src/slack/attachments.js';
import { readAttachment } from '../src/agent/tools/read_attachment.js';
import * as XLSX from 'xlsx';

describe('extractSlackFilesFromMessage', () => {
  it('returns [] when files is missing or wrong shape', () => {
    expect(extractSlackFilesFromMessage(null)).toEqual([]);
    expect(extractSlackFilesFromMessage({})).toEqual([]);
    expect(extractSlackFilesFromMessage({ files: 'not-an-array' })).toEqual([]);
  });

  it('keeps only entries matching the SlackFile schema', () => {
    const raw = {
      files: [
        { id: 'F1', name: 'a.png', mimetype: 'image/png', url_private_download: 'https://slack.com/f/F1' },
        { id: 'F2' }, // missing url_private_download
        { id: 'F3', name: 'b.pdf', mimetype: 'application/pdf', url_private_download: 'https://slack.com/f/F3' },
      ],
    };
    const out = extractSlackFilesFromMessage(raw);
    expect(out.map((f) => f.id)).toEqual(['F1', 'F3']);
  });
});

describe('downloadSlackAttachments', () => {
  it('downloads files, caps at 3, enforces bearer auth', async () => {
    let seenAuth = '';
    const server = createServer((req, res) => {
      seenAuth = String(req.headers.authorization ?? '');
      res.writeHead(200, { 'content-type': 'image/png' });
      // minimal PNG header so the byte count > 0
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    const files: SlackFile[] = Array.from({ length: 5 }).map((_, i) => ({
      id: `F${i}`,
      name: `x${i}.png`,
      mimetype: 'image/png',
      url_private_download: `http://127.0.0.1:${port}/f/F${i}`,
    }));

    try {
      const out = await downloadSlackAttachments({ files, botToken: 'xoxb-fake' });
      expect(out.length).toBe(3); // capped
      expect(seenAuth).toBe('Bearer xoxb-fake');
      for (const a of out) {
        expect(a.sizeBytes).toBe(8);
        expect(a.filePath.endsWith('.png')).toBe(true);
      }
    } finally {
      server.close();
    }
  });

  it('follows 302 redirects from Slack CDN', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/f/F1') {
        // simulate Slack's url_private_download → pre-signed CDN URL redirect
        res.writeHead(302, { location: `http://127.0.0.1:${(server.address() as AddressInfo).port}/cdn/F1` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from([10, 20, 30, 40, 50]));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    const files: SlackFile[] = [
      { id: 'F1', name: 'redirected.png', mimetype: 'image/png', url_private_download: `http://127.0.0.1:${port}/f/F1` },
    ];

    try {
      const out = await downloadSlackAttachments({ files, botToken: 'xoxb-fake' });
      expect(out).toHaveLength(1);
      expect(out[0]!.sizeBytes).toBe(5);
    } finally {
      server.close();
    }
  });

  it('skips files that 404 but keeps others', async () => {
    const server = createServer((req, res) => {
      if (req.url?.includes('F2')) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from([1, 2, 3, 4]));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    const files: SlackFile[] = [
      { id: 'F1', name: 'a.png', mimetype: 'image/png', url_private_download: `http://127.0.0.1:${port}/f/F1` },
      { id: 'F2', name: 'b.png', mimetype: 'image/png', url_private_download: `http://127.0.0.1:${port}/f/F2` },
    ];

    try {
      const out = await downloadSlackAttachments({ files, botToken: 'xoxb-fake' });
      expect(out.map((a) => a.fileId)).toEqual(['F1']);
    } finally {
      server.close();
    }
  });
});

describe('readAttachment tool', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'read-attachment-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function makeAtt(fileId: string, name: string, mimetype: string, bytes: Buffer): Promise<LocalAttachment> {
    const filePath = path.join(tmp, name);
    await writeFile(filePath, bytes);
    return { fileId, name, mimetype, sizeBytes: bytes.byteLength, filePath };
  }

  it('returns an image block for image mimetypes', async () => {
    const att = await makeAtt('F1', 'a.png', 'image/png', Buffer.from([1, 2, 3, 4, 5]));
    const map = new Map([[att.fileId, att]]);
    const out = await readAttachment({ attachments: map }, { file_id: 'F1' });
    expect(out.content).toHaveLength(1);
    expect(out.content[0]!.type).toBe('image');
    if (out.content[0]!.type === 'image') {
      expect(out.content[0]!.mimeType).toBe('image/png');
      expect(out.content[0]!.data).toBe(Buffer.from([1, 2, 3, 4, 5]).toString('base64'));
    }
  });

  it('inlines small text files', async () => {
    const att = await makeAtt('F2', 'notes.md', 'text/markdown', Buffer.from('# hello\nworld', 'utf-8'));
    const map = new Map([[att.fileId, att]]);
    const out = await readAttachment({ attachments: map }, { file_id: 'F2' });
    expect(out.content[0]!.type).toBe('text');
    if (out.content[0]!.type === 'text') {
      expect(out.content[0]!.text).toContain('# hello');
    }
  });

  it('parses XLSX into per-sheet JSON with row cap', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ n: i + 1, label: `row-${i + 1}` }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Data');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const att = await makeAtt(
      'F-xlsx',
      'report.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buf,
    );
    const map = new Map([[att.fileId, att]]);
    const out = await readAttachment({ attachments: map }, { file_id: 'F-xlsx' });
    expect(out.content[0]!.type).toBe('text');
    if (out.content[0]!.type === 'text') {
      const text = out.content[0]!.text;
      expect(text).toContain('Sheet "Data" — 60 row(s)');
      expect(text).toContain('First 50 rows (of 60)');
      expect(text).toContain('"label": "row-1"');
      expect(text).not.toContain('row-60'); // past the cap
    }
  });

  it('returns a metadata-only notice for unsupported mimetypes', async () => {
    const att = await makeAtt('F3', 'report.pdf', 'application/pdf', Buffer.from([1, 2, 3]));
    const map = new Map([[att.fileId, att]]);
    const out = await readAttachment({ attachments: map }, { file_id: 'F3' });
    expect(out.content[0]!.type).toBe('text');
    if (out.content[0]!.type === 'text') {
      expect(out.content[0]!.text).toContain('inline reading not supported');
    }
  });

  it('rejects unknown file ids without touching the filesystem', async () => {
    const out = await readAttachment({ attachments: new Map() }, { file_id: 'F-nope' });
    expect(out.content[0]!.type).toBe('text');
    if (out.content[0]!.type === 'text') {
      expect(out.content[0]!.text).toContain('no attachment with file_id=F-nope');
    }
  });
});
