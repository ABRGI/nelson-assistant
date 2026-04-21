---
name: add-tenant
description: Register a new Nelson client tenant — collect the required fields, write clients/<tenantId>.json to the state store (fs in dev, S3 in prod), and surface the prod-only follow-ups (CDK peering, SGs, route tables).
---

# /add-tenant

Register a new tenant so `nelson-assistant` can serve users bound to that client.

## 1 · Collect fields

Auth is global (one Cognito pool trusts every tenant's Nelson API — configured via `NELSON_USER_MGMT_BASE_URL` / `NELSON_COGNITO_USER_POOL_ID` / `NELSON_COGNITO_CLIENT_ID` env vars). A tenant record therefore only carries routing info. Ask the user for these fields (use AskUserQuestion if multiple are missing). Validate against the schema in `src/auth/clients.ts` → `ClientRecordSchema`:

| Field | Example | Notes |
|---|---|---|
| `tenantId` | `acme` | short lowercase slug, unique, used as the S3 key and the `DEFAULT_TENANT_ID` value. |
| `displayName` | `Acme Hotel Group` | human-readable, used in Slack messages. |
| `nelsonApiBaseUrl` | `https://stage-api.acme.nelson.internal` | private URL reachable from the hub VPC via peering. The `nelson_api` tool calls this with the user's JWT. |
| `dbHost` (optional) | `stage-db.rds.internal` | for the future `psql` tool. |
| `dbSchema` (optional) | `acme` | schema inside the shared Nelson DB. |
| `notes` (optional) | free text | any human-only context. |

## 2 · Build the record

Construct the JSON exactly matching `ClientRecordSchema`:

```json
{
  "tenantId": "...",
  "displayName": "...",
  "nelsonApiBaseUrl": "...",
  "dbHost": "...",           // omit if not known
  "dbSchema": "...",         // omit if not known
  "notes": "..."             // omit if not applicable
}
```

Reject invalid inputs before writing (e.g., URL not starting with `https://`).

## 3 · Write to the state store

**Dev (`STORAGE_MODE=fs` — the default):**
```bash
mkdir -p ./.local-state/state/clients
# write to ./.local-state/state/clients/<tenantId>.json
```
Use the Write tool, not `cat`/`echo`.

**Prod (`STORAGE_MODE=aws`):**
```bash
aws s3 cp - s3://nelson-assistant-state-<env>/clients/<tenantId>.json --sse aws:kms --sse-kms-key-id <key-arn>
```
(Don't actually run this unless the user explicitly asked to push to prod.)

## 4 · Reload

The registry is cached at boot. For dev, the user just restarts `npm run dev`. For prod, either:
- Restart the ECS service (`aws ecs update-service --force-new-deployment ...`), or
- Send SIGHUP once that's implemented.

If there is now more than one tenant registered, remind the user to set `DEFAULT_TENANT_ID` in `.env` — Stage 1 routes every `/nelson` query to one tenant and will refuse to boot with ambiguous state.

## 5 · Surface the prod-only follow-ups

If the user intends this tenant for production, list the outstanding infra work (but do NOT do it — CDK stacks aren't written yet):

- Peering: add `{ tenantid, vpcid, cidr, routetableids, nelsonapisgid }` to `aws-infrastructure/config/default.json` under `nelsonassistant.clients`, then `cdk deploy NelsonAssistantPeeringStack`.
- Client-side route: add a route in the tenant's VPC route tables pointing the hub CIDR through the peering connection (cross-account if the tenant is in a different AWS account).
- Client-side SG: allow 443 from the hub SG (or hub CIDR) on the Nelson API ALB.
- RDS SG: allow 5432 from the hub CIDR (once the DB tool exists).

## 6 · Report

Print: the file path written, whether registry reload is needed, and the prod follow-ups (if applicable). Do not print secrets or credentials.
