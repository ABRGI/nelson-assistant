// Document the identifier formats used by Nelson vs OTA bookings so the
// agent can route a lookup straight to DB or API without guessing.
require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const c = new Client({
    connectionString: process.env.PSQL_READ_ONLY_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const cols = await c.query(`
    SELECT column_name, data_type, udt_name, character_maximum_length
      FROM information_schema.columns
     WHERE table_schema = 'nelson' AND table_name = 'reservation'
     ORDER BY ordinal_position;`);
  const colNames = cols.rows.map((r) => r.column_name);

  // Find a recency column — Nelson uses check_in_date or date_created etc.
  const recencyCandidates = ['check_in_date', 'date_created', 'created_at', 'confirmed', 'booking_date', 'inserted_at'];
  const recencyCol = recencyCandidates.find((c) => colNames.includes(c));

  const sampleCols = ['reservation_code', 'uuid', 'booking_channel_reservation_id'];
  const selectList = sampleCols.map((n) => `${n}::text AS ${n}`).join(', ');
  const samples = {};
  const channels = ['NELSON', 'BOOKINGCOM', 'EXPEDIA', 'MOBILEAPP', 'LEGACY'];
  for (const ch of channels) {
    try {
      const r = await c.query(
        `SELECT ${selectList}, booking_channel
           FROM nelson.reservation
          WHERE booking_channel = $1
            ${recencyCol ? `AND ${recencyCol} > CURRENT_DATE - INTERVAL '60 days'` : ''}
          ORDER BY id DESC
          LIMIT 5;`,
        [ch],
      );
      samples[ch] = r.rows;
    } catch (e) {
      samples[ch] = { error: e.message };
    }
  }

  const lenStats = {};
  for (const colName of sampleCols) {
    try {
      const r = await c.query(
        `SELECT booking_channel, COUNT(*)::int AS n,
                MIN(length(${colName})) AS min_len,
                MAX(length(${colName})) AS max_len
           FROM nelson.reservation
          WHERE ${colName} IS NOT NULL
            ${recencyCol ? `AND ${recencyCol} > CURRENT_DATE - INTERVAL '60 days'` : ''}
          GROUP BY booking_channel
          ORDER BY booking_channel;`,
      );
      lenStats[colName] = r.rows;
    } catch (e) {
      lenStats[colName] = { error: e.message };
    }
  }

  await c.end();
  console.log(JSON.stringify({ recencyCol, date_like_columns: colNames.filter((n) => /date|created|at|confirmed/i.test(n)), samples, lenStats }, null, 2));
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(2); });
