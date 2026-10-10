export type ColumnKind = "number" | "text" | "bool" | "date" | "nested" | "other";

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  kind: ColumnKind;
}

export interface RowGroupInfo {
  index: number;
  numRows: number;
  bytes: number;
  numColumns: number;
}

export interface DatasetInfo {
  path: string;
  fileName: string;
  fileSize: number;
  numRows: number;
  numColumns: number;
  columns: ColumnInfo[];
  rowGroups: RowGroupInfo[];
  createdBy?: string | null;
  formatVersion: number;
}

export type FilterOp =
  | "eq"
  | "ne"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "contains"
  | "not_contains"
  | "contains_any"
  | "not_contains_any"
  | "starts_with"
  | "ends_with"
  | "is_null"
  | "is_not_null";

export interface Filter {
  column: string;
  op: FilterOp;
  value: string;
}

export interface QueryArgs {
  path: string;
  offset: number;
  limit: number;
  columns: string[];
  sortColumn?: string | null;
  sortDesc: boolean;
  filters: Filter[];
  quickSearch: string;
}

export interface PageResult {
  rows: (string | null)[][];
  totalRows: number;
  offset: number;
  limit: number;
}

export interface TopValue {
  value: string | null;
  count: number;
}

export interface ColumnProfile {
  column: string;
  nullCount: number;
  nonNullCount: number;
  distinctCount: number;
  min?: string | null;
  max?: string | null;
  topValues: TopValue[];
}

export type ExportFormat = "csv" | "json" | "parquet";

export interface ExportArgs {
  path: string;
  destination: string;
  columns: string[];
  sortColumn?: string | null;
  sortDesc: boolean;
  filters: Filter[];
  quickSearch: string;
  maxRows: number;
  format: ExportFormat;
}

export interface ExportResult {
  destination: string;
  exportedRows: number;
}
