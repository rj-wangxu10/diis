const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('storage/metadata/workbench.sqlite');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log('Tables:');
tables.forEach(t => console.log('  ' + t.name));
console.log('\nUsers:');
const users = db.prepare('SELECT id, email, display_name FROM users').all();
users.forEach(u => console.log(`  ${u.id} | ${u.email} | ${u.display_name}`));
db.close();
