import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import * as XLSX from 'xlsx';
import type { LocalAttachment } from '../../slack/attachments.js';
import { logger } from '../../observability/logger.js';

// Authority boundary: the agent can only reference attachments the caller
// already downloaded and bound to THIS job. It names the attachment by its
// Slack file id, the tool looks up the file id in a per-job map, and reads
// from that absolute path. No arbitrary path input — the agent cannot
// escape to other files on the task filesystem.

export const ReadAttachmentInputSchema = z.object({
  file_id: z.string().min(1, 'file_id: pass the Slack file id from the attachments preamble'),
});
export type ReadAttachmentInput = z.infer<typeof ReadAttachmentInputSchema>;

export interface ReadAttachmentContext {
  // fileId → LocalAttachment map for the current job. Built in pipeline.ts
  // after the download step; passed read-only to the tool handler.
  attachments: Map<string, LocalAttachment>;
}

type McpContent =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      data: string;
      mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    };

const IMAGE_MIME = new Set<string>(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const TEXT_MIME = new Set<string>(['text/plain', 'text/csv', 'text/markdown', 'application/json']);
const XLSX_MIME = new Set<string>([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls
]);
const MAX_XLSX_ROWS_PER_SHEET = 50;

export async function readAttachment(
  ctx: ReadAttachmentContext,
  input: ReadAttachmentInput,
): Promise<{ content: McpContent[] }> {
  const parsed = ReadAttachmentInputSchema.parse(input);
  const att = ctx.attachments.get(parsed.file_id);
  if (!att) {
    return {
      content: [{
        type: 'text',
        text: `read_attachment: no attachment with file_id=${parsed.file_id} is bound to this job. Valid ids: ${Array.from(ctx.attachments.keys()).join(', ') || '(none)'}`,
      }],
    };
  }

  if (IMAGE_MIME.has(att.mimetype)) {
    try {
      const buf = await readFile(att.filePath);
      const data = buf.toString('base64');
      logger.info({ fileId: att.fileId, mimetype: att.mimetype, bytes: buf.byteLength }, 'read_attachment: image');
      return {
        content: [
          {
            type: 'image',
            data,
            mimeType: att.mimetype as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
          },
        ],
      };
    } catch (err) {
      logger.warn({ err, fileId: att.fileId }, 'read_attachment: failed to read image');
      return { content: [{ type: 'text', text: `read_attachment: failed to read image ${att.name}: ${(err as Error).message}` }] };
    }
  }

  if (XLSX_MIME.has(att.mimetype)) {
    try {
      const buf = await readFile(att.filePath);
      const wb = XLSX.read(buf, { type: 'buffer' });
      const summary = wb.SheetNames.map((name) => {
        const sheet = wb.Sheets[name];
        if (!sheet) return `Sheet "${name}": empty`;
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
        const cols = rows.length > 0 ? Object.keys(rows[0]!) : [];
        const preview = rows.slice(0, MAX_XLSX_ROWS_PER_SHEET);
        return [
          `Sheet "${name}" — ${rows.length} row(s), columns: [${cols.join(', ')}]`,
          rows.length > MAX_XLSX_ROWS_PER_SHEET
            ? `First ${MAX_XLSX_ROWS_PER_SHEET} rows (of ${rows.length}):`
            : `Rows:`,
          JSON.stringify(preview, null, 2),
        ].join('\n');
      }).join('\n\n');
      logger.info({ fileId: att.fileId, sheets: wb.SheetNames.length }, 'read_attachment: xlsx');
      return {
        content: [{
          type: 'text',
          text: `File: ${att.name} (${att.mimetype}, ${att.sizeBytes} bytes)\n---\n${summary}`,
        }],
      };
    } catch (err) {
      logger.warn({ err, fileId: att.fileId }, 'read_attachment: failed to parse xlsx');
      return { content: [{ type: 'text', text: `read_attachment: failed to parse ${att.name}: ${(err as Error).message}` }] };
    }
  }

  if (TEXT_MIME.has(att.mimetype)) {
    try {
      const text = (await readFile(att.filePath, 'utf-8')).slice(0, 40_000); // cap at ~40KB of text into the context
      logger.info({ fileId: att.fileId, mimetype: att.mimetype, textLen: text.length }, 'read_attachment: text');
      return { content: [{ type: 'text', text: `File: ${att.name} (${att.mimetype}, ${att.sizeBytes} bytes)\n---\n${text}` }] };
    } catch (err) {
      logger.warn({ err, fileId: att.fileId }, 'read_attachment: failed to read text');
      return { content: [{ type: 'text', text: `read_attachment: failed to read ${att.name}: ${(err as Error).message}` }] };
    }
  }

  // Unsupported type (PDF, binary, etc.): return metadata so the agent knows
  // the file exists but can ask the user to paste relevant content inline.
  return {
    content: [{
      type: 'text',
      text: `read_attachment: ${att.name} (${att.mimetype}, ${att.sizeBytes} bytes) — inline reading not supported for this mimetype. Ask the user to paste the contents or a screenshot.`,
    }],
  };
}
