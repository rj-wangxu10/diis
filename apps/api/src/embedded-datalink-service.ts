/**
 * Embedded DataLink graph service backed by Neo4j.
 *
 * Stores semantic graph nodes (table, column, concept, entity) and
 * relationships (has_column, foreign_key, joinable, semantic_synonym,
 * correlated, maps_to, etc.) in a local Neo4j database.  Provides the same
 * surface area as the external DataLink REST API (/show, /explore,
 * /add-table, /remove-table, /rebuild) so the existing handleDatalinkRequest
 * handler can delegate to it directly.
 */
import neo4j, { type Driver, type Session } from "neo4j-driver";

// ---------------------------------------------------------------------------
// Types (kept compatible with the JSON-based prototype)
// ---------------------------------------------------------------------------

export type EmbeddedNodeType = "table" | "column" | "concept" | "entity";

export type EmbeddedNode = {
  id: string;
  type: string;
  name?: string;
  source?: string;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
};

export type EmbeddedEdge = {
  id: string;
  source_id?: string | undefined;
  source?: string | undefined;
  target_id?: string | undefined;
  target?: string | undefined;
  type: string;
  confidence?: number | undefined;
  properties?: Record<string, unknown> | undefined;
  [key: string]: unknown;
};

export type EmbeddedGraph = {
  nodes: EmbeddedNode[];
  edges: EmbeddedEdge[];
  snapshot_id?: string;
};

export type EmbeddedExploreResult = {
  text: string;
  nodes: EmbeddedNode[];
  edges: EmbeddedEdge[];
  snapshot_id: string;
};

// ---------------------------------------------------------------------------
// Neo4j record helper (minimal duck-typing interface)
// ---------------------------------------------------------------------------

type Neo4jRecord = {
  get: (key: string) => unknown;
};

// ---------------------------------------------------------------------------
// Neo4j-backed service
// ---------------------------------------------------------------------------

// Lazy getters — .env is loaded AFTER module imports in the ESM entry point
const getNeo4jUri = (): string => process.env.NEO4J_URI ?? "bolt://localhost:7687";
const getNeo4jUser = (): string => process.env.NEO4J_USER ?? "neo4j";
const getNeo4jPassword = (): string => process.env.NEO4J_PASSWORD ?? "neo4j123";
const getNeo4jDatabase = (): string => process.env.NEO4J_DATABASE ?? "neo4j";

export type EmbeddedDataLinkServiceOptions = {
  storageRoot: string;
  workspaceId: string;
  userId: string;
};

export class EmbeddedDataLinkService {
  private readonly driver: Driver;
  private readonly workspaceId: string;
  private readonly userId: string;
  private static seeded = false;
  private static databaseEnsured = false;
  /** The actual database to use — may differ from configured if the
   *  configured database doesn't exist (e.g. Neo4j Community Edition). */
  private static effectiveDatabase: string | null = null;

  constructor(_options: EmbeddedDataLinkServiceOptions) {
    this.driver = neo4j.driver(getNeo4jUri(), neo4j.auth.basic(getNeo4jUser(), getNeo4jPassword()));
    this.workspaceId = _options.workspaceId;
    this.userId = _options.userId;
  }

  /**
   * Ensure the target Neo4j database exists.
   * Neo4j does not auto-create databases — only the default "neo4j" database
   * exists on a fresh install.  We try to create the configured database, but
   * if that fails (Community Edition doesn't support CREATE DATABASE), we
   * check whether the database already exists via SHOW DATABASES.  If it
   * doesn't exist, we fall back to the default "neo4j" database.
   */
  private async ensureDatabase(): Promise<void> {
    if (EmbeddedDataLinkService.databaseEnsured) return;
    const configuredDb = getNeo4jDatabase();

    // First, check if the configured database already exists.
    const sysSession = this.driver.session({ database: "system" });
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
    } catch {
      // If SHOW DATABASES fails (very old Neo4j), assume the database exists.
      dbExists = true;
    } finally {
      await sysSession.close();
    }

    if (dbExists) {
      EmbeddedDataLinkService.effectiveDatabase = configuredDb;
    } else {
      // Try to create the database (Enterprise Edition only).
      const createSession = this.driver.session({ database: "system" });
      try {
        await createSession.run(`CREATE DATABASE \`${configuredDb}\` IF NOT EXISTS`);
        EmbeddedDataLinkService.effectiveDatabase = configuredDb;
      } catch {
        // Community Edition doesn't support CREATE DATABASE.
        // Fall back to the default "neo4j" database.
        EmbeddedDataLinkService.effectiveDatabase = "neo4j";
      } finally {
        await createSession.close();
      }
    }

    EmbeddedDataLinkService.databaseEnsured = true;
  }

  private async run<T>(
    query: string,
    params?: Record<string, unknown>,
    write = false
  ): Promise<T> {
    await this.ensureDatabase();
    const session: Session = this.driver.session({
      database: EmbeddedDataLinkService.effectiveDatabase!,
      defaultAccessMode: write ? neo4j.session.WRITE : neo4j.session.READ
    });
    try {
      const result = await session.run(query, params ?? {});
      return result.records as unknown as T;
    } finally {
      await session.close();
    }
  }

  /** Ensure constraints and indexes exist. */
  async ensureSchema(): Promise<void> {
    await this.run(
      "CREATE CONSTRAINT node_id_unique IF NOT EXISTS FOR (n:DataLinkNode) REQUIRE n.node_id IS UNIQUE",
      undefined,
      true
    );
    await this.run(
      "CREATE CONSTRAINT edge_id_unique IF NOT EXISTS FOR (e:DataLinkEdge) REQUIRE e.edge_id IS UNIQUE",
      undefined,
      true
    );
    await this.run(
      "CREATE INDEX node_type_idx IF NOT EXISTS FOR (n:DataLinkNode) ON (n.node_type)",
      undefined,
      true
    );
    await this.run(
      "CREATE INDEX node_name_idx IF NOT EXISTS FOR (n:DataLinkNode) ON (n.name)",
      undefined,
      true
    );
  }

  /** Seed the graph with sample data if empty. */
  async seedIfEmpty(): Promise<void> {
    if (EmbeddedDataLinkService.seeded) return;
    await this.ensureSchema();

    const records = await this.run<unknown[]>(
      "MATCH (n:DataLinkNode) RETURN count(n) AS cnt"
    );
    const count = (records as unknown as Neo4jRecord[])
      .at(0)?.get("cnt") as { toNumber: () => number } | undefined;
    const cnt = count?.toNumber?.() ?? 0;

    if (cnt > 0) {
      EmbeddedDataLinkService.seeded = true;
      return;
    }

    await this.seedGraph();
    EmbeddedDataLinkService.seeded = true;
  }

  /** GET /show — return the full graph. */
  async show(): Promise<EmbeddedGraph> {
    await this.seedIfEmpty();

    const nodeRecords = await this.run<Neo4jRecord[]>(
      "MATCH (n:DataLinkNode) RETURN n.node_id AS id, n.node_type AS type, n.name AS name, n.source AS source, n.properties AS properties"
    );
    const edgeRecords = await this.run<Neo4jRecord[]>(
      `MATCH (a:DataLinkNode)-[r:DataLinkEdge]->(b:DataLinkNode)
       RETURN r.edge_id AS id, a.node_id AS source_id, b.node_id AS target_id, r.edge_type AS type, r.confidence AS confidence, r.properties AS properties`
    );

    const nodes: EmbeddedNode[] = nodeRecords.map((r) => {
      const rawProps = r.get("properties");
      const props = typeof rawProps === "string" ? JSON.parse(rawProps) : (rawProps ?? {});
      return {
        id: r.get("id") as string,
        type: r.get("type") as string,
        name: r.get("name") as string,
        source: r.get("source") as string,
        properties: props as Record<string, unknown>
      };
    });

    const edges: EmbeddedEdge[] = edgeRecords.map((r) => {
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

    return { nodes, edges, snapshot_id: `snap-${Date.now()}` };
  }

  /** POST /explore — natural-language search over the graph. */
  async explore(
    query: string,
    opts?: { focus?: string; maxNodes?: number }
  ): Promise<EmbeddedExploreResult> {
    await this.seedIfEmpty();

    const maxNodes = opts?.maxNodes ?? 20;
    const focus = opts?.focus ?? "all";
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    // Build a Cypher query that matches nodes by name or type containing any term
    let whereClause = "";
    const params: Record<string, unknown> = { maxNodes: neo4j.int(maxNodes) };

    if (terms.length > 0) {
      const conditions = terms.map((term, i) => {
        params[`term${i}`] = `(?i).*${escapeRegex(term)}.*`;
        return `(n.name =~ $term${i} OR n.node_type =~ $term${i})`;
      });
      whereClause = `WHERE ${conditions.join(" OR ")}`;
    }

    if (focus !== "all") {
      params.focus = focus.toLowerCase();
      whereClause = whereClause
        ? `${whereClause} AND n.node_type = $focus`
        : `WHERE n.node_type = $focus`;
    }

    const cypher = `MATCH (n:DataLinkNode) ${whereClause} RETURN n.node_id AS id, n.node_type AS type, n.name AS name, n.source AS source, n.properties AS properties LIMIT $maxNodes`;

    let nodeRecords = await this.run<Neo4jRecord[]>(cypher, params);

    // Fallback: if nothing matched, return top-N nodes
    if (nodeRecords.length === 0) {
      nodeRecords = await this.run<Neo4jRecord[]>(
        "MATCH (n:DataLinkNode) RETURN n.node_id AS id, n.node_type AS type, n.name AS name, n.source AS source, n.properties AS properties LIMIT $maxNodes",
        { maxNodes: neo4j.int(maxNodes) }
      );
    }

    const nodes: EmbeddedNode[] = nodeRecords.map((r) => {
      const rawProps = r.get("properties");
      const props = typeof rawProps === "string" ? JSON.parse(rawProps) : (rawProps ?? {});
      return {
        id: r.get("id") as string,
        type: r.get("type") as string,
        name: r.get("name") as string,
        source: r.get("source") as string,
        properties: props as Record<string, unknown>
      };
    });

    const nodeIds = nodes.map((n) => n.id);
    const edgeRecords = nodeIds.length > 0
      ? await this.run<Neo4jRecord[]>(
          `MATCH (a:DataLinkNode)-[r:DataLinkEdge]->(b:DataLinkNode)
           WHERE a.node_id IN $nodeIds AND b.node_id IN $nodeIds
           RETURN r.edge_id AS id, a.node_id AS source_id, b.node_id AS target_id, r.edge_type AS type, r.confidence AS confidence, r.properties AS properties`,
          { nodeIds }
        )
      : [];

    const edges: EmbeddedEdge[] = edgeRecords.map((r) => {
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

    const snapshotId = `snap-${Date.now()}`;
    const text = formatExploreText(query, nodes, edges);

    return { text, nodes, edges, snapshot_id: snapshotId };
  }

  /** POST /add-table — add a table node to the graph. */
  async addTable(input: {
    source: string;
    table?: string | null;
    sourceType?: string;
    schemaName?: string | null;
  }): Promise<string> {
    await this.seedIfEmpty();

    const tableName = input.table ?? input.source;
    const tableId = `table:${input.source}:${tableName}`;

    await this.run(
      `MERGE (n:DataLinkNode {node_id: $tableId})
       SET n.node_type = 'table', n.name = $tableName, n.source = 'authoritative',
           n.properties = $properties`,
      {
        tableId,
        tableName,
        properties: JSON.stringify({
          source: input.source,
          source_type: input.sourceType ?? "csv",
          schema_name: input.schemaName ?? null
        })
      },
      true
    );

    return `Table "${tableName}" added to the graph from source "${input.source}".`;
  }

  /** DELETE /remove-table — remove a table and optionally orphan columns. */
  async removeTable(input: { tableId: string; cleanupOrphans?: boolean }): Promise<string> {
    await this.seedIfEmpty();

    const tableId = input.tableId;
    const cleanup = input.cleanupOrphans ?? true;

    // Check if table exists
    const checkRecords = await this.run<Neo4jRecord[]>(
      "MATCH (n:DataLinkNode {node_id: $tableId}) RETURN n.name AS name",
      { tableId }
    );
    if (checkRecords.length === 0) {
      return `Table "${tableId}" not found in the graph.`;
    }
    const tableName = checkRecords[0]?.get("name");

    if (cleanup) {
      // Find column IDs connected via has_column edges, then remove orphan columns
      await this.run(
        `MATCH (t:DataLinkNode {node_id: $tableId})-[r:DataLinkEdge {edge_type: 'has_column'}]->(c:DataLinkNode)
         DETACH DELETE c`,
        { tableId },
        true
      );
    }

    // Remove all edges connected to the table node, then delete the node
    await this.run(
      "MATCH (n:DataLinkNode {node_id: $tableId}) DETACH DELETE n",
      { tableId },
      true
    );

    return `Table "${tableName}" removed from the graph.`;
  }

  /** POST /rebuild — rebuild the graph (clears and re-seeds). */
  async rebuild(mode?: string): Promise<string> {
    await this.clearGraph();
    await this.seedGraph();
    const graph = await this.show();
    return `Graph rebuilt (${graph.nodes.length} nodes, ${graph.edges.length} edges). Mode: ${mode ?? "full"}.`;
  }

  /** Clear all DataLink nodes and edges. */
  private async clearGraph(): Promise<void> {
    await this.run(
      "MATCH (n:DataLinkNode) DETACH DELETE n",
      undefined,
      true
    );
  }

  /** Seed the graph with sample data. */
  private async seedGraph(): Promise<void> {
    const nodes = SEED_NODES;
    const edges = SEED_EDGES;

    // Insert nodes
    for (const node of nodes) {
      await this.run(
        `MERGE (n:DataLinkNode {node_id: $nodeId})
         SET n.node_type = $nodeType, n.name = $name, n.source = $source, n.properties = $properties`,
        {
          nodeId: node.id,
          nodeType: node.type,
          name: node.name,
          source: node.source ?? "verified",
          properties: JSON.stringify(node.properties ?? {})
        },
        true
      );
    }

    // Insert edges
    for (const edge of edges) {
      await this.run(
        `MATCH (a:DataLinkNode {node_id: $sourceId}), (b:DataLinkNode {node_id: $targetId})
         MERGE (a)-[r:DataLinkEdge {edge_id: $edgeId}]->(b)
         SET r.edge_type = $edgeType, r.confidence = $confidence, r.properties = $properties`,
        {
          sourceId: edge.source_id,
          targetId: edge.target_id,
          edgeId: edge.id,
          edgeType: edge.type,
          confidence: edge.confidence ?? 1.0,
          properties: JSON.stringify(edge.properties ?? {})
        },
        true
      );
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const escapeRegex = (str: string): string =>
  str.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const formatExploreText = (
  query: string,
  nodes: EmbeddedNode[],
  edges: EmbeddedEdge[]
): string => {
  const lines: string[] = [];
  lines.push(`Explore result for: "${query}"`);
  lines.push(`Found ${nodes.length} nodes and ${edges.length} edges.`);
  lines.push("");
  lines.push("Nodes:");
  for (const node of nodes) {
    lines.push(`  [${node.type}] ${node.name ?? node.id} (${node.id})`);
  }
  if (edges.length > 0) {
    lines.push("");
    lines.push("Edges:");
    for (const edge of edges) {
      lines.push(`  ${edge.source_id} --[${edge.type}]--> ${edge.target_id}`);
    }
  }
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

type SeedNode = {
  id: string;
  type: string;
  name: string;
  source?: string;
  properties?: Record<string, unknown>;
};

type SeedEdge = {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  confidence?: number;
  properties?: Record<string, unknown>;
};

const SEED_NODES: SeedNode[] = [
  // Tables
  { id: "table:demo:orders", type: "table", name: "orders", source: "authoritative", properties: { source: "demo", source_type: "sqlite" } },
  { id: "table:demo:customers", type: "table", name: "customers", source: "authoritative", properties: { source: "demo", source_type: "sqlite" } },
  { id: "table:demo:products", type: "table", name: "products", source: "authoritative", properties: { source: "demo", source_type: "sqlite" } },
  // Columns — orders
  { id: "column:demo:orders:id", type: "column", name: "id", source: "verified", properties: { table: "orders", data_type: "integer" } },
  { id: "column:demo:orders:customer_id", type: "column", name: "customer_id", source: "verified", properties: { table: "orders", data_type: "integer" } },
  { id: "column:demo:orders:product_id", type: "column", name: "product_id", source: "verified", properties: { table: "orders", data_type: "integer" } },
  { id: "column:demo:orders:amount", type: "column", name: "amount", source: "verified", properties: { table: "orders", data_type: "real" } },
  { id: "column:demo:orders:order_date", type: "column", name: "order_date", source: "verified", properties: { table: "orders", data_type: "text" } },
  { id: "column:demo:orders:channel", type: "column", name: "channel", source: "verified", properties: { table: "orders", data_type: "text" } },
  // Columns — customers
  { id: "column:demo:customers:id", type: "column", name: "id", source: "verified", properties: { table: "customers", data_type: "integer" } },
  { id: "column:demo:customers:name", type: "column", name: "name", source: "verified", properties: { table: "customers", data_type: "text" } },
  { id: "column:demo:customers:region", type: "column", name: "region", source: "verified", properties: { table: "customers", data_type: "text" } },
  // Columns — products
  { id: "column:demo:products:id", type: "column", name: "id", source: "verified", properties: { table: "products", data_type: "integer" } },
  { id: "column:demo:products:name", type: "column", name: "name", source: "verified", properties: { table: "products", data_type: "text" } },
  { id: "column:demo:products:category", type: "column", name: "category", source: "verified", properties: { table: "products", data_type: "text" } },
  { id: "column:demo:products:price", type: "column", name: "price", source: "verified", properties: { table: "products", data_type: "real" } },
  // Concepts
  { id: "concept:revenue", type: "concept", name: "Revenue", source: "authoritative", properties: { description: "Total order amount", formula: "SUM(orders.amount)" } },
  { id: "concept:gmv", type: "concept", name: "GMV", source: "authoritative", properties: { description: "Gross Merchandise Volume", formula: "SUM(orders.amount)" } },
  { id: "concept:order_count", type: "concept", name: "Order Count", source: "authoritative", properties: { description: "Number of orders", formula: "COUNT(orders.id)" } },
  // Entities
  { id: "entity:customer", type: "entity", name: "Customer", source: "authoritative", properties: { description: "A person who places orders" } },
  { id: "entity:product", type: "entity", name: "Product", source: "authoritative", properties: { description: "A product that can be ordered" } }
];

const SEED_EDGES: SeedEdge[] = [
  // has_column edges
  { id: "e1", source_id: "table:demo:orders", target_id: "column:demo:orders:id", type: "has_column", confidence: 1.0 },
  { id: "e2", source_id: "table:demo:orders", target_id: "column:demo:orders:customer_id", type: "has_column", confidence: 1.0 },
  { id: "e3", source_id: "table:demo:orders", target_id: "column:demo:orders:product_id", type: "has_column", confidence: 1.0 },
  { id: "e4", source_id: "table:demo:orders", target_id: "column:demo:orders:amount", type: "has_column", confidence: 1.0 },
  { id: "e5", source_id: "table:demo:orders", target_id: "column:demo:orders:order_date", type: "has_column", confidence: 1.0 },
  { id: "e6", source_id: "table:demo:orders", target_id: "column:demo:orders:channel", type: "has_column", confidence: 1.0 },
  { id: "e7", source_id: "table:demo:customers", target_id: "column:demo:customers:id", type: "has_column", confidence: 1.0 },
  { id: "e8", source_id: "table:demo:customers", target_id: "column:demo:customers:name", type: "has_column", confidence: 1.0 },
  { id: "e9", source_id: "table:demo:customers", target_id: "column:demo:customers:region", type: "has_column", confidence: 1.0 },
  { id: "e10", source_id: "table:demo:products", target_id: "column:demo:products:id", type: "has_column", confidence: 1.0 },
  { id: "e11", source_id: "table:demo:products", target_id: "column:demo:products:name", type: "has_column", confidence: 1.0 },
  { id: "e12", source_id: "table:demo:products", target_id: "column:demo:products:category", type: "has_column", confidence: 1.0 },
  { id: "e13", source_id: "table:demo:products", target_id: "column:demo:products:price", type: "has_column", confidence: 1.0 },
  // foreign_key edges
  { id: "e14", source_id: "column:demo:orders:customer_id", target_id: "column:demo:customers:id", type: "foreign_key", confidence: 1.0, properties: { join_condition: "orders.customer_id = customers.id" } },
  { id: "e15", source_id: "column:demo:orders:product_id", target_id: "column:demo:products:id", type: "foreign_key", confidence: 1.0, properties: { join_condition: "orders.product_id = products.id" } },
  // joinable edges (inferred)
  { id: "e16", source_id: "table:demo:orders", target_id: "table:demo:customers", type: "joinable", confidence: 0.95, properties: { via: "customer_id" } },
  { id: "e17", source_id: "table:demo:orders", target_id: "table:demo:products", type: "joinable", confidence: 0.95, properties: { via: "product_id" } },
  // semantic_synonym edges
  { id: "e18", source_id: "concept:revenue", target_id: "column:demo:orders:amount", type: "semantic_synonym", confidence: 0.9, properties: { description: "Revenue is computed from order amounts" } },
  { id: "e19", source_id: "concept:gmv", target_id: "concept:revenue", type: "semantic_synonym", confidence: 0.85, properties: { description: "GMV and Revenue are closely related" } },
  { id: "e20", source_id: "concept:order_count", target_id: "column:demo:orders:id", type: "semantic_synonym", confidence: 0.9, properties: { description: "Order count is computed by counting order IDs" } },
  // entity relationships
  { id: "e21", source_id: "entity:customer", target_id: "table:demo:customers", type: "maps_to", confidence: 1.0 },
  { id: "e22", source_id: "entity:product", target_id: "table:demo:products", type: "maps_to", confidence: 1.0 },
  // correlated edges (inferred)
  { id: "e23", source_id: "column:demo:products:price", target_id: "column:demo:orders:amount", type: "correlated", confidence: 0.7, properties: { description: "Product price correlates with order amount" } }
];
