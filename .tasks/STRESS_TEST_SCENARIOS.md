# Stress-test scenarios for Nelson Assistant

Self-contained list to work through one at a time. Each scenario names the
thread to start in, the exact message to send, the expected verdict/tools,
and the expected answer where we have ground truth.

The observer tunnel (`PSQL_READ_ONLY_URL` on :7435) must be open for any
scenario that requires Sonnet to query the DB.

All ground-truth numbers come from `.test_data/*.xlsx` — the real reports
Sandeep downloaded from production on 2026-04-22.

**Snapshot date for all OTB cases below: 2026-04-22** (today in dev).

---

## How to mark each scenario

```
[ ] open   —   not started
[~] wip    —   partially tested (note what still needs checking)
[✓] pass   —   verdict + answer both match expectations
[✗] fail   —   flag on Slack with `debug <what failed>`; Claude Code will fix
```

---

## Category A — Scope carry across turns

### A1 `[ ]` Long-gap follow-up
- Thread: *new*
- Turn 1: `What's OTB for HKI2 on May 5th?`
  - Expected: classifier `data_query` → effective_question preserved → picker `kpis.yaml` + `hotel-identity.yaml` → Sonnet calls `psql`.
  - Expected answer: *67 RN / €3,912.17* (exact).
- Turn 2 (in same thread, any time later): `what about POR2?`
  - Expected: classifier reconstructs `effective_question = "OTB for POR2 on May 5th"`. No re-ask of hotel or date. `historyTurns >= 2`.
  - Expected answer: POR2 on 2026-05-05 → *4 RN / €229.01* (from sales forecast).

### A2 `[ ]` Filter narrowing in-thread
- Thread: *new*
- Turn 1: `Reservations arriving on May 4th`
  - Expected: classifier `needs_clarification` → "which hotel?"
- Turn 2: `HKI2`
  - Expected: classifier `data_query` → reconstructed question → Sonnet fetches arrivals for 2026-05-04 at HKI2.
- Turn 3: `only Booking.com`
  - Expected: classifier reconstructs `effective_question` with the BOOKINGCOM filter *and* carries HKI2 + the date forward. NO re-ask of hotel.

### A3 `[ ]` Correction mid-thread
- Thread: *new*
- Turn 1: `Arrivals today at HKI2`
- Turn 2: `sorry I meant HKI3`
  - Expected: classifier reconstructs with HKI3 (not HKI2). `data_query`. Thread state after this turn: both HKI2 and HKI3 in `hotelLabels` but the latest query ran for HKI3.

### A4 `[ ]` Multi-message build-up
- Thread: *new*
- Turn 1: `arrivals` → expected: classifier `needs_clarification` (missing hotel AND date scope).
- Turn 2: `at HKI2`
  - Expected: classifier may still need date or emit data_query with "arrivals at HKI2 today" and default the date. Either is acceptable.
- Turn 3: `for May 5th`
  - Expected: classifier `data_query` → reconstructed = "arrivals at HKI2 on 2026-05-05". Sonnet queries arrivals.

### A5 `[ ]` Reservation-id continuity
- Thread: *new*
- Turn 1: `Show me reservation 681569518`
  - Expected: 9 digits → picker pulls `endpoints/reservations.yaml`, routing rule says psql first. Sonnet runs `SELECT ... WHERE reservation_code = '681569518'` and returns hotel/state/uuid.
- Turn 2: `what about its payments?`
  - Expected: classifier reconstructs using the reservation from turn 1, either re-using the uuid it received or keeping `reservation_code` in context.

### A6 `[ ]` Chain-wide question
- Thread: *new*
- Message: `Chain-wide OTB for May 5th`
  - Expected: classifier `data_query`. Picker pulls `kpis.yaml`. Sonnet returns per-hotel breakdown.
  - Expected answer (total row from sales-forecast-daily, snapshot 2026-04-22, stay 2026-05-05): *165 RN / €9,795.06 / 23.40% OCC*.

---

## Category B — Restart rehydration

### B1 `[ ]` Bot restart mid-conversation
- Thread: *new*
- Turn 1: `OTB for HKI2 on May 4th`
  - Expected answer: *63 RN / €3,623.06* (within 1-RN tolerance).
- **Action**: restart the dev server:
  ```bash
  pkill -f 'tsx watch src/index' && sleep 2 && nohup npm run dev >> /tmp/nelson-assistant-dev/server.log 2>&1 &
  ```
- Turn 2 (same thread): `what about the invoices?`
  - Expected: classifier reconstructs using HKI2 + stay 2026-05-04 from thread state (which was persisted before the restart). No re-ask of hotel.

### B2 `[ ]` Storage sanity
- After a 2-turn conversation, open a terminal:
  ```bash
  ls .local-state/state/threads/
  cat .local-state/state/threads/<threadTs>.json | jq
  ```
  - Expected: file exists, fields match (hotelLabels, turnCount, toolsUsedCounts, totalCostUsd).

---

## Category C — Thread isolation

### C1 `[ ]` Cross-thread leakage check
- Thread A: ask `What's OTB for HKI2 on May 5th?` → answered.
- Thread B (brand new — start a fresh parent message, NOT a reply in A): `What's occupancy?`
  - Expected: classifier `needs_clarification` (asks which hotel) because thread B has no state. NOT assume HKI2 from thread A.

---

## Category D — Scope override

### D1 `[ ]` Switch to chain-wide mid-thread
- Thread: *new*
- Turn 1: `OTB for HKI2 on May 5th` → answered.
- Turn 2: `actually give me all hotels`
  - Expected: classifier reconstructs `effective_question` without HKI2 scope. Picker still pulls `kpis.yaml`. Sonnet produces a per-hotel breakdown.
  - Expected answer (stay 2026-05-05 total): 165 RN / €9,795.06.

### D2 `[ ]` Hotel swap
- Thread: *new*
- Turn 1: `arrivals at HKI2 today` → answered.
- Turn 2: `actually HKI3`
  - Expected: classifier reconstructs for HKI3 (not mixed).

---

## Category E — Mixed identifiers

### E1 `[ ]` Mixed identifier types in one message
- Thread: *new*
- Message: `compare reservation 681569518 with 426840568 and 5a8d0841-cf7c-4316-ad59-20394e93c817`
  - Expected: thread state populates `reservationCodes: [681569518, 426840568]` + `reservationUuids: [5a8d0841-...]` after the turn. Sonnet resolves each identifier properly by shape.

### E2 `[ ]` OTA ref (10-digit)
- Thread: *new*
- Message: `what's the Booking.com ref 6512678711?`
  - Expected: 10-digit → picker + Sonnet route to psql `WHERE booking_channel_reservation_id = '6512678711'`. Returns Nelson uuid + code. Sonnet can then fetch the full reservation via the API if useful.

---

## Category F — Edge cases

### F1 `[ ]` Short acknowledgement after a data reply
- After any data_query reply: send `thanks` in the same thread.
  - Expected: classifier `conversational` with a brief acknowledgement. NO Sonnet run.

### F2 `[ ]` Destructive ask in a data-heavy thread
- After a KPI or reservation thread, send: `change the customer email for 681569518 to test@example.com`
  - Expected: classifier routes to `data_query`; Sonnet looks up the reservation via psql, recognises the *support-playbook* (email-change = escalate), calls `escalate_to_human`. No API write. `lastToolName = mcp__nelson__escalate_to_human`.

### F3 `[ ]` Re-refresh same snapshot
- In a thread where you asked about HKI2 May 5th OTB earlier, send: `refresh that`.
  - Expected: Sonnet re-runs the psql with `snapshot_date = today`. Cost accumulates in thread state.

---

## Category G — Report-anchored correctness (data-matching)

Each of these has a known-correct number from the XLSX reports. Sonnet's
answer must match within ±1 RN / €100 tolerance (documented cancel-edge).

### G1 `[ ]` HKI2 OTB exact (no YoY)
- Message: `HKI2 OTB on May 5th as of today`
- Expected answer: *67 RN / €3,912.17* (exact).

### G2 `[ ]` HKI2 OTB YoY with snapshot semantics
- Message: `HKI2 OTB on May 5th vs same time last year`
- Expected answer:
  - This year (2026-05-05): *67 RN / €3,912.17*
  - Last year (2025-05-06 as of 2025-04-23 snapshot): *63 RN / €4,188.69* (exact).
  - NOT last year's actual (116 / €6,673.93). Bot must distinguish OTB-at-snapshot from Actual.

### G3 `[ ]` HKI2 OTB weekly range
- Message: `HKI2 OTB for stays May 1 to May 7`
- Expected answer: *547 RN* (ACCOMMODATION only) / *€31,785.86* (ACCOMMODATION net) — from the 7-day OTB report. Breakdown by channel should roughly match:
  - BOOKINGCOM 298 / €18,210.01
  - EXPEDIA 69 / €3,509.94
  - MOBILEAPP 7 / €418.34
  - NELSON 173 / €9,647.57

### G4 `[ ]` Chain-wide SFD total
- Message: `Chain-wide cumulative OTB revenue for stays May 3–6`
- Expected answer: *€35,218.89 cumulative OTB revenue* (from the "Cumulative Revenue OTB" column, row 2026-05-06). Or equivalent: per-day totals 6,361.27 + 7,583.54 + 9,795.06 + 11,479.02 = 35,218.89.

### G5 `[ ]` Pickup since last week
- Message: `HKI2 pickup for stay May 5th over the past week`
- Expected answer: *4 RN / +€259.64 / weekly-pickup 2.56% OCC* (from the SFD "Pick up (weekly)" column).

### G6 `[ ]` Per-channel breakdown for single stay
- Message: `HKI2 OTB by channel for May 4th`
- Expected answer (exactly matches the OTB report):
  - BOOKINGCOM: 29 RN / €1,736.53 (net)
  - EXPEDIA: 4 RN / €192.26
  - MOBILEAPP: 2 RN / €122.80
  - NELSON: 28 RN / €1,509.80 (or 29 with tolerance)
  - Plus EXTRA_BED rows.

### G7 `[ ]` ADR question
- Message: `HKI2 ADR on May 5th`
- Expected answer: *€58.39* (ADR = Revenue / RN = 3912.17 / 67 = 58.39).

### G8 `[ ]` Occupancy question
- Message: `HKI2 occupancy on May 5th`
- Expected answer: *42.95%* (from SFD OCC column for HKI2 2026-05-05).

---

## After-test ritual

When a scenario fails, do one of:

1. Fix the mistake in-Slack: `debug <what went wrong + expected vs got>`. Claude Code picks it up via the bot log, diagnoses, fixes, replies on the thread.
2. Mark `[✗]` in this doc and come back to it.
3. If correctness is fine but presentation is off (table, tone, verbosity), flag as `[~]` with a note — Sandeep decides whether it's worth a format-only iteration.

When all scenarios are `[✓]`, the thread-state / classifier / OTB / identifier-routing stack is production-ready for the next deploy.
