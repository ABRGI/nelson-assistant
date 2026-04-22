import type { KnowledgeBundle } from './loader.js';
import { getLeafContent } from './loader.js';

// Assembles the text block that gets appended to Sonnet's system prompt so the
// picked knowledge leaves are in-context. Sonnet reads this as grounded truth
// and cites from it — no tool call required.
export function renderInjection(bundle: KnowledgeBundle, leafPaths: string[]): string {
  if (leafPaths.length === 0) return '';
  const blocks: string[] = [
    '=== PRE-INJECTED KNOWLEDGE (source of truth for Nelson) ===',
    '',
    'The YAML leaves below were selected by the leaf picker as most relevant to this user\'s question. Use them as your PRIMARY grounded source for any factual claim about Nelson. Quote paths, endpoints, rules, SQL and enums from here directly. If a claim is NOT supported by these leaves, escalate or say "I don\'t know" — do NOT fall back to your pre-training memory.',
    '',
    'The source code of Nelson repos is deliberately NOT available to you on the hot path. If the knowledge leaves don\'t cover the question, call mcp__nelson__deep_research with a focused sub-question; that tool allocates a worktree and returns a distilled finding. Do not call it casually — it is the expensive path.',
    '',
  ];
  for (const leaf of leafPaths) {
    const content = getLeafContent(bundle, leaf);
    if (!content) continue;
    blocks.push(`--- knowledge/${leaf} ---`);
    blocks.push(content);
    blocks.push('');
  }
  blocks.push('=== END PRE-INJECTED KNOWLEDGE ===');
  return blocks.join('\n');
}
