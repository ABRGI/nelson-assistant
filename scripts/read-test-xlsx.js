// One-off: dump the ground-truth numbers from the XLSX reports Sandeep dropped
// in .test_data/. Used to set expectations for the self-test pass.
require('dotenv').config();
const XLSX = require('xlsx');
const path = require('path');

const files = [
  '.test_data/on-the-books-report-hki2-20260422-20260504-20260504.xlsx',
  '.test_data/on-the-books-report-hki2-20260422-20260501-20260507.xlsx',
  '.test_data/sales-forecast-daily-report-all-20260422-20260503-20260506.xlsx',
];

for (const f of files) {
  const abs = path.resolve(f);
  console.log(`\n\n=== ${f} ===`);
  const wb = XLSX.readFile(abs);
  for (const sheetName of wb.SheetNames) {
    console.log(`\n--- sheet: ${sheetName} ---`);
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    for (const row of rows) {
      console.log(JSON.stringify(row));
    }
  }
}
