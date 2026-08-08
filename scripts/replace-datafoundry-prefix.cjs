const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('apps/api/storage/metadata/workbench.sqlite');

const rows = db.prepare("SELECT id, payload_json FROM context_package_snapshots WHERE payload_json LIKE '%datafoundry%'").all();
console.log(`Found ${rows.length} rows with 'datafoundry' path`);

let updated = 0;
for (const row of rows) {
  const newJson = row.payload_json.replace(/D:\\\\work\\\\datafoundry/gi, 'D:\\\\work\\\\diis');
  if (newJson !== row.payload_json) {
    db.prepare('UPDATE context_package_snapshots SET payload_json = ? WHERE id = ?').run(newJson, row.id);
    updated++;
  }
}
console.log(`Updated ${updated} rows`);
db.close();
