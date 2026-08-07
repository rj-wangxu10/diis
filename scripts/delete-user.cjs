const { DatabaseSync } = require("node:sqlite");

const email = process.argv[2];
if (!email) {
  console.error("Usage: node scripts/delete-user.cjs <email>");
  process.exit(1);
}

const dbPath = process.env.METADATA_DB_PATH || "apps/api/storage/metadata/workbench.sqlite";
const db = new DatabaseSync(dbPath);

db.exec("PRAGMA foreign_keys = ON");

try {
  const userRow = db.prepare("SELECT id, email, display_name, created_at FROM users WHERE lower(email) = lower(?)").get(email);
  if (!userRow) {
    console.log(`User not found: ${email}`);
    process.exit(0);
  }

  const userId = userRow.id;
  console.log(`Found user: ${userRow.id} | ${userRow.email} | ${userRow.display_name}`);

  // Diagnostic: count related records
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  const userIdTables = [];
  for (const table of tables) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all();
      if (cols.some(c => c.name === "user_id")) {
        const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE user_id = ?`).get(userId).c;
        if (count > 0) userIdTables.push({ table, count });
      }
    } catch {
      // ignore
    }
  }
  console.log("\nRelated records by user_id:");
  for (const { table, count } of userIdTables) {
    console.log(`  ${table}: ${count}`);
  }

  // Find personal workspace
  const workspaceRows = db.prepare("SELECT id, name FROM workspaces WHERE owner_user_id = ?").all(userId);
  console.log("\nWorkspaces owned:");
  for (const w of workspaceRows) {
    console.log(`  ${w.id} | ${w.name}`);
  }

  console.log("\nDeleting user and all associated data...");

  db.exec("BEGIN IMMEDIATE");
  try {
    // Delete auth-related records
    db.prepare("DELETE FROM auth_audit_events WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM auth_audit_events WHERE lower(email) = lower(?)").run(email);
    db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM auth_tokens WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM user_password_credentials WHERE user_id = ?").run(userId);

    // Delete workspace memberships and workspaces
    db.prepare("DELETE FROM workspace_memberships WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM workspace_memberships WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)").run(userId);
    db.prepare("DELETE FROM workspaces WHERE owner_user_id = ?").run(userId);

    // Delete user-created sessions and their descendants (if any)
    const sessionRows = db.prepare("SELECT id FROM sessions WHERE user_id = ?").all(userId);
    const sessionIds = sessionRows.map(r => r.id);
    if (sessionIds.length > 0) {
      const placeholders = sessionIds.map(() => "?").join(", ");
      db.prepare(`DELETE FROM session_branches WHERE user_id = ? AND (child_session_id IN (${placeholders}) OR parent_session_id IN (${placeholders}) OR root_session_id IN (${placeholders}))`).run(userId, ...sessionIds, ...sessionIds, ...sessionIds);
      db.prepare(`DELETE FROM artifact_versions WHERE user_id = ? AND artifact_id IN (SELECT id FROM artifacts WHERE user_id = ? AND session_id IN (${placeholders}))`).run(userId, userId, ...sessionIds);
      db.prepare(`DELETE FROM artifacts WHERE user_id = ? AND session_id IN (${placeholders})`).run(userId, ...sessionIds);
      db.prepare(`DELETE FROM checkpoints WHERE user_id = ? AND session_id IN (${placeholders})`).run(userId, ...sessionIds);
      db.prepare(`DELETE FROM trace_sections WHERE user_id = ? AND session_id IN (${placeholders})`).run(userId, ...sessionIds);
      db.prepare(`DELETE FROM context_package_snapshots WHERE user_id = ? AND session_id IN (${placeholders})`).run(userId, ...sessionIds);
      db.prepare(`DELETE FROM conversation_messages WHERE user_id = ? AND session_id IN (${placeholders})`).run(userId, ...sessionIds);
      db.prepare(`DELETE FROM conversation_summaries WHERE user_id = ? AND session_id IN (${placeholders})`).run(userId, ...sessionIds);
      db.prepare(`DELETE FROM interactions WHERE user_id = ? AND session_id IN (${placeholders})`).run(userId, ...sessionIds);
      db.prepare(`DELETE FROM query_history WHERE user_id = ? AND session_id IN (${placeholders})`).run(userId, ...sessionIds);
      db.prepare(`DELETE FROM long_term_memories WHERE user_id = ? AND session_id IN (${placeholders})`).run(userId, ...sessionIds);
      db.prepare(`DELETE FROM run_events WHERE user_id = ? AND session_id IN (${placeholders})`).run(userId, ...sessionIds);
      db.prepare(`DELETE FROM runs WHERE user_id = ? AND session_id IN (${placeholders})`).run(userId, ...sessionIds);
      db.prepare(`DELETE FROM file_asset_refs WHERE user_id = ? AND session_id IN (${placeholders})`).run(userId, ...sessionIds);
      db.prepare(`DELETE FROM sessions WHERE user_id = ? AND id IN (${placeholders})`).run(userId, ...sessionIds);
    }

    // Delete any remaining user-scoped records (in case schema has more)
    for (const table of tables) {
      try {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all();
        if (cols.some(c => c.name === "user_id")) {
          db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
        }
      } catch {
        // ignore
      }
    }

    // Finally delete the user
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);

    db.exec("COMMIT");
    console.log(`\nUser ${email} and all associated data deleted successfully.`);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
} finally {
  db.close();
}
