---
name: add-tool
description: Scaffold a new Claude Agent SDK tool for nelson-assistant — create src/agent/tools/<name>.ts with a Zod schema + context + handler, register it in runner.ts, allowlist mcp__nelson__<name>, and write a unit test.
---

# /add-tool

Add a new tool the agent can call during a Slack conversation. Follow the existing pattern — do not invent new shapes.

## 1 · Clarify the design before writing code

Ask the user (use AskUserQuestion when ≥3 fields are missing):

1. **Tool name** — snake_case, short, verb-like. Examples: `download_report`, `psql_query`, `visual_compare`.
2. **One-sentence description** — this becomes the LLM-facing description. It should make the tool's scope obvious: what it does, when the agent should call it, what it won't do.
3. **Input schema** — fields, types, required/optional, brief descriptions.
4. **Authority boundary** — what can this tool reach? Nelson API only? Filesystem (EFS)? External HTTP? PostgreSQL? Don't proceed until this is clear.
5. **Escalation triggers** — are there inputs for which the tool should refuse and route to `escalate_to_human` instead? (E.g., a `psql_query` tool should never accept a statement starting with anything other than `SELECT`.)

Read `src/agent/tools/nelson_api.ts` as the canonical example before writing.

## 2 · Create the tool file

`src/agent/tools/<name>.ts`:

```ts
import { z } from 'zod';
import { logger } from '../../observability/logger.js';
// ... other imports (undici, pg, etc.) as needed

export const <Name>InputSchema = z.object({
  // LLM-supplied fields ONLY. No auth, no base URL, no tenant.
});
export type <Name>Input = z.infer<typeof <Name>InputSchema>;

export interface <Name>Context {
  // Pre-resolved values from the pipeline: client, idToken, slackUserId, etc.
  // Never let the LLM supply any of these.
}

export interface <Name>Result {
  // Plain JSON-serializable shape.
}

/**
 * Authority boundary: <describe what this tool can reach and what it refuses>.
 * Escalation: <describe conditions under which it throws rather than executes>.
 */
export async function <name>(
  ctx: <Name>Context,
  input: <Name>Input,
): Promise<<Name>Result> {
  const parsed = <Name>InputSchema.parse(input);
  // ...implement...
  logger.info({ /* tenant, user, key facts, no secrets */ }, '<name> called');
  return { /* ... */ };
}
```

## 3 · Register in `src/agent/runner.ts`

1. Import `{ <name>, <Name>InputSchema }`.
2. Thread any new context from `RunAgentArgs` (add fields if needed).
3. Add a `tool()` entry inside `mcpServers.nelson.instance.tools`:

   ```ts
   tool(
     '<name>',
     '<LLM-facing description from step 1>',
     <Name>InputSchema.shape,
     async (input) => {
       const result = await <name>({ /* ctx */ }, input);
       return { content: [{ type: 'text', text: JSON.stringify(result) }] };
     },
   ),
   ```

4. Add `'mcp__nelson__<name>'` to the `allowedTools` array (same file, near the top of `options`).

## 4 · Unit test

`test/<name>.test.ts` — at minimum, schema validation and the pure logic. Mock external calls; don't hit real services in unit tests. See `test/fs-store.test.ts` for the style.

## 5 · Typecheck + test

```bash
npm run typecheck
npm test
```

Both must pass. Do not mark the task done otherwise.

## 6 · Docs

- Only if the pattern itself changed (e.g., you introduced a new kind of context, a new escalation convention) update `.claude/CLAUDE.md` "Adding a new Agent tool" section. Tool-specific behavior documented in the file header is enough.
- If the tool unlocks a user-visible feature, add a one-line note to `SMOKE_TEST.md` showing how to exercise it.

## Anti-patterns to reject

- Accepting `base_url`, `token`, `tenant_id`, or any credential from the LLM input.
- A tool that quietly succeeds on an edge case the user didn't authorize. Prefer `throw` + escalation.
- `Bash`-shaped tools that let the agent run arbitrary shell. The existing `Bash(git ...)` allowlist is deliberately narrow — don't widen it.
- Logging raw request/response bodies that may contain PII or tokens. Use the logger's redact list (extend it if you add new sensitive fields).
