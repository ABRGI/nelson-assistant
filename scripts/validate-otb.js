// Validate canonical_sql.otb_at_snapshot against the XLSX reports under
// .test_data/. Prints per-cell deltas so we can see exactly where the SQL
// drifts from the authoritative report.
require('dotenv').config();
const { Client } = require('pg');

// Ground truth pulled from the XLSX reports (2026-04-22 snapshot).
// Numbers are ACCOMMODATION-only RN + ACCOMMODATION+EXTRA_BED net revenue.
const CASES = [
  // HKI2 current-year OTB per stay date, snapshot = 2026-04-22.
  { label: 'HKI2 2026-05-03 OTB current (snap 2026-04-22)',
    hotelId: 3, stayDate: '2026-05-03', snapshotDate: '2026-04-22',
    expected: { rn: 59, net: 3342.93 } },
  { label: 'HKI2 2026-05-04 OTB current (snap 2026-04-22)',
    hotelId: 3, stayDate: '2026-05-04', snapshotDate: '2026-04-22',
    expected: { rn: 63, net: 3623.06 } },
  { label: 'HKI2 2026-05-05 OTB current (snap 2026-04-22)',
    hotelId: 3, stayDate: '2026-05-05', snapshotDate: '2026-04-22',
    expected: { rn: 67, net: 3912.17 } },
  { label: 'HKI2 2026-05-06 OTB current (snap 2026-04-22)',
    hotelId: 3, stayDate: '2026-05-06', snapshotDate: '2026-04-22',
    expected: { rn: 76, net: 4459.53 } },

  // HKI2 prior-year OTB at equivalent -364d snapshot.
  { label: 'HKI2 2025-05-04 OTB (snap 2025-04-23) — LY of 2026-05-03',
    hotelId: 3, stayDate: '2025-05-04', snapshotDate: '2025-04-23',
    expected: { rn: 52, net: 3312.05 } },
  { label: 'HKI2 2025-05-05 OTB (snap 2025-04-23) — LY of 2026-05-04',
    hotelId: 3, stayDate: '2025-05-05', snapshotDate: '2025-04-23',
    expected: { rn: 51, net: 3132.48 } },
  { label: 'HKI2 2025-05-06 OTB (snap 2025-04-23) — LY of 2026-05-05',
    hotelId: 3, stayDate: '2025-05-06', snapshotDate: '2025-04-23',
    expected: { rn: 63, net: 4188.69 } },
  { label: 'HKI2 2025-05-07 OTB (snap 2025-04-23) — LY of 2026-05-06',
    hotelId: 3, stayDate: '2025-05-07', snapshotDate: '2025-04-23',
    expected: { rn: 55, net: 3588.28 } },

  // HKI2 LY Actual (no snapshot — final pickup for that stay date).
  // We use a large snapshotDate (far in the future) so every line_item
  // confirmed by now is included.
  { label: 'HKI2 2025-05-04 ACTUAL (no snapshot filter)',
    hotelId: 3, stayDate: '2025-05-04', snapshotDate: '2030-01-01',
    expected: { rn: 83, net: 5206.48 } },
  { label: 'HKI2 2025-05-05 ACTUAL',
    hotelId: 3, stayDate: '2025-05-05', snapshotDate: '2030-01-01',
    expected: { rn: 93, net: 5228.41 } },
  { label: 'HKI2 2025-05-06 ACTUAL',
    hotelId: 3, stayDate: '2025-05-06', snapshotDate: '2030-01-01',
    expected: { rn: 116, net: 6673.93 } },
];

const OTB_SNAPSHOT_SQL = `
  WITH snap AS (SELECT ($3::timestamp + TIME '15:43:00') AS ts)
  SELECT COUNT(*) FILTER (WHERE p.type = 'ACCOMMODATION') AS room_nights,
         SUM(nelson.net_price(li.price, li.vat_percentage))
           FILTER (WHERE p.type IN ('ACCOMMODATION','EXTRA_BED')) AS net_revenue
    FROM nelson.line_item li
    JOIN nelson.reservation r ON r.id = li.reservation_id
    JOIN nelson.product p     ON p.id = li.product_id
    CROSS JOIN snap
   WHERE r.hotel_id = $1
     AND li.invoice_date = $2::date
     AND li.confirmed IS NOT NULL
     AND li.confirmed <= snap.ts
     AND (
       (li.cancelled IS NULL AND li.to_be_cancelled IS NULL)
       OR li.refundable IS FALSE
       OR (li.cancelled IS NOT NULL AND li.cancelled > snap.ts)
       OR (li.to_be_cancelled IS NOT NULL AND li.to_be_cancelled > snap.ts)
     );`;

async function main() {
  const c = new Client({
    connectionString: process.env.PSQL_READ_ONLY_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const results = [];
  for (const tc of CASES) {
    const r = await c.query(OTB_SNAPSHOT_SQL, [tc.hotelId, tc.stayDate, tc.snapshotDate]);
    const row = r.rows[0];
    const rn = Number(row.room_nights);
    const net = Number(row.net_revenue);
    const dRn = rn - tc.expected.rn;
    const dNet = +(net - tc.expected.net).toFixed(2);
    results.push({ label: tc.label, expected: tc.expected, got: { rn, net: +net.toFixed(2) }, delta: { rn: dRn, net: dNet } });
  }

  await c.end();

  console.log('\n=== OTB SQL vs Report ===\n');
  let pass = 0;
  for (const r of results) {
    const okRn = Math.abs(r.delta.rn) <= 1;           // tolerate ±1 cancel-edge row
    const okNet = Math.abs(r.delta.net) <= 100;        // tolerate ~€100 on one row
    const mark = (okRn && okNet) ? '✓' : '✗';
    if (okRn && okNet) pass++;
    console.log(`${mark} ${r.label}`);
    console.log(`    expected: ${r.expected.rn} RN / €${r.expected.rn === 0 ? '0' : r.expected.net.toFixed(2)}`);
    console.log(`    got:      ${r.got.rn} RN / €${r.got.net.toFixed(2)}`);
    console.log(`    delta:    ${r.delta.rn >= 0 ? '+' : ''}${r.delta.rn} RN / ${r.delta.net >= 0 ? '+' : ''}€${r.delta.net.toFixed(2)}`);
  }
  console.log(`\n${pass}/${results.length} cases within tolerance (±1 RN, ±€100).`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(2); });
