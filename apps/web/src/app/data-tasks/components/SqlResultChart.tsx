"use client";

import React, { useMemo } from "react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ChartKind = "bar" | "line" | "pie" | "area" | "scatter";

export interface ChartSeriesPoint {
  label: string;
  value: number;
}

export interface ChartSeries {
  name: string;
  points: ChartSeriesPoint[];
}

export interface SqlResultChartData {
  columns: string[];
  rows: unknown[][];
}

/* ------------------------------------------------------------------ */
/*  Helpers — derive chart-friendly data from SQL result tables        */
/* ------------------------------------------------------------------ */

/**
 * Analyse a SQL result table and decide which columns are numeric
 * (suitable for the Y axis) and which are categorical (X axis / labels).
 */
export function classifyColumns(data: SqlResultChartData): {
  numericIndices: number[];
  labelIndex: number;
} {
  const { rows } = data;
  if (rows.length === 0) return { numericIndices: [], labelIndex: 0 };

  const numericCounts = data.columns.map((_, col) =>
    rows.reduce(
      (acc, row) => acc + (isNumericValue(row[col]) ? 1 : 0),
      0,
    ),
  );

  const numericIndices = data.columns
    .map((_, col) => col)
    .filter((col) => numericCounts[col] / rows.length >= 0.6);

  // Pick the first non-numeric column as the label axis; fall back to row index.
  const labelIndex = data.columns.findIndex((_, col) => !numericCounts[col]);
  const resolvedLabel = labelIndex >= 0 ? labelIndex : 0;

  return {
    numericIndices: numericIndices.length > 0 ? numericIndices : [0],
    labelIndex: resolvedLabel,
  };
}

function isNumericValue(value: unknown): boolean {
  if (typeof value === "number") return true;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed !== "" && !Number.isNaN(Number(trimmed));
  }
  return false;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value.trim());
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

function toLabel(value: unknown): string {
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

/**
 * Convert a SQL result table into one or more chart series.
 * Each numeric column becomes a series; the label column provides X-axis categories.
 */
export function deriveSeries(data: SqlResultChartData): ChartSeries[] {
  const { numericIndices, labelIndex } = classifyColumns(data);
  const labels = data.rows.map((row) => toLabel(row[labelIndex]));

  return numericIndices.map((colIndex) => ({
    name: data.columns[colIndex] ?? `series-${colIndex}`,
    points: data.rows.map((row, rowIndex) => ({
      label: labels[rowIndex],
      value: toNumber(row[colIndex]),
    })),
  }));
}

/* ------------------------------------------------------------------ */
/*  Option builders                                                    */
/* ------------------------------------------------------------------ */

const PALETTE = [
  "#5470c6", "#91cc75", "#fac858", "#ee6666", "#73c0de",
  "#3ba272", "#fc8452", "#9a60b4", "#ea7ccc", "#5a8dee",
];

function buildBarOption(series: ChartSeries[], unit?: string): EChartsOption {
  const categories = series[0]?.points.map((p) => p.label) ?? [];
  return {
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      ...(unit ? { valueFormatter: (v: unknown) => `${unit}${v}` } : {}),
    },
    legend: series.length > 1 ? { top: 0 } : undefined,
    grid: { left: "3%", right: "4%", bottom: "3%", containLabel: true },
    xAxis: {
      type: "category",
      data: categories,
      axisLabel: { interval: 0, rotate: categories.length > 6 ? 30 : 0 },
    },
    yAxis: { type: "value", ...(unit ? { name: unit } : {}) },
    color: PALETTE,
    series: series.map((s) => ({
      name: s.name,
      type: "bar",
      data: s.points.map((p) => p.value),
      emphasis: { focus: "series" },
    })),
  };
}

function buildLineOption(series: ChartSeries[], area: boolean, unit?: string): EChartsOption {
  const categories = series[0]?.points.map((p) => p.label) ?? [];
  return {
    tooltip: {
      trigger: "axis",
      ...(unit ? { valueFormatter: (v: unknown) => `${unit}${v}` } : {}),
    },
    legend: series.length > 1 ? { top: 0 } : undefined,
    grid: { left: "3%", right: "4%", bottom: "3%", containLabel: true },
    xAxis: {
      type: "category",
      data: categories,
      axisLabel: { interval: 0, rotate: categories.length > 6 ? 30 : 0 },
      boundaryGap: false,
    },
    yAxis: { type: "value", ...(unit ? { name: unit } : {}) },
    color: PALETTE,
    series: series.map((s) => ({
      name: s.name,
      type: "line",
      data: s.points.map((p) => p.value),
      smooth: true,
      ...(area ? { areaStyle: { opacity: 0.15 } } : {}),
      emphasis: { focus: "series" },
    })),
  };
}

function buildPieOption(series: ChartSeries[], unit?: string): EChartsOption {
  // For pie charts, use the first series only.
  const s = series[0];
  if (!s) return {};
  return {
    tooltip: {
      trigger: "item",
      formatter: (p: unknown) => {
        const params = p as { name?: string; value?: number; percent?: number };
        return `${params.name ?? ""}: ${unit ?? ""}${params.value ?? 0} (${params.percent ?? 0}%)`;
      },
    },
    legend: { orient: "vertical", left: "left", top: "middle" },
    color: PALETTE,
    series: [
      {
        name: s.name,
        type: "pie",
        radius: ["35%", "65%"],
        center: ["55%", "50%"],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 6, borderColor: "#fff", borderWidth: 2 },
        label: { show: true, formatter: "{b}: {d}%" },
        emphasis: {
          label: { show: true, fontSize: 14, fontWeight: "bold" },
        },
        data: s.points.map((p) => ({ name: p.label, value: p.value })),
      },
    ],
  };
}

function buildScatterOption(series: ChartSeries[], unit?: string): EChartsOption {
  // Scatter: first numeric column = X, second = Y (if available).
  if (series.length < 2) {
    // Fall back to index vs value
    const s = series[0];
    return {
      tooltip: { trigger: "item" },
      grid: { left: "3%", right: "4%", bottom: "3%", containLabel: true },
      xAxis: { type: "value", name: "Index" },
      yAxis: { type: "value", ...(unit ? { name: unit } : {}) },
      color: PALETTE,
      series: [
        {
          name: s?.name ?? "series",
          type: "scatter",
          data: s?.points.map((p, i) => [i, p.value]) ?? [],
        },
      ],
    };
  }
  return {
    tooltip: { trigger: "item" },
    grid: { left: "3%", right: "4%", bottom: "3%", containLabel: true },
    xAxis: { type: "value", name: series[0].name },
    yAxis: { type: "value", name: series[1].name },
    color: PALETTE,
    series: [
      {
        name: `${series[0].name} vs ${series[1].name}`,
        type: "scatter",
        data: series[0].points.map((p, i) => [
          p.value,
          series[1].points[i]?.value ?? 0,
        ]),
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  Public component                                                   */
/* ------------------------------------------------------------------ */

export interface SqlResultChartProps {
  data: SqlResultChartData;
  chartKind: ChartKind;
  unit?: string;
  height?: number;
}

/**
 * Renders a SQL result table as an interactive ECharts chart.
 *
 * The component auto-detects numeric vs. categorical columns, builds
 * appropriate ECharts options, and renders a responsive chart.
 * No backend round-trip is needed — the chart is derived purely from
 * the SQL result data already in the browser.
 */
export function SqlResultChart({
  data,
  chartKind,
  unit,
  height = 320,
}: SqlResultChartProps): React.ReactElement | null {
  const option = useMemo(() => {
    if (data.rows.length === 0 || data.columns.length === 0) return null;
    const series = deriveSeries(data);
    if (series.length === 0) return null;

    switch (chartKind) {
      case "bar":
        return buildBarOption(series, unit);
      case "line":
        return buildLineOption(series, false, unit);
      case "area":
        return buildLineOption(series, true, unit);
      case "pie":
        return buildPieOption(series, unit);
      case "scatter":
        return buildScatterOption(series, unit);
      default:
        return buildBarOption(series, unit);
    }
  }, [data, chartKind, unit]);

  if (!option) return null;

  return (
    <ReactECharts
      option={option}
      style={{ height: `${height}px`, width: "100%" }}
      opts={{ renderer: "canvas" }}
      notMerge={true}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Auto chart type selection                                          */
/* ------------------------------------------------------------------ */

/**
 * Heuristically pick the best chart kind for the given data.
 *
 * - label looks like dates/months → line (trend)
 * - 2-4 categories, 1 numeric column → pie (proportion)
 * - otherwise → bar (comparison)
 *
 * Note: scatter is only chosen when there is NO categorical label column
 * (i.e. all columns are numeric). When there is a label column plus
 * multiple numeric columns, bar is the best default for comparison.
 */
export function autoSelectChartKind(data: SqlResultChartData): ChartKind {
  const { numericIndices, labelIndex } = classifyColumns(data);
  const series = deriveSeries(data);
  const categoryCount = series[0]?.points.length ?? 0;

  // Check if labels look like dates / time series
  const labels = series[0]?.points.map((p) => p.label) ?? [];
  const dateLike = labels.length >= 3 && labels.every((l) => /\d{4}|\d{1,2}[-/月]\d{0,2}/.test(l));
  if (dateLike) {
    return "line";
  }

  // 2-4 categories with a single numeric column → pie (good for proportions)
  if (categoryCount >= 2 && categoryCount <= 4 && numericIndices.length === 1) {
    return "pie";
  }

  // Default: bar (best for categorical comparisons, works with multi-series too)
  return "bar";
}

/**
 * Build an ECharts option from raw SQL result data using auto-selected chart kind.
 */
export function buildAutoChartOption(data: SqlResultChartData, unit?: string): EChartsOption | null {
  const kind = autoSelectChartKind(data);
  const series = deriveSeries(data);
  if (!series.length) return null;
  switch (kind) {
    case "bar":
      return buildBarOption(series, unit);
    case "line":
      return buildLineOption(series, false, unit);
    case "area":
      return buildLineOption(series, true, unit);
    case "pie":
      return buildPieOption(series, unit);
    case "scatter":
      return buildScatterOption(series, unit);
    default:
      return buildBarOption(series, unit);
  }
}
