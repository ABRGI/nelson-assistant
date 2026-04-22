---
name: train
description: Refresh the consolidated knowledge/ in nelson-assistant by reading the current release branch of each in-scope Nelson repo. Pulls key files, distills into machine-readable yaml leaves, diffs against the existing knowledge, shows a per-leaf approval prompt, and commits the approved set. Runs in this Claude Code session — never over Slack.
---

# /train

Keeps `nelson-assistant/knowledge/` aligned with the current release state of the 8 in-scope Nelson repos. Cheap to run often; intended to be part of every prod release cycle.

Runs ONLY in a Claude Code session (on this dev machine), never via Slack. The production bot reads the checked-in knowledge — it does NOT re-train at runtime.

## Scope

In-scope repos (on this VM at `/home/sandeep/nelson/<repo>`):

1. `nelson` — core PMS (Spring Boot monolith)
2. `nelson-user-management-service` — Cognito auth Lambda
3. `nelson-tenant-management-service` — tenant registry Lambda
4. `nelson-client-configuration` — BUI/MUI display content
5. `nelson-management-ui` — Angular MUI
6. `nelson-bui-2.0` — React BUI
7. `omena-mobile-app` — Flutter guest app
8. `omena-service-app` — Flutter staff app

Awareness-only (documented in `knowledge/cross-repo/ecosystem.yaml` but NOT deep-scanned): CDP, nelson-short-links-service, nprice-core, nprice-integration, omena-wordpress.

## 0 · Inputs

Ask (sensible defaults):

1. **Target**: `all` | `<repo-name>` | `db` | comma-separated list. `db` refreshes DB-sourced leaves only (enums, tenant-hotels). Default: prompt for a specific repo if Sandeep says "refresh nelson" etc., else default `all`.
2. **Mode**: `diff-only` (preview + approval per leaf) vs `auto-update-safe-leaves` (auto-apply when the diff is additive-only; prompt for destructive). Default `diff-only`.

## 0.5 · Check the observer DB connection

For any run that refreshes DB-backed leaves (enums, tenant-hotels, any leaf with `last_db_refresh:` in its frontmatter), first verify the observer tunnel is open:

```bash
node -e "require('dotenv').config(); const { Client } = require('pg');
  const c = new Client({ connectionString: process.env.PSQL_READ_ONLY_URL, ssl: { rejectUnauthorized: false } });
  c.connect().then(() => c.query('SELECT 1')).then(() => { console.log('OK'); return c.end(); })
   .catch(e => { console.error('DB_ERR:', e.message); process.exit(2); });"
```

If this fails with `ECONNREFUSED` or a no-tunnel error, **ask Sandeep to open the observer tunnel** (the SSM port-forward that exposes the RDS on `localhost:<port>` — typically `localhost:7435`) before continuing. Do not guess at the list; DB-truth is the authority here.

## 1 · Release-branch discipline (HARD RULE)

Read ONLY from `origin/<release-branch>`:

- `omena-service-app` → `main`
- everything else → `master`

Use `git fetch origin <branch> --quiet`, then `git show origin/<branch>:<path>` and `git ls-tree origin/<branch>`. **Never** `git checkout`. Develop / feature branches are off-limits — unstable changes on develop must not poison the knowledge.

## 1.5 · DB refresh — authoritative enums + tenant hotel roster

Enums and tenant data live in the DB, not in source. Refresh them from the observer connection before scanning source repos — source has drift (hallucinated enum values, stale hotel labels) that only the DB can correct.

**Script**: `scripts/db-dump.js` (checked in; extend it as needs grow).

Run:
```bash
node scripts/db-dump.js > /tmp/db-dump.json
```

What it pulls (all read-only, all bounded — no SELECT * on `reservation` / `line_item` / `audit_log` / any hot tables):

1. `pg_enum` labels per schema (workflow_status, action_type, room_clean_status_event_*, member_deletion_status).
2. `DISTINCT` value lists from the varchar domain enums: `reservation.state`, `reservation.booking_channel`, `reservation.change_type`, `product.type`, `reservation.type` (integer).
3. `hotel` table — full roster (id, label, name, city, currency, country, time_zone, available) for the `nelson` schema. Split into active (available=true) and sunset (available=false).
4. `information_schema.columns` for `room` and `product` — confirms the room-type-via-product.product_id relationship.

**Also run `scripts/reservation-formats.js`** to re-verify the identifier shapes per booking channel (format-length stats + 5-row samples per channel). The output feeds `knowledge/nelson/endpoints/reservations.yaml#identifiers` and `#how_to_route_a_user_supplied_identifier`. Current invariants (refresh date in the leaf):
- `reservation_code`: exactly 9 digits across ALL channels
- `uuid`: 36 chars (standard UUID)
- `booking_channel_reservation_id`: exactly 10 digits, set only for BOOKINGCOM + EXPEDIA
These shapes drive Sonnet's DB-first routing; keep them in sync with the DB.

Apply the output:
- `knowledge/nelson/enums.yaml` — mark each enum `✓DB` or `✓source`; set `last_db_refresh: <YYYY-MM-DD>`. Remove any enum value that disappeared from the DB (these are common source-code hallucinations — e.g. `CHECK_IN_INCOMPLETE`, `NO_CHANGE`, `EXTRA`).
- `knowledge/nelson/tenant-hotels.yaml` — rewrite the `hotels:` (available=true) and `sunset_or_inactive:` lists. Update `city_to_labels` and `ambiguous_cities` accordingly.

**HARD RULES for DB reads in /train (and for the bot at runtime)**:
- NEVER run `SELECT *` on `nelson.reservation`, `nelson.line_item`, `nelson.audit_log`, `nelson.audit_log_event`, or any table inserted into on reservation creation. These are 200k+ rows and a full scan will load the DB. Use `DISTINCT <column>`, `LIMIT`, or `WHERE invoice_date >= <recent>` filters.
- Read-only observer role. SELECT only. No DDL, no INSERT/UPDATE/DELETE.
- Use `?sslmode=require` or the equivalent `ssl: { rejectUnauthorized: false }` in the pg client — the RDS requires TLS.

Once enums.yaml + tenant-hotels.yaml are in sync with DB, hot-reload the dev bot and verify `tenant hotel roster loaded count=<N>` in the log.

## 2 · Per-repo scan — what to read

The file sets below are starting points; extend based on what each repo exposes.

### `nelson` (core PMS)

- `domain/src/main/java/nelson/api/Urls.java` — authoritative URL constants.
- `nelson-web/src/main/java/nelson/api/infrastructure/controllers/*.java` — `@GetMapping/@PostMapping` + method signatures (path variables, request params, return types).
- `nelson-web/src/main/java/nelson/api/model/booking/*.java` — response DTOs (RoomPrice, ProductOffer, etc.).
- `nelson-web/src/main/java/nelson/report/ReportService.java` — authoritative KPI SQL (REVENUE_REPORT, etc.).
- `nelson-web/src/main/java/nelson/api/infrastructure/controllers/ApiExceptionHandler.java` — error mapping.
- `nelson-web/src/main/resources/db/common/V*.sql` — Flyway migrations → schema updates.
- `reservation-core/src/main/java/nelson/reservation/core/model/reservation/ReservationService.java` — business-rule validation sites (underage, blocking, state machine).
- `reservation-core/src/main/java/nelson/reservation/core/model/product/ProductType.java` — product ordering cutoffs.
- `reservation-core/src/main/java/nelson/reservation/core/model/eci_lco/EciLcoService.java` — ECI/LCO buffers.
- `reservation-core/src/main/java/nelson/reservation/core/model/allocation/AllocationService.java` — room allocation filters.
- `payment-core/src/main/java/nelson/payment/core/service/RefundCalculator.java` — refund constraints.
- `channelmanager-*/src/main/java/**` — OTA integration specifics.
- `docs/02-domain-model.md`, `docs/03-booking-flows.md`, `docs/10-database.md`, `docs/12-api-reference.md` — narrative references.

Update in `knowledge/nelson/`: tasks.yaml, business-rules.yaml, enums.yaml, bugs.yaml, hotel-identity.yaml, security-prefixes.yaml, retry-policy.yaml, kpis.yaml, response-shapes.yaml, diagnostics.yaml, code-paths.yaml, endpoints/*.yaml, db/*.yaml.

### Backend Lambda services (`nelson-user-management-service`, `nelson-tenant-management-service`)

- `index_local.js` — route registrations (`app.get / app.post`).
- `lambda_src/*.js` — handler logic; extract preconditions, Cognito flows, DynamoDB interactions.
- `package.json` — env var requirements.

Update in `knowledge/<repo>/`: purpose.yaml, flow.yaml, endpoints.yaml, cognito.yaml / data.yaml, deploys.yaml, gotchas.yaml.

### Content repo (`nelson-client-configuration`)

- `src/config/<client>/*.json` — content file shapes + clients list.
- `src/language/**` — shared translation bundle keys.
- `export-config.js` — build pipeline.

Update in `knowledge/nelson-client-configuration/`: purpose.yaml, layout.yaml, content-files.yaml, dev-and-deploy.yaml.

### Frontends (`nelson-management-ui`, `nelson-bui-2.0`)

- `package.json` — pinned versions + scripts.
- `src/app/helpers/constants.ts` (MUI) / equivalent — URL constants.
- `src/services/api/*.ts` (BUI) / `src/app/services/*.service.ts` (MUI) — API wrappers.
- `src/services/localization/*.ts` (BUI) / translations.service.ts (MUI) — i18n wiring.
- `docs/*.md` — architecture, flows, state management.

Update in `knowledge/<repo>/`: purpose.yaml, stack.yaml, portals-and-routes.yaml or docs-map.yaml, api-patterns.yaml, i18n.yaml, deploys.yaml.

### Mobile apps (`omena-mobile-app`, `omena-service-app`)

- `pubspec.yaml` — dependencies.
- `README.md` — build / env flags.
- `lib/` — structure (high-level only; no deep code reads).

Update in `knowledge/<repo>/`: purpose.yaml, stack.yaml, envs-and-build.yaml.

## 3 · Distillation rules

For each leaf being refreshed:

- Shape: `schema: 1`, `node: <name>`, `purpose:` one-sentence, `when_to_load:` one-sentence (important for the leaf picker), content sections below.
- Target <200 lines per leaf. Split if growing past that.
- Quote short code snippets verbatim when the rule hinges on exact logic. Don't paraphrase business rules.
- Cite file path + line range for every rule / endpoint (agent uses this in Source footers).
- Validate enum values against the code — invalid values cause 400s.
- Do not include narrative prose. Bullets, tables, structured maps only.

## 4 · Diff + approval

For each leaf with a proposed change:

1. Print a concise diff summary (`git diff --stat`-style, plus the first 30 lines of the actual diff).
2. Classify:
   - **additive-only** — new entries, new keys. Safe to auto-apply if mode allows.
   - **destructive** — removes or changes an existing entry. Always prompt: `apply / modify / drop`.
3. On `apply`: write the file. On `modify`: take free-form Sandeep input, re-render, re-diff. On `drop`: move to the next leaf.

## 5 · End-of-session summary

Print:

- Per-repo: leaves touched, lines changed, lines removed.
- Aggregate token-cost reminder: "Knowledge bundle grew from X KB to Y KB — this is what every data_query now pre-injects (cached) per Sonnet call."
- `git status` in nelson-assistant so Sandeep can review before committing.
- Offer to append a one-line entry to `.tasks/ROADMAP.md`.

## 6 · Commit convention

When Sandeep says commit:

- Author: `sandeepbaynes <sandeep.baynes@gmail.com>`
- Message: `"Train: refresh knowledge for <repos> from origin/<release-branch> (<YYYY-MM-DD>)"`
- Push only when Sandeep explicitly says push.

## Absolute rules for this skill

- Read from release branches only (`origin/main` for omena-service-app, `origin/master` for everyone else). NEVER develop.
- Never `git checkout`, `git push`, or any write to a sibling repo's remote. Reads via `git show` / `git ls-tree` only.
- Never fabricate endpoint paths, file lines, SQL column names. Every fact must come from a file you literally read in this session.
- Cap each leaf at ~200 lines. Quality > completeness.
- Don't train on awareness-only repos (CDP, nelson-short-links-service, nprice-*, omena-wordpress) — they stay as one-paragraph entries in `knowledge/cross-repo/ecosystem.yaml`.
- The runtime bot reads the checked-in knowledge only. Changes here do NOT reach prod until the Docker image is rebuilt and the ECS service updated.
