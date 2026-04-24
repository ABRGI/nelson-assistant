import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { request } from 'undici';
import { z } from 'zod';
import { logger } from '../observability/logger.js';

// Hard limits. Keep small — Slack attachments are going straight into the
// agent's context window if the agent reads them, so unbounded files are
// both a cost and an attack surface.
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_ATTACHMENTS_PER_JOB = 3;

// The subset of Slack's File object we actually use. Extracted in
// events.ts from message.files[*] and passed through the AskJob.
export const SlackFileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mimetype: z.string().default('application/octet-stream'),
  size: z.number().int().nonnegative().optional(),
  url_private_download: z.string().url(),
});
export type SlackFile = z.infer<typeof SlackFileSchema>;

export interface LocalAttachment {
  fileId: string;          // Slack file id — agent references this via the read_attachment tool
  name: string;
  mimetype: string;
  sizeBytes: number;
  filePath: string;        // absolute path on the task filesystem (inside the per-job attachment dir)
}

export interface DownloadAttachmentsArgs {
  files: SlackFile[];
  botToken: string;
}

// Downloads up to MAX_ATTACHMENTS_PER_JOB files from the Slack WebClient's
// url_private_download using the bot token. Returns only the files that
// successfully downloaded and passed size+mime checks; logs + drops the rest.
// Caller owns cleanup of the returned paths (dirs live under os.tmpdir()).
export async function downloadSlackAttachments(
  args: DownloadAttachmentsArgs,
): Promise<LocalAttachment[]> {
  const capped = args.files.slice(0, MAX_ATTACHMENTS_PER_JOB);
  if (capped.length === 0) return [];

  const dir = path.join(os.tmpdir(), 'nelson-attachments', randomUUID());
  await mkdir(dir, { recursive: true });

  const out: LocalAttachment[] = [];
  for (const raw of capped) {
    const parsed = SlackFileSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ err: parsed.error, fileId: (raw as { id?: unknown }).id }, 'attachment: Slack file shape rejected');
      continue;
    }
    const file = parsed.data;
    if (typeof file.size === 'number' && file.size > MAX_FILE_BYTES) {
      logger.warn({ fileId: file.id, size: file.size }, 'attachment: size exceeds limit — skipping');
      continue;
    }
    try {
      const res = await request(file.url_private_download, {
        method: 'GET',
        headers: { authorization: `Bearer ${args.botToken}` },
      });
      if (res.statusCode !== 200) {
        logger.warn({ fileId: file.id, status: res.statusCode }, 'attachment: download non-200 — skipping');
        continue;
      }
      const buf = Buffer.from(await res.body.arrayBuffer());
      if (buf.byteLength > MAX_FILE_BYTES) {
        logger.warn({ fileId: file.id, bytes: buf.byteLength }, 'attachment: actual size exceeds limit — skipping');
        continue;
      }
      const safeName = file.name.replace(/[^\w.\-]+/g, '_') || `${file.id}.bin`;
      const filePath = path.join(dir, safeName);
      await writeFile(filePath, buf);
      out.push({
        fileId: file.id,
        name: file.name,
        mimetype: file.mimetype,
        sizeBytes: buf.byteLength,
        filePath,
      });
      logger.info(
        { fileId: file.id, name: file.name, mimetype: file.mimetype, bytes: buf.byteLength },
        'attachment: downloaded',
      );
    } catch (err) {
      logger.warn({ err, fileId: file.id }, 'attachment: download failed — skipping');
    }
  }
  return out;
}

// Pick the usable file entries out of a Slack message event's files[] field.
// Events that don't carry attachments should just short-circuit to [].
export function extractSlackFilesFromMessage(raw: unknown): SlackFile[] {
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as { files?: unknown }).files;
  if (!Array.isArray(list)) return [];
  const out: SlackFile[] = [];
  for (const item of list) {
    const parsed = SlackFileSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
