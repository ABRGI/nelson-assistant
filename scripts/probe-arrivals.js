require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const c = new Client({ connectionString: process.env.PSQL_READ_ONLY_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  // First, find the columns on nelson.reservation related to check-in/out/arrival
  const cols = await c.query(`
    SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'nelson' AND table_name = 'reservation'
       AND (column_name ILIKE '%check%' OR column_name ILIKE '%arrival%'
            OR column_name ILIKE '%departure%' OR column_name ILIKE '%start%' OR column_name ILIKE '%end%')
     ORDER BY ordinal_position;`);
  console.log('=== date columns on nelson.reservation ===');
  for (const r of cols.rows) console.log(`${r.column_name} (${r.data_type})`);

  // Arrivals today at HKI2 (hotel_id=3) by state
  const arrivals = await c.query(`
    SELECT state, COUNT(*)::int AS n
      FROM nelson.reservation
     WHERE hotel_id = 3
       AND DATE(check_in) = CURRENT_DATE
     GROUP BY state ORDER BY state;`);
  console.log('\n=== HKI2 arrivals today by state (DATE(check_in)=today) ===');
  for (const r of arrivals.rows) console.log(`${r.state}: ${r.n}`);

  // Check if check_in is a timestamp or a date
  const sample = await c.query(`
    SELECT check_in, check_out, state, booking_channel
      FROM nelson.reservation
     WHERE hotel_id = 3 AND DATE(check_in) = CURRENT_DATE
     ORDER BY check_in LIMIT 3;`);
  console.log('\n=== sample 3 rows ===');
  for (const r of sample.rows) console.log(JSON.stringify(r));

  await c.end();
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(2); });
