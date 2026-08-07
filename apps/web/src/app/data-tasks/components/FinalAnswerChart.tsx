"use client";

import { useMemo, useState } from "react";
import type { DataArtifact } from "../data-task-state";
import {
  SqlResultChart,
  autoSelectChartKind,
  type ChartKind,
  type SqlResultChartData,
} from "./SqlResultChart";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface FinalAnswerChartProps {
  artifacts: DataArtifact[];
  /** When true the answer is still streaming — hide the chart. */
  isActive?: boolean;
  height?: number;
  /** Markdown content of the final answer — used to extract display column names. */
  markdownContent?: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Extract the header row from the first markdown table found in the content.
 * Returns null if no table is found.
 *
 * Example input:
 *   | 产品类别 | 销售额（元） | 订单数 |
 *   |----------|-------------|--------|
 *   | 护肤套装 | 3,192       | 8      |
 *
 * Returns: ["产品类别", "销售额（元）", "订单数"]
 */
function extractMarkdownTableHeaders(markdown?: string): string[] | null {
  if (!markdown) return null;
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // A markdown table header row starts and ends with |
    if (!line.startsWith("|") || !line.endsWith("|")) continue;
    // The next line must be a separator (---|---|---)
    const nextLine = (lines[i + 1] ?? "").trim();
    if (!/^\|[\s:|-]+\|?$/.test(nextLine)) continue;
    // Parse header cells
    const cells = line
      .slice(1, -1) // remove leading and trailing |
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length >= 2) return cells;
  }
  return null;
}

/**
 * Extract the first dataset artifact that has enough data to chart.
 * If `markdownContent` contains a markdown table, use its header row to
 * replace SQL column aliases (e.g. "sales" → "销售额（元）") so the chart
 * axis labels match what the user sees in the answer table.
 */
function pickDatasetArtifact(
  artifacts: DataArtifact[],
  markdownContent?: string,
): { artifact: DataArtifact; data: SqlResultChartData } | null {
  const displayColumns = extractMarkdownTableHeaders(markdownContent);

  for (const art of artifacts) {
    const detail = art.detail;
    if (!detail || detail.type !== "dataset") continue;
    const { columns, rows } = detail;
    if (!columns?.length || !rows?.length) continue;
    // Need at least 2 columns (label + value) and 2 rows
    if (columns.length < 2 || rows.length < 2) continue;

    // If the markdown table has the same number of columns, use its header
    // labels as display names (they are user-friendly / localized).
    const finalColumns =
      displayColumns && displayColumns.length === columns.length
        ? displayColumns
        : columns;

    return {
      artifact: art,
      data: { columns: finalColumns, rows: rows as unknown[][] },
    };
  }
  return null;
}

const CHART_KINDS: { kind: ChartKind; label: string }[] = [
  { kind: "bar", label: "柱状图" },
  { kind: "line", label: "折线图" },
  { kind: "pie", label: "饼图" },
  { kind: "area", label: "面积图" },
  { kind: "scatter", label: "散点图" },
];

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

export function FinalAnswerChart({
  artifacts,
  isActive = false,
  height = 320,
  markdownContent,
}: FinalAnswerChartProps) {
  const chartData = useMemo(
    () => pickDatasetArtifact(artifacts, markdownContent),
    [artifacts, markdownContent],
  );

  // Auto-select the best chart kind as default
  const autoKind = useMemo(() => {
    if (!chartData) return "bar" as ChartKind;
    return autoSelectChartKind(chartData.data);
  }, [chartData]);

  const [selectedKind, setSelectedKind] = useState<ChartKind | null>(null);
  const chartKind = selectedKind ?? autoKind;

  // Don't render while streaming or if no suitable data
  if (isActive || !chartData) return null;

  return (
    <div className="mt-4 rounded-lg border border-border bg-white/50 p-3 dark:bg-muted-dark/30">
      {/* Header with chart type selector */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-light">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 3v18h18" />
            <path d="M7 16l4-8 4 4 4-6" />
          </svg>
          <span className="font-medium">数据可视化</span>
        </div>
        {/* Chart type selector buttons */}
        <div className="inline-flex flex-wrap gap-1">
          {CHART_KINDS.map((c) => (
            <button
              key={c.kind}
              type="button"
              onClick={() => setSelectedKind(c.kind)}
              className={[
                "h-6 rounded-md px-2 text-[11px] font-semibold transition",
                chartKind === c.kind
                  ? "bg-slate-900 text-white"
                  : "border border-border bg-surface text-muted hover:text-foreground",
              ].join(" ")}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      {/* Chart */}
      <SqlResultChart
        data={chartData.data}
        chartKind={chartKind}
        height={height}
      />
    </div>
  );
}
