const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("storage/metadata/workbench.sqlite");

// List all tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log("=== Tables ===");
console.log(tables.map(t => t.name).join("\n"));

// Check users table
console.log("\n=== Users ===");
try {
  const users = db.prepare("SELECT id, email, display_name, created_at FROM users").all();
  console.log(JSON.stringify(users, null, 2));
} catch (e) {
  console.log("Error:", e.message);
}

// Check auth_sessions
console.log("\n=== Auth Sessions ===");
try {
  const sessions = db.prepare("SELECT id, user_id, created_at FROM auth_sessions LIMIT 5").all();
  console.log(JSON.stringify(sessions, null, 2));
} catch (e) {
  console.log("Error:", e.message);
}

db.close();
