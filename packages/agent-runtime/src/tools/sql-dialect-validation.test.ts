import { describe, expect, it } from "vitest";

import { enrichSqlDialectError, validateSqlDialect } from "./sql-dialect-validation.js";

describe("SQL dialect validation", () => {
  it("rejects percentile_cont within group for SQLite with a repair hint", () => {
    expect(validateSqlDialect(
      "SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY profit) FROM orders",
      "sqlite"
    )).toEqual([{
      code: "SQLITE_PERCENTILE_CONT_UNSUPPORTED",
      dialect: "sqlite",
      hint: "Use ROW_NUMBER and COUNT to select or interpolate ordered percentile rows."
    }]);
  });

  it("rejects ilike for SQLite", () => {
    expect(validateSqlDialect("SELECT * FROM orders WHERE name ILIKE '%a%'", "sqlite")).toEqual([
      expect.objectContaining({ code: "SQLITE_ILIKE_UNSUPPORTED", dialect: "sqlite" })
    ]);
  });

  it("allows supported SQLite read queries", () => {
    expect(validateSqlDialect("SELECT region, SUM(profit) FROM orders GROUP BY region", "sqlite")).toEqual([]);
  });

  it("enriches a known SQLite UNION LIMIT error", () => {
    const error = enrichSqlDialectError(
      new Error("LIMIT clause should come after UNION ALL not before"),
      "sqlite"
    );

    expect(error.message).toContain("SQLITE_UNION_LIMIT_POSITION");
    expect(error.message).toContain("Wrap the limited UNION branch in a subquery");
  });

  // ---- MySQL ----

  it("rejects FULL OUTER JOIN for MySQL", () => {
    const issues = validateSqlDialect(
      "SELECT * FROM a FULL OUTER JOIN b ON a.id = b.id",
      "mysql"
    );
    expect(issues).toEqual([
      expect.objectContaining({ code: "MYSQL_FULL_OUTER_JOIN_UNSUPPORTED", dialect: "mysql" })
    ]);
  });

  it("rejects INTERSECT for MySQL", () => {
    expect(validateSqlDialect("SELECT id FROM a INTERSECT SELECT id FROM b", "mysql")).toEqual([
      expect.objectContaining({ code: "MYSQL_INTERSECT_UNSUPPORTED", dialect: "mysql" })
    ]);
  });

  it("rejects EXCEPT for MySQL", () => {
    expect(validateSqlDialect("SELECT id FROM a EXCEPT SELECT id FROM b", "mysql")).toEqual([
      expect.objectContaining({ code: "MYSQL_EXCEPT_UNSUPPORTED", dialect: "mysql" })
    ]);
  });

  it("rejects CTE (WITH) for MySQL", () => {
    expect(validateSqlDialect("WITH cte AS (SELECT 1) SELECT * FROM cte", "mysql")).toEqual([
      expect.objectContaining({ code: "MYSQL_CTE_UNSUPPORTED", dialect: "mysql" })
    ]);
  });

  it("rejects window functions for MySQL", () => {
    expect(validateSqlDialect(
      "SELECT ROW_NUMBER() OVER (ORDER BY id) FROM orders", "mysql"
    )).toEqual([
      expect.objectContaining({ code: "MYSQL_WINDOW_FUNCTION_UNSUPPORTED", dialect: "mysql" })
    ]);
  });

  it("rejects ILIKE for MySQL", () => {
    expect(validateSqlDialect("SELECT * FROM t WHERE name ILIKE '%x%'", "mysql")).toEqual([
      expect.objectContaining({ code: "MYSQL_ILIKE_UNSUPPORTED", dialect: "mysql" })
    ]);
  });

  it("rejects DATE_TRUNC for MySQL", () => {
    expect(validateSqlDialect("SELECT DATE_TRUNC('month', created_at) FROM t", "mysql")).toEqual([
      expect.objectContaining({ code: "MYSQL_DATE_TRUNC_UNSUPPORTED", dialect: "mysql" })
    ]);
  });

  it("rejects LATERAL for MySQL", () => {
    expect(validateSqlDialect(
      "SELECT * FROM a, LATERAL (SELECT 1) b", "mysql"
    )).toEqual([
      expect.objectContaining({ code: "MYSQL_LATERAL_UNSUPPORTED", dialect: "mysql" })
    ]);
  });

  it("allows valid MySQL read queries", () => {
    expect(validateSqlDialect(
      "SELECT region, SUM(profit) FROM orders GROUP BY region LIMIT 10", "mysql"
    )).toEqual([]);
  });

  it("enriches MySQL CTE error", () => {
    const error = enrichSqlDialectError(new Error("syntax error near 'WITH'"), "mysql");
    expect(error.message).toContain("MYSQL_CTE_UNSUPPORTED");
  });

  it("enriches MySQL FULL OUTER JOIN error", () => {
    const error = enrichSqlDialectError(new Error("syntax error near 'FULL'"), "mysql");
    expect(error.message).toContain("MYSQL_FULL_OUTER_JOIN_UNSUPPORTED");
  });

  // ---- MySQL family dialects ----

  it("treats mariadb as mysql family", () => {
    expect(validateSqlDialect("SELECT * FROM a FULL OUTER JOIN b ON 1=1", "mariadb")).toEqual([
      expect.objectContaining({ code: "MYSQL_FULL_OUTER_JOIN_UNSUPPORTED", dialect: "mariadb" })
    ]);
  });

  it("treats tidb as mysql family", () => {
    expect(validateSqlDialect("SELECT * FROM a FULL OUTER JOIN b ON 1=1", "tidb")).toEqual([
      expect.objectContaining({ code: "MYSQL_FULL_OUTER_JOIN_UNSUPPORTED", dialect: "tidb" })
    ]);
  });

  // ---- SQL Server ----

  it("rejects LIMIT for SQL Server", () => {
    expect(validateSqlDialect("SELECT * FROM orders LIMIT 10", "sqlserver")).toEqual([
      expect.objectContaining({ code: "SQLSERVER_LIMIT_UNSUPPORTED", dialect: "sqlserver" })
    ]);
  });

  it("rejects ILIKE for SQL Server", () => {
    expect(validateSqlDialect("SELECT * FROM t WHERE name ILIKE '%x%'", "sqlserver")).toEqual([
      expect.objectContaining({ code: "SQLSERVER_ILIKE_UNSUPPORTED", dialect: "sqlserver" })
    ]);
  });

  it("rejects DATE_TRUNC for SQL Server", () => {
    expect(validateSqlDialect("SELECT DATE_TRUNC('month', created_at) FROM t", "sqlserver")).toEqual([
      expect.objectContaining({ code: "SQLSERVER_DATE_TRUNC_UNSUPPORTED", dialect: "sqlserver" })
    ]);
  });

  it("allows valid SQL Server read queries", () => {
    expect(validateSqlDialect(
      "SELECT TOP 10 region, SUM(profit) FROM orders GROUP BY region", "sqlserver"
    )).toEqual([]);
  });

  it("enriches SQL Server LIMIT error", () => {
    const error = enrichSqlDialectError(new Error("Incorrect syntax near 'LIMIT'"), "sqlserver");
    expect(error.message).toContain("SQLSERVER_LIMIT_UNSUPPORTED");
  });

  // ---- Oracle ----

  it("rejects LIMIT for Oracle", () => {
    expect(validateSqlDialect("SELECT * FROM orders LIMIT 10", "oracle")).toEqual([
      expect.objectContaining({ code: "ORACLE_LIMIT_UNSUPPORTED", dialect: "oracle" })
    ]);
  });

  it("rejects DATE_TRUNC for Oracle", () => {
    expect(validateSqlDialect("SELECT DATE_TRUNC('month', created_at) FROM t", "oracle")).toEqual([
      expect.objectContaining({ code: "ORACLE_DATE_TRUNC_UNSUPPORTED", dialect: "oracle" })
    ]);
  });

  it("allows valid Oracle read queries", () => {
    expect(validateSqlDialect(
      "SELECT region, SUM(profit) FROM orders GROUP BY region FETCH FIRST 10 ROWS ONLY", "oracle"
    )).toEqual([]);
  });

  it("enriches Oracle LIMIT error", () => {
    const error = enrichSqlDialectError(new Error("ORA-00933: SQL command not properly ended"), "oracle");
    expect(error.message).toContain("ORACLE_LIMIT_UNSUPPORTED");
  });

  // ---- ClickHouse ----

  it("rejects FULL OUTER JOIN for ClickHouse", () => {
    expect(validateSqlDialect(
      "SELECT * FROM a FULL OUTER JOIN b ON a.id = b.id", "clickhouse"
    )).toEqual([
      expect.objectContaining({ code: "CH_FULL_OUTER_JOIN_UNSUPPORTED", dialect: "clickhouse" })
    ]);
  });

  it("rejects INTERSECT for ClickHouse", () => {
    expect(validateSqlDialect("SELECT id FROM a INTERSECT SELECT id FROM b", "clickhouse")).toEqual([
      expect.objectContaining({ code: "CH_INTERSECT_UNSUPPORTED", dialect: "clickhouse" })
    ]);
  });

  // ---- PostgreSQL ----

  it("allows CTEs and window functions for PostgreSQL", () => {
    expect(validateSqlDialect(
      "WITH cte AS (SELECT 1) SELECT ROW_NUMBER() OVER (ORDER BY id) FROM cte", "postgresql"
    )).toEqual([]);
  });

  it("allows FULL OUTER JOIN for PostgreSQL", () => {
    expect(validateSqlDialect(
      "SELECT * FROM a FULL OUTER JOIN b ON a.id = b.id", "postgresql"
    )).toEqual([]);
  });

  // ---- Unknown dialect ----

  it("returns empty for unknown dialect", () => {
    expect(validateSqlDialect("SELECT * FROM a FULL OUTER JOIN b ON 1=1", "unknown")).toEqual([]);
  });

  it("returns empty for undefined dialect", () => {
    expect(validateSqlDialect("SELECT * FROM a FULL OUTER JOIN b ON 1=1", undefined)).toEqual([]);
  });
});
