//! ParquetPeek backend.

use std::collections::HashSet;
use std::path::PathBuf;

use duckdb::Connection;
use parquet::file::reader::{FileReader, SerializedFileReader};
use serde::{Deserialize, Serialize};
use tauri::{
    Manager, Monitor, PhysicalPosition, PhysicalRect, PhysicalSize, Runtime, WebviewWindow,
};

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    /// Coarse kind used by the UI for alignment / icons:
    /// "number" | "text" | "bool" | "date" | "nested" | "other"
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowGroupInfo {
    pub index: usize,
    pub num_rows: i64,
    pub bytes: i64,
    pub num_columns: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetInfo {
    pub path: String,
    pub file_name: String,
    pub file_size: u64,
    pub num_rows: u64,
    pub num_columns: usize,
    pub columns: Vec<ColumnInfo>,
    pub row_groups: Vec<RowGroupInfo>,
    pub created_by: Option<String>,
    pub format_version: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub column: String,
    pub op: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryArgs {
    pub path: String,
    pub offset: u64,
    pub limit: u64,
    pub columns: Vec<String>,
    pub sort_column: Option<String>,
    pub sort_desc: bool,
    pub filters: Vec<Filter>,
    pub quick_search: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageResult {
    /// One string or null per requested column; nested values are JSON strings.
    pub rows: Vec<Vec<Option<String>>>,
    pub total_rows: u64,
    pub offset: u64,
    pub limit: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopValue {
    pub value: Option<String>,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnProfile {
    pub column: String,
    pub null_count: u64,
    pub non_null_count: u64,
    pub distinct_count: u64,
    pub min: Option<String>,
    pub max: Option<String>,
    pub top_values: Vec<TopValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportArgs {
    pub path: String,
    pub destination: String,
    pub columns: Vec<String>,
    pub sort_column: Option<String>,
    pub sort_desc: bool,
    pub filters: Vec<Filter>,
    pub quick_search: String,
    pub max_rows: u64,
    /// "csv" | "json" | "parquet". Defaults to "parquet" when missing.
    #[serde(default)]
    pub format: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub destination: String,
    pub exported_rows: u64,
}

// ---------------------------------------------------------------------------
// SQL helpers (all identifiers / literals are validated + escaped here so the
// query builders below can never inject raw user input).
// ---------------------------------------------------------------------------

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn quote_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn quote_path(path: &str) -> String {
    quote_literal(path)
}

/// Escape `%`, `_` and `\` for use inside a LIKE pattern.
/// (Single quotes are handled separately by `quote_literal`.)
fn like_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn classify_kind(data_type: &str) -> String {
    let t = data_type.to_ascii_uppercase();
    // Arrays/lists have the element type's prefix (e.g. INTEGER[]), so check
    // them before scalar types. Fixed-size arrays end in [N].
    if t.ends_with(']')
        || ["STRUCT(", "MAP(", "UNION(", "LIST(", "ARRAY("]
            .iter()
            .any(|k| t.starts_with(k))
    {
        "nested".to_string()
    } else if t.starts_with("DECIMAL")
        || ["TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT"]
            .iter()
            .any(|k| t.starts_with(k))
        || [
            "UTINYINT",
            "USMALLINT",
            "UINTEGER",
            "UBIGINT",
            "UHUGEINT",
            "BIGNUM",
        ]
        .iter()
        .any(|k| t.starts_with(k))
        || ["FLOAT", "DOUBLE"].iter().any(|k| t.starts_with(k))
    {
        "number".to_string()
    } else if t.starts_with("BOOL") {
        "bool".to_string()
    } else if t.starts_with("DATE")
        || t.starts_with("TIME")
        || t.starts_with("TIMESTAMP")
        || t.starts_with("INTERVAL")
    {
        "date".to_string()
    } else if t.starts_with("VARCHAR")
        || t.starts_with("CHAR")
        || t.starts_with("STRING")
        || t.starts_with("TEXT")
        || t.starts_with("UUID")
        || t.starts_with("JSON")
        || t.starts_with("ENUM")
    {
        "text".to_string()
    } else {
        "other".to_string()
    }
}

fn open_connection() -> Result<Connection, String> {
    Connection::open_in_memory().map_err(|e| format!("Failed to open file: {e}"))
}

fn source_table(path: &str) -> String {
    format!("read_parquet({}) AS parquet_source", quote_path(path))
}

fn assert_parquet_file(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path.trim());
    if !p.is_file() {
        return Err("That path is not a readable file".to_string());
    }
    let ext_ok = p
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("parquet") || e.eq_ignore_ascii_case("pq"));
    if !ext_ok {
        return Err("Only .parquet / .pq files can be opened".to_string());
    }
    Ok(p)
}

/// Column list from `DESCRIBE`, used both for metadata and as the
/// allow-list that validates every selected / sorted / filtered identifier.
fn describe_columns(conn: &Connection, path: &str) -> Result<Vec<ColumnInfo>, String> {
    let sql = format!("DESCRIBE SELECT * FROM {}", source_table(path));
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to read file schema: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            let name: String = row.get(0)?;
            let data_type: String = row.get(1)?;
            let null_flag: String = row.get(2)?;
            Ok((name, data_type, null_flag))
        })
        .map_err(|e| format!("Failed to read file schema: {e}"))?;
    let mut columns = Vec::new();
    for row in rows {
        let (name, data_type, null_flag) =
            row.map_err(|e| format!("Failed to read schema row: {e}"))?;
        columns.push(ColumnInfo {
            kind: classify_kind(&data_type),
            name,
            data_type,
            nullable: null_flag.eq_ignore_ascii_case("YES"),
        });
    }
    if columns.is_empty() {
        return Err("No columns found in this file".to_string());
    }
    Ok(columns)
}

fn check_column(allowed: &HashSet<String>, column: &str) -> Result<(), String> {
    if allowed.contains(column) {
        Ok(())
    } else {
        Err(format!("Unknown column: {column}"))
    }
}

/// Split a multi-value filter input (comma-separated) into non-empty terms.
fn split_multi_values(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Give invalid values a useful error before running a scan, and make the
/// comparison type explicit instead of relying on DuckDB combination casting.
fn comparison_literal(
    conn: &Connection,
    column: &ColumnInfo,
    value: &str,
) -> Result<String, String> {
    let numeric = column.kind == "number";
    let value = if numeric || column.kind == "bool" || column.kind == "date" {
        value.trim()
    } else {
        value
    };
    let invalid = || {
        format!(
            "Invalid value for {}: expected {}",
            column.name, column.data_type
        )
    };
    if numeric {
        if !value.parse::<f64>().is_ok_and(|n| n.is_finite()) {
            return Err(invalid());
        }
        if column.data_type.contains("INT") || column.data_type == "BIGNUM" {
            let digits = value.trim_start_matches(['+', '-']);
            if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) {
                return Err(format!("Enter a whole number for {}", column.name));
            }
        }
    }
    if column.kind == "bool" && !matches!(value.to_ascii_lowercase().as_str(), "true" | "false") {
        return Err(format!("Choose true or false for {}", column.name));
    }
    let parameter = if column.kind == "nested" {
        "TRY_CAST(? AS JSON)"
    } else {
        "?"
    };
    let sql = format!(
        "SELECT TRY_CAST({parameter} AS {}) IS NOT NULL",
        column.data_type
    );
    let valid: bool = conn
        .query_row(&sql, [value], |row| row.get(0))
        .map_err(|_| invalid())?;
    if !valid {
        return Err(invalid());
    }
    let literal = if column.kind == "nested" {
        format!("CAST({} AS JSON)", quote_literal(value))
    } else {
        quote_literal(value)
    };
    Ok(format!("CAST({literal} AS {})", column.data_type))
}

fn display_expression(column: &ColumnInfo) -> String {
    let col = quote_ident(&column.name);
    if column.kind == "nested" {
        // Keep SQL NULL distinct from JSON null, and use DuckDB's JSON
        // serialization for structs, lists and maps rather than their SQL text.
        format!("CASE WHEN {col} IS NULL THEN NULL ELSE to_json({col})::VARCHAR END")
    } else {
        format!("{col}::VARCHAR")
    }
}

/// Build the WHERE clause (including the leading keyword) shared by the page,
/// count and export queries.
fn build_where(
    conn: &Connection,
    filters: &[Filter],
    quick_search: &str,
    text_columns: &[String],
    columns: &[ColumnInfo],
) -> Result<String, String> {
    let mut parts: Vec<String> = Vec::new();
    for f in filters {
        let column = columns
            .iter()
            .find(|c| c.name == f.column)
            .ok_or_else(|| format!("Unknown column: {}", f.column))?;
        let col = quote_ident(&f.column);
        let text_value = display_expression(column);
        let comparison = if matches!(f.op.as_str(), "eq" | "ne" | "gt" | "lt" | "gte" | "lte") {
            comparison_literal(conn, column, &f.value)?
        } else {
            String::new()
        };
        let clause = match f.op.as_str() {
            "eq" => format!("{col} = {comparison}"),
            "ne" => format!("{col} != {comparison}"),
            "gt" => format!("{col} > {comparison}"),
            "lt" => format!("{col} < {comparison}"),
            "gte" => format!("{col} >= {comparison}"),
            "lte" => format!("{col} <= {comparison}"),
            "contains" => format!(
                "{text_value} ILIKE {} ESCAPE '\\'",
                quote_literal(&format!("%{}%", like_escape(&f.value)))
            ),
            "not_contains" => format!(
                "({col} IS NULL OR {text_value} NOT ILIKE {} ESCAPE '\\')",
                quote_literal(&format!("%{}%", like_escape(&f.value)))
            ),
            "contains_any" => {
                let terms = split_multi_values(&f.value);
                if terms.is_empty() {
                    return Err("Enter at least one comma-separated value".to_string());
                }
                let ors: Vec<String> = terms
                    .iter()
                    .map(|t| {
                        format!(
                            "{text_value} ILIKE {} ESCAPE '\\'",
                            quote_literal(&format!("%{}%", like_escape(t)))
                        )
                    })
                    .collect();
                format!("({})", ors.join(" OR "))
            }
            "not_contains_any" => {
                let terms = split_multi_values(&f.value);
                if terms.is_empty() {
                    return Err("Enter at least one comma-separated value".to_string());
                }
                let ands: Vec<String> = terms
                    .iter()
                    .map(|t| {
                        format!(
                            "{text_value} NOT ILIKE {} ESCAPE '\\'",
                            quote_literal(&format!("%{}%", like_escape(t)))
                        )
                    })
                    .collect();
                format!("({col} IS NULL OR ({}))", ands.join(" AND "))
            }
            "starts_with" => format!(
                "{text_value} ILIKE {} ESCAPE '\\'",
                quote_literal(&format!("{}%", like_escape(&f.value)))
            ),
            "ends_with" => format!(
                "{text_value} ILIKE {} ESCAPE '\\'",
                quote_literal(&format!("%{}", like_escape(&f.value)))
            ),
            "is_null" => format!("{col} IS NULL"),
            "is_not_null" => format!("{col} IS NOT NULL"),
            other => return Err(format!("Unsupported filter operator: {other}")),
        };
        parts.push(clause);
    }
    let q = quick_search.trim();
    if !q.is_empty() {
        let pattern = quote_literal(&format!("%{}%", like_escape(q)));
        let ors: Vec<String> = text_columns
            .iter()
            .filter_map(|c| columns.iter().find(|column| &column.name == c))
            .map(|column| format!("{} ILIKE {pattern} ESCAPE '\\'", display_expression(column)))
            .collect();
        if !ors.is_empty() {
            parts.push(format!("({})", ors.join(" OR ")));
        }
    }
    if parts.is_empty() {
        Ok(String::new())
    } else {
        Ok(format!("WHERE {}", parts.join(" AND ")))
    }
}

fn build_order_by(
    sort_column: &Option<String>,
    sort_desc: bool,
    allowed: &HashSet<String>,
) -> Result<String, String> {
    if let Some(col) = sort_column {
        check_column(allowed, col)?;
        Ok(format!(
            "ORDER BY parquet_source.{} {}",
            quote_ident(col),
            if sort_desc { "DESC" } else { "ASC" }
        ))
    } else {
        Ok(String::new())
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn open_dataset(path: String) -> Result<DatasetInfo, String> {
    let path = path.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || open_dataset_blocking(&path))
        .await
        .map_err(|e| format!("Could not open file: {e}"))?
}

fn open_dataset_blocking(path: &str) -> Result<DatasetInfo, String> {
    let resolved = assert_parquet_file(path)?;
    let canonical = resolved
        .canonicalize()
        .map_err(|e| format!("Cannot resolve file path: {e}"))?;
    let canonical_str = canonical.to_string_lossy().into_owned();

    let meta = std::fs::metadata(&canonical).map_err(|e| format!("Cannot stat file: {e}"))?;
    let file_size = meta.len();
    let file_name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| canonical_str.clone());

    // File details without reading row data.
    let file = std::fs::File::open(&canonical).map_err(|e| format!("Cannot open file: {e}"))?;
    let reader =
        SerializedFileReader::new(file).map_err(|e| format!("Not a valid Parquet file: {e}"))?;
    let metadata = reader.metadata();
    let file_meta = metadata.file_metadata();
    let row_groups = metadata
        .row_groups()
        .iter()
        .enumerate()
        .map(|(index, rg)| RowGroupInfo {
            index,
            num_rows: rg.num_rows(),
            bytes: rg.total_byte_size(),
            num_columns: rg.num_columns(),
        })
        .collect::<Vec<_>>();
    let created_by = file_meta.created_by().map(str::to_string);
    let format_version = file_meta.version();

    // Schema + row count.
    let conn = open_connection()?;
    let columns = describe_columns(&conn, &canonical_str)?;
    let num_rows: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM {}", source_table(&canonical_str)),
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to count rows: {e}"))?;

    Ok(DatasetInfo {
        path: canonical_str,
        file_name,
        file_size,
        num_rows: num_rows.max(0) as u64,
        num_columns: columns.len(),
        columns,
        row_groups,
        created_by,
        format_version,
    })
}

#[tauri::command]
async fn fetch_page(args: QueryArgs) -> Result<PageResult, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_page_blocking(args))
        .await
        .map_err(|e| format!("Could not load page: {e}"))?
}

fn fetch_page_blocking(args: QueryArgs) -> Result<PageResult, String> {
    assert_parquet_file(&args.path)?;
    let canonical = PathBuf::from(args.path.trim())
        .canonicalize()
        .map_err(|e| format!("Cannot resolve file path: {e}"))?;
    let path = canonical.to_string_lossy().into_owned();

    let limit = args.limit.clamp(1, 1000);
    let offset = args.offset;
    let conn = open_connection()?;
    let columns = describe_columns(&conn, &path)?;
    let allowed: HashSet<String> = columns.iter().map(|c| c.name.clone()).collect();

    let selected: Vec<String> = if args.columns.is_empty() {
        columns.iter().map(|c| c.name.clone()).collect()
    } else {
        let mut seen = HashSet::new();
        let mut list = Vec::new();
        for c in &args.columns {
            check_column(&allowed, c)?;
            if seen.insert(c.clone()) {
                list.push(c.clone());
            }
        }
        list
    };
    if selected.is_empty() {
        return Err("Select at least one column".to_string());
    }
    // Quick search across text-like columns (falls back to all columns).
    let mut text_columns: Vec<String> = columns
        .iter()
        .filter(|c| c.kind == "text")
        .map(|c| c.name.clone())
        .collect();
    if text_columns.is_empty() {
        text_columns = columns.iter().map(|c| c.name.clone()).collect();
    }

    let where_sql = build_where(
        &conn,
        &args.filters,
        &args.quick_search,
        &text_columns,
        &columns,
    )?;
    let order_sql = build_order_by(&args.sort_column, args.sort_desc, &allowed)?;

    let select_list = selected
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let column = columns
                .iter()
                .find(|column| &column.name == c)
                .expect("validated column");
            format!(
                "{} AS {}",
                display_expression(column),
                quote_ident(&format!("c{i}"))
            )
        })
        .collect::<Vec<_>>()
        .join(", ");

    let table = source_table(&path);
    let count_sql = format!("SELECT COUNT(*) FROM {table} {where_sql}");
    let total_rows: i64 = conn
        .query_row(&count_sql, [], |row| row.get(0))
        .map_err(|e| format!("Failed to count rows: {e}"))?;

    // Clamp the offset so paging past the end returns the last page instead of
    // an error (filters may shrink the result between requests).
    let total = total_rows.max(0) as u64;
    let offset = if total > 0 { offset.min(total - 1) } else { 0 };

    let page_sql = format!(
        "SELECT {select_list} FROM {table} {where_sql} {order_sql} LIMIT {limit} OFFSET {offset}"
    );
    let width = selected.len();
    let mut stmt = conn
        .prepare(&page_sql)
        .map_err(|e| format!("Failed to load page: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            let mut out = Vec::with_capacity(width);
            for i in 0..width {
                out.push(row.get::<_, Option<String>>(i)?);
            }
            Ok(out)
        })
        .map_err(|e| format!("Failed to load page: {e}"))?;

    let mut data = Vec::new();
    for row in rows {
        data.push(row.map_err(|e| format!("Failed to read row: {e}"))?);
    }

    Ok(PageResult {
        rows: data,
        total_rows: total,
        offset,
        limit,
    })
}

#[tauri::command]
async fn column_profile(path: String, column: String) -> Result<ColumnProfile, String> {
    tauri::async_runtime::spawn_blocking(move || column_profile_blocking(&path, &column))
        .await
        .map_err(|e| format!("Could not load column details: {e}"))?
}

fn column_profile_blocking(path: &str, column: &str) -> Result<ColumnProfile, String> {
    assert_parquet_file(path)?;
    let canonical = PathBuf::from(path.trim())
        .canonicalize()
        .map_err(|e| format!("Cannot resolve file path: {e}"))?;
    let path = canonical.to_string_lossy().into_owned();

    let conn = open_connection()?;
    let columns = describe_columns(&conn, &path)?;
    let allowed = columns.iter().map(|c| c.name.clone()).collect();
    check_column(&allowed, column)?;
    let info = columns
        .iter()
        .find(|c| c.name == column)
        .expect("validated column");
    let display = display_expression(info);
    let col = quote_ident(column);
    let table = source_table(&path);

    let (null_count, non_null_count, distinct_count): (i64, i64, i64) = conn
        .query_row(
            &format!(
                "SELECT COUNT(*) - COUNT({col}), COUNT({col}), COUNT(DISTINCT {col}) FROM {table}"
            ),
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|e| format!("Failed to load column details: {e}"))?;

    // MIN/MAX can fail for nested types; degrade gracefully.
    let (min, max): (Option<String>, Option<String>) = conn
        .query_row(
            &format!("SELECT MIN({col})::VARCHAR, MAX({col})::VARCHAR FROM {table}"),
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap_or((None, None));

    let mut stmt = conn
        .prepare(&format!(
            "SELECT {display} AS v, COUNT(*) AS n FROM {table} GROUP BY 1 ORDER BY n DESC LIMIT 15"
        ))
        .map_err(|e| format!("Failed to load column details: {e}"))?;
    let top = stmt
        .query_map([], |row| {
            let value: Option<String> = row.get(0)?;
            let count: i64 = row.get(1)?;
            Ok(TopValue {
                value,
                count: count.max(0) as u64,
            })
        })
        .map_err(|e| format!("Failed to load column details: {e}"))?;
    let mut top_values = Vec::new();
    for row in top {
        top_values.push(row.map_err(|e| format!("Failed to read value: {e}"))?);
    }

    Ok(ColumnProfile {
        column: column.to_string(),
        null_count: null_count.max(0) as u64,
        non_null_count: non_null_count.max(0) as u64,
        distinct_count: distinct_count.max(0) as u64,
        min,
        max,
        top_values,
    })
}

#[tauri::command]
async fn export_data(args: ExportArgs) -> Result<ExportResult, String> {
    tauri::async_runtime::spawn_blocking(move || export_blocking(args))
        .await
        .map_err(|e| format!("Export was interrupted: {e}"))?
}

#[tauri::command]
async fn export_csv(args: ExportArgs) -> Result<ExportResult, String> {
    // Back-compat alias: old UI only exported CSV and sent no format.
    tauri::async_runtime::spawn_blocking(move || {
        let mut args = args;
        if args.format.is_none() {
            args.format = Some("csv".to_string());
        }
        export_blocking(args)
    })
    .await
    .map_err(|e| format!("Export was interrupted: {e}"))?
}

fn normalize_export_format(raw: &Option<String>, destination: &str) -> Result<String, String> {
    let fmt = raw
        .as_deref()
        .unwrap_or("parquet")
        .trim()
        .to_ascii_lowercase();
    let fmt = match fmt.as_str() {
        "csv" => "csv".to_string(),
        "json" | "ndjson" => "json".to_string(),
        "parquet" | "pq" => "parquet".to_string(),
        "" => "parquet".to_string(),
        other => return Err(format!("Unsupported export format: {other}")),
    };
    // Validate the destination extension matches the chosen format so users
    // don't accidentally write Parquet bytes into a `.csv` file.
    let ext = std::path::Path::new(destination)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let ok = match fmt.as_str() {
        "csv" => ext == "csv",
        "json" => ext == "json" || ext == "ndjson",
        "parquet" => ext == "parquet" || ext == "pq",
        _ => false,
    };
    if !ok {
        let want = match fmt.as_str() {
            "csv" => ".csv",
            "json" => ".json",
            _ => ".parquet",
        };
        return Err(format!("Choose a destination ending in {want}"));
    }
    Ok(fmt)
}

fn export_blocking(args: ExportArgs) -> Result<ExportResult, String> {
    assert_parquet_file(&args.path)?;
    let canonical = PathBuf::from(args.path.trim())
        .canonicalize()
        .map_err(|e| format!("Cannot resolve file path: {e}"))?;
    let path = canonical.to_string_lossy().into_owned();

    let dest = PathBuf::from(args.destination.trim());
    assert_export_destination(&canonical, &dest)?;
    let dest_str = dest.to_string_lossy().into_owned();
    let fmt = normalize_export_format(&args.format, &dest_str)?;
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create export folder: {e}"))?;
        }
    }

    let conn = open_connection()?;
    let columns = describe_columns(&conn, &path)?;
    let allowed: HashSet<String> = columns.iter().map(|c| c.name.clone()).collect();

    let selected: Vec<String> = if args.columns.is_empty() {
        columns.iter().map(|c| c.name.clone()).collect()
    } else {
        let mut seen = HashSet::new();
        let mut list = Vec::new();
        for c in &args.columns {
            check_column(&allowed, c)?;
            if seen.insert(c.clone()) {
                list.push(c.clone());
            }
        }
        list
    };
    if selected.is_empty() {
        return Err("Select at least one column to export".to_string());
    }

    let mut text_columns: Vec<String> = columns
        .iter()
        .filter(|c| c.kind == "text")
        .map(|c| c.name.clone())
        .collect();
    if text_columns.is_empty() {
        text_columns = columns.iter().map(|c| c.name.clone()).collect();
    }

    let where_sql = build_where(
        &conn,
        &args.filters,
        &args.quick_search,
        &text_columns,
        &columns,
    )?;
    let order_sql = build_order_by(&args.sort_column, args.sort_desc, &allowed)?;
    let select_list = selected
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let max_rows = args.max_rows.clamp(1, 10_000_000);
    let table = source_table(&path);
    let select_sql =
        format!("SELECT {select_list} FROM {table} {where_sql} {order_sql} LIMIT {max_rows}");

    let count_sql = format!("SELECT COUNT(*) FROM ({select_sql})");
    let exported: i64 = conn
        .query_row(&count_sql, [], |row| row.get(0))
        .map_err(|e| format!("Export failed: {e}"))?;

    let copy_sql = match fmt.as_str() {
        "csv" => format!(
            "COPY ({select_sql}) TO {} (HEADER, DELIMITER ',')",
            quote_literal(&dest_str)
        ),
        "json" => format!(
            "COPY ({select_sql}) TO {} (FORMAT JSON)",
            quote_literal(&dest_str)
        ),
        _ => format!(
            "COPY ({select_sql}) TO {} (FORMAT PARQUET)",
            quote_literal(&dest_str)
        ),
    };
    conn.execute(&copy_sql, [])
        .map_err(|e| format!("Export failed: {e}"))?;

    Ok(ExportResult {
        destination: dest_str,
        exported_rows: exported.max(0) as u64,
    })
}

fn assert_export_destination(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    if destination
        .try_exists()
        .map_err(|e| format!("Cannot inspect export destination: {e}"))?
        && same_file::is_same_file(source, destination)
            .map_err(|e| format!("Cannot compare export destination with source: {e}"))?
    {
        return Err(
            "Choose a different export destination; the source file cannot be overwritten".to_string(),
        );
    }
    Ok(())
}

/// Write a small demo file so users can explore the UI without one.
#[tauri::command]
async fn generate_sample(destination: String) -> Result<DatasetInfo, String> {
    let destination = destination.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || generate_sample_blocking(&destination))
        .await
        .map_err(|e| format!("Could not create sample file: {e}"))?
}

fn generate_sample_blocking(destination: &str) -> Result<DatasetInfo, String> {
    use arrow_array::{ArrayRef, BooleanArray, Date32Array, Float64Array, Int32Array, StringArray};
    use arrow_schema::{DataType, Field, Schema};
    use parquet::arrow::ArrowWriter;

    let dest = PathBuf::from(destination.trim());
    if dest.extension().and_then(|e| e.to_str()).is_none() {
        return Err("Choose a destination ending in .parquet".to_string());
    }
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create folder: {e}"))?;
        }
    }

    let first = [
        "Aarav", "Mia", "Liam", "Zoe", "Kai", "Nina", "Omar", "Ivy", "Ravi", "Elena", "Theo",
        "Priya", "Jonas", "Sana", "Marco", "Tara",
    ];
    let last = [
        "Sharma", "Garcia", "Nguyen", "Kim", "Patel", "Muller", "Rossi", "Silva", "Khan",
        "Novak", "Tanaka", "Ali", "Smith", "Dubois", "Costa", "Iyer",
    ];
    let departments = [
        "Engineering",
        "Design",
        "Marketing",
        "Sales",
        "Support",
        "Research",
    ];

    // Deterministic LCG so the sample is stable across runs.
    let mut state: u64 = 0x9E3779B97F4A7C15;
    let mut next = |bound: u64| -> u64 {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (state >> 33) % bound
    };

    let n: usize = 1500;
    let mut ids = Vec::with_capacity(n);
    let mut names = Vec::with_capacity(n);
    let mut depts = Vec::with_capacity(n);
    let mut salaries = Vec::with_capacity(n);
    let mut ratings = Vec::with_capacity(n);
    let mut actives = Vec::with_capacity(n);
    let mut joined = Vec::with_capacity(n);
    for i in 0..n {
        ids.push(1000 + i as i32);
        names.push(format!(
            "{} {}",
            first[next(first.len() as u64) as usize],
            last[next(last.len() as u64) as usize]
        ));
        depts.push(departments[next(departments.len() as u64) as usize].to_string());
        salaries.push(42_000.0 + next(90_000) as f64 + next(100) as f64 / 100.0);
        ratings.push((next(50) as f64 / 10.0).clamp(0.0, 5.0));
        actives.push(next(100) < 82);
        joined.push(18_000 + next(2_200) as i32);
    }

    let schema = Schema::new(vec![
        Field::new("id", DataType::Int32, false),
        Field::new("name", DataType::Utf8, false),
        Field::new("department", DataType::Utf8, false),
        Field::new("salary", DataType::Float64, false),
        Field::new("rating", DataType::Float64, false),
        Field::new("active", DataType::Boolean, false),
        Field::new("joined", DataType::Date32, false),
    ]);
    let batch = arrow_array::RecordBatch::try_new(
        std::sync::Arc::new(schema),
        vec![
            std::sync::Arc::new(Int32Array::from(ids)) as ArrayRef,
            std::sync::Arc::new(StringArray::from(names)) as ArrayRef,
            std::sync::Arc::new(StringArray::from(depts)) as ArrayRef,
            std::sync::Arc::new(Float64Array::from(salaries)) as ArrayRef,
            std::sync::Arc::new(Float64Array::from(ratings)) as ArrayRef,
            std::sync::Arc::new(BooleanArray::from(actives)) as ArrayRef,
            std::sync::Arc::new(Date32Array::from(joined)) as ArrayRef,
        ],
    )
    .map_err(|e| format!("Failed to build sample batch: {e}"))?;

    let file =
        std::fs::File::create(&dest).map_err(|e| format!("Cannot write sample file: {e}"))?;
    let mut writer = ArrowWriter::try_new(file, batch.schema(), None)
        .map_err(|e| format!("Failed to create Parquet writer: {e}"))?;
    writer
        .write(&batch)
        .map_err(|e| format!("Failed to write sample rows: {e}"))?;
    writer
        .close()
        .map_err(|e| format!("Failed to finish sample file: {e}"))?;

    open_dataset_blocking(&dest.to_string_lossy())
}

// ---------------------------------------------------------------------------
// Window controls + geometry (frameless window)
// ---------------------------------------------------------------------------

#[tauri::command]
async fn window_minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
async fn window_maximize(window: WebviewWindow) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
async fn window_close(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

struct WindowGeometry {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
}

fn monitor_for_window<R: Runtime>(window: &WebviewWindow<R>) -> Option<Monitor> {
    window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
        .or_else(|| {
            window
                .available_monitors()
                .ok()
                .and_then(|monitors| monitors.into_iter().next())
        })
}

fn constrained_window_geometry(
    geometry: WindowGeometry,
    work_area: PhysicalRect<i32, u32>,
    center_fallback: bool,
) -> WindowGeometry {
    let max_width = work_area.size.width.max(1);
    let max_height = work_area.size.height.max(1);
    let target_width = geometry.size.width.clamp(1, max_width);
    let target_height = geometry.size.height.clamp(1, max_height);

    let max_x = work_area.position.x + work_area.size.width.saturating_sub(target_width) as i32;
    let max_y = work_area.position.y + work_area.size.height.saturating_sub(target_height) as i32;

    let target_x = if center_fallback {
        work_area.position.x + (work_area.size.width.saturating_sub(target_width) / 2) as i32
    } else {
        geometry.position.x.clamp(work_area.position.x, max_x)
    };

    let target_y = if center_fallback {
        work_area.position.y + (work_area.size.height.saturating_sub(target_height) / 2) as i32
    } else {
        geometry.position.y.clamp(work_area.position.y, max_y)
    };

    WindowGeometry {
        position: PhysicalPosition::new(target_x, target_y),
        size: PhysicalSize::new(target_width, target_height),
    }
}

fn fit_initial_window_to_work_area<R: Runtime>(window: &WebviewWindow<R>) {
    let Some(monitor) = monitor_for_window(window) else {
        return;
    };
    let work_area = *monitor.work_area();
    let Ok(inner_size) = window.inner_size() else {
        return;
    };
    let Ok(outer_size) = window.outer_size() else {
        return;
    };
    let horizontal_chrome = outer_size.width.saturating_sub(inner_size.width);
    let vertical_chrome = outer_size.height.saturating_sub(inner_size.height);
    let position = window
        .outer_position()
        .unwrap_or_else(|_| PhysicalPosition::new(work_area.position.x, work_area.position.y));
    let constrained = constrained_window_geometry(
        WindowGeometry {
            position,
            size: outer_size,
        },
        work_area,
        true,
    );
    let target_inner_size = PhysicalSize::new(
        constrained
            .size
            .width
            .saturating_sub(horizontal_chrome)
            .max(1),
        constrained
            .size
            .height
            .saturating_sub(vertical_chrome)
            .max(1),
    );
    if target_inner_size != inner_size {
        let _ = window.set_size(target_inner_size);
    }

    let Ok(final_outer_size) = window.outer_size() else {
        return;
    };
    let Ok(final_position) = window.outer_position() else {
        return;
    };
    let final_geometry = constrained_window_geometry(
        WindowGeometry {
            position: final_position,
            size: final_outer_size,
        },
        work_area,
        true,
    );
    let _ = window.set_position(final_geometry.position);
}

// ---------------------------------------------------------------------------
// Reveal in file manager / open with default app.
//
// These use plain OS commands (`open -R` / `open` on macOS, Explorer on
// Windows, xdg-open on Linux) instead of the opener plugin's direct AppKit
// calls, which aborted the process on some macOS versions when invoked from
// a background thread.
// ---------------------------------------------------------------------------

#[tauri::command]
async fn reveal_path(path: String) -> Result<(), String> {
    let trimmed = path.trim().to_string();
    if trimmed.is_empty() {
        return Err("Nothing to reveal".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || reveal_path_blocking(&trimmed))
        .await
        .map_err(|e| format!("Reveal was interrupted: {e}"))?
}

fn run_command(cmd: &mut std::process::Command) -> Result<(), String> {
    let output = cmd.output().map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stderr.is_empty() {
        Err(stderr)
    } else if !stdout.is_empty() {
        Err(stdout)
    } else {
        Err(format!("command exited with {}", output.status))
    }
}

fn reveal_path_blocking(path: &str) -> Result<(), String> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Err("File no longer exists".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        return run_command(
            std::process::Command::new("open").arg("-R").arg(path),
        )
        .map_err(|e| format!("Reveal failed: {e}"));
    }
    #[cfg(target_os = "windows")]
    {
        return run_command(
            std::process::Command::new("explorer").args(["/select,", path]),
        )
        .map_err(|e| format!("Reveal failed: {e}"));
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Try the file-manager portal first, fall back to opening the folder.
        let parent = p
            .parent()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "/".to_string());
        return run_command(std::process::Command::new("xdg-open").arg(&parent))
            .map_err(|e| format!("Reveal failed: {e}"));
    }
}

#[tauri::command]
async fn open_external(path: String) -> Result<(), String> {
    let trimmed = path.trim().to_string();
    if trimmed.is_empty() {
        return Err("Nothing to open".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || open_external_blocking(&trimmed))
        .await
        .map_err(|e| format!("Open was interrupted: {e}"))?
}

fn open_external_blocking(path: &str) -> Result<(), String> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Err("File no longer exists".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        return run_command(std::process::Command::new("open").arg(path))
            .map_err(|e| format!("Open failed: {e}"));
    }
    #[cfg(target_os = "windows")]
    {
        return run_command(
            std::process::Command::new("cmd").args(["/C", "start", "", path]),
        )
        .map_err(|e| format!("Open failed: {e}"));
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        return run_command(std::process::Command::new("xdg-open").arg(path))
            .map_err(|e| format!("Open failed: {e}"));
    }
}

// ---------------------------------------------------------------------------
// App entry
// ---------------------------------------------------------------------------

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                fit_initial_window_to_work_area(&window);
                window.show()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_dataset,
            fetch_page,
            column_profile,
            export_data,
            export_csv,
            generate_sample,
            reveal_path,
            open_external,
            window_minimize,
            window_maximize,
            window_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ParquetPeek");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "parquetpeek-test-{}-{unique}-{}",
                std::process::id(),
                NEXT_TEST.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write_fixture(path: &std::path::Path, query: &str) {
        open_connection()
            .unwrap()
            .execute(
                &format!(
                    "COPY ({query}) TO {} (FORMAT PARQUET)",
                    quote_path(&path.to_string_lossy())
                ),
                [],
            )
            .unwrap();
    }

    fn export_args(source: &std::path::Path, destination: &std::path::Path) -> ExportArgs {
        ExportArgs {
            path: source.to_string_lossy().into_owned(),
            destination: destination.to_string_lossy().into_owned(),
            columns: vec!["id".into()],
            sort_column: None,
            sort_desc: false,
            filters: vec![],
            quick_search: String::new(),
            max_rows: 2,
            format: Some("parquet".into()),
        }
    }

    #[test]
    fn exports_reject_source_and_hard_link_without_changing_data() {
        let dir = TestDirectory::new();
        let source = dir.0.join("source.parquet");
        write_fixture(&source, "SELECT range AS id FROM range(10)");
        let original = std::fs::read(&source).unwrap();
        let alias = dir.0.join("alias.parquet");
        std::fs::hard_link(&source, &alias).unwrap();

        for destination in [&source, &dir.0.join(".").join("source.parquet"), &alias] {
            let error = export_blocking(export_args(&source, destination)).unwrap_err();
            assert!(
                error.contains("source file cannot be overwritten"),
                "{error}"
            );
            assert_eq!(std::fs::read(&source).unwrap(), original);
        }

        let destination = dir.0.join("export.parquet");
        let result = export_blocking(export_args(&source, &destination)).unwrap();
        assert_eq!(result.exported_rows, 2);
        assert_eq!(
            open_dataset_blocking(&destination.to_string_lossy())
                .unwrap()
                .num_rows,
            2
        );
        assert_eq!(std::fs::read(&source).unwrap(), original);
    }

    #[cfg(unix)]
    #[test]
    fn exports_reject_symlink_to_source_without_changing_data() {
        let dir = TestDirectory::new();
        let source = dir.0.join("source.parquet");
        write_fixture(&source, "SELECT range AS id FROM range(10)");
        let original = std::fs::read(&source).unwrap();
        let alias = dir.0.join("alias.parquet");
        std::os::unix::fs::symlink(&source, &alias).unwrap();
        let error = export_blocking(export_args(&source, &alias)).unwrap_err();
        assert!(error.contains("source file cannot be overwritten"));
        assert_eq!(std::fs::read(&source).unwrap(), original);
    }

    #[test]
    fn page_sort_uses_source_column_despite_projection_alias_collision() {
        let dir = TestDirectory::new();
        let source = dir.0.join("sort.parquet");
        write_fixture(
            &source,
            "SELECT * FROM (VALUES (100, 2), (200, 10), (300, 1)) t(a, c0)",
        );
        for (selected, expected) in [
            (vec!["c0".into()], vec![vec!["1"], vec!["2"], vec!["10"]]),
            (
                vec!["a".into(), "c0".into()],
                vec![vec!["300", "1"], vec!["100", "2"], vec!["200", "10"]],
            ),
            (vec!["a".into()], vec![vec!["300"], vec!["100"], vec!["200"]]),
        ] {
            for descending in [false, true] {
                let result = fetch_page_blocking(QueryArgs {
                    path: source.to_string_lossy().into_owned(),
                    offset: 0,
                    limit: 100,
                    columns: selected.clone(),
                    sort_column: Some("c0".into()),
                    sort_desc: descending,
                    filters: vec![],
                    quick_search: String::new(),
                })
                .unwrap();
                let mut expected: Vec<Vec<Option<String>>> = expected
                    .iter()
                    .map(|row| row.iter().map(|value| Some((*value).into())).collect())
                    .collect();
                if descending {
                    expected.reverse();
                }
                assert_eq!(result.rows, expected);
            }
        }
    }
}
