import { createHash } from "node:crypto";

import { asRecord, BaseToolObservationAdapter } from "./base-tool-observation-adapter.js";
import type { ContextBudget } from "../../inventory/context-budget.js";
import { createContextItem, type ContextItem } from "../../inventory/context-item.js";
import { createContextSourceMetadata } from "../../inventory/context-source-metadata.js";

export class ListDataSourcesToolObservationAdapter extends BaseToolObservationAdapter {
  readonly toolName = "list_data_sources";
  readonly resultType = "data-list-sources";

  protected project(raw: unknown): unknown {
    return Array.isArray(raw) ? { datasources: raw } : asRecord(raw);
  }
}

export class PreviewTableToolObservationAdapter extends BaseToolObservationAdapter {
  readonly toolName = "preview_table";
  readonly resultType = "data-preview-table";

  protected project(raw: unknown): unknown {
    return asRecord(raw);
  }
}

export class CreateChartToolObservationAdapter extends BaseToolObservationAdapter {
  readonly toolName = "create_chart";
  readonly resultType = "data-chart";

  protected project(raw: unknown): unknown {
    return asRecord(raw);
  }
}

export class RetrieveKnowledgeToolObservationAdapter extends BaseToolObservationAdapter {
  readonly toolName = "retrieve_knowledge";
  readonly resultType = "knowledge-retrieval";
  protected readonly modelGroupKind = "source";
  protected readonly sourceKind = "knowledge";
  protected readonly sourceOwner = "knowledge-retrieval";

  /** Project retrieved Knowledge chunks as chunk-level source items for precise dedupe and overlap decisions. */
  toContextItems(raw: unknown, budget: ContextBudget): ContextItem[] {
    const projected = this.project(raw);
    const chunks = extractKnowledgeChunks(projected);
    if (chunks.length === 0) {
      return super.toContextItems(raw, budget);
    }

    const record = asRecord(projected);
    const collectionId = stringField(record, "collection_id") ?? "unknown";
    const groupId = `${this.resultType}-observation`;
    const maxModelChars = Math.max(600, Math.floor((budget.maxChars ?? 12000) / chunks.length));
    const modelItems = chunks.map((chunk, index) => {
      const chunkKey = knowledgeChunkIdentity(collectionId, chunk, index);
      return createContextItem({
        id: `${this.resultType}-model-${chunkKey}`,
        sourceType: this.resultType,
        sourceId: chunkKey,
        groupId,
        visibility: "model",
        trust: "tool",
        retention: "supporting",
        priority: 25,
        content: boundStructuredValue(createKnowledgeChunkContent(collectionId, chunk), maxModelChars),
        metadata: createContextSourceMetadata({
          dedupeKeys: knowledgeChunkDedupeKeys(collectionId, chunk),
          exclusivityKey: `knowledge-chunk:${chunkKey}`,
          overlapKeys: knowledgeChunkOverlapKeys(collectionId, chunk),
          sourceKind: this.sourceKind,
          sourceOwner: this.sourceOwner
        }, { atomic: true, groupKind: "source", toolName: this.toolName })
      });
    });
    return [
      ...modelItems,
      createContextItem({
        id: `${this.resultType}-activity`,
        sourceType: this.resultType,
        sourceId: this.toolName,
        groupId,
        visibility: "activity",
        trust: "tool",
        retention: "reference",
        priority: 10,
        content: boundStructuredValue(projected, budget.maxChars ?? 12000),
        metadata: createContextSourceMetadata({
          dedupeKeys: [`knowledge-result:${stableHash(projected)}`],
          exclusivityKey: `knowledge-result:${stableHash(projected)}`,
          overlapKeys: chunks.flatMap((chunk) => knowledgeChunkOverlapKeys(collectionId, chunk)),
          sourceKind: this.sourceKind,
          sourceOwner: this.sourceOwner
        }, { atomic: true, groupKind: "reference", toolName: this.toolName })
      })
    ];
  }

  protected project(raw: unknown): unknown {
    return asRecord(raw);
  }

  protected createDedupeKeys(projected: unknown): string[] {
    const keys = this.knowledgeDedupeKeys(projected);
    return keys.length > 0 ? keys : [`knowledge-result:${stableHash(projected)}`];
  }

  protected createExclusivityKey(projected: unknown): string {
    const collectionId = stringField(asRecord(projected), "collection_id") ?? "unknown";
    return `knowledge-retrieval:${collectionId}:${stableHash(projected)}`;
  }

  protected createOverlapKeys(projected: unknown): string[] {
    return this.knowledgeOverlapKeys(projected);
  }

  private knowledgeDedupeKeys(projected: unknown): string[] {
    const record = asRecord(projected);
    const collectionId = stringField(record, "collection_id") ?? "unknown";
    return unique(extractKnowledgeChunks(projected).flatMap((chunk) => knowledgeChunkDedupeKeys(collectionId, chunk)));
  }

  private knowledgeOverlapKeys(projected: unknown): string[] {
    const record = asRecord(projected);
    const collectionId = stringField(record, "collection_id") ?? "unknown";
    return unique(extractKnowledgeChunks(projected).flatMap((chunk) => knowledgeChunkOverlapKeys(collectionId, chunk)));
  }
}

const createKnowledgeChunkContent = (
  collectionId: string,
  chunk: Record<string, unknown>
): Record<string, unknown> => ({
  collection_id: collectionId,
  ...chunk
});

const extractKnowledgeChunks = (value: unknown): Record<string, unknown>[] => {
  const record = asRecord(value);
  const chunks = Array.isArray(record.chunks) ? record.chunks : Array.isArray(value) ? value : [];
  return chunks.filter(isRecord);
};

const knowledgeChunkIdentity = (
  collectionId: string,
  chunk: Record<string, unknown>,
  index: number
): string => {
  const chunkId = stringField(chunk, "chunk_id");
  const documentId = stringField(chunk, "document_id");
  if (chunkId) {
    return chunkId;
  }
  if (documentId) {
    return `${documentId}:${index}`;
  }
  const content = stringField(chunk, "content") ?? stringField(chunk, "quote") ?? safeSerialize(chunk);
  return `${collectionId}:${contentHash(content)}`;
};

const knowledgeChunkDedupeKeys = (collectionId: string, chunk: Record<string, unknown>): string[] => {
  const chunkId = stringField(chunk, "chunk_id");
  const documentId = stringField(chunk, "document_id");
  const content = stringField(chunk, "content") ?? stringField(chunk, "quote");
  return unique([
    ...(chunkId ? [`knowledge-chunk:${chunkId}`] : []),
    ...(documentId && chunkId ? [`knowledge-citation:${documentId}:${chunkId}`] : []),
    ...(content ? [`knowledge-content:${collectionId}:${contentHash(content)}`] : [])
  ]);
};

const knowledgeChunkOverlapKeys = (collectionId: string, chunk: Record<string, unknown>): string[] => {
  const content = stringField(chunk, "content") ?? stringField(chunk, "quote");
  if (!content) {
    return [];
  }
  const hash = contentHash(content);
  return [`content:${hash}`, `content:${collectionId}:${hash}`];
};

const stableHash = (value: unknown): string => contentHash(safeSerialize(value));

const contentHash = (text: string): string =>
  createHash("sha256").update(normalizeOverlapText(text)).digest("hex");

const normalizeOverlapText = (text: string): string => text.toLowerCase().replaceAll(/\s+/gu, " ").trim();

const safeSerialize = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const boundStructuredValue = (value: unknown, maxChars: number): unknown => {
  const serialized = safeSerialize(value);
  if (serialized.length <= maxChars) {
    return value;
  }

  const reservedChars = 160;
  return {
    original_chars: serialized.length,
    preview: serialized.slice(0, Math.max(maxChars - reservedChars, 0)),
    truncated: true
  };
};

const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const unique = (values: string[]): string[] => [...new Set(values)].sort((left, right) => left.localeCompare(right));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export class SemanticGraphToolObservationAdapter extends BaseToolObservationAdapter {
  readonly toolName = "semantic_graph";
  readonly resultType = "semantic-graph";

  protected project(raw: unknown): unknown {
    return asRecord(raw);
  }

  /**
   * Override toContextItems to apply semantic-graph-specific compression.
   *
   * When the result is large (many nodes/edges), we compress the structured data
   * before it enters the context window:
   * 1. Keep the `text` field (already structured by the service with built-in budget)
   * 2. For `nodes`: keep only essential fields (id, type, name, is_indicator, indicator_caliber)
   *    and drop verbose properties/descriptions when there are many nodes
   * 3. For `edges`: keep only essential fields and cap the count
   * 4. Drop the `datasources` array (it's metadata, not needed for LLM reasoning)
   */
  toContextItems(raw: unknown, budget: ContextBudget): ContextItem[] {
    const projected = this.project(raw);
    const maxChars = budget.maxChars ?? 12000;
    const compressed = compressSemanticGraphResult(projected, maxChars);
    const bounded = boundStructuredValue(compressed, maxChars);
    const groupId = `${this.resultType}-observation`;
    const dedupeKeys = this.createDedupeKeys(projected);
    const exclusivityKey = this.createExclusivityKey(projected);
    const overlapKeys = this.createOverlapKeys(projected);
    return [
      createContextItem({
        id: `${this.resultType}-model`,
        sourceType: this.resultType,
        sourceId: this.toolName,
        groupId,
        visibility: "model",
        trust: "tool",
        retention: "supporting",
        priority: 20,
        content: bounded,
        metadata: createContextSourceMetadata({
          dedupeKeys,
          exclusivityKey,
          overlapKeys,
          sourceKind: this.sourceKind,
          sourceOwner: this.sourceOwner
        }, { atomic: true, groupKind: this.modelGroupKind, toolName: this.toolName })
      }),
      createContextItem({
        id: `${this.resultType}-activity`,
        sourceType: this.resultType,
        sourceId: this.toolName,
        groupId,
        visibility: "activity",
        trust: "tool",
        retention: "reference",
        priority: 10,
        content: bounded,
        metadata: createContextSourceMetadata({
          dedupeKeys,
          exclusivityKey,
          overlapKeys,
          sourceKind: this.sourceKind,
          sourceOwner: this.sourceOwner
        }, { atomic: true, groupKind: "reference", toolName: this.toolName })
      })
    ];
  }
}

/**
 * Compress a semantic graph result to fit within a character budget.
 *
 * Strategy:
 * - Always keep the `text` field (it's already structured and budget-aware from the service)
 * - For nodes: when there are many, keep only key fields and drop verbose metadata
 * - For edges: cap the number and keep only essential fields
 * - Drop `datasources` metadata array (not needed for LLM reasoning)
 */
const compressSemanticGraphResult = (projected: unknown, maxChars: number): Record<string, unknown> => {
  const record = asRecord(projected);
  const text = stringField(record, "text") ?? "";
  const nodes = Array.isArray(record.nodes) ? record.nodes : [];
  const edges = Array.isArray(record.edges) ? record.edges : [];

  // Reserve space for text + overhead
  const textChars = text.length;
  const overhead = 512; // JSON structure overhead
  const remainingBudget = Math.max(maxChars - textChars - overhead, 1000);

  // Determine compression level based on node count
  const COMPACT_THRESHOLD = 30;
  const MINIMAL_THRESHOLD = 60;

  let compressedNodes: unknown[];
  let compressedEdges: unknown[];

  if (nodes.length <= COMPACT_THRESHOLD) {
    // Full detail: keep all fields
    compressedNodes = nodes;
    compressedEdges = edges;
  } else if (nodes.length <= MINIMAL_THRESHOLD) {
    // Medium compression: keep key fields only
    compressedNodes = nodes.map((node) => {
      const n = asRecord(node);
      const result: Record<string, unknown> = {
        id: n.id,
        type: n.type,
        ...(n.name !== undefined ? { name: n.name } : {})
      };
      if (n.is_indicator) {
        result.is_indicator = true;
        if (n.indicator_caliber) result.indicator_caliber = n.indicator_caliber;
      }
      if (n.business_semantic) result.business_semantic = n.business_semantic;
      return result;
    });
    // Keep only relationship type and endpoints
    compressedEdges = edges.slice(0, 50).map((edge) => {
      const e = asRecord(edge);
      return {
        ...(e.source_id !== undefined ? { source_id: e.source_id } : {}),
        ...(e.target_id !== undefined ? { target_id: e.target_id } : {}),
        ...(e.type !== undefined ? { type: e.type } : {})
      };
    });
  } else {
    // Heavy compression: minimal fields, cap counts
    compressedNodes = nodes.slice(0, 50).map((node) => {
      const n = asRecord(node);
      const result: Record<string, unknown> = {
        id: n.id,
        type: n.type,
        ...(n.name !== undefined ? { name: n.name } : {})
      };
      if (n.is_indicator) {
        result.is_indicator = true;
        if (n.indicator_caliber) result.indicator_caliber = truncateForCompression(n.indicator_caliber, 100);
      }
      return result;
    });
    compressedEdges = edges.slice(0, 20).map((edge) => {
      const e = asRecord(edge);
      return {
        ...(e.source_id !== undefined ? { source_id: e.source_id } : {}),
        ...(e.target_id !== undefined ? { target_id: e.target_id } : {}),
        ...(e.type !== undefined ? { type: e.type } : {})
      };
    });
  }

  // Check if the compressed result still fits; if not, progressively reduce
  let result: Record<string, unknown> = {
    text,
    nodes: compressedNodes,
    edges: compressedEdges
  };

  // Keep snapshot_id if present (useful for follow-up queries)
  if (record.snapshot_id !== undefined) {
    result.snapshot_id = record.snapshot_id;
  }

  // If still over budget, drop edges first, then reduce nodes
  while (safeSerialize(result).length > maxChars && Array.isArray(result.edges) && (result.edges as unknown[]).length > 0) {
    const currentEdges = result.edges as unknown[];
    result.edges = currentEdges.slice(0, Math.floor(currentEdges.length / 2));
  }
  while (safeSerialize(result).length > maxChars && Array.isArray(result.nodes) && (result.nodes as unknown[]).length > 5) {
    const currentNodes = result.nodes as unknown[];
    result.nodes = currentNodes.slice(0, Math.floor(currentNodes.length / 2));
  }

  // Final fallback: if still over budget, keep only text
  if (safeSerialize(result).length > maxChars) {
    result = { text: truncateForCompression(text, maxChars - 200) };
  }

  return result;
};

const truncateForCompression = (text: unknown, maxLen: number): string => {
  const str = typeof text === "string" ? text : safeSerialize(text);
  return str.length <= maxLen ? str : `${str.slice(0, Math.max(maxLen - 3, 0))}...`;
};
