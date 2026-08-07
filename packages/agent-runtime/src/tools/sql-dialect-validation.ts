export type SqlDialectIssue = {
  code: string;
  dialect: string;
  hint: string;
};

/* ------------------------------------------------------------------ */
/* Dialect family helpers                                             */
/* ------------------------------------------------------------------ */

const normalizeDialect = (dialect: string | undefined): string =>
  (dialect ?? "").toLowerCase().trim();

/** Group dialects into families that share SQL syntax constraints. */
const dialectFamily = (dialect: string): string => {
  const d = dialect.toLowerCase();
  if (d === "sqlite") return "sqlite";
  if (d === "duckdb") return "duckdb";
  // MySQL family
  if (["mysql", "mariadb", "tidb", "starrocks", "doris", "oceanbase", "gaussdb"].includes(d)) return "mysql";
  // PostgreSQL family
  if (["postgresql", "postgres", "redshift", "greenplum", "gaussdb"].includes(d)) return "postgresql";
  if (d === "clickhouse") return "clickhouse";
  if (d === "sqlserver" || d === "mssql") return "sqlserver";
  if (d === "oracle") return "oracle";
  if (d === "bigquery") return "bigquery";
  if (d === "snowflake") return "snowflake";
  return "";
};

/* ------------------------------------------------------------------ */
/* Per-dialect validation rules                                       */
/* ------------------------------------------------------------------ */

type DialectRule = {
  code: string;
  pattern: RegExp;
  hint: string;
};

const SQLITE_RULES: DialectRule[] = [
  {
    code: "SQLITE_PERCENTILE_CONT_UNSUPPORTED",
    pattern: /\bPERCENTILE_CONT\s*\([^)]*\)\s*WITHIN\s+GROUP\b/iu,
    hint: "Use ROW_NUMBER and COUNT to select or interpolate ordered percentile rows."
  },
  {
    code: "SQLITE_ILIKE_UNSUPPORTED",
    pattern: /\bILIKE\b/iu,
    hint: "Use LIKE with COLLATE NOCASE for case-insensitive matching."
  },
  {
    code: "SQLITE_DATE_TRUNC_UNSUPPORTED",
    pattern: /\bDATE_TRUNC\s*\(/iu,
    hint: "Use strftime with the required date grain."
  },
  {
    code: "SQLITE_QUALIFY_UNSUPPORTED",
    pattern: /\bQUALIFY\b/iu,
    hint: "Move the window predicate into an outer SELECT WHERE clause."
  },
  {
    code: "SQLITE_FULL_OUTER_JOIN_UNSUPPORTED",
    pattern: /\bFULL\s+OUTER\s+JOIN\b/iu,
    hint: "SQLite does not support FULL OUTER JOIN. Emulate with a LEFT JOIN UNION RIGHT JOIN."
  },
  {
    code: "SQLITE_BOOLEAN_LITERAL_UNSUPPORTED",
    pattern: /\bTRUE\b|\bFALSE\b/iu,
    hint: "SQLite uses 1 and 0 for booleans, not TRUE/FALSE literals."
  },
  {
    code: "SQLITE_ROW_NUMBER_UNSUPPORTED",
    pattern: /\bROW_NUMBER\s*\(\s*\)\s+OVER\b/iu,
    hint: "SQLite versions before 3.25 do not support window functions. Use correlated subqueries."
  }
];

const MYSQL_RULES: DialectRule[] = [
  {
    code: "MYSQL_FULL_OUTER_JOIN_UNSUPPORTED",
    pattern: /\bFULL\s+OUTER\s+JOIN\b/iu,
    hint: "MySQL does not support FULL OUTER JOIN. Emulate with LEFT JOIN UNION RIGHT JOIN."
  },
  {
    code: "MYSQL_INTERSECT_UNSUPPORTED",
    pattern: /\bINTERSECT\b/iu,
    hint: "MySQL does not support INTERSECT before 8.0. Use INNER JOIN or IN subquery."
  },
  {
    code: "MYSQL_EXCEPT_UNSUPPORTED",
    pattern: /\bEXCEPT\b/iu,
    hint: "MySQL does not support EXCEPT before 8.0. Use NOT IN or LEFT JOIN with NULL check."
  },
  {
    code: "MYSQL_CTE_UNSUPPORTED",
    pattern: /\bWITH\s+\w+\s+AS\s*\(/iu,
    hint: "MySQL does not support CTEs (WITH clause) before 8.0. Rewrite as subqueries."
  },
  {
    code: "MYSQL_WINDOW_FUNCTION_UNSUPPORTED",
    pattern: /\bOVER\s*\(/iu,
    hint: "MySQL does not support window functions before 8.0. Use correlated subqueries or user variables."
  },
  {
    code: "MYSQL_LATERAL_UNSUPPORTED",
    pattern: /\bLATERAL\b/iu,
    hint: "MySQL does not support LATERAL joins. Rewrite as correlated subqueries."
  },
  {
    code: "MYSQL_ARRAY_CONSTRUCTOR_UNSUPPORTED",
    pattern: /\bARRAY\s*\[|::\s*\w+\s*\[\]/iu,
    hint: "MySQL does not support PostgreSQL-style ARRAY constructors or typed arrays."
  },
  {
    code: "MYSQL_RETURNING_UNSUPPORTED",
    pattern: /\bRETURNING\b/iu,
    hint: "MySQL does not support RETURNING clause."
  },
  {
    code: "MYSQL_BOOLEAN_LITERAL_UNSUPPORTED",
    pattern: /\bTRUE\b|\bFALSE\b/iu,
    hint: "MySQL accepts TRUE/FALSE but they map to 1/0. For strict compatibility use 1/0."
  },
  {
    code: "MYSQL_JSON_PATH_UNSUPPORTED",
    pattern: /->>|#>>|#>/u,
    hint: "MySQL JSON path uses ->'$.key' syntax, not PostgreSQL ->> or #>> operators."
  },
  {
    code: "MYSQL_ILIKE_UNSUPPORTED",
    pattern: /\bILIKE\b/iu,
    hint: "MySQL does not support ILIKE. Use LOWER() on both sides with LIKE."
  },
  {
    code: "MYSQL_PERCENTILE_CONT_UNSUPPORTED",
    pattern: /\bPERCENTILE_CONT\s*\([^)]*\)\s*WITHIN\s+GROUP\b/iu,
    hint: "MySQL does not support PERCENTILE_CONT. Use a subquery with percentile rank calculation."
  },
  {
    code: "MYSQL_DATE_TRUNC_UNSUPPORTED",
    pattern: /\bDATE_TRUNC\s*\(/iu,
    hint: "MySQL does not support DATE_TRUNC. Use DATE_FORMAT() for the required grain."
  },
  {
    code: "MYSQL_GENERATE_SERIES_UNSUPPORTED",
    pattern: /\bGENERATE_SERIES\s*\(/iu,
    hint: "MySQL does not support GENERATE_SERIES. Use a recursive CTE or a numbers table."
  }
];

const POSTGRESQL_RULES: DialectRule[] = [
  {
    code: "PG_INTERSECT_ALL_UNSUPPORTED",
    pattern: /\bINTERSECT\s+ALL\b/iu,
    hint: "PostgreSQL does not support INTERSECT ALL. Use INTERSECT or rewrite with EXISTS."
  },
  {
    code: "PG_MERGE_UNSUPPORTED",
    pattern: /\bMERGE\s+INTO\b/iu,
    hint: "PostgreSQL does not support MERGE before version 15. Use INSERT ON CONFLICT."
  }
];

const SQLSERVER_RULES: DialectRule[] = [
  {
    code: "SQLSERVER_ILIKE_UNSUPPORTED",
    pattern: /\bILIKE\b/iu,
    hint: "SQL Server does not support ILIKE. Use LOWER() with LIKE."
  },
  {
    code: "SQLSERVER_LIMIT_UNSUPPORTED",
    pattern: /\bLIMIT\s+\d+/iu,
    hint: "SQL Server does not support LIMIT. Use TOP n or OFFSET n ROWS FETCH NEXT."
  },
  {
    code: "SQLSERVER_DATE_TRUNC_UNSUPPORTED",
    pattern: /\bDATE_TRUNC\s*\(/iu,
    hint: "SQL Server does not support DATE_TRUNC. Use DATEFROMPARTS or DATEADD with DATEDIFF."
  },
  {
    code: "SQLSERVER_GENERATE_SERIES_UNSUPPORTED",
    pattern: /\bGENERATE_SERIES\s*\(/iu,
    hint: "SQL Server does not support GENERATE_SERIES. Use a numbers table or recursive CTE."
  },
  {
    code: "SQLSERVER_BOOLEAN_LITERAL_UNSUPPORTED",
    pattern: /\bTRUE\b|\bFALSE\b/iu,
    hint: "SQL Server does not support TRUE/FALSE literals. Use 1/0 or BIT columns."
  },
  {
    code: "SQLSERVER_EXTRACT_UNSUPPORTED",
    pattern: /\bEXTRACT\s*\(/iu,
    hint: "SQL Server does not support EXTRACT(). Use DATEPART() instead."
  },
  {
    code: "SQLSERVER_PERCENTILE_CONT_UNSUPPORTED",
    pattern: /\bPERCENTILE_CONT\s*\([^)]*\)\s*WITHIN\s+GROUP\b/iu,
    hint: "SQL Server supports PERCENTILE_CONT but syntax differs. Verify WITHIN GROUP usage."
  },
  {
    code: "SQLSERVER_ARRAY_CONSTRUCTOR_UNSUPPORTED",
    pattern: /\bARRAY\s*\[|::\s*\w+\s*\[\]/iu,
    hint: "SQL Server does not support ARRAY constructors or typed arrays."
  }
];

const ORACLE_RULES: DialectRule[] = [
  {
    code: "ORACLE_LIMIT_UNSUPPORTED",
    pattern: /\bLIMIT\s+\d+/iu,
    hint: "Oracle does not support LIMIT. Use ROWNUM or FETCH FIRST n ROWS ONLY."
  },
  {
    code: "ORACLE_AS_UNSUPPORTED",
    pattern: /\bAS\s+\w+\s*(?:FROM|WHERE|GROUP|ORDER|JOIN)/iu,
    hint: "Oracle does not support AS for table aliases. Use the alias directly."
  },
  {
    code: "ORACLE_BOOLEAN_LITERAL_UNSUPPORTED",
    pattern: /\bTRUE\b|\bFALSE\b/iu,
    hint: "Oracle does not have a BOOLEAN type. Use 1/0 or CHAR(1) with Y/N."
  },
  {
    code: "ORACLE_DATE_TRUNC_UNSUPPORTED",
    pattern: /\bDATE_TRUNC\s*\(/iu,
    hint: "Oracle does not support DATE_TRUNC. Use TRUNC() with date format."
  },
  {
    code: "ORACLE_ILIKE_UNSUPPORTED",
    pattern: /\bILIKE\b/iu,
    hint: "Oracle does not support ILIKE. Use LOWER() with LIKE."
  },
  {
    code: "ORACLE_GENERATE_SERIES_UNSUPPORTED",
    pattern: /\bGENERATE_SERIES\s*\(/iu,
    hint: "Oracle does not support GENERATE_SERIES. Use CONNECT BY LEVEL."
  }
];

const CLICKHOUSE_RULES: DialectRule[] = [
  {
    code: "CH_FULL_OUTER_JOIN_UNSUPPORTED",
    pattern: /\bFULL\s+OUTER\s+JOIN\b/iu,
    hint: "ClickHouse does not support FULL OUTER JOIN. Use LEFT JOIN UNION RIGHT JOIN."
  },
  {
    code: "CH_INTERSECT_UNSUPPORTED",
    pattern: /\bINTERSECT\b/iu,
    hint: "ClickHouse does not support INTERSECT. Use INNER JOIN or IN subquery."
  },
  {
    code: "CH_EXCEPT_UNSUPPORTED",
    pattern: /\bEXCEPT\b/iu,
    hint: "ClickHouse does not support EXCEPT. Use NOT IN or LEFT JOIN with NULL check."
  },
  {
    code: "CH_CTE_UNSUPPORTED",
    pattern: /\bWITH\s+\w+\s+AS\s*\(/iu,
    hint: "ClickHouse does not support CTEs before 23.3. Rewrite as subqueries."
  }
];

const BIGQUERY_RULES: DialectRule[] = [
  {
    code: "BQ_UPDATE_UNSUPPORTED",
    pattern: /\bUPDATE\s+\w+\s+SET\b/iu,
    hint: "BigQuery does not support UPDATE in read-only queries."
  },
  {
    code: "BQ_DELETE_UNSUPPORTED",
    pattern: /\bDELETE\s+FROM\b/iu,
    hint: "BigQuery does not support DELETE in read-only queries."
  }
];

const SNOWFLAKE_RULES: DialectRule[] = [];

const DUCKDB_RULES: DialectRule[] = [];

const DIALECT_RULES: Record<string, DialectRule[]> = {
  sqlite: SQLITE_RULES,
  mysql: MYSQL_RULES,
  postgresql: POSTGRESQL_RULES,
  sqlserver: SQLSERVER_RULES,
  oracle: ORACLE_RULES,
  clickhouse: CLICKHOUSE_RULES,
  bigquery: BIGQUERY_RULES,
  snowflake: SNOWFLAKE_RULES,
  duckdb: DUCKDB_RULES
};

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */

/** Detect common SQL constructs unsupported by the inspected datasource dialect. */
export const validateSqlDialect = (sql: string, dialect: string | undefined): SqlDialectIssue[] => {
  const normalized = normalizeDialect(dialect);
  const family = dialectFamily(normalized);
  if (!family) {
    return [];
  }
  const rules = DIALECT_RULES[family] ?? [];
  return rules
    .filter((rule) => rule.pattern.test(sql))
    .map((rule) => ({
      code: rule.code,
      dialect: normalized,
      hint: rule.hint
    }));
};

/** Add stable dialect context and repair guidance to known backend syntax failures. */
export const enrichSqlDialectError = (error: unknown, dialect: string | undefined): Error => {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = normalizeDialect(dialect);
  const family = dialectFamily(normalized);

  if (family === "sqlite") {
    if (/LIMIT clause should come after UNION(?: ALL)? not before/iu.test(message)) {
      return new Error(
        "SQL_DIALECT_ERROR:sqlite:SQLITE_UNION_LIMIT_POSITION:"
        + "Wrap the limited UNION branch in a subquery, or apply LIMIT after the complete UNION."
      );
    }
    if (/near ["']?WITHIN["']?: syntax error/iu.test(message)) {
      return new Error(
        "SQL_DIALECT_ERROR:sqlite:SQLITE_WITHIN_GROUP_UNSUPPORTED:"
        + "Replace WITHIN GROUP ordered-set aggregates with SQLite window functions."
      );
    }
  }

  if (family === "mysql") {
    if (/near ["']?WITH["']?:|Unknown column|syntax error.*WITH/iu.test(message)) {
      return new Error(
        `SQL_DIALECT_ERROR:${normalized}:MYSQL_CTE_UNSUPPORTED:`
        + "MySQL does not support CTEs before 8.0. Rewrite as subqueries."
      );
    }
    if (/near ["']?FULL["']?|FULL OUTER JOIN/iu.test(message)) {
      return new Error(
        `SQL_DIALECT_ERROR:${normalized}:MYSQL_FULL_OUTER_JOIN_UNSUPPORTED:`
        + "MySQL does not support FULL OUTER JOIN. Emulate with LEFT JOIN UNION RIGHT JOIN."
      );
    }
    if (/near ["']?INTERSECT["']?/iu.test(message)) {
      return new Error(
        `SQL_DIALECT_ERROR:${normalized}:MYSQL_INTERSECT_UNSUPPORTED:`
        + "MySQL does not support INTERSECT. Use INNER JOIN or IN subquery."
      );
    }
    if (/near ["']?EXCEPT["']?/iu.test(message)) {
      return new Error(
        `SQL_DIALECT_ERROR:${normalized}:MYSQL_EXCEPT_UNSUPPORTED:`
        + "MySQL does not support EXCEPT. Use NOT IN or LEFT JOIN with NULL check."
      );
    }
    if (/near ["']?OVER["']?|window function/iu.test(message)) {
      return new Error(
        `SQL_DIALECT_ERROR:${normalized}:MYSQL_WINDOW_FUNCTION_UNSUPPORTED:`
        + "MySQL does not support window functions before 8.0. Use correlated subqueries."
      );
    }
    if (/near ["']?LATERAL["']?/iu.test(message)) {
      return new Error(
        `SQL_DIALECT_ERROR:${normalized}:MYSQL_LATERAL_UNSUPPORTED:`
        + "MySQL does not support LATERAL joins. Rewrite as correlated subqueries."
      );
    }
  }

  if (family === "sqlserver") {
    if (/near ["']?LIMIT["']?|Incorrect syntax near 'LIMIT'/iu.test(message)) {
      return new Error(
        `SQL_DIALECT_ERROR:${normalized}:SQLSERVER_LIMIT_UNSUPPORTED:`
        + "SQL Server does not support LIMIT. Use TOP n or OFFSET n ROWS FETCH NEXT."
      );
    }
    if (/near ["']?ILIKE["']?/iu.test(message)) {
      return new Error(
        `SQL_DIALECT_ERROR:${normalized}:SQLSERVER_ILIKE_UNSUPPORTED:`
        + "SQL Server does not support ILIKE. Use LOWER() with LIKE."
      );
    }
  }

  if (family === "oracle") {
    if (/near ["']?LIMIT["']?|ORA-00933/iu.test(message)) {
      return new Error(
        `SQL_DIALECT_ERROR:${normalized}:ORACLE_LIMIT_UNSUPPORTED:`
        + "Oracle does not support LIMIT. Use ROWNUM or FETCH FIRST n ROWS ONLY."
      );
    }
    if (/ORA-00904.*TRUE|ORA-00904.*FALSE/iu.test(message)) {
      return new Error(
        `SQL_DIALECT_ERROR:${normalized}:ORACLE_BOOLEAN_LITERAL_UNSUPPORTED:`
        + "Oracle does not have a BOOLEAN type. Use 1/0 or CHAR(1) with Y/N."
      );
    }
  }

  if (family === "clickhouse") {
    if (/near ["']?FULL["']?|FULL OUTER JOIN/iu.test(message)) {
      return new Error(
        `SQL_DIALECT_ERROR:${normalized}:CH_FULL_OUTER_JOIN_UNSUPPORTED:`
        + "ClickHouse does not support FULL OUTER JOIN."
      );
    }
    if (/near ["']?INTERSECT["']?/iu.test(message)) {
      return new Error(
        `SQL_DIALECT_ERROR:${normalized}:CH_INTERSECT_UNSUPPORTED:`
        + "ClickHouse does not support INTERSECT."
      );
    }
    if (/near ["']?EXCEPT["']?/iu.test(message)) {
      return new Error(
        `SQL_DIALECT_ERROR:${normalized}:CH_EXCEPT_UNSUPPORTED:`
        + "ClickHouse does not support EXCEPT."
      );
    }
  }

  return error instanceof Error ? error : new Error(message);
};
