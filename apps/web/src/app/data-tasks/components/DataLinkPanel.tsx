"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  DatalinkGraphDto,
  DatasourceDto,
  SemanticGraphRelationDto,
} from "../../../lib/config-api";
import { configApi } from "../../../lib/config-api";

// ── Types matching the prototype data model ────────────────────────────

type TableData = {
  id: string;
  name: string;
  label: string;
  schema: string;
  description: string;
  rowCount: number;
};

type ColumnData = {
  id: string;
  tableId: string;
  name: string;
  type: string;
  comment: string;
  isPK: boolean;
  businessSemantic: string;
  synonyms: string[];
  isIndicator: boolean;
  indicatorCaliber: string;
  fkTableId?: string;
};

type RelationData = {
  id: string;
  from: string;
  to: string;
  type: string;
  joinType: string;
  cardinality: string;
  leftField: string;
  rightField: string;
  description: string;
};

type AppData = {
  tables: TableData[];
  columns: ColumnData[];
  relations: RelationData[];
};

type SelectedNode = { id: string; kind: "table" | "column" } | null;

type ToastMsg = { id: number; text: string };

type RelationModalState = {
  sourceTableId: string;
  leftTable: string;
  rightTable: string;
  leftField: string;
  rightField: string;
  joinType: string;
  cardinality: string;
  description: string;
} | null;

// ── Component ──────────────────────────────────────────────────────────

export function DataLinkPanel({ onBack, onGraphBuilt }: { onBack: () => void; onOpenMcpSettings: () => void; onGraphBuilt?: () => void }) {
  const [datasources, setDatasources] = useState<DatasourceDto[]>([]);
  const [selectedDatasourceId, setSelectedDatasourceId] = useState("");
  const [loadingDatasources, setLoadingDatasources] = useState(false);
  const [buildingGraph, setBuildingGraph] = useState(false);
  const [loadingGraph, setLoadingGraph] = useState(false);
  const [appData, setAppData] = useState<AppData>({ tables: [], columns: [], relations: [] });
  const [selectedNode, setSelectedNode] = useState<SelectedNode>(null);
  const [lastEditedColumnId, setLastEditedColumnId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const [relationModal, setRelationModal] = useState<RelationModalState>(null);
  const [error, setError] = useState<string | null>(null);
  const [buildInfo, setBuildInfo] = useState<string | null>(null);

  const networkRef = useRef<unknown>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const visRef = useRef<{ Network: new (container: HTMLElement, data: unknown, options: unknown) => unknown; DataSet: new (data?: unknown[]) => { add: (items: unknown | unknown[]) => void; update: (items: unknown | unknown[]) => void; remove: (ids: string | string[]) => void; get: () => unknown[]; clear: () => void; } } | null>(null);
  const toastIdRef = useRef(0);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // ── Toast ──────────────────────────────────────────────────────────

  const showToast = useCallback((text: string) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, text }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 2500);
  }, []);

  // ── Data loading ───────────────────────────────────────────────────

  const loadDatasources = useCallback(async () => {
    setLoadingDatasources(true);
    setError(null);
    try {
      const response = await configApi.listDatalinkDatasources();
      setDatasources(response.datasources);
      if (response.datasources.length > 0 && !selectedDatasourceId) {
        setSelectedDatasourceId(response.datasources[0]?.id ?? "");
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load data sources");
      setDatasources([]);
    } finally {
      setLoadingDatasources(false);
    }
  }, [selectedDatasourceId]);

  const loadGraph = useCallback(async (dsId: string) => {
    if (!dsId) {
      setAppData({ tables: [], columns: [], relations: [] });
      return;
    }
    setLoadingGraph(true);
    setError(null);
    try {
      const response = await configApi.getSemanticGraph(dsId);
      const graph = response.graph as DatalinkGraphDto;
      const data = graphToAppData(graph, dsId);

      // Also load relations from SQLite
      try {
        const relResponse = await configApi.listSemanticRelations(dsId);
        // Build table name -> id map for resolving relation endpoints
        const tableNameToId = new Map<string, string>();
        for (const t of data.tables) {
          tableNameToId.set(t.name, t.id);
        }
        const relations: RelationData[] = (relResponse.relations ?? []).map((r: SemanticGraphRelationDto) => ({
          id: (r.relation_id ?? r.id ?? "") as string,
          from: tableNameToId.get(r.from_table as string) ?? r.from_table as string,
          to: tableNameToId.get(r.to_table as string) ?? r.to_table as string,
          type: "FK",
          joinType: (r.join_type ?? "INNER") as string,
          cardinality: (r.cardinality ?? "1:N") as string,
          leftField: r.from_field as string,
          rightField: r.to_field as string,
          description: (r.description ?? "") as string,
        }));
        data.relations = relations;
      } catch {
        // Relations might not exist yet — that's OK
      }

      setAppData(data);
    } catch (loadError) {
      setAppData({ tables: [], columns: [], relations: [] });
      const msg = loadError instanceof Error ? loadError.message : "Failed to load graph";
      if (!msg.includes("not found") && !msg.includes("empty") && !msg.includes("INTERNAL_ERROR")) {
        setError(msg);
      }
    } finally {
      setLoadingGraph(false);
    }
  }, []);

  const handleBuildGraph = useCallback(async () => {
    if (!selectedDatasourceId) {
      showToast("⚠️ 请先选择数据源");
      return;
    }
    setBuildingGraph(true);
    setError(null);
    setBuildInfo(null);
    try {
      const response = await configApi.buildSemanticGraph(selectedDatasourceId);
      setBuildInfo(response.result.message);
      await loadGraph(selectedDatasourceId);
      onGraphBuilt?.();
    } catch (buildError) {
      const msg = buildError instanceof Error ? buildError.message : "Failed to build graph";
      setError(msg);
    } finally {
      setBuildingGraph(false);
    }
  }, [loadGraph, selectedDatasourceId, showToast, onGraphBuilt]);

  // ── Load vis-network dynamically ───────────────────────────────────

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const vis = await import("vis-network/standalone");
        if (mounted) {
          visRef.current = vis as unknown as typeof visRef.current;
        }
      } catch {
        // Fallback: try separate imports
        try {
          const visData = await import("vis-data");
          const visNetwork = await import("vis-network");
          if (mounted) {
            visRef.current = {
              Network: visNetwork.Network,
              DataSet: visData.DataSet,
            } as unknown as typeof visRef.current;
          }
        } catch {
          // vis-network not available
        }
      }
    })();
    return () => { mounted = false; };
  }, []);

  // ── Graph rendering with vis-network ───────────────────────────────

  const buildGraphData = useCallback((data: AppData) => {
    const nodes: unknown[] = [];
    const edges: unknown[] = [];
    const maxRows = Math.max(1, ...data.tables.map((t) => t.rowCount || 0));

    // Table nodes
    data.tables.forEach((tbl) => {
      const size = 35 + (tbl.rowCount ? 25 * (tbl.rowCount / maxRows) : 0);
      nodes.push({
        id: tbl.id,
        label: tbl.label || tbl.name,
        group: "table",
        shape: "box",
        size: Math.min(size, 60),
        font: { color: "#e1e4ed", size: 13, face: "PingFang SC,Microsoft YaHei" },
        color: { background: "#ff6467", border: "#ff8a8c", highlight: { background: "#ff8a8c", border: "#ffa8aa" } },
        borderWidth: 2,
        borderWidthSelected: 3,
      });
    });

    // Column nodes
    data.columns.forEach((col) => {
      const isIndicator = col.isIndicator;
      nodes.push({
        id: col.id,
        label: col.name,
        group: isIndicator ? "indicator" : "column",
        shape: "ellipse",
        size: isIndicator ? 18 : 12,
        font: { color: "#e1e4ed", size: 9, face: "PingFang SC,Microsoft YaHei" },
        color: isIndicator
          ? { background: "#fe9a00", border: "#feb54d", highlight: { background: "#feb54d", border: "#fed099" } }
          : { background: "#615fff", border: "#818fff", highlight: { background: "#818fff", border: "#a5b4ff" } },
        borderWidth: 1,
        borderWidthSelected: 2,
      });
    });

    // Table-to-Column edges
    data.columns.forEach((col) => {
      edges.push({
        id: "tc_" + col.id,
        from: col.tableId,
        to: col.id,
        color: { color: "#5b8def", opacity: 0.4 },
        width: 1,
        arrows: "",
      });
    });

    // JOIN type → color mapping
    const joinTypeColors: Record<string, string> = {
      "LEFT JOIN": "#f59e0b",   // orange
      "INNER JOIN": "#34d399",  // green
      "RIGHT JOIN": "#3b82f6",  // blue
      "FULL JOIN": "#f87171",   // red
      "CROSS JOIN": "#a78bfa",  // purple
    };
    const defaultJoinColor = "#34d399";

    // Table-to-Table relations (deduplicate by ID to prevent DataSet crash)
    const seenEdgeIds = new Set<string>();
    data.relations.forEach((rel) => {
      const edgeId = "rel_" + rel.id;
      if (seenEdgeIds.has(edgeId)) return;
      seenEdgeIds.add(edgeId);
      const edgeColor = joinTypeColors[rel.joinType] ?? defaultJoinColor;
      edges.push({
        id: edgeId,
        from: rel.from,
        to: rel.to,
        label: rel.joinType || rel.type,
        color: { color: edgeColor, opacity: 0.85 },
        width: 2.5,
        arrows: "to",
        font: { color: edgeColor, size: 10, strokeWidth: 0, background: "rgba(255,255,255,0.8)" },
        smooth: { type: "curvedCW", roundness: 0.2 },
      });
    });

    return { nodes, edges };
  }, []);

  const onNodeClick = useCallback((nodeId: string) => {
    const tooltip = tooltipRef.current;
    if (tooltip) tooltip.style.display = "none";
    setSelectedNode({ id: nodeId, kind: appData.tables.find((t) => t.id === nodeId) ? "table" : "column" });
  }, [appData]);

  const showNodeTooltip = useCallback((nodeId: string, clientX: number, clientY: number) => {
    const tooltip = tooltipRef.current;
    if (!tooltip) return;
    const table = appData.tables.find((t) => t.id === nodeId);
    const col = appData.columns.find((c) => c.id === nodeId);
    if (table) {
      tooltip.innerHTML = `<div class="tt-name">📊 ${table.label || table.name}</div>`;
    } else if (col) {
      const tbl = appData.tables.find((t) => t.id === col.tableId);
      const tblName = tbl ? tbl.label || tbl.name : "";
      const synonyms = col.synonyms && col.synonyms.length > 0 ? col.synonyms.join("、") : "—";
      const lines = [
        `所属表: ${tblName}`,
        `字段注释: ${col.comment || "—"}`,
        `业务语义: ${col.businessSemantic || "—"}`,
        `同义词: ${synonyms}`,
      ];
      if (col.isIndicator) {
        lines.push(`指标口径/计算逻辑: ${col.indicatorCaliber || "—"}`);
      }
      tooltip.innerHTML = `<div class="tt-name">${col.isIndicator ? "📈" : "🔤"} ${col.name}</div><div class="tt-detail">${lines.join("<br>")}</div>`;
    } else {
      tooltip.style.display = "none";
      return;
    }
    tooltip.style.display = "block";
    tooltip.style.left = (clientX + 16) + "px";
    tooltip.style.top = (clientY + 16) + "px";
  }, [appData]);

  const renderGraph = useCallback(() => {
    if (!containerRef.current || !visRef.current) return;
    const vis = visRef.current;
    // Destroy old network before creating a new one to prevent memory leaks and stale state
    if (networkRef.current) {
      try { (networkRef.current as { destroy?: () => void }).destroy?.(); } catch { /* ignore */ }
      networkRef.current = null;
    }
    const data = buildGraphData(appData);
    const options = {
      groups: {
        table: {
          color: { background: "#ff6467", border: "#ff8a8c", highlight: { background: "#ff8a8c", border: "#ffa8aa" } },
        },
        column: {
          color: { background: "#615fff", border: "#818fff", highlight: { background: "#818fff", border: "#a5b4ff" } },
        },
        indicator: {
          color: { background: "#fe9a00", border: "#feb54d", highlight: { background: "#feb54d", border: "#fed099" } },
        },
      },
      physics: {
        solver: "forceAtlas2Based",
        forceAtlas2Based: { gravitationalConstant: -80, centralGravity: 0.005, springLength: 150, springConstant: 0.08 },
        stabilization: { iterations: 200 },
      },
      interaction: { hover: true, zoomView: true, dragView: true },
      layout: { improvedLayout: true },
      edges: { smooth: true },
    };
    const network = new vis.Network(containerRef.current, {
      nodes: new vis.DataSet(data.nodes),
      edges: new vis.DataSet(data.edges),
    }, options);
    networkRef.current = network;

    // Type the network events
    const net = network as { on: (event: string, cb: (params: unknown) => void) => void };

    net.on("click", (params: unknown) => {
      const p = params as { nodes: string[] };
      if (p.nodes.length > 0) {
        onNodeClick(p.nodes[0]);
      }
    });

    net.on("hoverNode", (params: unknown) => {
      const p = params as { node: string; event: { clientX: number; clientY: number } };
      showNodeTooltip(p.node, p.event.clientX, p.event.clientY);
    });

    net.on("blurNode", () => {
      const tooltip = tooltipRef.current;
      if (tooltip) tooltip.style.display = "none";
    });
  }, [appData, buildGraphData, onNodeClick, showNodeTooltip]);

  // Re-render graph when appData changes
  useEffect(() => {
    if (appData.tables.length > 0 || appData.columns.length > 0) {
      renderGraph();
    }
  }, [appData, renderGraph]);

  // ── Initial load ───────────────────────────────────────────────────

  useEffect(() => {
    void loadDatasources();
  }, [loadDatasources]);

  useEffect(() => {
    void loadGraph(selectedDatasourceId);
  }, [loadGraph, selectedDatasourceId]);

  // ── Keyboard shortcuts ────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedNode(null);
        setRelationModal(null);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // ── Helpers ────────────────────────────────────────────────────────

  const getTable = useCallback((id: string) => appData.tables.find((t) => t.id === id), [appData]);
  const getColumn = useCallback((id: string) => appData.columns.find((c) => c.id === id), [appData]);
  const getColumnsForTable = useCallback((tableId: string) => appData.columns.filter((c) => c.tableId === tableId), [appData]);
  const getRelationsForTable = useCallback((tableId: string) => appData.relations.filter((r) => r.from === tableId || r.to === tableId), [appData]);

  // ── Data mutations ─────────────────────────────────────────────────

  const updateTable = useCallback(async (tableId: string, key: "label" | "description", value: string) => {
    setAppData((prev) => ({
      ...prev,
      tables: prev.tables.map((t) => t.id === tableId ? { ...t, [key]: value } : t),
    }));
    const table = getTable(tableId);
    if (table && selectedDatasourceId) {
      try {
        await configApi.updateSemanticTableMeta(selectedDatasourceId, table.name, { [key]: value });
      } catch {
        // Non-fatal — local state is already updated
      }
    }
  }, [getTable, selectedDatasourceId]);

  const updateColumn = useCallback(async (colId: string, key: "comment" | "businessSemantic" | "indicatorCaliber" | "isIndicator", value: string | boolean) => {
    setAppData((prev) => ({
      ...prev,
      columns: prev.columns.map((c) => c.id === colId ? { ...c, [key]: value } : c),
    }));
    const col = getColumn(colId);
    const table = col ? getTable(col.tableId) : null;
    if (col && table && selectedDatasourceId) {
      try {
        const apiField = key === "comment" ? "description" : key;
        await configApi.updateSemanticColumnMeta(selectedDatasourceId, table.name, col.name, { [apiField]: value });
      } catch {
        // Non-fatal
      }
    }
  }, [getColumn, getTable, selectedDatasourceId]);

  const addSynonym = useCallback(async (colId: string, value: string) => {
    const col = getColumn(colId);
    if (!col || !value) return;
    if (col.synonyms.includes(value)) return;
    const newSynonyms = [...col.synonyms, value];
    setAppData((prev) => ({
      ...prev,
      columns: prev.columns.map((c) => c.id === colId ? { ...c, synonyms: newSynonyms } : c),
    }));
    const table = getTable(col.tableId);
    if (table && selectedDatasourceId) {
      try {
        await configApi.updateSemanticColumnMeta(selectedDatasourceId, table.name, col.name, { synonyms: newSynonyms });
      } catch {
        // Non-fatal
      }
    }
    showToast(`同义词 "${value}" 已添加`);
  }, [getColumn, getTable, selectedDatasourceId, showToast]);

  const removeSynonym = useCallback(async (colId: string, index: number) => {
    const col = getColumn(colId);
    if (!col) return;
    const newSynonyms = col.synonyms.filter((_, i) => i !== index);
    setAppData((prev) => ({
      ...prev,
      columns: prev.columns.map((c) => c.id === colId ? { ...c, synonyms: newSynonyms } : c),
    }));
    const table = getTable(col.tableId);
    if (table && selectedDatasourceId) {
      try {
        await configApi.updateSemanticColumnMeta(selectedDatasourceId, table.name, col.name, { synonyms: newSynonyms });
      } catch {
        // Non-fatal
      }
    }
  }, [getColumn, getTable, selectedDatasourceId]);

  const saveAndClose = useCallback(() => {
    // Re-render graph to reflect changes
    renderGraph();
    // When saving from a column detail panel reached via the table's field list,
    // return to the parent table detail panel instead of closing the side panel,
    // so users can continue editing other columns without reopening the table panel.
    if (selectedNode?.kind === "column") {
      const col = appData.columns.find((c) => c.id === selectedNode.id);
      if (col) {
        setLastEditedColumnId(col.id);
        setSelectedNode({ id: col.tableId, kind: "table" });
        return;
      }
    }
    setSelectedNode(null);
  }, [renderGraph, selectedNode, appData.columns]);

  // ── Relation management ────────────────────────────────────────────

  const openRelationModal = useCallback((sourceTableId: string) => {
    const other = appData.tables.find((t) => t.id !== sourceTableId);
    setRelationModal({
      sourceTableId,
      leftTable: sourceTableId,
      rightTable: other?.id ?? appData.tables[0]?.id ?? "",
      leftField: "",
      rightField: "",
      joinType: "LEFT JOIN",
      cardinality: "N:1",
      description: "",
    });
  }, [appData.tables]);

  const confirmRelation = useCallback(async () => {
    if (!relationModal) return;
    const { leftTable, rightTable, leftField, rightField, joinType, cardinality, description } = relationModal;
    if (!leftTable || !rightTable) { showToast("⚠️ 请选择左右表"); return; }
    if (leftTable === rightTable) { showToast("⚠️ 左表和右表不能相同"); return; }
    if (!leftField || !rightField) { showToast("⚠️ 请选择左右表字段"); return; }

    const exists = appData.relations.some((r) =>
      (r.from === leftTable && r.to === rightTable && r.leftField === leftField && r.rightField === rightField) ||
      (r.from === rightTable && r.to === leftTable && r.leftField === rightField && r.rightField === leftField)
    );
    if (exists) { showToast("⚠️ 两表之间已存在关联"); return; }

    const leftTableData = getTable(leftTable);
    const rightTableData = getTable(rightTable);

    if (selectedDatasourceId && leftTableData && rightTableData) {
      try {
        const response = await configApi.addSemanticRelation(selectedDatasourceId, {
          fromTable: leftTableData.name,
          toTable: rightTableData.name,
          fromField: leftField,
          toField: rightField,
          joinType,
          cardinality,
          description: description || `${joinType} ON ${leftField} = ${rightField}`,
        });
        const newRel: RelationData = {
          id: response.relationId,
          from: leftTable,
          to: rightTable,
          type: "FK",
          joinType,
          cardinality,
          leftField,
          rightField,
          description: description || `${joinType} ON ${leftField} = ${rightField}`,
        };
        setAppData((prev) => {
          // Avoid duplicates: if a relation with the same ID already exists (from graph data), replace it
          const filtered = prev.relations.filter((r) => r.id !== response.relationId);
          return { ...prev, relations: [...filtered, newRel] };
        });
        setRelationModal(null);
      } catch {
        // Non-fatal: relation creation failure is surfaced by the relation remaining open
      }
    }
  }, [relationModal, appData.relations, getTable, selectedDatasourceId]);

  const removeRelation = useCallback(async (relId: string) => {
    const rel = appData.relations.find((r) => r.id === relId);
    if (!rel) return;
    // Try to find the table by ID first, then by name as fallback
    const leftTableData = getTable(rel.from) ?? appData.tables.find((t) => t.name === rel.from);
    if (selectedDatasourceId && leftTableData) {
      try {
        await configApi.removeSemanticRelation(selectedDatasourceId, relId);
        setAppData((prev) => ({
          ...prev,
          relations: prev.relations.filter((r) => r.id !== relId),
        }));
      } catch {
        // Non-fatal: deletion failure is non-blocking
      }
    }
  }, [appData.relations, appData.tables, getTable, selectedDatasourceId]);

  // ── Filtered table list ────────────────────────────────────────────

  const filteredTables = useMemo(() => {
    const term = searchTerm.toLowerCase();
    if (!term) return appData.tables;
    return appData.tables.filter((t) =>
      t.name.toLowerCase().includes(term) ||
      (t.label || "").toLowerCase().includes(term) ||
      (t.description || "").toLowerCase().includes(term)
    );
  }, [appData.tables, searchTerm]);

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface">
      {/* TOP BAR */}
      <div className="flex h-13 items-center gap-3 border-b border-border bg-surface-subtle px-5 py-2">
        <button
          type="button"
          onClick={onBack}
          className="flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-surface hover:text-foreground"
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12.5 5 7.5 10l5 5" />
          </svg>
        </button>
        <div className="h-5 w-px bg-border" />
        <div className="ml-auto flex items-center gap-2">
          {loadingDatasources ? (
            <span className="text-xs text-muted-light">加载数据源...</span>
          ) : (
            <select
              value={selectedDatasourceId}
              onChange={(e) => setSelectedDatasourceId(e.target.value)}
              className="min-w-40 cursor-pointer rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground outline-none focus:border-primary"
            >
              <option value="">请选择数据源</option>
              {datasources.map((ds) => (
                <option key={ds.id} value={ds.id}>{ds.name}</option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={handleBuildGraph}
            disabled={buildingGraph || !selectedDatasourceId}
            className="cursor-pointer rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-primary-light disabled:cursor-not-allowed disabled:opacity-50"
          >
            {buildingGraph ? "⏳ 构建中..." : "🔨 构建图谱"}
          </button>
        </div>
      </div>

      {/* MAIN LAYOUT */}
      <div className="flex min-h-0 flex-1">
        {/* LEFT PANEL */}
        <div className="flex w-64 shrink-0 flex-col border-r border-border bg-surface-subtle">
          <div className="border-b border-border p-3">
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="🔍 搜索数据表..."
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
            />
          </div>
          <div className="border-b border-border px-3 py-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-light">📋 数据表 ({appData.tables.length})</h3>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {filteredTables.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-muted-light">
                {loadingGraph ? "加载中..." : "暂无数据表"}
              </div>
            ) : (
              filteredTables.map((tbl) => (
                <div
                  key={tbl.id}
                  onClick={() => {
                    setSelectedNode({ id: tbl.id, kind: "table" });
                    // Focus node in network
                    const net = networkRef.current as { focus: (id: string, opts?: unknown) => void; selectNodes: (ids: string[], opts?: unknown) => void } | null;
                    if (net) {
                      net.selectNodes([tbl.id]);
                      net.focus(tbl.id, { scale: 1.2, animation: { duration: 500, easingFunction: "easeInOutQuad" } });
                    }
                  }}
                  className={`mb-0.5 flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-xs transition-colors hover:bg-surface ${selectedNode?.id === tbl.id ? "border border-primary bg-primary/10" : "border border-transparent"}`}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-red-400 text-[11px] font-bold text-white">T</span>
                  <div className="min-w-0">
                    <div className="truncate font-medium text-foreground">{tbl.label || tbl.name}</div>
                    <div className="truncate text-[10px] text-muted-light">{tbl.name}</div>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Legend */}
          <div className="shrink-0 border-t border-border p-3">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-light">图例</h3>
            <div className="space-y-1 text-xs">
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-sm bg-red-400" /> 数据表
              </div>
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full bg-indigo-500" /> 普通字段
              </div>
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full bg-amber-500" /> 指标字段
              </div>
              <div className="flex items-center gap-2" style={{ color: "#5b8def" }}>
                <span style={{ color: "#5b8def" }}>→</span> 表与字段归属
              </div>
            </div>
            <div className="mt-2 border-t border-border pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-light">关联关系</div>
            <div className="mt-1 space-y-1 text-xs">
              <div className="flex items-center gap-2" style={{ color: "#f59e0b" }}>
                <span className="inline-block h-0.5 w-5 rounded" style={{ background: "#f59e0b" }} /> LEFT JOIN
              </div>
              <div className="flex items-center gap-2" style={{ color: "#34d399" }}>
                <span className="inline-block h-0.5 w-5 rounded" style={{ background: "#34d399" }} /> INNER JOIN
              </div>
              <div className="flex items-center gap-2" style={{ color: "#3b82f6" }}>
                <span className="inline-block h-0.5 w-5 rounded" style={{ background: "#3b82f6" }} /> RIGHT JOIN
              </div>
              <div className="flex items-center gap-2" style={{ color: "#f87171" }}>
                <span className="inline-block h-0.5 w-5 rounded" style={{ background: "#f87171" }} /> FULL JOIN
              </div>
              <div className="flex items-center gap-2" style={{ color: "#a78bfa" }}>
                <span className="inline-block h-0.5 w-5 rounded" style={{ background: "#a78bfa" }} /> CROSS JOIN
              </div>
            </div>
          </div>
        </div>

        {/* GRAPH AREA */}
        <div className="relative min-w-0 flex-1 bg-surface">
          {loadingGraph ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-light">加载图谱中...</div>
          ) : appData.tables.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-light">
              <div className="text-5xl">📊</div>
              <div className="text-sm">请选择数据源并构建图谱</div>
              {buildInfo && <div className="rounded-lg bg-surface-subtle px-3 py-1.5 text-xs text-muted">{buildInfo}</div>}
            </div>
          ) : (
            <>
              <div ref={containerRef} className="h-full w-full" style={{ background: "var(--color-surface)" }} />
            </>
          )}
          {error && (
            <div className="absolute top-3 left-3 right-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}

          {/* BUILDING OVERLAY - only covers graph area */}
          {buildingGraph && (
            <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-surface/80 backdrop-blur-sm">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-border border-t-primary" />
              <div className="text-sm font-medium text-foreground">正在构建语义图谱…</div>
            </div>
          )}
        </div>
      </div>

      {/* DETAIL PANEL (slide-in from right) */}
      {selectedNode && (
        <DetailPanel
          selectedNode={selectedNode}
          getTable={getTable}
          getColumn={getColumn}
          getColumnsForTable={getColumnsForTable}
          getRelationsForTable={getRelationsForTable}
          onClose={() => setSelectedNode(null)}
          onUpdateTable={updateTable}
          onUpdateColumn={updateColumn}
          onAddSynonym={addSynonym}
          onRemoveSynonym={removeSynonym}
          onSave={saveAndClose}
          onOpenRelationModal={openRelationModal}
          onRemoveRelation={removeRelation}
          onNodeClick={(id) => setSelectedNode({ id, kind: appData.tables.find((t) => t.id === id) ? "table" : "column" })}
          lastEditedColumnId={lastEditedColumnId}
        />
      )}

      {/* ADD RELATION MODAL */}
      {relationModal && (
        <RelationModal
          modal={relationModal}
          tables={appData.tables}
          getColumnsForTable={getColumnsForTable}
          onUpdate={setRelationModal}
          onClose={() => setRelationModal(null)}
          onConfirm={confirmRelation}
        />
      )}

      {/* TOAST */}
      <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-1">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="rounded-lg bg-green-500 px-6 py-3 text-sm font-semibold text-black shadow-lg"
          >
            {toast.text}
          </div>
        ))}
      </div>

      {/* NODE TOOLTIP */}
      <div
        ref={tooltipRef}
        className="pointer-events-none fixed z-50 hidden max-w-60 rounded-lg border border-border bg-surface-subtle p-2.5 text-xs shadow-lg"
      />
    </div>
  );
}

// ── Detail Panel ────────────────────────────────────────────────────────

function DetailPanel({
  selectedNode,
  getTable,
  getColumn,
  getColumnsForTable,
  getRelationsForTable,
  onClose,
  onUpdateTable,
  onUpdateColumn,
  onAddSynonym,
  onRemoveSynonym,
  onSave,
  onOpenRelationModal,
  onRemoveRelation,
  onNodeClick,
  lastEditedColumnId,
}: {
  selectedNode: { id: string; kind: "table" | "column" };
  getTable: (id: string) => TableData | undefined;
  getColumn: (id: string) => ColumnData | undefined;
  getColumnsForTable: (tableId: string) => ColumnData[];
  getRelationsForTable: (tableId: string) => RelationData[];
  onClose: () => void;
  onUpdateTable: (id: string, key: "label" | "description", value: string) => void;
  onUpdateColumn: (id: string, key: "comment" | "businessSemantic" | "indicatorCaliber" | "isIndicator", value: string | boolean) => void;
  onAddSynonym: (colId: string, value: string) => void;
  onRemoveSynonym: (colId: string, index: number) => void;
  onSave: () => void;
  onOpenRelationModal: (tableId: string) => void;
  onRemoveRelation: (relId: string) => void;
  onNodeClick: (id: string) => void;
  lastEditedColumnId?: string | null;
}) {
  const [synonymInput, setSynonymInput] = useState("");
  const [colSearch, setColSearch] = useState("");
  const columnRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Scroll the just-edited column into view when returning to the table panel.
  useEffect(() => {
    if (selectedNode.kind === "table" && lastEditedColumnId) {
      const el = columnRefs.current[lastEditedColumnId];
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }, [selectedNode.kind, lastEditedColumnId]);

  if (selectedNode.kind === "table") {
    const table = getTable(selectedNode.id);
    if (!table) return null;
    const cols = getColumnsForTable(table.id);
    const relations = getRelationsForTable(table.id);

    const filteredCols = colSearch.trim()
      ? cols.filter((c) => {
          const q = colSearch.trim().toLowerCase();
          return (
            (c.name ?? "").toLowerCase().includes(q) ||
            (c.type ?? "").toLowerCase().includes(q) ||
            (c.comment ?? "").toLowerCase().includes(q) ||
            (c.businessSemantic ?? "").toLowerCase().includes(q)
          );
        })
      : cols;

    return (
      <div key={`table-${table.id}`} className="fixed inset-0 z-40 flex justify-end bg-black/50" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="flex h-full w-120 max-w-[480px] flex-col overflow-y-auto bg-surface-subtle shadow-2xl" style={{ animation: "slideIn 0.25s ease-out" }}>
          {/* Header */}
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface-subtle px-5 py-4">
            <h2 className="text-base font-bold text-foreground">📊 {table.label || table.name}</h2>
            <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-foreground transition-colors hover:border-red-400 hover:text-red-500">✕</button>
          </div>
          {/* Body */}
          <div className="flex-1 p-5">
            <span className="mb-4 inline-block rounded-full bg-red-400/20 px-2.5 py-0.5 text-[11px] font-semibold text-red-500">数据表</span>
            <div className="mb-4">
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-light">表名 <span className="text-red-500">*</span></label>
              <input value={table.name || ""} readOnly className="w-full cursor-not-allowed rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted-light" />
              <div className="mt-1 text-[10px] text-muted-light">来自同步数据库的源数据，不可修改</div>
            </div>
            <div className="mb-4">
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-light">中文标签</label>
              <input
                defaultValue={table.label || ""}
                onBlur={(e) => onUpdateTable(table.id, "label", e.target.value)}
                placeholder="例如: 客户维度表"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
              />
            </div>
            <div className="mb-4">
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-light">表描述</label>
              <textarea
                defaultValue={table.description || ""}
                onBlur={(e) => onUpdateTable(table.id, "description", e.target.value)}
                placeholder="描述这张表的业务含义和用途"
                className="min-h-18 w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
              />
            </div>

            {/* Relations */}
            <div className="mt-5 border-t border-border pt-4">
              <div className="mb-2.5 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground">🔗 表关联 ({relations.length})</h3>
                <button
                  onClick={() => onOpenRelationModal(table.id)}
                  className="cursor-pointer rounded-lg bg-primary px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-primary-light"
                >+ 新建关联</button>
              </div>
              {relations.length === 0 ? (
                <div className="py-8 text-center text-muted-light">
                  <div className="mb-2 text-4xl">🔗</div>
                  暂无关联，点击上方按钮新建
                </div>
              ) : (
                relations.map((rel) => {
                  const targetId = rel.from === table.id ? rel.to : rel.from;
                  const targetTable = getTable(targetId);
                  return (
                    <div key={rel.id} className="mb-2 flex items-center gap-2.5 rounded-lg bg-surface px-3 py-2.5 text-xs">
                      <span>{rel.from === table.id ? "出" : "入"}</span>
                      <span className="rounded-full bg-green-500/20 px-2 py-0.5 text-[10px] font-semibold text-green-500">{rel.joinType || rel.type}</span>
                      <span className="text-foreground">{targetTable?.label || targetTable?.name || targetId}</span>
                      <span className="text-[10px] text-muted-light">{rel.cardinality || ""} {rel.leftField && rel.rightField ? `· ${rel.leftField} = ${rel.rightField}` : ""}</span>
                      <span className="flex-1 truncate text-[10px] text-muted-light" title={rel.description || ""}>{rel.description || ""}</span>
                      <span onClick={() => onRemoveRelation(rel.id)} className="cursor-pointer text-muted-light transition-colors hover:text-red-500" title="删除关联">✕</span>
                    </div>
                  );
                })
              )}
            </div>

            {/* Columns */}
            <div className="mt-4 border-t border-border pt-4">
              <div className="mb-2.5 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground">📋 包含字段 ({cols.length})</h3>
              </div>
              <div className="relative mb-2.5">
                <input
                  value={colSearch}
                  onChange={(e) => setColSearch(e.target.value)}
                  placeholder="搜索字段名、类型、注释、业务语义…"
                  className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-light focus:border-primary"
                />
                {colSearch && (
                  <button
                    onClick={() => setColSearch("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer text-muted-light transition-colors hover:text-foreground"
                    title="清除搜索"
                  >✕</button>
                )}
              </div>
              {filteredCols.length === 0 ? (
                <div className="py-6 text-center text-xs text-muted-light">
                  未找到匹配的字段
                </div>
              ) : (
                filteredCols.map((col) => (
                <div
                  key={col.id}
                  ref={(el) => { columnRefs.current[col.id] = el; }}
                  onClick={() => onNodeClick(col.id)}
                  className={`flex cursor-pointer items-center gap-2 border-b border-border py-2 text-xs hover:bg-surface ${lastEditedColumnId === col.id ? "bg-primary/10" : ""}`}
                >
                  <span style={{ color: col.isIndicator ? "var(--color-amber-500, #f59e0b)" : "var(--color-indigo-500, #6366f1)" }}>
                    {col.isIndicator ? "📈" : "🔤"}
                  </span>
                  <span className="flex-1 text-foreground">{col.name}</span>
                  <span className="text-[10px] text-muted-light">{col.type}</span>
                  {col.comment && (
                    <span className="max-w-32 truncate text-[10px] text-muted" title={col.comment}>{col.comment}</span>
                  )}
                </div>
                ))
              )}
            </div>
          </div>
          {/* Footer */}
          <div className="sticky bottom-0 flex gap-2 border-t border-border bg-surface-subtle px-5 py-4">
            <button onClick={onSave} className="cursor-pointer rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-white hover:bg-primary-light">保存 ✓</button>
            <button onClick={onClose} className="cursor-pointer rounded-lg border border-border px-4 py-2 text-xs font-medium text-foreground hover:border-primary">取消</button>
          </div>
        </div>
      </div>
    );
  }

  // Column panel
  const col = getColumn(selectedNode.id);
  if (!col) return null;
  const table = getTable(col.tableId);

  return (
    <div key={`column-${col.id}`} className="fixed inset-0 z-40 flex justify-end bg-black/50" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex h-full w-120 max-w-[480px] flex-col overflow-y-auto bg-surface-subtle shadow-2xl" style={{ animation: "slideIn 0.25s ease-out" }}>
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface-subtle px-5 py-4">
          <h2 className="text-base font-bold text-foreground">{col.isIndicator ? "📈" : "🔤"} {col.name}</h2>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-foreground transition-colors hover:border-red-400 hover:text-red-500">✕</button>
        </div>
        {/* Body */}
        <div className="flex-1 p-5">
          <span className={`mb-4 inline-block rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${col.isIndicator ? "bg-amber-500/20 text-amber-500" : "bg-indigo-500/20 text-indigo-500"}`}>
            {col.isIndicator ? "指标字段" : "普通字段"}
          </span>
          <div className="mb-4 text-xs text-muted-light">所属表: {table?.label || table?.name || "未知"}</div>

          <div className="mb-4">
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-light">字段名 <span className="text-red-500">*</span></label>
            <input value={col.name || ""} readOnly className="w-full cursor-not-allowed rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted-light" />
            <div className="mt-1 text-[10px] text-muted-light">来自同步数据库的源数据，不可修改</div>
          </div>
          <div className="mb-4">
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-light">数据类型</label>
            <input value={col.type || ""} readOnly className="w-full cursor-not-allowed rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted-light" />
            <div className="mt-1 text-[10px] text-muted-light">来自同步数据库的源数据，不可修改</div>
          </div>
          <div className="mb-4">
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-light">技术注释 (Comment)</label>
            <textarea
              defaultValue={col.comment || ""}
              onBlur={(e) => onUpdateColumn(col.id, "comment", e.target.value)}
              placeholder="可编辑的技术注释，保存后持久化"
              className="min-h-16 w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
            />
            <div className="mt-1 text-[10px] text-muted-light">编辑后点击保存即可持久化</div>
          </div>

          {/* Business Semantics */}
          <div className="mt-4 border-t-2 border-primary pt-4">
            <h3 className="mb-3 text-sm font-semibold text-primary">🧠 业务语义</h3>
            <div className="mb-4">
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-light">业务语义名称</label>
              <input
                defaultValue={col.businessSemantic || ""}
                onBlur={(e) => onUpdateColumn(col.id, "businessSemantic", e.target.value)}
                placeholder="例如: 客户姓名、销售金额"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
              />
            </div>
            <div className="mb-4">
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-light">同义词 (回车添加)</label>
              <div className="flex min-h-10 flex-wrap items-center gap-1 rounded-lg border border-border bg-surface p-1.5 focus-within:border-primary">
                {col.synonyms.map((syn, i) => (
                  <span key={i} className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] text-primary">
                    {syn}
                    <span onClick={() => onRemoveSynonym(col.id, i)} className="cursor-pointer text-sm leading-none opacity-70 hover:opacity-100">×</span>
                  </span>
                ))}
                <input
                  type="text"
                  value={synonymInput}
                  onChange={(e) => setSynonymInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const val = synonymInput.trim();
                      if (val) {
                        onAddSynonym(col.id, val);
                        setSynonymInput("");
                      }
                    }
                  }}
                  placeholder="输入同义词后回车"
                  className="min-w-20 flex-1 border-none bg-transparent px-1 py-0.5 text-xs text-foreground outline-none"
                />
              </div>
            </div>
          </div>

          {/* Indicator */}
          <div className="mt-4 border-t border-border pt-4">
            <label className="mb-4 flex cursor-pointer items-center gap-2.5">
              <input
                type="checkbox"
                checked={col.isIndicator || false}
                onChange={(e) => onUpdateColumn(col.id, "isIndicator", e.target.checked)}
                className="h-4 w-4 cursor-pointer accent-primary"
              />
              <span className="text-xs text-foreground">📈 标记为指标字段</span>
            </label>
            {col.isIndicator && (
              <div className="mb-4">
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-light">指标口径 / 计算逻辑</label>
                <textarea
                  defaultValue={col.indicatorCaliber || ""}
                  onBlur={(e) => onUpdateColumn(col.id, "indicatorCaliber", e.target.value)}
                  placeholder="例如: SUM(订单金额)，时间范围: 自然月"
                  className="min-h-18 w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
                />
              </div>
            )}
          </div>
        </div>
        {/* Footer */}
        <div className="sticky bottom-0 flex gap-2 border-t border-border bg-surface-subtle px-5 py-4">
          <button onClick={onSave} className="cursor-pointer rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-white hover:bg-primary-light">保存 ✓</button>
          <button onClick={onClose} className="cursor-pointer rounded-lg border border-border px-4 py-2 text-xs font-medium text-foreground hover:border-primary">取消</button>
        </div>
      </div>
    </div>
  );
}

// ── Relation Modal ──────────────────────────────────────────────────────

function RelationModal({
  modal,
  tables,
  getColumnsForTable,
  onUpdate,
  onClose,
  onConfirm,
}: {
  modal: RelationModalState;
  tables: TableData[];
  getColumnsForTable: (tableId: string) => ColumnData[];
  onUpdate: (modal: RelationModalState) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const leftCols = modal?.leftTable ? getColumnsForTable(modal.leftTable) : [];
  const rightCols = modal?.rightTable ? getColumnsForTable(modal.rightTable) : [];

  if (!modal) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="max-h-80vh w-140 max-w-[560px] overflow-y-auto rounded-xl bg-surface-subtle p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-base font-bold text-foreground">新建表关系 · {modal.joinType.replace(/\s+/g, "_")}</h3>
          <button onClick={onClose} className="text-muted-light hover:text-foreground">✕</button>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1.5 block text-xs text-muted-light">左表</label>
            <select
              value={modal.leftTable}
              onChange={(e) => onUpdate({ ...modal, leftTable: e.target.value, leftField: "" })}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
            >
              {tables.map((t) => <option key={t.id} value={t.id}>{t.label || t.name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs text-muted-light">右表</label>
            <select
              value={modal.rightTable}
              onChange={(e) => onUpdate({ ...modal, rightTable: e.target.value, rightField: "" })}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
            >
              {tables.map((t) => <option key={t.id} value={t.id}>{t.label || t.name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs text-muted-light">左表字段</label>
            <select
              value={modal.leftField}
              onChange={(e) => onUpdate({ ...modal, leftField: e.target.value })}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
            >
              <option value="">选择字段</option>
              {leftCols.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1.3 block text-xs text-muted-light">右表字段</label>
            <select
              value={modal.rightField}
              onChange={(e) => onUpdate({ ...modal, rightField: e.target.value })}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
            >
              <option value="">选择字段</option>
              {rightCols.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs text-muted-light">JOIN 类型</label>
            <select
              value={modal.joinType}
              onChange={(e) => onUpdate({ ...modal, joinType: e.target.value })}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
            >
              <option value="LEFT JOIN">LEFT JOIN</option>
              <option value="INNER JOIN">INNER JOIN</option>
              <option value="RIGHT JOIN">RIGHT JOIN</option>
              <option value="FULL JOIN">FULL JOIN</option>
              <option value="CROSS JOIN">CROSS JOIN</option>
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs text-muted-light">基数</label>
            <select
              value={modal.cardinality}
              onChange={(e) => onUpdate({ ...modal, cardinality: e.target.value })}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
            >
              <option value="N:1">N:1</option>
              <option value="1:1">1:1</option>
              <option value="1:N">1:N</option>
              <option value="N:N">N:N</option>
            </select>
          </div>
        </div>

        <div className="mb-4">
          <label className="mb-1.5 block text-xs text-muted-light">关联描述</label>
          <input
            value={modal.description || ""}
            onChange={(e) => onUpdate({ ...modal, description: e.target.value })}
            placeholder="例如: 通过 customer_id 关联客户信息"
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-primary"
          />
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="cursor-pointer rounded-lg border border-border px-4 py-2 text-xs font-medium text-foreground hover:border-primary">取消</button>
          <button onClick={onConfirm} className="cursor-pointer rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-white hover:bg-primary-light">保存</button>
        </div>
      </div>
    </div>
  );
}

// ── Helpers: Convert graph DTO to app data ──────────────────────────────

function graphToAppData(graph: DatalinkGraphDto, datasourceId: string): AppData {
  const tables: TableData[] = [];
  const columns: ColumnData[] = [];

  // Build a map of table name -> tableId for column lookup
  const tableNodes = graph.nodes.filter((n) => n.type === "table");
  const columnNodes = graph.nodes.filter((n) => n.type === "column");

  // Map table nodes
  for (const node of tableNodes) {
    const props = (node.properties ?? {}) as Record<string, unknown>;
    const tableName = (node.name ?? node.id) as string;
    tables.push({
      id: node.id,
      name: tableName,
      label: (node.label ?? node.name ?? tableName) as string,
      schema: (props.schema as string) ?? "",
      description: (node.description as string) ?? "",
      rowCount: (props.row_count as number) ?? (props.column_count as number) ?? 0,
    });
  }

  // Build table name -> id map
  const tableNameToId = new Map<string, string>();
  for (const t of tables) {
    tableNameToId.set(t.name, t.id);
  }

  // Find has_column edges to map columns to tables
  const hasColumnEdges = graph.edges.filter((e) => e.type === "has_column");
  const columnToTableMap = new Map<string, string>();
  for (const edge of hasColumnEdges) {
    const sourceId = (edge.source_id ?? edge.source) as string;
    const targetId = (edge.target_id ?? edge.target) as string;
    // Table -> Column edge
    columnToTableMap.set(targetId, sourceId);
  }

  // Map column nodes
  for (const node of columnNodes) {
    const props = (node.properties ?? {}) as Record<string, unknown>;
    const colName = (node.name ?? node.id) as string;
    const tableId = columnToTableMap.get(node.id) ?? "";
    // Extract table name from column properties or from the edge
    const tableName = (props.table_name as string) ?? "";
    const resolvedTableId = tableId || (tableNameToId.get(tableName) ?? "");

    columns.push({
      id: node.id,
      tableId: resolvedTableId,
      name: colName,
      type: (props.data_type as string) ?? (props.type as string) ?? "unknown",
      comment: (node.description as string) ?? (props.comment as string) ?? "",
      isPK: (props.is_pk as boolean) ?? false,
      businessSemantic: (node.business_semantic as string) ?? (props.business_semantic as string) ?? "",
      synonyms: (node.synonyms as string[]) ?? (props.synonyms as string[]) ?? [],
      isIndicator: (node.is_indicator as boolean) ?? (props.is_indicator as boolean) ?? false,
      indicatorCaliber: (node.indicator_caliber as string) ?? (props.indicator_caliber as string) ?? "",
    });
  }

  // Map FK edges as relations (table-to-table)
  const relations: RelationData[] = graph.edges
    .filter((e) => e.type === "foreign_key" || e.type === "joinable")
    .map((edge) => {
      const props = (edge.properties ?? {}) as Record<string, unknown>;
      const rawSource = (edge.source_id ?? edge.source) as string;
      const rawTarget = (edge.target_id ?? edge.target) as string;
      // Resolve table names to table node IDs
      const sourceId = tableNameToId.get(rawSource) ?? rawSource;
      const targetId = tableNameToId.get(rawTarget) ?? rawTarget;
      return {
        id: edge.id,
        from: sourceId,
        to: targetId,
        type: "FK",
        joinType: (props.join_type as string) ?? "INNER",
        cardinality: (props.cardinality as string) ?? "1:N",
        leftField: (props.from_field as string) ?? (props.left_field as string) ?? "",
        rightField: (props.to_field as string) ?? (props.right_field as string) ?? "",
        description: (props.description as string) ?? "",
      };
    });

  return { tables, columns, relations };
}
