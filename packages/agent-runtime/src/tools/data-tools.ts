import { createTool } from "@mastra/core/tools";
import type { DataGateway, SchemaSummary, SqlExecutionResult } from "@datafoundry/data-gateway";
import type { ArtifactSummary, ChartPreviewPoint, ChartPreviewSeries, ChartPreviewType } from "@datafoundry/contracts";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ContextPackage } from "../context/inventory/context-package.js";
import { truncateContextText } from "../context/inventory/context-text.js";
import { SQL_MAX_SQL_CHARS } from "../context/inventory/context-limits.js";
import { toolObservationActivityFromPackage } from "../context/tool-observation/tool-observation-projection-items.js";
import { createActivitySnapshot, createArtifactEvent, createCustomEvent } from "../events.js";
import { SQL_MAX_EXECUTION_COUNT } from "../runtime-limits.js";
import { createTokenUsageCorrelationStore } from "../stream/token-usage-correlation.js";
import type { AgentRunContext, AgUiEventEmitter } from "../types.js";
import { enrichSqlDialectError, validateSqlDialect } from "./sql-dialect-validation.js";

type DataToolExecutionOptions = {
  toolCallId?: string;
};

type MastraToolExecuteOptions = {
  agent?: { toolCallId?: string };
};

const toolCallIdFromOptions = (options?: MastraToolExecuteOptions): string | undefined =>
  typeof options?.agent?.toolCallId === "string" && options.agent.toolCallId.length > 0
    ? options.agent.toolCallId
    : undefined;

const executionOptionsFromMastra = (
  options?: MastraToolExecuteOptions,
): DataToolExecutionOptions | undefined => {
  const toolCallId = toolCallIdFromOptions(options);
  return toolCallId ? { toolCallId } : undefined;
};

type TokenUsageCorrelationStore = ReturnType<typeof createTokenUsageCorrelationStore>;

type SchemaCapability = {
  datasource_id: string;
  dialect?: string;
  schema_id: string;
};

/** Lightweight client for querying the semantic graph (Data Link) service. */
export type SemanticGraphClient = {
  /** Explore the semantic graph for a datasource using a natural-language query. */
  explore(input: {
    user_id: string;
    workspace_id?: string;
    datasource_id: string;
    query: string;
    max_nodes?: number;
    focus?: string;
  }): Promise<{
    text: string;
    nodes?: unknown[];
    edges?: unknown[];
    snapshot_id?: string;
  }>;
  /** Check whether a semantic graph has been built for a datasource. */
  hasGraph(input: {
    user_id: string;
    workspace_id?: string;
    datasource_id: string;
  }): Promise<{ built: boolean; tables_count?: number; columns_count?: number; edges_count?: number }>;
};

type InspectSchemaResult = SchemaSummary & {
  schema_id: string;
};

type RawSqlToolResult = {
  cache_hit?: boolean;
  result: SqlExecutionResult;
  sql: string;
};

type GovernedResultInput = {
  contextPackage: ContextPackage;
  rawResult: unknown;
  toolName: string;
  toolCallId?: string;
  toolInput?: unknown;
};

export type ToolRegistry = {
  inspectSchema(
    input?: { datasource_id?: string; table_names?: string[] },
    options?: DataToolExecutionOptions,
  ): Promise<InspectSchemaResult>;
  listDataSources(input?: { enabled_only?: boolean }): Promise<unknown>;
  mastraTools: {
    inspect_schema: ReturnType<typeof createTool>;
    list_data_sources: ReturnType<typeof createTool>;
    preview_table: ReturnType<typeof createTool>;
    run_sql_readonly: ReturnType<typeof createTool>;
    create_chart: ReturnType<typeof createTool>;
    semantic_graph: ReturnType<typeof createTool>;
  };
  onGovernedResult(input: GovernedResultInput): void;
  onGovernanceError(input: { error: unknown; rawResult: unknown; toolName: string }): void;
  previewTable(input: { schema_id: string; table: string; limit?: number }): Promise<unknown>;
  runSqlReadonly(
    input: {
      schema_id: string;
      sql: string;
      assertion_ids?: string[];
      requirement_ids?: string[];
      expected_columns?: string[];
      limit?: number;
      timeout_ms?: number;
    },
    options?: DataToolExecutionOptions,
  ): Promise<RawSqlToolResult>;
  createChart(
    input: {
      title: string;
      chart_type: ChartPreviewType;
      points?: ChartPreviewPoint[];
      series?: ChartPreviewSeries[];
      unit?: string;
      source_artifact_id?: string;
    },
    options?: DataToolExecutionOptions,
  ): Promise<ArtifactSummary>;
  exploreSemanticGraph(
    input: {
      datasource_id?: string;
      query: string;
      max_nodes?: number;
      focus?: string;
    },
    options?: DataToolExecutionOptions,
  ): Promise<{
    datasource_id: string;
    query: string;
    text: string;
    nodes: unknown[];
    edges: unknown[];
    snapshot_id?: string;
    graph_built: boolean;
    guidance?: string;
    datasources?: Array<{
      datasource_id: string;
      text: string;
      nodes: unknown[];
      edges: unknown[];
      graph_built: boolean;
      guidance?: string;
    }>;
  }>;
  state: {
    artifact_ids: string[];
    schema_capabilities: Map<string, SchemaCapability>;
    sql_execution_count: number;
    sql_execution_count_by_datasource: Map<string, number>;
  };
};

type CreateDataFoundryToolRegistryInput = {
  abortSignal?: AbortSignal | undefined;
  dataGateway: DataGateway;
  emitter: AgUiEventEmitter;
  runContext: AgentRunContext;
  tokenUsageCorrelation?: TokenUsageCorrelationStore;
  semanticGraphClient?: SemanticGraphClient;
};

/** Create the run-local data tool registry and concurrency-safe execution state. */
export const createDataFoundryToolRegistry = (input: CreateDataFoundryToolRegistryInput): ToolRegistry => {
  const state = {
    artifact_ids: [] as string[],
    schema_capabilities: new Map<string, SchemaCapability>(),
    sql_execution_count: 0,
    sql_execution_count_by_datasource: new Map<string, number>()
  };
  const resultMetadata = new WeakMap<object, { datasourceId: string; stepId: string }>();
  const sqlResultCache = new Map<string, RawSqlToolResult>();

  const listDataSources = async (toolInput: { enabled_only?: boolean } = {}): Promise<unknown> => {
    throwIfAborted(input.abortSignal);
    const allowedIds = new Set(input.runContext.enabled_datasource_ids ?? []);
    const results = await input.dataGateway.listDataSources({
      user_id: input.runContext.user_id,
      ...(toolInput.enabled_only !== undefined ? { enabled_only: toolInput.enabled_only } : {})
    });
    return { datasources: results.filter((datasource) => allowedIds.has(datasource.id)) };
  };

  const emitStepCorrelation = (
    stepId: string,
    toolName: string,
    toolCallId?: string,
  ): void => {
    if (!toolCallId || !input.tokenUsageCorrelation) return;
    input.tokenUsageCorrelation.emitCorrelation(input.emitter, {
      stepId,
      toolCallId,
      toolName,
    });
  };

  const inspectSchema = async (
    toolInput: { datasource_id?: string; table_names?: string[] } = {},
    options?: DataToolExecutionOptions,
  ): Promise<InspectSchemaResult> => {
    throwIfAborted(input.abortSignal);
    const datasourceId = resolveDatasourceId(input.runContext, toolInput.datasource_id);
    const stepId = `schema-${randomUUID()}`;
    emitStepCorrelation(stepId, "inspect_schema", options?.toolCallId);
    input.emitter.emit(createActivitySnapshot(input.runContext, "STEP", {
      step_id: stepId,
      title: "Inspect data source schema",
      kind: "schema",
      tool_name: "inspect_schema",
      status: "running",
      datasource_id: datasourceId,
      input: toolInput
    }));

    try {
      const result = await input.dataGateway.inspectSchema({
        user_id: input.runContext.user_id,
        ...(input.runContext.workspace_id ? { workspace_id: input.runContext.workspace_id } : {}),
        datasource_id: datasourceId,
        ...(toolInput.table_names ? { table_names: toolInput.table_names } : {}),
        ...(input.abortSignal ? { signal: input.abortSignal } : {})
      });
      const schema_id = `schema_${randomUUID()}`;
      state.schema_capabilities.set(schema_id, {
        datasource_id: datasourceId,
        ...(result.dialect ? { dialect: result.dialect } : {}),
        schema_id
      });
      const rawResult = { ...result, schema_id };
      resultMetadata.set(rawResult, { datasourceId, stepId });
      return rawResult;
    } catch (error) {
      emitFailedStep(input, stepId, "inspect_schema", "Inspect data source schema", error);
      throw error;
    }
  };

  const runSqlReadonly = async (
    toolInput: {
      schema_id: string;
      sql: string;
      assertion_ids?: string[];
      requirement_ids?: string[];
      expected_columns?: string[];
      limit?: number;
      timeout_ms?: number;
    },
    options?: DataToolExecutionOptions,
  ): Promise<RawSqlToolResult> => {
    throwIfAborted(input.abortSignal);
    const capability = state.schema_capabilities.get(toolInput.schema_id);
    if (!capability) {
      throw new Error("SCHEMA_REQUIRED_BEFORE_SQL");
    }
    const datasourceId = capability.datasource_id;
    const dialectIssues = validateSqlDialect(toolInput.sql, capability.dialect);
    if (dialectIssues.length > 0) {
      const issue = dialectIssues[0];
      throw new Error(`SQL_DIALECT_UNSUPPORTED:${issue?.dialect}:${issue?.code}:${issue?.hint}`);
    }
    const cacheKey = sqlCacheKey(toolInput);
    const cached = sqlResultCache.get(cacheKey);
    if (cached) {
      const rawResult = { ...cached, cache_hit: true as const };
      resultMetadata.set(rawResult, { datasourceId, stepId: `sql-cache-${randomUUID()}` });
      return rawResult;
    }

    state.sql_execution_count += 1;
    const datasourceCount = (state.sql_execution_count_by_datasource.get(datasourceId) ?? 0) + 1;
    state.sql_execution_count_by_datasource.set(datasourceId, datasourceCount);
    if (state.sql_execution_count > SQL_MAX_EXECUTION_COUNT) {
      throw new Error("SQL_EXECUTION_LIMIT_EXCEEDED");
    }

    const stepId = `sql-${state.sql_execution_count}`;
    emitStepCorrelation(stepId, "run_sql_readonly", options?.toolCallId);
    const sqlActivityPreview = truncateContextText(toolInput.sql, SQL_MAX_SQL_CHARS);
    input.emitter.emit(createActivitySnapshot(input.runContext, "STEP", {
      step_id: stepId,
      title: "Run read-only SQL",
      kind: "sql",
      tool_name: "run_sql_readonly",
      status: "running",
      datasource_id: datasourceId,
      sql: sqlActivityPreview,
      input: { ...toolInput, datasource_id: datasourceId, sql: sqlActivityPreview }
    }));

    try {
      const result = await input.dataGateway.runSqlReadonly({
        user_id: input.runContext.user_id,
        ...(input.runContext.workspace_id ? { workspace_id: input.runContext.workspace_id } : {}),
        run_id: input.runContext.run_id,
        datasource_id: datasourceId,
        sql: toolInput.sql,
        ...(toolInput.limit ? { limit: toolInput.limit } : {}),
        ...(toolInput.timeout_ms ? { timeout_ms: toolInput.timeout_ms } : {}),
        ...(input.abortSignal ? { signal: input.abortSignal } : {}),
        // R-018: let the produced table artifact record its origin so the Detail view
        // can link the SQL result back to this tool_call / step.
        ...(options?.toolCallId || stepId
          ? { correlation: {
              ...(options?.toolCallId ? { tool_call_id: options.toolCallId } : {}),
              ...(stepId ? { step_id: stepId } : {})
            } }
          : {})
      });
      if (result.artifact_id) {
        state.artifact_ids.push(result.artifact_id);
      }
      emitSqlReferences(input, datasourceId, result);
      const rawResult = { result, sql: toolInput.sql };
      sqlResultCache.set(cacheKey, rawResult);
      resultMetadata.set(rawResult, { datasourceId, stepId });
      return rawResult;
    } catch (error) {
      emitFailedStep(input, stepId, "run_sql_readonly", "Run read-only SQL", error);
      throw enrichSqlDialectError(error, capability.dialect);
    }
  };

  const previewTable = async (toolInput: {
    schema_id: string;
    table: string;
    limit?: number;
  }): Promise<unknown> => {
    throwIfAborted(input.abortSignal);
    const capability = state.schema_capabilities.get(toolInput.schema_id);
    if (!capability) {
      throw new Error("SCHEMA_REQUIRED_BEFORE_PREVIEW");
    }
    const result = await input.dataGateway.previewTable({
      user_id: input.runContext.user_id,
      ...(input.runContext.workspace_id ? { workspace_id: input.runContext.workspace_id } : {}),
      datasource_id: capability.datasource_id,
      table: toolInput.table,
      ...(toolInput.limit ? { limit: toolInput.limit } : {}),
      ...(input.abortSignal ? { signal: input.abortSignal } : {})
    });
    return { datasource_id: capability.datasource_id, table: toolInput.table, ...result };
  };

  const onGovernedResult = (governed: GovernedResultInput): void => {
    if (!isObject(governed.rawResult)) {
      return;
    }
    const metadata = resultMetadata.get(governed.rawResult);
    if (!metadata) {
      return;
    }
    const isSchema = governed.toolName === "inspect_schema";
    const isSql = governed.toolName === "run_sql_readonly";
    if (!isSchema && !isSql) {
      return;
    }
    input.emitter.emit(createActivitySnapshot(input.runContext, "STEP", {
      step_id: metadata.stepId,
      title: isSchema ? "Inspect data source schema" : "Run read-only SQL",
      kind: isSchema ? "schema" : "sql",
      tool_name: governed.toolName,
      status: "completed",
      output_type: isSchema ? "json" : "table",
      content: toolObservationActivityFromPackage(governed.contextPackage)
    }));
  };

  const createChart = async (
    toolInput: {
      title: string;
      chart_type: ChartPreviewType;
      points?: ChartPreviewPoint[];
      series?: ChartPreviewSeries[];
      unit?: string;
      source_artifact_id?: string;
    },
    options?: DataToolExecutionOptions,
  ): Promise<ArtifactSummary> => {
    throwIfAborted(input.abortSignal);
    const stepId = `chart-${randomUUID()}`;
    emitStepCorrelation(stepId, "create_chart", options?.toolCallId);
    input.emitter.emit(createActivitySnapshot(input.runContext, "STEP", {
      step_id: stepId,
      title: `Create chart: ${toolInput.title}`,
      kind: "visualize",
      tool_name: "create_chart",
      status: "running",
      input: { chart_type: toolInput.chart_type, title: toolInput.title }
    }));

    try {
      const artifact = await input.dataGateway.createChartArtifact({
        user_id: input.runContext.user_id,
        session_id: input.runContext.session_id,
        run_id: input.runContext.run_id,
        name: toolInput.title,
        chartType: toolInput.chart_type,
        ...(toolInput.points ? { points: toolInput.points } : {}),
        ...(toolInput.series ? { series: toolInput.series } : {}),
        ...(toolInput.unit ? { unit: toolInput.unit } : {}),
        ...(toolInput.source_artifact_id
          ? { metadata_json: { source_artifact_id: toolInput.source_artifact_id } }
          : {}),
      });
      state.artifact_ids.push(artifact.id);
      input.emitter.emit(createArtifactEvent(artifact));
      input.emitter.emit(createActivitySnapshot(input.runContext, "STEP", {
        step_id: stepId,
        title: `Create chart: ${toolInput.title}`,
        kind: "visualize",
        tool_name: "create_chart",
        status: "completed",
        artifact_id: artifact.id
      }));
      return artifact;
    } catch (error) {
      emitFailedStep(input, stepId, "create_chart", `Create chart: ${toolInput.title}`, error);
      throw error;
    }
  };

  const exploreSemanticGraph = async (
    toolInput: {
      datasource_id?: string;
      query: string;
      max_nodes?: number;
      focus?: string;
    },
    options?: DataToolExecutionOptions,
  ): Promise<{
    datasource_id: string;
    query: string;
    text: string;
    nodes: unknown[];
    edges: unknown[];
    snapshot_id?: string;
    graph_built: boolean;
    guidance?: string;
    datasources?: Array<{
      datasource_id: string;
      text: string;
      nodes: unknown[];
      edges: unknown[];
      graph_built: boolean;
      guidance?: string;
    }>;
  }> => {
    throwIfAborted(input.abortSignal);
    if (!input.semanticGraphClient) {
      throw new Error("SEMANTIC_GRAPH_CLIENT_UNAVAILABLE");
    }

    // Single-datasource model: the user selects one datasource for analysis.
    // Use the explicitly requested datasource_id, or fall back to the selected datasource.
    const datasourceId = resolveDatasourceId(input.runContext, toolInput.datasource_id);

    const stepId = `semantic-${randomUUID()}`;
    emitStepCorrelation(stepId, "semantic_graph", options?.toolCallId);
    input.emitter.emit(createActivitySnapshot(input.runContext, "STEP", {
      step_id: stepId,
      title: "Explore semantic graph",
      kind: "semantic",
      tool_name: "semantic_graph",
      status: "running",
      datasource_id: datasourceId,
      input: { ...toolInput, datasource_id: datasourceId }
    }));

    try {
      // Explore the selected datasource's semantic graph
      const graphStatus = await input.semanticGraphClient.hasGraph({
        user_id: input.runContext.user_id,
        ...(input.runContext.workspace_id ? { workspace_id: input.runContext.workspace_id } : {}),
        datasource_id: datasourceId
      });

      let result: {
        datasource_id: string;
        query: string;
        text: string;
        nodes: unknown[];
        edges: unknown[];
        snapshot_id?: string;
        graph_built: boolean;
        guidance?: string;
      };

      if (!graphStatus.built) {
        const guidance = [
          `数据源 ${datasourceId} 尚未构建语义图谱。`,
          "语义图谱包含表与表之间的关系、字段语义、指标口径等信息，能够显著提高数据分析的准确性。",
          "请前往「Data Link」页面为该数据源构建语义图谱，补充表关系和字段语义后再进行分析。"
        ].join(" ");
        result = {
          datasource_id: datasourceId,
          query: toolInput.query,
          text: guidance,
          nodes: [],
          edges: [],
          graph_built: false,
          guidance
        };
      } else {
        const exploreResult = await input.semanticGraphClient.explore({
          user_id: input.runContext.user_id,
          ...(input.runContext.workspace_id ? { workspace_id: input.runContext.workspace_id } : {}),
          datasource_id: datasourceId,
          query: toolInput.query,
          ...(toolInput.max_nodes ? { max_nodes: toolInput.max_nodes } : {}),
          ...(toolInput.focus ? { focus: toolInput.focus } : {})
        });
        result = {
          datasource_id: datasourceId,
          query: toolInput.query,
          text: exploreResult.text,
          nodes: exploreResult.nodes ?? [],
          edges: exploreResult.edges ?? [],
          graph_built: true,
          ...(exploreResult.snapshot_id ? { snapshot_id: exploreResult.snapshot_id } : {})
        };
      }

      input.emitter.emit(createActivitySnapshot(input.runContext, "STEP", {
        step_id: stepId,
        title: "Explore semantic graph",
        kind: "semantic",
        tool_name: "semantic_graph",
        status: "completed",
        datasource_id: datasourceId,
        output_type: "json",
        content: result
      }));
      return result;
    } catch (error) {
      emitFailedStep(input, stepId, "semantic_graph", "Explore semantic graph", error);
      throw error;
    }
  };

  const onGovernanceError = (failed: { error: unknown; rawResult: unknown; toolName: string }): void => {
    if (!isObject(failed.rawResult)) {
      return;
    }
    const metadata = resultMetadata.get(failed.rawResult);
    if (!metadata || (failed.toolName !== "inspect_schema" && failed.toolName !== "run_sql_readonly")) {
      return;
    }
    emitFailedStep(
      input,
      metadata.stepId,
      failed.toolName,
      failed.toolName === "inspect_schema" ? "Inspect data source schema" : "Run read-only SQL",
      failed.error
    );
  };

  return {
    inspectSchema,
    listDataSources,
    mastraTools: createMastraDataTools({ inspectSchema, listDataSources, previewTable, runSqlReadonly, createChart, exploreSemanticGraph }),
    onGovernanceError,
    onGovernedResult,
    previewTable,
    runSqlReadonly,
    createChart,
    exploreSemanticGraph,
    state
  };
};

const sqlCacheKey = (input: {
  schema_id: string;
  sql: string;
  limit?: number;
  timeout_ms?: number;
}): string => [
  input.schema_id,
  input.sql.trim().replace(/;\s*$/u, ""),
  input.limit ?? "default",
  input.timeout_ms ?? "default"
].join("\u0000");

type DataToolExecutors = Pick<ToolRegistry, "inspectSchema" | "listDataSources" | "previewTable" | "runSqlReadonly" | "createChart" | "exploreSemanticGraph">;

const createMastraDataTools = (executors: DataToolExecutors): ToolRegistry["mastraTools"] => ({
  list_data_sources: createTool({
    id: "list_data_sources",
    description: "List datasources enabled for this run.",
    inputSchema: z.object({ enabled_only: z.boolean().optional() }),
    execute: (toolInput) => executors.listDataSources({
      ...(toolInput.enabled_only !== undefined ? { enabled_only: toolInput.enabled_only } : {})
    })
  }),
  inspect_schema: createTool({
    id: "inspect_schema",
    description:
      "Inspect a datasource schema and return a run-local schema_id that must precede SQL or preview calls.",
    inputSchema: z.object({
      datasource_id: z.string().optional(),
      table_names: z.array(z.string()).optional()
    }),
    execute: (toolInput, options) =>
      executors.inspectSchema(
        {
          ...(toolInput.datasource_id ? { datasource_id: toolInput.datasource_id } : {}),
          ...(toolInput.table_names ? { table_names: toolInput.table_names } : {}),
        },
        executionOptionsFromMastra(options),
      ),
  }),
  preview_table: createTool({
    id: "preview_table",
    description: "Preview a table using a schema_id returned by inspect_schema in this run.",
    inputSchema: z.object({
      schema_id: z.string(),
      table: z.string().min(1),
      limit: z.number().int().positive().optional()
    }),
    execute: (toolInput) => executors.previewTable({
      schema_id: toolInput.schema_id,
      table: toolInput.table,
      ...(toolInput.limit ? { limit: toolInput.limit } : {})
    })
  }),
  run_sql_readonly: createTool({
    id: "run_sql_readonly",
    description: "Execute one read-only SELECT/WITH query using a schema_id returned in this run.",
    inputSchema: z.object({
      schema_id: z.string(),
      sql: z.string(),
      assertion_ids: z.array(z.string().min(1)).max(32).optional(),
      requirement_ids: z.array(z.string().min(1)).max(16).optional(),
      expected_columns: z.array(z.string().min(1)).max(100).optional(),
      limit: z.number().int().positive().max(1000).optional(),
      timeout_ms: z.number().int().positive().max(30000).optional()
    }),
    execute: (toolInput, options) =>
      executors.runSqlReadonly(
        {
          schema_id: toolInput.schema_id,
          sql: toolInput.sql,
          ...(toolInput.assertion_ids ? { assertion_ids: toolInput.assertion_ids } : {}),
          ...(toolInput.requirement_ids ? { requirement_ids: toolInput.requirement_ids } : {}),
          ...(toolInput.expected_columns ? { expected_columns: toolInput.expected_columns } : {}),
          ...(toolInput.limit ? { limit: toolInput.limit } : {}),
          ...(toolInput.timeout_ms ? { timeout_ms: toolInput.timeout_ms } : {}),
        },
        executionOptionsFromMastra(options),
      ),
  }),
  create_chart: createTool({
    id: "create_chart",
    description:
      "Create an interactive chart artifact (bar / line / pie) from data you have already queried. " +
      "The frontend renders the chart with recharts and the user can switch chart types interactively. " +
      "Use this instead of matplotlib when you want an interactive, in-conversation visualization.",
    inputSchema: z.object({
      title: z.string().min(1).max(200),
      chart_type: z.enum(["bar", "line", "pie"]),
      points: z.array(z.object({
        label: z.string(),
        value: z.number()
      })).optional(),
      series: z.array(z.object({
        name: z.string(),
        points: z.array(z.object({
          label: z.string(),
          value: z.number()
        }))
      })).optional(),
      unit: z.string().max(50).optional(),
      source_artifact_id: z.string().optional()
    }),
    execute: (toolInput, options) =>
      executors.createChart(
        {
          title: toolInput.title,
          chart_type: toolInput.chart_type,
          ...(toolInput.points ? { points: toolInput.points } : {}),
          ...(toolInput.series ? { series: toolInput.series } : {}),
          ...(toolInput.unit ? { unit: toolInput.unit } : {}),
          ...(toolInput.source_artifact_id ? { source_artifact_id: toolInput.source_artifact_id } : {}),
        },
        executionOptionsFromMastra(options),
      ),
  }),
  semantic_graph: createTool({
    id: "semantic_graph",
    description:
      "Explore the semantic graph (Data Link) for the selected datasource to retrieve table relationships, " +
      "column semantics, indicator definitions, and business context that improve analysis accuracy. " +
      "Use this before writing SQL to understand table joins, field meanings, and metric calibers. " +
      "IMPORTANT: The 'query' parameter should contain the user's actual question or analysis intent " +
      "(e.g. '客户增长趋势' or 'monthly revenue by region') so the tool can retrieve only the relevant " +
      "tables, fields, and indicators — not the entire graph. " +
      "When datasource_id is omitted, the tool uses the user-selected datasource for this run. " +
      "If no graph has been built for the datasource, the tool returns guidance on how to build one.",
    inputSchema: z.object({
      datasource_id: z.string().optional(),
      query: z.string().min(1).max(500),
      max_nodes: z.number().int().min(1).max(50).optional(),
      focus: z.string().optional()
    }),
    execute: (toolInput, options) =>
      executors.exploreSemanticGraph(
        {
          query: toolInput.query,
          ...(toolInput.datasource_id ? { datasource_id: toolInput.datasource_id } : {}),
          ...(toolInput.max_nodes ? { max_nodes: toolInput.max_nodes } : {}),
          ...(toolInput.focus ? { focus: toolInput.focus } : {}),
        },
        executionOptionsFromMastra(options),
      ),
  })
});

const emitSqlReferences = (
  input: CreateDataFoundryToolRegistryInput,
  datasourceId: string,
  result: SqlExecutionResult
): void => {
  input.emitter.emit(createCustomEvent("sql_audit", {
    audit_log_id: result.audit_log_id,
    datasource_id: datasourceId,
    status: "succeeded",
    row_count: result.row_count,
    elapsed_ms: result.elapsed_ms
  }));
  if (result.artifact) {
    input.emitter.emit(createArtifactEvent(result.artifact));
  }
};

const emitFailedStep = (
  input: CreateDataFoundryToolRegistryInput,
  stepId: string,
  toolName: string,
  title: string,
  error: unknown
): void => {
  const kind = toolName === "inspect_schema" ? "schema"
    : toolName === "semantic_graph" ? "semantic"
    : "sql";
  input.emitter.emit(createActivitySnapshot(input.runContext, "STEP", {
    step_id: stepId,
    title,
    kind,
    tool_name: toolName,
    status: "failed",
    error_message: error instanceof Error ? error.message : `Unknown ${toolName} error`
  }));
};

const resolveDatasourceId = (context: AgentRunContext, requestedDatasourceId: string | undefined): string => {
  const datasourceId = requestedDatasourceId ?? context.selected_datasource_id;
  if (!datasourceId || !(context.enabled_datasource_ids ?? []).includes(datasourceId)) {
    throw new Error("DATASOURCE_NOT_SELECTED");
  }
  return datasourceId;
};

const throwIfAborted = (signal?: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("RUN_CANCELLED");
  }
};

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;
