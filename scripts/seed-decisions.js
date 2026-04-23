// One-off: write the initial set of decision records distilled from the
// /debug and /learning session fixes shipped during 2026-04-22/23. Reruns
// safely — each saveDecision is an upsert keyed on slug.
require('dotenv').config();
const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const tsxReq = require('tsx/cjs/api');
  const { FsJsonStore } = tsxReq.require(pathToFileURL(path.resolve('src/state/fs.ts')).href, __filename);
  const { saveDecision } = tsxReq.require(pathToFileURL(path.resolve('src/state/decisions.ts')).href, __filename);

  const stateRoot = process.env.LOCAL_STATE_ROOT ?? './.local-state';
  const store = new FsJsonStore(path.join(stateRoot, 'state'));
  const now = new Date().toISOString();

  const DECISIONS = [
    {
      schema: 1,
      slug: 'otb-vs-current-total',
      version: 1,
      created: now,
      updated: now,
      failure_pattern: "For 'OTB same time last year' questions, Sonnet returned the CURRENT total for last year's stay date instead of OTB-at-equivalent-snapshot.",
      recognise_phrases: [
        'OTB', 'on the books', 'same time last year', 'pace',
        'as of now vs last year', 'last year OTB', 'YoY OTB',
      ],
      correct_behaviour: "Use canonical_sql.otb_at_snapshot from kpis.yaml. This year: stay_date = user's date, snapshot = today. Last year: stay_date = user's date − 364d (DoW-aligned), snapshot = today − 364d. Cutoff = 15:43 local on snapshot_date (matches Nelson's Sales Forecast Daily extraction). RN counts ACCOMMODATION-only; revenue sums ACCOMMODATION+EXTRA_BED.",
      wrong_behaviour: 'Plain SUM(net_price) on nelson.line_item without the snapshot filter, or returning last-year Actual as if it were OTB. These are different columns in the SFD report.',
      related_leaves: ['knowledge/nelson/kpis.yaml#otb_at_snapshot', 'knowledge/nelson/kpis.yaml#otb_and_sales_forecast'],
      related_commits: ['2929db3', '866437d', '0942648'],
      source_threads: ['1776862642.256219', '1776863227.002729', '1776864056.540009'],
      related_leaves_suffix: undefined,
    },
    {
      schema: 1,
      slug: 'datemode-for-arrivals-not-exact',
      version: 1,
      created: now,
      updated: now,
      failure_pattern: "Sonnet used dateMode=EXACT on /api/management/secure/reservations for 'arrivals today' and got 0 rows, when dateMode=ARRIVAL would have returned the real count.",
      recognise_phrases: [
        'arrivals', 'arriving', 'check-ins', "who's arriving",
        'who is arriving', 'arrivals at', 'arrivals today',
        'reservations for', 'checkouts', 'departures',
        'staying tonight', 'in-house', 'occupancy on',
      ],
      correct_behaviour: 'Map user phrasing to dateMode BEFORE calling the API: arrivals → dateMode=ARRIVAL; departures → DEPARTURE; staying/in-house → STAY; booked-on → CREATED. EXACT is almost never right — it means "reservation spans EXACTLY that one night". Always pair with totalCount=true. If first call returns 0 rows on a date with clear activity, retry ARRIVAL → STAY → CREATED before concluding empty data. Cross-check with psql SELECT COUNT(*) GROUP BY state FROM nelson.reservation WHERE DATE(check_in) = target.',
      wrong_behaviour: 'Defaulting to dateMode=EXACT, then concluding "no reservations exist" when EXACT returns 0.',
      related_leaves: ['knowledge/nelson/endpoints/reservations.yaml#dateMode_semantics', 'knowledge/nelson/endpoints/reservations.yaml#dateMode_pick_procedure', 'knowledge/nelson/bugs.yaml'],
      related_commits: ['866437d', '90b1a7c'],
      source_threads: ['1776898154.424829', '1776900320.710969'],
    },
    {
      schema: 1,
      slug: 'reservation-identifier-routing',
      version: 1,
      created: now,
      updated: now,
      failure_pattern: "Sonnet hit /reservations?code=... for a 9-digit reservation_code, the API's fuzzy match returned nothing, and Sonnet concluded 'reservation does not exist'.",
      recognise_phrases: [
        'reservation ', 'booking ', 'reservation code',
        'booking code', 'booking.com ref', 'otb ref',
        'reservation_code', 'find reservation',
      ],
      correct_behaviour: 'Route by shape BEFORE calling the API: 36-char UUID → GET /api/management/secure/reservations/{uuid}. EXACTLY 9 digits → psql SELECT uuid, reservation_code, booking_channel, state FROM nelson.reservation WHERE reservation_code = <code> FIRST (DB is authoritative, API fuzzy match misses). EXACTLY 10 digits → psql WHERE booking_channel_reservation_id = <n> (Booking.com / Expedia OTA ref). Take the returned uuid and continue via API for payments/invoices.',
      wrong_behaviour: "Hitting the API's /reservations?code= search blindly and concluding 'not found' on a miss.",
      related_leaves: ['knowledge/nelson/endpoints/reservations.yaml#identifiers', 'knowledge/nelson/endpoints/reservations.yaml#how_to_route_a_user_supplied_identifier'],
      related_commits: ['91a73a9'],
      source_threads: [],
    },
    {
      schema: 1,
      slug: 'room-nights-accommodation-only',
      version: 1,
      created: now,
      updated: now,
      failure_pattern: 'Sonnet inflated Room Nights by adding EXTRA_BED line items to the count, giving e.g. 70 instead of 67. Revenue stayed right because extra-bed revenue is small.',
      recognise_phrases: [
        'room nights', 'RN ', 'rooms sold', 'usages',
        'ADR ', 'RevPAR', 'occupancy',
      ],
      correct_behaviour: 'Revenue sums ACCOMMODATION + EXTRA_BED. Room Nights counts ACCOMMODATION ONLY. Use FILTER (WHERE p.type = \'ACCOMMODATION\') for the count and FILTER (WHERE p.type IN (\'ACCOMMODATION\', \'EXTRA_BED\')) for the revenue sum. These are different metrics with different product filters.',
      wrong_behaviour: "Single WHERE p.type IN ('ACCOMMODATION','EXTRA_BED') applied to BOTH metrics.",
      related_leaves: ['knowledge/nelson/kpis.yaml#core_formula_facts', 'knowledge/nelson/kpis.yaml#usages_or_room_nights_sold'],
      related_commits: ['91a73a9', '2929db3'],
      source_threads: ['1776861054.383469', '1776863227.002729'],
    },
  ];

  for (const d of DECISIONS) {
    // strip the experimental field we accidentally added on one record
    if ('related_leaves_suffix' in d) delete d.related_leaves_suffix;
    await saveDecision(store, d);
    console.log(`✓ saved decisions/${d.slug}.json`);
  }
  console.log(`\n${DECISIONS.length} decisions written to ${stateRoot}/state/decisions/`);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(2); });
