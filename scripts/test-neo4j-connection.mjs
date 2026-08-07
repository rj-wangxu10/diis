// Quick Neo4j connection test
import neo4j from "neo4j-driver";

const URI = process.env.NEO4J_URI ?? "bolt://172.16.3.247:7687";
const USER = process.env.NEO4J_USER ?? "neo4j";
const PASSWORD = process.env.NEO4J_PASSWORD ?? "neo4j123";
const DATABASE = process.env.NEO4J_DATABASE ?? "semanticgraph";

console.log(`Connecting to: ${URI}`);
console.log(`User: ${USER}`);
console.log(`Database: ${DATABASE}`);

const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD));

async function test() {
  // Test 1: Verify connectivity
  console.log("\n--- Test 1: verifyConnectivity ---");
  try {
    await driver.verifyConnectivity();
    console.log("[OK] Connectivity verified!");
  } catch (e) {
    console.log("[FAIL] Connectivity check failed:", e.message);
  }

  // Test 2: Simple query on system database
  console.log("\n--- Test 2: Query system database ---");
  const sysSession = driver.session({ database: "system" });
  try {
    const result = await sysSession.run("RETURN 1 AS num");
    console.log("[OK] System query succeeded:", result.records[0]?.get("num")?.toNumber?.() ?? result.records[0]?.get("num"));
  } catch (e) {
    console.log("[FAIL] System query failed:", e.message);
  } finally {
    await sysSession.close();
  }

  // Test 3: List databases
  console.log("\n--- Test 3: List databases ---");
  const listSession = driver.session({ database: "system" });
  try {
    const result = await listSession.run("SHOW DATABASES");
    for (const record of result.records) {
      const name = record.get("name");
      const status = record.get("currentStatus") ?? record.get("status") ?? "unknown";
      console.log(`  DB: ${name} — status: ${status}`);
    }
  } catch (e) {
    console.log("[FAIL] List databases failed:", e.message);
  } finally {
    await listSession.close();
  }

  // Test 4: Query the target database
  console.log(`\n--- Test 4: Query database '${DATABASE}' ---`);
  const dbSession = driver.session({ database: DATABASE });
  try {
    const result = await dbSession.run("RETURN 1 AS num");
    console.log("[OK] Database query succeeded:", result.records[0]?.get("num")?.toNumber?.() ?? result.records[0]?.get("num"));
  } catch (e) {
    console.log(`[FAIL] Database '${DATABASE}' query failed:`, e.message);
    // Try default database
    console.log("\n--- Test 4b: Query default 'neo4j' database ---");
    const defSession = driver.session({ database: "neo4j" });
    try {
      const result = await defSession.run("RETURN 1 AS num");
      console.log("[OK] Default database query succeeded:", result.records[0]?.get("num")?.toNumber?.() ?? result.records[0]?.get("num"));
    } catch (e2) {
      console.log("[FAIL] Default database query also failed:", e2.message);
    } finally {
      await defSession.close();
    }
  } finally {
    await dbSession.close();
  }

  // Test 5: Get server info
  console.log("\n--- Test 5: Get server info ---");
  try {
    const info = await driver.getServerInfo();
    console.log("[OK] Server info:", JSON.stringify(info, null, 2));
  } catch (e) {
    console.log("[FAIL] Get server info failed:", e.message);
  }

  await driver.close();
  console.log("\nDone.");
}

test().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
