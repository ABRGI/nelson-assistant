import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../observability/logger.js';

export interface KnowledgeLeaf {
  path: string;            // relative path from knowledge/ root, e.g. "nelson/tasks.yaml"
  purpose: string;         // one-line semantic summary, from leaf's `purpose:` field
  when: string;            // leaf-picker trigger, from leaf's `when_to_load:` field (falls back to purpose)
  content: string;         // raw yaml text
  bytes: number;
}

export interface KnowledgeBundle {
  root: string;                        // absolute path to knowledge/ dir
  leaves: Map<string, KnowledgeLeaf>;  // keyed by relative path
  totalBytes: number;
  loadedAt: Date;
}

// Parse only the front matter of a YAML leaf — we care about 3 top-level keys:
// purpose, when_to_load, node. We don't need a full YAML parser because every
// leaf is authored to put these fields on their own lines near the top.
function extractHeader(yaml: string): { purpose?: string; whenToLoad?: string; node?: string } {
  const out: { purpose?: string; whenToLoad?: string; node?: string } = {};
  const lines = yaml.split('\n').slice(0, 30);
  for (const line of lines) {
    const m = line.match(/^(purpose|when_to_load|node)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const raw = (m[2] ?? '').trim();
    let value = raw;
    if (value.startsWith('>-') || value.startsWith('>')) value = '';
    else value = value.replace(/^['"]|['"]$/g, '');
    if (!value) continue;
    if (key === 'purpose') out.purpose = value;
    else if (key === 'when_to_load') out.whenToLoad = value;
    else if (key === 'node') out.node = value;
  }
  return out;
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile() && p.endsWith('.yaml')) yield p;
  }
}

export async function loadKnowledgeBundle(root: string): Promise<KnowledgeBundle> {
  const leaves = new Map<string, KnowledgeLeaf>();
  let totalBytes = 0;

  try {
    const s = await stat(root);
    if (!s.isDirectory()) throw new Error(`${root} is not a directory`);
  } catch (err) {
    logger.warn({ err, root }, 'knowledge/ root not found — running without pre-injection');
    return { root, leaves, totalBytes: 0, loadedAt: new Date() };
  }

  for await (const abs of walk(root)) {
    const rel = path.relative(root, abs);
    if (rel === 'index.yaml') continue;              // index is meta; not injectable on its own
    try {
      const content = await readFile(abs, 'utf-8');
      const header = extractHeader(content);
      const purpose = header.purpose ?? '';
      const when = header.whenToLoad ?? purpose;
      leaves.set(rel, { path: rel, purpose, when, content, bytes: content.length });
      totalBytes += content.length;
    } catch (err) {
      logger.warn({ err, abs }, 'failed to read knowledge leaf');
    }
  }

  logger.info({ count: leaves.size, totalBytes, root }, 'knowledge bundle loaded');
  return { root, leaves, totalBytes, loadedAt: new Date() };
}

export function renderLeafCatalogue(bundle: KnowledgeBundle): string {
  const rows: string[] = [];
  for (const leaf of [...bundle.leaves.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    rows.push(`- ${leaf.path} — ${leaf.when || leaf.purpose || '(no description)'}`);
  }
  return rows.join('\n');
}

export function getLeafContent(bundle: KnowledgeBundle, relativePath: string): string | undefined {
  return bundle.leaves.get(relativePath)?.content;
}
