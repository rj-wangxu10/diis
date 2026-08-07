"use client";

import React, { useMemo, useState } from "react";
import { SqlResultChart, type ChartKind } from "./SqlResultChart";
import type { SqlResultChartData } from "./SqlResultChart";
import {
  dataTableClass,
  dataTableHeadClass,
  dataTableCellClass,
  dataTableCellNumericClass,
  dataTableRowClass,
  dataTableShellClass,
} from "../ui-tokens";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type ViewMode = "table" | "chart";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function isNumericCell(value: unknown): boolean {
  if (typeof value === "number") return true;
  if (typeof value === "string") {
    return value.trim() !== "" && !Number.isNaN(Number(value));
  }
  return false;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

const CHART_KINDS: { kind: ChartKind; label: string }[] = [
  { kind: "bar", label: "Bar" },
  { kind: "line", label: "Line" },
  { kind: "area", label: "Area" },
  { kind: "pie", label: "Pie" },
  { kind: "scatter", label: "Scatter" },
];

const VIEW_MODES: { mode: ViewMode; label: string }[] = [
  { mode: "table", label: "Table" },
  { mode: "chart", label: "Chart" },
];

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function ViewToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-surface-subtle p-0.5">
      {VIEW_MODES.map((v) => (
        <button
          key={v.mode}
          type="button"
          onClick={() => onChange(v.mode)}
          className={[
            "rounded-md px-2.5 py-1 text-[11px] font-semibold transition",
            mode === v.mode
              ? "bg-slate-900 text-white shadow-sm"
              : "text-muted hover:text-foreground",
          ].join(" ")}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

function ChartKindToggle({
  kind,
  onChange,
}: {
  kind: ChartKind;
  onChange: (kind: ChartKind) => void;
}) {
  return (
    <div className="inline-flex flex-wrap gap-1">
      {CHART_KINDS.map((c) => (
        <button
          key={c.kind}
          type="button"
          onClick={() => onChange(c.kind)}
          className={[
            "h-7 rounded-md px-2 text-[11px] font-semibold transition",
            kind === c.kind
              ? "bg-slate-900 text-white"
              : "border border-border bg-surface text-muted hover:text-foreground",
          ].join(" ")}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

function ResultTable({
  columns,
  rows,
  maxRows = 100,
}: {
  columns: string[];
  rows: unknown[][];
  maxRows?: number;
}) {
  const previewRows = rows.slice(0, maxRows);
  const numericColumns = columns.map((_, index) =>
    previewRows.some((row) => isNumericCell(row[index])),
  );

  return (
    <div className={`${dataTableShellClass} max-h-[min(480px,60vh)] overflow-auto`}>
      <table className={dataTableClass}>
        <thead className={dataTableHeadClass}>
          <tr>
            {columns.map((column, index) => (
              <th
                key={column}
                className={[
                  "whitespace-nowrap px-2.5 py-1.5 font-semibold",
                  numericColumns[index] ? "text-right" : "",
                ].join(" ")}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {previewRows.map((row, rowIndex) => (
            <tr key={rowIndex} className={dataTableRowClass}>
              {columns.map((_, cellIndex) => (
                <td
                  key={cellIndex}
                  className={[
                    numericColumns[cellIndex]
                      ? dataTableCellNumericClass
                      : dataTableCellClass,
                    cellIndex === 0 && !numericColumns[cellIndex]
                      ? "font-medium text-foreground"
                      : "",
                    row[cellIndex] === null || row[cellIndex] === undefined
                      ? "text-muted-light"
                      : "",
                  ].join(" ")}
                >
                  {formatCell(row[cellIndex])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > previewRows.length ? (
        <div className="border-t border-border bg-surface-subtle px-2.5 py-1 text-[10px] text-muted-light">
          Showing the first {previewRows.length} rows of {rows.length}.
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export interface SqlResultChartViewProps {
  columns: string[];
  rows: unknown[][];
  metaItems?: { label: string; value: string }[];
  unit?: string;
}

/**
 * A unified SQL result viewer that lets users toggle between
 * a data table and an interactive ECharts visualization.
 *
 * The chart is rendered entirely client-side from the SQL result
 * data — no additional backend calls or agent tool invocations
 * are required.  Users can switch between bar, line, area, pie,
 * and scatter chart types in real time.
 */
export function SqlResultChartView({
  columns,
  rows,
  metaItems,
  unit,
}: SqlResultChartViewProps): React.ReactElement {
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [chartKind, setChartKind] = useState<ChartKind>("bar");

  const chartData = useMemo<SqlResultChartData>(
    () => ({ columns, rows }),
    [columns, rows],
  );

  return (
    <div className="grid gap-2">
      {metaItems && metaItems.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {metaItems.map((item) => (
            <span
              key={item.label}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] text-muted"
            >
              <span className="font-semibold text-muted-light">{item.label}</span>
              <span className="max-w-[200px] truncate font-mono text-muted">
                {item.value}
              </span>
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <ViewToggle mode={viewMode} onChange={setViewMode} />
        {viewMode === "chart" ? (
          <ChartKindToggle kind={chartKind} onChange={setChartKind} />
        ) : null}
      </div>

      {viewMode === "table" ? (
        <ResultTable columns={columns} rows={rows} />
      ) : (
        <div className="rounded-xl border border-border bg-surface-subtle p-3">
          <SqlResultChart
            data={chartData}
            chartKind={chartKind}
            unit={unit}
            height={340}
          />
        </div>
      )}
    </div>
  );
}
