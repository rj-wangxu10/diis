const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("apps/api/storage/metadata/workbench.sqlite");

// Check users table
console.log("=== Users ===");
try {
  const users = db.prepare("SELECT id, email, display_name, created_at FROM users").all();
  console.log(JSON.stringify(users, null, 2));
} catch (e) {
  console.log("Error:", e.message);
}

// Check user_password_credentials
console.log("\n=== User Password Credentials ===");
try {
  const creds = db.prepare("SELECT user_id, created_at FROM user_password_credentials").all();
  console.log(JSON.stringify(creds, null, 2));
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

// Check auth_tokens
console.log("\n=== Auth Tokens ===");
try {
  const tokens = db.prepare("SELECT user_id, token_type, created_at FROM auth_tokens LIMIT 5").all();
  console.log(JSON.stringify(tokens, null, 2));
} catch (e) {
  console.log("Error:", e.message);
}

db.close();
