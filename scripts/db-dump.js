require('dotenv').config();
const { Client } = require('pg');

// Application-level enums are stored as varchar in Postgres (not pg_enum) so we
// have to derive them from DISTINCT values. Cap row scans — these tables are
// huge; use explicit small queries where possible.
const QUERIES = {
  pg_enums: `
    SELECT n.nspname AS schema, t.typname AS name,
           array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
     GROUP BY n.nspname, t.typname
     ORDER BY n.nspname, t.typname;`,

  nelson_hotels: `
    SELECT id, label, name, city, currency, country, time_zone,
           check_in_time::text AS check_in_time, check_out_time::text AS check_out_time,
           available
      FROM nelson.hotel ORDER BY id;`,

  nelson_product_types: `SELECT DISTINCT type FROM nelson.product ORDER BY type;`,
  nelson_products_by_type: `
    SELECT type, COUNT(*)::int AS count FROM nelson.product GROUP BY type ORDER BY type;`,

  nelson_booking_channels: `
    SELECT DISTINCT booking_channel FROM nelson.reservation
     WHERE booking_channel IS NOT NULL ORDER BY booking_channel;`,
  nelson_reservation_states: `
    SELECT DISTINCT state FROM nelson.reservation
     WHERE state IS NOT NULL ORDER BY state;`,
  nelson_reservation_types: `
    SELECT type, COUNT(*)::int AS count FROM nelson.reservation GROUP BY type ORDER BY type;`,
  nelson_change_types: `
    SELECT DISTINCT change_type FROM nelson.reservation
     WHERE change_type IS NOT NULL ORDER BY change_type;`,

  nelson_room_columns: `
    SELECT column_name, data_type, udt_name
      FROM information_schema.columns
     WHERE table_schema = 'nelson' AND table_name = 'room'
     ORDER BY ordinal_position;`,

  nelson_product_columns: `
    SELECT column_name, data_type, udt_name
      FROM information_schema.columns
     WHERE table_schema = 'nelson' AND table_name = 'product'
     ORDER BY ordinal_position;`,

  // Room "type" is actually the associated product's type.
  nelson_room_to_product: `
    SELECT DISTINCT p.type AS product_type, COUNT(*)::int AS rooms
      FROM nelson.room r JOIN nelson.product p ON p.id = r.product_id
     WHERE r.available = true
     GROUP BY p.type ORDER BY product_type;`,

  nelson_table_sizes_top: `
    SELECT relname AS table_name, n_live_tup AS approx_rows
      FROM pg_stat_user_tables
     WHERE schemaname = 'nelson'
     ORDER BY n_live_tup DESC LIMIT 40;`,
};

async function main() {
  const c = new Client({
    connectionString: process.env.PSQL_READ_ONLY_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  const out = {};
  for (const [k, sql] of Object.entries(QUERIES)) {
    try { out[k] = (await c.query(sql)).rows; } catch (e) { out[k] = { error: e.message }; }
  }
  await c.end();
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(2); });
