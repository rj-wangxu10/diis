/**
 * Semantic Graph Service — user-scoped semantic graph backed by Neo4j.
 *
 * Replaces the old EmbeddedDataLinkService.  Instead of hardcoded seed data,
 * this service introspects real data sources via the DataGateway and stores
 * the resulting table/column graph in a dedicated `semanticgraph` Neo4j
 * database.  All data is partitioned by (user_id, datasource_id) so multiple
 * users can build graphs from the same data source independently.
 *
 * Build metadata (build history, table whitelist) is stored in SQLite via
 * the MetadataStore's `db` handle.
 */
import neo4j, { type Driver, type Session } from "neo4j-driver";
import type { DatabaseSync } from "node:sqlite";
import type { LocalDataGateway, SchemaSummary } from "@datafoundry/data-gateway";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SemanticNodeType = "table" | "column";

export type SemanticNode = {
  id: string;
  type: string;
  name?: string | undefined;
  label?: string | undefined;
  description?: string | undefined;
  source?: string | undefined;
  business_semantic?: string | undefined;
  synonyms?: string[] | undefined;
  is_indicator?: boolean | undefined;
  indicator_caliber?: string | undefined;
  properties?: Record<string, unknown> | undefined;
  [key: string]: unknown;
};

export type SemanticEdgeType =
  | "has_column"
  | "foreign_key"
  | "joinable";

export type SemanticEdge = {
  id: string;
  source_id?: string | undefined;
  target_id?: string | undefined;
  type: string;
  confidence?: number | undefined;
  properties?: Record<string, unknown> | undefined;
  [key: string]: unknown;
};

export type SemanticGraph = {
  nodes: SemanticNode[];
  edges: SemanticEdge[];
  datasource_id?: string | undefined;
  build_id?: string | undefined;
};

export type BuildResult = {
  build_id: string;
  datasource_id: string;
  mode: "full" | "incremental";
  tables_added: number;
  columns_added: number;
  edges_added: number;
  message: string;
};

export type BuildHistoryEntry = {
  build_id: string;
  user_id: string;
  datasource_id: string;
  mode: string;
  tables_count: number;
  columns_count: number;
  edges_count: number;
  status: string;
  created_at: string;
};

// ---------------------------------------------------------------------------
// Neo4j record helper
// ---------------------------------------------------------------------------

type Neo4jRecord = {
  get: (key: string) => unknown;
};

// ---------------------------------------------------------------------------
// Neo4j config — read lazily because .env is loaded AFTER module imports
// in the ESM entry point (index.ts calls loadDotenv() after imports).
// ---------------------------------------------------------------------------

const getNeo4jUri = (): string => process.env.NEO4J_URI ?? "bolt://localhost:7687";
const getNeo4jUser = (): string => process.env.NEO4J_USER ?? "neo4j";
const getNeo4jPassword = (): string => process.env.NEO4J_PASSWORD ?? "neo4j123";
const getNeo4jDatabase = (): string => process.env.NEO4J_DATABASE ?? "semanticgraph";

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type SemanticGraphServiceOptions = {
  userId: string;
  workspaceId: string;
  dataGateway: LocalDataGateway;
  db: DatabaseSync;
};

// Shared driver — Neo4j drivers are thread-safe and designed to be shared.
let sharedDriver: Driver | null = null;
let databaseEnsured = false;

/** The actual database to use — may differ from configured if the
 *  configured database doesn't exist (e.g. Neo4j Community Edition). */
let effectiveDatabase: string | null = null;

const getDriver = (): Driver => {
  if (!sharedDriver) {
    console.log("[neo4j] Creating shared driver for", getNeo4jUri());
    sharedDriver = neo4j.driver(getNeo4jUri(), neo4j.auth.basic(getNeo4jUser(), getNeo4jPassword()));
    console.log("[neo4j] Shared driver created");
  }
  return sharedDriver;
};

/**
 * Ensure the target Neo4j database exists.
 * Neo4j does not auto-create databases — only the default "neo4j" database
 * exists on a fresh install.  We try to create the configured database, but
 * if that fails (Community Edition doesn't support CREATE DATABASE), we
 * check whether the database already exists via SHOW DATABASES.  If it
 * doesn't exist, we fall back to the default "neo4j" database.
 */
const ensureDatabase = async (): Promise<void> => {
  if (databaseEnsured) return;
  const driver = getDriver();
  const configuredDb = getNeo4jDatabase();

  // First, verify connectivity to the Neo4j server.
  try {
    await driver.verifyConnectivity();
    console.log("[neo4j] Connectivity verified to", getNeo4jUri());
  } catch (e) {
    console.error("[neo4j] verifyConnectivity failed:", (e as Error).message);
    throw e;
  }

  // First, check if the configured database already exists.
  const sysSession = driver.session({ database: "system" });
  let dbExists = false;
  try {
    const result = await sysSession.run("SHOW DATABASES");
    for (const record of result.records) {
      const name = record.get("name");
      if (name === configuredDb) {
        dbExists = true;
        break;
      }
    }
    console.log("[neo4j] Database check: configured db =", configuredDb, "exists =", dbExists);
  } catch (e) {
    // If SHOW DATABASES fails (very old Neo4j), assume the database exists.
    console.error("[neo4j] SHOW DATABASES failed:", (e as Error).message);
    dbExists = true;
  } finally {
    await sysSession.close();
  }

  if (dbExists) {
    effectiveDatabase = configuredDb;
  } else {
    // Try to create the database (Enterprise Edition only).
    const createSession = driver.session({ database: "system" });
    try {
      await createSession.run(`CREATE DATABASE \`${configuredDb}\` IF NOT EXISTS`);
      effectiveDatabase = configuredDb;
    } catch (e) {
      // Community Edition doesn't support CREATE DATABASE.
      // Fall back to the default "neo4j" database.
      console.log("[neo4j] CREATE DATABASE failed (expected on Community Edition):", (e as Error).message);
      effectiveDatabase = "neo4j";
    } finally {
      await createSession.close();
    }
  }

  console.log("[neo4j] Using database:", effectiveDatabase);
  databaseEnsured = true;
};

export class SemanticGraphService {
  private readonly userId: string;
  private readonly workspaceId: string;
  private readonly dataGateway: LocalDataGateway;
  private readonly db: DatabaseSync;

  constructor(options: SemanticGraphServiceOptions) {
    this.userId = options.userId;
    this.workspaceId = options.workspaceId;
    this.dataGateway = options.dataGateway;
    this.db = options.db;
    this.ensureSqliteSchema();
  }

  // -- SQLite schema for build metadata ----------------------------------

  private ensureSqliteSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_graph_builds (
        build_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        datasource_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        tables_count INTEGER NOT NULL DEFAULT 0,
        columns_count INTEGER NOT NULL DEFAULT 0,
        edges_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'completed',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id, datasource_id, build_id)
      );
      CREATE INDEX IF NOT EXISTS idx_sgb_user_ds ON semantic_graph_builds(user_id, datasource_id);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_table_whitelist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        datasource_id TEXT NOT NULL,
        table_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id, datasource_id, table_name)
      );
      CREATE INDEX IF NOT EXISTS idx_stw_user_ds ON semantic_table_whitelist(user_id, datasource_id);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_graph_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        datasource_id TEXT NOT NULL,
        relation_id TEXT NOT NULL,
        from_table TEXT NOT NULL,
        to_table TEXT NOT NULL,
        from_field TEXT NOT NULL,
        to_field TEXT NOT NULL,
        join_type TEXT NOT NULL DEFAULT 'INNER',
        cardinality TEXT NOT NULL DEFAULT '1:N',
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id, datasource_id, relation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_sgr_user_ds ON semantic_graph_relations(user_id, datasource_id);
    `);
  }

  // -- Neo4j helpers ------------------------------------------------------

  private async runCypher<T>(
    query: string,
    params?: Record<string, unknown>,
    write = false
  ): Promise<T> {
    await ensureDatabase();
    const session: Session = getDriver().session({
      database: effectiveDatabase!,
      defaultAccessMode: write ? neo4j.session.WRITE : neo4j.session.READ
    });
    try {
      const result = await session.run(query, params ?? {});
      return result.records as unknown as T;
    } finally {
      await session.close();
    }
  }

  /** Ensure Neo4j constraints and indexes exist (called once per service). */
  async ensureNeo4jSchema(): Promise<void> {
    // Unique constraint on node_id scoped to user+datasource
    await this.runCypher(
      `CREATE CONSTRAINT sg_node_unique IF NOT EXISTS
       FOR (n:SemanticNode) REQUIRE (n.user_id, n.datasource_id, n.node_id) IS UNIQUE`,
      undefined,
      true
    );
    await this.runCypher(
      `CREATE INDEX sg_node_type_idx IF NOT EXISTS
       FOR (n:SemanticNode) ON (n.node_type)`,
      undefined,
      true
    );
    await this.runCypher(
      `CREATE INDEX sg_node_user_ds_idx IF NOT EXISTS
       FOR (n:SemanticNode) ON (n.user_id, n.datasource_id)`,
      undefined,
      true
    );
  }

  // -- Build metadata (SQLite) -------------------------------------------

  /** Get the most recent build for a datasource. */
  getLatestBuild(datasourceId: string): BuildHistoryEntry | null {
    const row = this.db
      .prepare(
        `SELECT * FROM semantic_graph_builds
         WHERE user_id = ? AND datasource_id = ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(this.userId, datasourceId) as BuildHistoryEntry | undefined;
    return row ?? null;
  }

  /** List all builds for a datasource. */
  listBuilds(datasourceId: string): BuildHistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM semantic_graph_builds
         WHERE user_id = ? AND datasource_id = ?
         ORDER BY created_at DESC`
      )
      .all(this.userId, datasourceId) as BuildHistoryEntry[];
    return rows;
  }

  /** Count distinct datasources that have at least one build for this user. */
  countBuiltGraphs(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT datasource_id) AS cnt
         FROM semantic_graph_builds
         WHERE user_id = ?`
      )
      .get(this.userId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  /** Save a build record. */
  private saveBuildRecord(buildId: string, datasourceId: string, mode: string, tables: number, columns: number, edges: number): void {
    this.db
      .prepare(
        `INSERT INTO semantic_graph_builds (build_id, user_id, datasource_id, mode, tables_count, columns_count, edges_count, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'completed')`
      )
      .run(buildId, this.userId, datasourceId, mode, tables, columns, edges);
  }

  // -- Table whitelist (SQLite) ------------------------------------------

  /** Get the table whitelist for a datasource (empty = all tables). */
  getTableWhitelist(datasourceId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT table_name FROM semantic_table_whitelist
         WHERE user_id = ? AND datasource_id = ?
         ORDER BY table_name`
      )
      .all(this.userId, datasourceId) as { table_name: string }[];
    return rows.map((r) => r.table_name);
  }

  /** Set the table whitelist for a datasource (replaces all). */
  setTableWhitelist(datasourceId: string, tableNames: string[]): void {
    // Delete existing
    this.db
      .prepare(
        `DELETE FROM semantic_table_whitelist
         WHERE user_id = ? AND datasource_id = ?`
      )
      .run(this.userId, datasourceId);
    // Insert new
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO semantic_table_whitelist (user_id, datasource_id, table_name)
       VALUES (?, ?, ?)`
    );
    for (const name of tableNames) {
      stmt.run(this.userId, datasourceId, name);
    }
  }

  // -- Relations (SQLite) -------------------------------------------------

  /** List custom relations for a datasource. */
  listRelations(datasourceId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT * FROM semantic_graph_relations
         WHERE user_id = ? AND datasource_id = ?
         ORDER BY created_at DESC`
      )
      .all(this.userId, datasourceId) as Array<Record<string, unknown>>;
  }

  /** Add a custom relation. */
  addRelation(datasourceId: string, relation: {
    from_table: string;
    to_table: string;
    from_field: string;
    to_field: string;
    join_type?: string | undefined;
    cardinality?: string | undefined;
    description?: string | undefined;
  }): string {
    const relationId = `rel:${datasourceId}:${relation.from_table}:${relation.to_table}:${relation.from_field}:${relation.to_field}`;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO semantic_graph_relations
         (user_id, datasource_id, relation_id, from_table, to_table, from_field, to_field, join_type, cardinality, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.userId,
        datasourceId,
        relationId,
        relation.from_table,
        relation.to_table,
        relation.from_field,
        relation.to_field,
        relation.join_type ?? "INNER",
        relation.cardinality ?? "1:N",
        relation.description ?? null
      );
    return relationId;
  }

  /** Remove a custom relation. */
  removeRelation(datasourceId: string, relationId: string): boolean {
    const result = this.db
      .prepare(
        `DELETE FROM semantic_graph_relations
         WHERE user_id = ? AND datasource_id = ? AND relation_id = ?`
      )
      .run(this.userId, datasourceId, relationId);
    return result.changes > 0;
  }

  // -- Core: build graph from data source --------------------------------

  /**
   * Build (or incrementally update) the semantic graph for a data source.
   *
   * 1. Introspect the data source schema via DataGateway.inspectSchema()
   * 2. For each table in the whitelist (or all if no whitelist), create/update
   *    Table and Column nodes in Neo4j with has_column edges.
   * 3. If there's an existing build, only add new tables/columns (incremental).
   * 4. Store build metadata in SQLite.
   */
  async buildGraph(datasourceId: string, tableWhitelist?: string[]): Promise<BuildResult> {
    await this.ensureNeo4jSchema();

    // Save whitelist if provided
    if (tableWhitelist && tableWhitelist.length > 0) {
      this.setTableWhitelist(datasourceId, tableWhitelist);
    }

    // Get current whitelist
    const whitelist = this.getTableWhitelist(datasourceId);

    // Introspect schema
    const schema: SchemaSummary = await this.dataGateway.inspectSchema({
      user_id: this.userId,
      workspace_id: this.workspaceId,
      datasource_id: datasourceId,
      ...(whitelist.length > 0 ? { table_names: whitelist } : {})
    });

    // Determine build mode
    const latestBuild = this.getLatestBuild(datasourceId);
    const isIncremental = latestBuild !== null;

    // Get existing table node IDs for incremental comparison
    let existingTableIds: Set<string> = new Set();
    if (isIncremental) {
      const existingRecords = await this.runCypher<Neo4jRecord[]>(
        `MATCH (n:SemanticNode {user_id: $userId, datasource_id: $dsId, node_type: 'table'})
         RETURN n.node_id AS id`,
        { userId: this.userId, dsId: datasourceId }
      );
      existingTableIds = new Set(existingRecords.map((r) => r.get("id") as string));
    }

    const buildId = `build-${this.userId}-${datasourceId}-${Date.now()}`;
    let tablesAdded = 0;
    let columnsAdded = 0;
    let edgesAdded = 0;

    for (const table of schema.tables) {
      const tableId = `table:${datasourceId}:${table.name}`;

      // Check if this table already exists (incremental)
      const tableExists = existingTableIds.has(tableId);
      if (tableExists && isIncremental) {
        // Backfill table description/label from datasource if missing
        const tableDescription = table.description;
        if (tableDescription) {
          await this.runCypher(
            `MATCH (n:SemanticNode {user_id: $userId, datasource_id: $dsId, node_id: $tableId})
             SET n.description = COALESCE(n.description, $description),
                 n.label = COALESCE(n.label, $description, n.name)`,
            { userId: this.userId, dsId: datasourceId, tableId, description: tableDescription },
            true
          );
        }

        // Still check for new columns
        const existingColRecords = await this.runCypher<Neo4jRecord[]>(
          `MATCH (n:SemanticNode {user_id: $userId, datasource_id: $dsId, node_type: 'column'})
           WHERE n.properties CONTAINS $tableName
           RETURN n.node_id AS id`,
          { userId: this.userId, dsId: datasourceId, tableName: table.name }
        );
        const existingColIds = new Set(existingColRecords.map((r) => r.get("id") as string));

        for (const col of table.columns) {
          const colId = `column:${datasourceId}:${table.name}:${col.name}`;
          const colComment = col.comment ?? col.description;
          if (!existingColIds.has(colId)) {
            await this.createColumnNode(datasourceId, table.name, col.name, col.type, col.nullable ?? true, colComment);
            await this.createHasColumnEdge(datasourceId, table.name, col.name);
            columnsAdded++;
            edgesAdded++;
          } else if (colComment) {
            // Backfill missing column comment from datasource (preserve user edits)
            await this.runCypher(
              `MATCH (n:SemanticNode {user_id: $userId, datasource_id: $dsId, node_id: $colId})
               SET n.description = COALESCE(n.description, $description)`,
              { userId: this.userId, dsId: datasourceId, colId, description: colComment },
              true
            );
          }
        }
        continue;
      }

      // Full build for this table
      const tableDescription = table.description;
      await this.runCypher(
        `MERGE (n:SemanticNode {user_id: $userId, datasource_id: $dsId, node_id: $tableId})
         SET n.node_type = 'table',
             n.name = $tableName,
             n.label = COALESCE(n.label, $description, $tableName),
             n.source = 'datasource',
             n.description = $description,
             n.properties = $properties`,
        {
          userId: this.userId,
          dsId: datasourceId,
          tableId,
          tableName: table.name,
          description: tableDescription ?? null,
          properties: JSON.stringify({
            datasource_id: datasourceId,
            table_name: table.name,
            column_count: table.columns.length,
            ...(tableDescription ? { description: tableDescription } : {})
          })
        },
        true
      );
      tablesAdded++;

      // Create column nodes and has_column edges
      for (const col of table.columns) {
        await this.createColumnNode(datasourceId, table.name, col.name, col.type, col.nullable ?? true, col.comment ?? col.description);
        await this.createHasColumnEdge(datasourceId, table.name, col.name);
        columnsAdded++;
        edgesAdded++;
      }
    }

    // Sync custom relations from SQLite to Neo4j
    const relations = this.listRelations(datasourceId);
    for (const rel of relations) {
      await this.runCypher(
        `MATCH (a:SemanticNode {user_id: $userId, datasource_id: $dsId, node_type: 'column', node_id: $fromColId}),
              (b:SemanticNode {user_id: $userId, datasource_id: $dsId, node_type: 'column', node_id: $toColId})
         MERGE (a)-[r:SemanticEdge {edge_id: $edgeId, user_id: $userId, datasource_id: $dsId}]->(b)
         SET r.edge_type = 'foreign_key',
             r.confidence = 1.0,
             r.properties = $props`,
        {
          userId: this.userId,
          dsId: datasourceId,
          fromColId: `column:${datasourceId}:${rel.from_table}:${rel.from_field}`,
          toColId: `column:${datasourceId}:${rel.to_table}:${rel.to_field}`,
          edgeId: rel.relation_id as string,
          props: JSON.stringify({
            join_type: rel.join_type,
            cardinality: rel.cardinality,
            description: rel.description
          })
        },
        true
      );
    }

    // Save build record
    const totalTables = schema.tables.length;
    const totalColumns = schema.tables.reduce((sum, t) => sum + t.columns.length, 0);
    this.saveBuildRecord(buildId, datasourceId, isIncremental ? "incremental" : "full", totalTables, totalColumns, edgesAdded);

    return {
      build_id: buildId,
      datasource_id: datasourceId,
      mode: isIncremental ? "incremental" : "full",
      tables_added: tablesAdded,
      columns_added: columnsAdded,
      edges_added: edgesAdded,
      message: `Graph ${isIncremental ? "incrementally updated" : "built"} for datasource "${datasourceId}". ${tablesAdded} tables, ${columnsAdded} columns, ${edgesAdded} edges ${isIncremental ? "added/updated" : "created"}.`
    };
  }

  private async createColumnNode(
    datasourceId: string,
    tableName: string,
    colName: string,
    colType: string,
    nullable: boolean,
    comment?: string | null
  ): Promise<void> {
    const colId = `column:${datasourceId}:${tableName}:${colName}`;
    await this.runCypher(
      `MERGE (n:SemanticNode {user_id: $userId, datasource_id: $dsId, node_id: $colId})
       SET n.node_type = 'column',
           n.name = $colName,
           n.label = COALESCE(n.label, $colName),
           n.source = 'datasource',
           n.description = $description,
           n.properties = $properties`,
      {
        userId: this.userId,
        dsId: datasourceId,
        colId,
        colName,
        description: comment ?? null,
        properties: JSON.stringify({
          datasource_id: datasourceId,
          table_name: tableName,
          column_name: colName,
          data_type: colType,
          nullable,
          ...(comment ? { comment } : {})
        })
      },
      true
    );
  }

  private async createHasColumnEdge(
    datasourceId: string,
    tableName: string,
    colName: string
  ): Promise<void> {
    const tableId = `table:${datasourceId}:${tableName}`;
    const colId = `column:${datasourceId}:${tableName}:${colName}`;
    const edgeId = `edge:${datasourceId}:has_column:${tableName}:${colName}`;
    await this.runCypher(
      `MATCH (t:SemanticNode {user_id: $userId, datasource_id: $dsId, node_id: $tableId}),
              (c:SemanticNode {user_id: $userId, datasource_id: $dsId, node_id: $colId})
       MERGE (t)-[r:SemanticEdge {edge_id: $edgeId, user_id: $userId, datasource_id: $dsId}]->(c)
       SET r.edge_type = 'has_column', r.confidence = 1.0, r.properties = $props`,
      {
        userId: this.userId,
        dsId: datasourceId,
        tableId,
        colId,
        edgeId,
        props: JSON.stringify({})
      },
      true
    );
  }

  // -- Core: show graph ---------------------------------------------------

  /** GET /show — return the full graph for a datasource. */
  async show(datasourceId: string): Promise<SemanticGraph> {
    await this.ensureNeo4jSchema();

    const nodeRecords = await this.runCypher<Neo4jRecord[]>(
      `MATCH (n:SemanticNode {user_id: $userId, datasource_id: $dsId})
       RETURN n.node_id AS id, n.node_type AS type, n.name AS name,
              n.label AS label, n.source AS source, n.properties AS properties,
              n.description AS description, n.business_semantic AS business_semantic,
              n.synonyms AS synonyms, n.is_indicator AS is_indicator,
              n.indicator_caliber AS indicator_caliber`,
      { userId: this.userId, dsId: datasourceId }
    );

    const edgeRecords = await this.runCypher<Neo4jRecord[]>(
      `MATCH (a:SemanticNode {user_id: $userId, datasource_id: $dsId})-[r:SemanticEdge]->(b:SemanticNode {user_id: $userId, datasource_id: $dsId})
       RETURN r.edge_id AS id, a.node_id AS source_id, b.node_id AS target_id,
              r.edge_type AS type, r.confidence AS confidence, r.properties AS properties`,
      { userId: this.userId, dsId: datasourceId }
    );

    const nodes: SemanticNode[] = nodeRecords.map((r) => {
      const rawProps = r.get("properties");
      const props = typeof rawProps === "string" ? JSON.parse(rawProps) : (rawProps ?? {});
      // Merge business semantic fields from top-level Neo4j properties
      const description = r.get("description") as string | null;
      const businessSemantic = r.get("business_semantic") as string | null;
      const synonymsRaw = r.get("synonyms");
      const synonyms = typeof synonymsRaw === "string" ? JSON.parse(synonymsRaw) : (synonymsRaw ?? undefined);
      const isIndicator = r.get("is_indicator") as boolean | null;
      const indicatorCaliber = r.get("indicator_caliber") as string | null;
      return {
        id: r.get("id") as string,
        type: r.get("type") as string,
        name: r.get("name") as string,
        label: r.get("label") as string | undefined,
        source: r.get("source") as string | undefined,
        description: description ?? undefined,
        business_semantic: businessSemantic ?? undefined,
        synonyms: synonyms as string[] | undefined,
        is_indicator: isIndicator ?? undefined,
        indicator_caliber: indicatorCaliber ?? undefined,
        properties: props as Record<string, unknown>
      };
    });

    const edges: SemanticEdge[] = edgeRecords.map((r) => {
      const rawProps = r.get("properties");
      const props = typeof rawProps === "string" ? JSON.parse(rawProps) : (rawProps ?? {});
      return {
        id: r.get("id") as string,
        source_id: r.get("source_id") as string,
        target_id: r.get("target_id") as string,
        type: r.get("type") as string,
        confidence: r.get("confidence") as number | undefined,
        properties: props as Record<string, unknown>
      };
    });

    const latestBuild = this.getLatestBuild(datasourceId);
    return {
      nodes,
      edges,
      datasource_id: datasourceId,
      build_id: latestBuild?.build_id
    };
  }

  // -- Core: explore -----------------------------------------------------

  /** POST /explore — search over the graph. */
  async explore(
    datasourceId: string,
    query: string,
    opts?: { focus?: string; maxNodes?: number }
  ): Promise<{ text: string; nodes: SemanticNode[]; edges: SemanticEdge[]; build_id: string }> {
    await this.ensureNeo4jSchema();

    const maxNodes = opts?.maxNodes ?? 50;
    const focus = opts?.focus ?? "all";
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    let whereClause = "";
    const params: Record<string, unknown> = {
      userId: this.userId,
      dsId: datasourceId,
      maxNodes: neo4j.int(maxNodes)
    };

    if (terms.length > 0) {
      // Match against name, node_type, description, business_semantic, synonyms, and indicator_caliber
      // so the LLM gets only the tables/fields/indicators relevant to the user's question.
      const conditions = terms.map((term, i) => {
        params[`term${i}`] = `(?i).*${escapeRegex(term)}.*`;
        return `(n.name =~ $term${i} OR n.node_type =~ $term${i} OR n.description =~ $term${i} OR n.business_semantic =~ $term${i} OR n.indicator_caliber =~ $term${i} OR n.synonyms =~ $term${i})`;
      });
      whereClause = `WHERE ${conditions.join(" OR ")}`;
    }

    if (focus !== "all") {
      params.focus = focus.toLowerCase();
      whereClause = whereClause
        ? `${whereClause} AND n.node_type = $focus`
        : `WHERE n.node_type = $focus`;
    }

    const cypher = `MATCH (n:SemanticNode {user_id: $userId, datasource_id: $dsId}) ${whereClause}
                    RETURN n.node_id AS id, n.node_type AS type, n.name AS name,
                           n.label AS label, n.source AS source, n.properties AS properties,
                           n.description AS description, n.business_semantic AS business_semantic,
                           n.synonyms AS synonyms, n.is_indicator AS is_indicator,
                           n.indicator_caliber AS indicator_caliber
                    LIMIT $maxNodes`;

    let nodeRecords = await this.runCypher<Neo4jRecord[]>(cypher, params);

    // Fallback: if nothing matched, return top-N nodes
    if (nodeRecords.length === 0) {
      nodeRecords = await this.runCypher<Neo4jRecord[]>(
        `MATCH (n:SemanticNode {user_id: $userId, datasource_id: $dsId})
         RETURN n.node_id AS id, n.node_type AS type, n.name AS name,
                n.label AS label, n.source AS source, n.properties AS properties,
                n.description AS description, n.business_semantic AS business_semantic,
                n.synonyms AS synonyms, n.is_indicator AS is_indicator,
                n.indicator_caliber AS indicator_caliber
         LIMIT $maxNodes`,
        { userId: this.userId, dsId: datasourceId, maxNodes: neo4j.int(maxNodes) }
      );
    }

    const nodes: SemanticNode[] = nodeRecords.map((r) => {
      const rawProps = r.get("properties");
      const props = typeof rawProps === "string" ? JSON.parse(rawProps) : (rawProps ?? {});
      const description = r.get("description") as string | null;
      const businessSemantic = r.get("business_semantic") as string | null;
      const synonymsRaw = r.get("synonyms");
      const synonyms = typeof synonymsRaw === "string" ? JSON.parse(synonymsRaw) : (synonymsRaw ?? undefined);
      const isIndicator = r.get("is_indicator") as boolean | null;
      const indicatorCaliber = r.get("indicator_caliber") as string | null;
      return {
        id: r.get("id") as string,
        type: r.get("type") as string,
        name: r.get("name") as string,
        label: r.get("label") as string | undefined,
        source: r.get("source") as string | undefined,
        description: description ?? undefined,
        business_semantic: businessSemantic ?? undefined,
        synonyms: synonyms as string[] | undefined,
        is_indicator: isIndicator ?? undefined,
        indicator_caliber: indicatorCaliber ?? undefined,
        properties: props as Record<string, unknown>
      };
    });

    const nodeIds = nodes.map((n) => n.id);
    const edgeRecords = nodeIds.length > 0
      ? await this.runCypher<Neo4jRecord[]>(
          `MATCH (a:SemanticNode {user_id: $userId, datasource_id: $dsId})-[r:SemanticEdge]->(b:SemanticNode {user_id: $userId, datasource_id: $dsId})
           WHERE a.node_id IN $nodeIds AND b.node_id IN $nodeIds
           RETURN r.edge_id AS id, a.node_id AS source_id, b.node_id AS target_id,
                  r.edge_type AS type, r.confidence AS confidence, r.properties AS properties`,
          { userId: this.userId, dsId: datasourceId, nodeIds }
        )
      : [];

    const edges: SemanticEdge[] = edgeRecords.map((r) => {
      const rawProps = r.get("properties");
      const props = typeof rawProps === "string" ? JSON.parse(rawProps) : (rawProps ?? {});
      return {
        id: r.get("id") as string,
        source_id: r.get("source_id") as string,
        target_id: r.get("target_id") as string,
        type: r.get("type") as string,
        confidence: r.get("confidence") as number | undefined,
        properties: props as Record<string, unknown>
      };
    });

    const latestBuild = this.getLatestBuild(datasourceId);
    const text = formatExploreText(query, nodes, edges);

    return {
      text,
      nodes,
      edges,
      build_id: latestBuild?.build_id ?? `snap-${Date.now()}`
    };
  }

  // -- Core: rebuild ------------------------------------------------------

  /** POST /rebuild — clear and rebuild the graph from scratch. */
  async rebuild(datasourceId: string): Promise<BuildResult> {
    await this.clearGraph(datasourceId);
    // Force full build by temporarily ignoring the latest build record
    // (buildGraph checks getLatestBuild, so we delete the record)
    this.db
      .prepare(
        `DELETE FROM semantic_graph_builds
         WHERE user_id = ? AND datasource_id = ?`
      )
      .run(this.userId, datasourceId);

    return this.buildGraph(datasourceId);
  }

  /** Clear all nodes and edges for a specific datasource. */
  async clearGraph(datasourceId: string): Promise<void> {
    await this.runCypher(
      `MATCH (n:SemanticNode {user_id: $userId, datasource_id: $dsId})
       DETACH DELETE n`,
      { userId: this.userId, dsId: datasourceId },
      true
    );
  }

  /**
   * Delete the entire semantic graph for a datasource:
   * Neo4j nodes/edges + all SQLite metadata (builds, whitelist, relations).
   */
  async deleteGraph(datasourceId: string): Promise<void> {
    // Neo4j: delete all nodes and edges
    await this.clearGraph(datasourceId);
    // SQLite: delete build history
    this.db
      .prepare(
        `DELETE FROM semantic_graph_builds
         WHERE user_id = ? AND datasource_id = ?`
      )
      .run(this.userId, datasourceId);
    // SQLite: delete table whitelist
    this.db
      .prepare(
        `DELETE FROM semantic_table_whitelist
         WHERE user_id = ? AND datasource_id = ?`
      )
      .run(this.userId, datasourceId);
    // SQLite: delete custom relations
    this.db
      .prepare(
        `DELETE FROM semantic_graph_relations
         WHERE user_id = ? AND datasource_id = ?`
      )
      .run(this.userId, datasourceId);
  }

  // -- Core: update table metadata ----------------------------------------

  /** Update a table's label/description (business semantics). */
  async updateTableMeta(datasourceId: string, tableName: string, meta: { label?: string | undefined; description?: string | undefined }): Promise<void> {
    const tableId = `table:${datasourceId}:${tableName}`;
    const setParts: string[] = [];
    const params: Record<string, unknown> = {
      userId: this.userId,
      dsId: datasourceId,
      tableId
    };
    if (meta.label !== undefined) {
      setParts.push("n.label = $label");
      params.label = meta.label;
    }
    if (meta.description !== undefined) {
      setParts.push("n.description = $description");
      params.description = meta.description;
    }
    if (setParts.length === 0) return;

    await this.runCypher(
      `MATCH (n:SemanticNode {user_id: $userId, datasource_id: $dsId, node_id: $tableId})
       SET ${setParts.join(", ")}`,
      params,
      true
    );
  }

  /** Update a column's business semantics. */
  async updateColumnMeta(
    datasourceId: string,
    tableName: string,
    colName: string,
    meta: {
      label?: string | undefined;
      description?: string | undefined;
      businessSemantic?: string | undefined;
      synonyms?: string[] | undefined;
      isIndicator?: boolean | undefined;
      indicatorCaliber?: string | undefined;
    }
  ): Promise<void> {
    const colId = `column:${datasourceId}:${tableName}:${colName}`;
    const setParts: string[] = [];
    const params: Record<string, unknown> = {
      userId: this.userId,
      dsId: datasourceId,
      colId
    };
    if (meta.label !== undefined) {
      setParts.push("n.label = $label");
      params.label = meta.label;
    }
    if (meta.description !== undefined) {
      setParts.push("n.description = $description");
      params.description = meta.description;
    }
    if (meta.businessSemantic !== undefined) {
      setParts.push("n.business_semantic = $businessSemantic");
      params.businessSemantic = meta.businessSemantic;
    }
    if (meta.synonyms !== undefined) {
      setParts.push("n.synonyms = $synonyms");
      params.synonyms = JSON.stringify(meta.synonyms);
    }
    if (meta.isIndicator !== undefined) {
      setParts.push("n.is_indicator = $isIndicator");
      params.isIndicator = meta.isIndicator;
    }
    if (meta.indicatorCaliber !== undefined) {
      setParts.push("n.indicator_caliber = $indicatorCaliber");
      params.indicatorCaliber = meta.indicatorCaliber;
    }
    if (setParts.length === 0) return;

    await this.runCypher(
      `MATCH (n:SemanticNode {user_id: $userId, datasource_id: $dsId, node_id: $colId})
       SET ${setParts.join(", ")}`,
      params,
      true
    );
  }

  // -- Export ------------------------------------------------------------

  /** Export the graph as JSON (matching prototype format). */
  async exportGraph(datasourceId: string): Promise<{
    tables: unknown[];
    columns: unknown[];
    relations: unknown[];
    cypher: string;
  }> {
    const graph = await this.show(datasourceId);
    const relations = this.listRelations(datasourceId);

    const tables = graph.nodes
      .filter((n) => n.type === "table")
      .map((n) => ({
        id: n.id,
        name: n.name,
        label: n.label ?? n.name,
        description: n.description ?? "",
        ...(n.properties ?? {})
      }));

    const columns = graph.nodes
      .filter((n) => n.type === "column")
      .map((n) => ({
        id: n.id,
        name: n.name,
        label: n.label ?? n.name,
        description: n.description ?? "",
        businessSemantic: n.business_semantic ?? "",
        synonyms: n.synonyms ?? [],
        isIndicator: n.is_indicator ?? false,
        indicatorCaliber: n.indicator_caliber ?? "",
        ...(n.properties ?? {})
      }));

    const relationsOut = relations.map((r) => ({
      id: r.relation_id,
      from: r.from_table,
      to: r.to_table,
      type: "foreign_key",
      joinType: r.join_type,
      cardinality: r.cardinality,
      leftField: r.from_field,
      rightField: r.to_field,
      description: r.description ?? ""
    }));

    // Generate Cypher MERGE statements
    const cypherLines: string[] = [];
    for (const t of tables) {
      const tData = t as Record<string, unknown>;
      cypherLines.push(
        `MERGE (t:Table {id: '${tData.id}'}) SET t.name = '${tData.name}', t.label = '${tData.label ?? tData.name}';`
      );
    }
    for (const c of columns) {
      const cData = c as Record<string, unknown>;
      cypherLines.push(
        `MERGE (c:Column {id: '${cData.id}'}) SET c.name = '${cData.name}', c.type = '${cData.data_type ?? "unknown"}';`
      );
    }
    for (const r of relationsOut) {
      cypherLines.push(
        `MATCH (a:Table {name: '${r.from}'}), (b:Table {name: '${r.to}'}) MERGE (a)-[:FOREIGN_KEY {leftField: '${r.leftField}', rightField: '${r.rightField}', joinType: '${r.joinType}'}]->(b);`
      );
    }

    return {
      tables,
      columns,
      relations: relationsOut,
      cypher: cypherLines.join("\n")
    };
  }

  // -- Cleanup -----------------------------------------------------------

  async close(): Promise<void> {
    // Driver is shared, don't close it here.
    // It will be closed when the process exits.
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const escapeRegex = (str: string): string =>
  str.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Format explore results into structured, context-efficient text for the LLM.
 *
 * - Groups nodes by type (tables first, then columns, then indicators)
 * - Includes rich metadata (business_semantic, indicator_caliber, synonyms) so the LLM
 *   can understand the data without needing additional tool calls
 * - Compresses output when the result is large: omits low-value fields, truncates descriptions,
 *   and falls back to a compact summary when there are too many nodes
 */
const formatExploreText = (
  query: string,
  nodes: SemanticNode[],
  edges: SemanticEdge[]
): string => {
  const lines: string[] = [];
  lines.push(`Semantic graph explore result for: "${query}"`);
  lines.push(`Found ${nodes.length} nodes and ${edges.length} edges.`);

  // Build a lookup for edge rendering (source/target names)
  const nodeMap = new Map<string, SemanticNode>();
  for (const n of nodes) {
    nodeMap.set(n.id, n);
  }

  // Separate nodes by type for structured output
  const tables = nodes.filter((n) => n.type === "table");
  const columns = nodes.filter((n) => n.type === "column");
  const indicators = nodes.filter((n) => n.is_indicator);
  const otherNodes = nodes.filter((n) => n.type !== "table" && n.type !== "column" && !n.is_indicator);

  // Context budget: estimate ~4 chars per token, target ~6000 chars for graph text
  const MAX_CHARS = 6000;
  const COMPACT_THRESHOLD = 40; // switch to compact mode if more than 40 nodes
  let charsUsed = lines.join("\n").length;
  let nodeCount = 0;

  const pushLine = (text: string): boolean => {
    charsUsed += text.length + 1;
    if (charsUsed > MAX_CHARS) {
      return false; // budget exhausted
    }
    lines.push(text);
    return true;
  };

  // -- Tables section --
  if (tables.length > 0) {
    lines.push("");
    lines.push(`Tables (${tables.length}):`);
    for (const t of tables) {
      nodeCount++;
      const parts: string[] = [`  [table] ${t.name ?? t.id}`];
      if (t.description) {
        parts.push(`desc: ${truncate(t.description, 120)}`);
      }
      if (t.business_semantic) {
        parts.push(`biz: ${truncate(t.business_semantic, 100)}`);
      }
      if (!pushLine(parts.join(" | "))) break;
    }
  }

  // -- Indicators section (highlighted, as they are key for analysis) --
  if (indicators.length > 0) {
    if (pushLine("")) {
      lines.push(`Indicators (${indicators.length}):`);
      for (const ind of indicators) {
        nodeCount++;
        const parts: string[] = [`  [indicator] ${ind.name ?? ind.id}`];
        if (ind.indicator_caliber) {
          parts.push(`caliber: ${truncate(ind.indicator_caliber, 150)}`);
        }
        if (ind.business_semantic) {
          parts.push(`biz: ${truncate(ind.business_semantic, 100)}`);
        }
        if (ind.synonyms && ind.synonyms.length > 0) {
          parts.push(`synonyms: ${ind.synonyms.slice(0, 5).join(", ")}`);
        }
        if (!pushLine(parts.join(" | "))) break;
      }
    }
  }

  // -- Columns section --
  if (columns.length > 0 && nodeCount < COMPACT_THRESHOLD) {
    if (pushLine("")) {
      lines.push(`Columns (${columns.length}):`);
      for (const c of columns) {
        nodeCount++;
        const parts: string[] = [`  [column] ${c.name ?? c.id}`];
        if (c.description) {
          parts.push(`desc: ${truncate(c.description, 80)}`);
        }
        if (c.business_semantic) {
          parts.push(`biz: ${truncate(c.business_semantic, 80)}`);
        }
        if (!pushLine(parts.join(" | "))) break;
      }
    }
  } else if (columns.length > 0 && nodeCount >= COMPACT_THRESHOLD) {
    // Compact mode: just list column names without metadata
    if (pushLine("")) {
      lines.push(`Columns (${columns.length}, compact):`);
      const colNames = columns.map((c) => c.name ?? c.id).join(", ");
      pushLine(`  ${truncate(colNames, 500)}`);
    }
  }

  // -- Other nodes --
  if (otherNodes.length > 0) {
    if (pushLine("")) {
      lines.push(`Other (${otherNodes.length}):`);
      for (const n of otherNodes) {
        nodeCount++;
        if (!pushLine(`  [${n.type}] ${n.name ?? n.id}`)) break;
      }
    }
  }

  // -- Edges section --
  if (edges.length > 0) {
    if (pushLine("")) {
      lines.push(`Relationships (${edges.length}):`);
      const shownEdges = edges.length > 20 ? edges.slice(0, 20) : edges;
      for (const e of shownEdges) {
        const srcNode = e.source_id ? nodeMap.get(e.source_id) : undefined;
        const tgtNode = e.target_id ? nodeMap.get(e.target_id) : undefined;
        const srcName = srcNode?.name ?? e.source_id ?? "?";
        const tgtName = tgtNode?.name ?? e.target_id ?? "?";
        const edgeProps: string[] = [];
        if (e.type) edgeProps.push(e.type);
        if (e.properties) {
          const fk = (e.properties as Record<string, unknown>).leftField;
          const rk = (e.properties as Record<string, unknown>).rightField;
          if (fk) edgeProps.push(`${fk}→${rk ?? "?"}`);
        }
        if (!pushLine(`  ${srcName} --[${edgeProps.join(", ")}]--> ${tgtName}`)) break;
      }
      if (edges.length > 20) {
        pushLine(`  ... and ${edges.length - 20} more edges (omitted for brevity)`);
      }
    }
  }

  // If we ran out of budget, add a truncation notice
  if (charsUsed > MAX_CHARS) {
    lines.push("");
    lines.push(`[Note: Result truncated to fit context budget. ${nodes.length - nodeCount} nodes omitted. Use a more specific query to see details.]`);
  }

  return lines.join("\n");
};

const truncate = (text: string, maxLen: number): string =>
  text.length <= maxLen ? text : `${text.slice(0, maxLen - 3)}...`;
