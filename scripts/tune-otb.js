// Try a few snapshot-boundary variations to see which one best matches the
// reports. Current drift is ±1 RN on several cases — we'd like 0.
require('dotenv').config();
const { Client } = require('pg');

const CASES = [
  { label: '2026-05-03', hotelId: 3, stayDate: '2026-05-03', snapshotDate: '2026-04-22', expected: { rn: 59, net: 3342.93 } },
  { label: '2026-05-04', hotelId: 3, stayDate: '2026-05-04', snapshotDate: '2026-04-22', expected: { rn: 63, net: 3623.06 } },
  { label: '2026-05-05', hotelId: 3, stayDate: '2026-05-05', snapshotDate: '2026-04-22', expected: { rn: 67, net: 3912.17 } },
  { label: '2026-05-06', hotelId: 3, stayDate: '2026-05-06', snapshotDate: '2026-04-22', expected: { rn: 76, net: 4459.53 } },
  { label: 'LY 2025-05-04', hotelId: 3, stayDate: '2025-05-04', snapshotDate: '2025-04-23', expected: { rn: 52, net: 3312.05 } },
  { label: 'LY 2025-05-05', hotelId: 3, stayDate: '2025-05-05', snapshotDate: '2025-04-23', expected: { rn: 51, net: 3132.48 } },
  { label: 'LY 2025-05-06', hotelId: 3, stayDate: '2025-05-06', snapshotDate: '2025-04-23', expected: { rn: 63, net: 4188.69 } },
  { label: 'LY 2025-05-07', hotelId: 3, stayDate: '2025-05-07', snapshotDate: '2025-04-23', expected: { rn: 55, net: 3588.28 } },
];

// The snapshot-boundary variants to try. Each returns a SQL condition
// expression that defines "included in OTB at snapshot date".
const VARIANTS = {
  // V0: the current shipped rule (end of snapshot day).
  v0_end_of_day: {
    cutoff: `($3::date + INTERVAL '1 day' - INTERVAL '1 second')`,
    cancelBoundary: `($3::date + INTERVAL '1 day')`,
  },
  // V1: exact end-of-day but cancel boundary == cutoff (tighter).
  v1_tight_boundary: {
    cutoff: `($3::date + INTERVAL '1 day' - INTERVAL '1 second')`,
    cancelBoundary: `($3::date + INTERVAL '1 day' - INTERVAL '1 second')`,
  },
  // V2: start of NEXT day (midnight of snapshot+1).
  v2_next_midnight: {
    cutoff: `($3::date + INTERVAL '1 day')`,
    cancelBoundary: `($3::date + INTERVAL '1 day')`,
  },
  // V3: just the date itself (start of snapshot day — strict <= date).
  v3_date_literal: {
    cutoff: `$3::date`,
    cancelBoundary: `$3::date`,
  },
  // V4: snapshot date exactly at 16:29 (OTB report extraction time).
  v4_1629_local: {
    cutoff: `($3::timestamp + TIME '16:29:00')`,
    cancelBoundary: `($3::timestamp + TIME '16:29:00')`,
  },
  // V5: snapshot date exactly at 15:43 (sales-forecast extraction time).
  v5_1543_local: {
    cutoff: `($3::timestamp + TIME '15:43:00')`,
    cancelBoundary: `($3::timestamp + TIME '15:43:00')`,
  },
};

function buildSql(variant) {
  return `
    SELECT COUNT(*) FILTER (WHERE p.type = 'ACCOMMODATION') AS rn,
           SUM(nelson.net_price(li.price, li.vat_percentage))
             FILTER (WHERE p.type IN ('ACCOMMODATION','EXTRA_BED')) AS net
      FROM nelson.line_item li
      JOIN nelson.reservation r ON r.id = li.reservation_id
      JOIN nelson.product p     ON p.id = li.product_id
     WHERE r.hotel_id = $1
       AND li.invoice_date = $2::date
       AND li.confirmed IS NOT NULL
       AND li.confirmed <= ${variant.cutoff}
       AND (
         (li.cancelled IS NULL AND li.to_be_cancelled IS NULL)
         OR li.refundable IS FALSE
         OR (li.cancelled IS NOT NULL AND li.cancelled > ${variant.cancelBoundary})
         OR (li.to_be_cancelled IS NOT NULL AND li.to_be_cancelled > ${variant.cancelBoundary})
       );`;
}

async function main() {
  const c = new Client({
    connectionString: process.env.PSQL_READ_ONLY_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const scores = {};
  for (const [name, v] of Object.entries(VARIANTS)) {
    scores[name] = { exactRn: 0, withinTol: 0, totalRnDelta: 0, totalNetDelta: 0 };
  }

  for (const tc of CASES) {
    const line = [`\n${tc.label} (expected ${tc.expected.rn} / €${tc.expected.net})`];
    for (const [name, v] of Object.entries(VARIANTS)) {
      const r = await c.query(buildSql(v), [tc.hotelId, tc.stayDate, tc.snapshotDate]);
      const rn = Number(r.rows[0].rn);
      const net = Number(r.rows[0].net) || 0;
      const dRn = rn - tc.expected.rn;
      const dNet = +(net - tc.expected.net).toFixed(2);
      line.push(`  ${name.padEnd(20)} → ${rn} RN / €${net.toFixed(2)}  (Δ ${dRn >= 0 ? '+' : ''}${dRn} RN / ${dNet >= 0 ? '+' : ''}€${dNet.toFixed(2)})`);
      if (dRn === 0) scores[name].exactRn++;
      if (Math.abs(dRn) <= 1 && Math.abs(dNet) <= 100) scores[name].withinTol++;
      scores[name].totalRnDelta += Math.abs(dRn);
      scores[name].totalNetDelta += Math.abs(dNet);
    }
    console.log(line.join('\n'));
  }
  await c.end();

  console.log('\n=== Variant scorecard ===');
  for (const [name, s] of Object.entries(scores)) {
    console.log(`  ${name.padEnd(20)}  exact ${s.exactRn}/${CASES.length}  withinTol ${s.withinTol}/${CASES.length}  sum|ΔRN|=${s.totalRnDelta}  sum|Δ€|=${s.totalNetDelta.toFixed(2)}`);
  }
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(2); });
