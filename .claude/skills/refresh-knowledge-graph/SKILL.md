---
name: refresh-knowledge-graph
description: Rebuild or update the machine-readable .claude/knowledge/ graph for one or all in-scope Nelson repos. ALWAYS reads from the release branch (main / master), never develop. Used when the repos drift or new features are added.
---

# /refresh-knowledge-graph

Keeps the `.claude/knowledge/` graphs in each Nelson repo aligned with the current release state so the Nelson Assistant answers questions from accurate info.

## Scope

**In-scope repos** (9 total — deep-dive graphs live in each):

1. `nelson-assistant` (this repo)
2. `nelson`
3. `nelson-client-configuration`
4. `nelson-user-management-service`
5. `nelson-tenant-management-service`
6. `nelson-management-ui`
7. `nelson-bui-2.0`
8. `omena-mobile-app`
9. `omena-service-app`

**Awareness-only** (one-paragraph entry in `nelson-assistant/.claude/knowledge/ecosystem.yaml`, no deep dive):

- `CDP`, `nelson-short-links-service`, `nprice-core`, `nprice-integration`, `omena-wordpress`

Repos live at `~/nelson/<repo>/` on this remote dev VM (or `~/Documents/nelson/src/<repo>/` on laptop). If a repo isn't cloned, say so and stop — don't fabricate content.

## 0 · Inputs

Ask (use `AskUserQuestion` only if required — default to sensible choices):

1. **Target**: `all`, `<repo-name>`, or a comma-separated list. Default `all`.
2. **Diff mode**: `show-diff` (preview only) or `write` (write updated files to disk). Default `write`.

## 1 · Branch discipline (HARD RULE)

**Only read from the release branch.** Never build the graph from `develop` or feature branches — unstable changes will confuse the Nelson Assistant at runtime.

Resolve the release branch per repo:

```bash
for r in <repos>; do
  cd ~/nelson/$r
  if git rev-parse --quiet --verify origin/main >/dev/null; then echo "$r: main"
  elif git rev-parse --quiet --verify origin/master >/dev/null; then echo "$r: master"
  else echo "$r: NEITHER — stop and escalate"
  fi
done
```

Use `git show origin/<release-branch>:<path>` and `git ls-tree origin/<release-branch>` for all file reads. Do NOT run `git checkout` — it's destructive on the shared worktree.

If local HEAD isn't the release branch, that's fine for reading via `git show` / `git ls-tree`. But when the user commits the updated graph, they must do it on the release branch (or create a PR targeting it).

## 2 · Graph shape per repo

Entry point + leaves. Keep each leaf under ~150 lines, one topic each. Leaf names and when-to-read blurbs live in the `index:` block of the entry point.

**Minimum for every repo**:

```
.claude/
  knowledge.yaml          # entry: schema, repo, purpose, absolute_rules, index[]
  knowledge/
    stack.yaml OR flow.yaml   # language/deps/entry-points OR the request lifecycle
    deploys.yaml              # how it runs in prod; CI pipelines; env vars
```

**Add leaves as the repo warrants**:

| Repo kind | Recommended extra leaves |
|---|---|
| Backend service (Lambda / Express) | `endpoints.yaml`, `flow.yaml`, `cognito.yaml` or `data.yaml`, `gotchas.yaml` |
| Nelson core (`nelson`) | `tasks.yaml`, `hotel-identity.yaml`, `enums.yaml`, `bugs.yaml`, `security-prefixes.yaml`, `endpoints/*.yaml`, `db.yaml` + `db/*.yaml`, `kpis.yaml`, `diagnostics.yaml`, `response-shapes.yaml`, `support-playbooks.yaml`, `cross-repo-content.yaml`, `code-paths.yaml`, `authority-boundary.yaml`, `output-format.yaml`, `modules.yaml` |
| Frontend (Angular / React) | `stack.yaml`, `portals-and-routes.yaml` OR `docs-map.yaml`, `api-patterns.yaml`, `i18n.yaml` |
| Mobile (Flutter) | `stack.yaml`, `env-and-build.yaml` |
| Content repo (`nelson-client-configuration`) | `layout.yaml`, `content-files.yaml`, `dev-and-deploy.yaml` |

**Shape rules**:

- First line of every leaf: `schema: 1`
- Second line: `node: <name>` matching the filename minus `.yaml`
- Include `related: [...]` with cross-links when useful
- Include `purpose:` in one sentence
- `absolute_rules` block on entry points for anything that MUST NOT be violated (typically: read-only, no direct writes, citation rules)

## 3 · Per-repo file probes

For each repo, read the following from `origin/<release-branch>`:

**All repos**:
- `README.md` (or `readme.md`) — purpose, setup
- `package.json` / `pom.xml` / `pubspec.yaml` — deps, stack, scripts
- `buildspec.yml` — CI shape
- `.env.example` if present — runtime env
- Existing `CLAUDE.md` if present (inherit any voice/style constraints)

**Backend services**:
- `index_local.js` / main Lambda routing files → list routes
- `lambda_src/*.js` or Spring controllers → list methods

**Nelson core (`nelson`)**:
- `domain/src/main/java/nelson/api/Urls.java` (URL templates — authoritative for paths)
- `nelson-web/src/main/java/nelson/api/infrastructure/controllers/*.java` → method annotations (GET vs POST, path variables)
- `nelson-web/src/main/java/nelson/api/model/booking/*.java` → response shapes
- `nelson-web/src/main/java/nelson/report/ReportService.java` → KPI SQL formulas
- `nelson-web/src/main/java/nelson/api/infrastructure/controllers/ApiExceptionHandler.java` → error mapping
- `nelson-web/src/main/resources/db/common/V*.sql` → schema migrations
- `docs/*.md` → narrative reference (don't duplicate — point at them)

**Frontends**:
- `src/app/helpers/constants.ts` (MUI) or equivalent → URL constants
- `src/services/localization/*.ts` (BUI) / `src/app/services/translations.service.ts` (MUI) → i18n wiring
- `docs/*.md` if present (BUI 2.0 has extensive docs)

**Content repo (`nelson-client-configuration`)**:
- `src/config/<client>/*.json` files → content ownership map
- Language bundles under `src/language/`

**Mobile apps**:
- `pubspec.yaml` → dependencies
- `lib/` structure → high-level areas
- `.env` variants → per-env config

## 4 · Compile the output

For each repo, output one of:

- **new graph** — if `.claude/knowledge.yaml` doesn't exist, scaffold entry point + minimum leaves + any warranted extras.
- **update graph** — if the graph exists, diff the file contents the current release surfaces against what's captured. Update only the files that drifted.
- **no change** — when nothing material has changed since the last refresh.

If `diff mode = show-diff`: print a summary of intended changes per repo. Don't write.
If `diff mode = write`: apply edits with the `Edit` tool (for existing files) or `Write` (for new files). Never use `Bash`/`sed` for this.

## 5 · Post-actions

After writing:

1. `find ~/nelson/<each-repo>/.claude/knowledge -type f | wc -l` — sanity-check file counts.
2. In `nelson-assistant`, typecheck: `npm run typecheck` (harmless but a good canary — the runner may have been hardened to match).
3. Update `~/nelson/nelson-assistant/.tasks/ROADMAP.md` completion log with a one-line entry referencing today's date + which repos touched.
4. If `nelson-assistant/src/agent/runner.ts` system prompt has drifted from the graph's `absolute_rules`, raise it — but DON'T edit unless the user asks.
5. Summarize to the user:
   - Repos touched, leaves added/updated/unchanged, total line count.
   - Anything surprising found (new endpoints, renamed branches, broken tests).
   - Reminder that these edits are untracked in each repo — user has to commit + push per repo, on the release branch.

## Absolute rules for this skill

- Read from release branch only (main / master / `origin/<branch>`). NEVER from develop.
- Never `git checkout`, `git push`, `git merge`, or any write-to-remote. Reads via `git show` / `git ls-tree` only.
- Don't fabricate endpoint paths, JSON field names, or SQL columns — cite them via a file path + line you actually read.
- Don't add leaves that aren't supported by concrete code/config evidence. "Might be useful" doesn't warrant a file.
- If a repo isn't cloned on the local machine, say so and skip — don't try to clone.
- Keep each leaf under ~150 lines. Split oversized nodes.
- Maintain consistent YAML shape across repos.
- Stay inside the 9 in-scope + 5 awareness-only list. New repos need explicit user greenlight.
