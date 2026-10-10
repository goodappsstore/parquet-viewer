import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { icon } from "./icons";
import { defaultFilterOp, filterInputType, isComparison, isIntegerColumn, validateFilter } from "./filters";
import { populateJsonNode, structuredCellHtml, structuredJsonForCopy } from "./structured";
import {
  ColumnInfo,
  ColumnProfile,
  DatasetInfo,
  ExportFormat,
  ExportResult,
  Filter,
  FilterOp,
  PageResult,
  QueryArgs,
} from "./types";
import "./styles.css";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface DatasetTab {
  info: DatasetInfo;
  visibleColumns: string[];
  page: PageResult | null;
  // The column order used by the loaded page, independent of pending changes.
  pageColumns: string[];
  currentPage: number;
  pageSize: number;
  sortColumn: string | null;
  sortDesc: boolean;
  filters: Filter[];
  quickSearch: string;
  loading: boolean;
  error: string | null;
  requestId: number;
  queryMs: number | null;
  selectedRow: number | null;
  profileColumn: string | null;
  profile: ColumnProfile | null;
  profileLoading: boolean;
  profileError: string | null;
  profileCache: Map<string, ColumnProfile | null>;
  profileRequests: Map<string, Promise<ColumnProfile>>;
}

interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  message: string;
}

const PAGE_SIZES = [50, 100, 200, 500];
const DEFAULT_PAGE_SIZE = 100;

const FILTER_OPS: { value: FilterOp; label: string; needsValue: boolean; multi?: boolean }[] = [
  { value: "contains", label: "contains", needsValue: true },
  { value: "contains_any", label: "contains any", needsValue: true, multi: true },
  { value: "not_contains", label: "does not contain", needsValue: true },
  { value: "not_contains_any", label: "does not contain any", needsValue: true, multi: true },
  { value: "eq", label: "=  equals", needsValue: true },
  { value: "ne", label: "≠  not equals", needsValue: true },
  { value: "gt", label: ">  greater than", needsValue: true },
  { value: "lt", label: "<  less than", needsValue: true },
  { value: "gte", label: "≥  at least", needsValue: true },
  { value: "lte", label: "≤  at most", needsValue: true },
  { value: "starts_with", label: "starts with", needsValue: true },
  { value: "ends_with", label: "ends with", needsValue: true },
  { value: "is_null", label: "is empty (NULL)", needsValue: false },
  { value: "is_not_null", label: "is not empty", needsValue: false },
];

let tabs: DatasetTab[] = [];
let activePath: string | null = null;
let recents: string[] = [];
let toasts: Toast[] = [];
let toastSeq = 0;

let filterPanelOpen = false;
let exportModalOpen = false;
let exportMaxRows = 100000;
let exportFormat: ExportFormat = "parquet";
let exportBusy = false;
let lastExport: ExportResult | null = null;
let fileInfoOpen = false;
let columnSearch = "";
let newFilter: Filter = { column: "", op: "contains", value: "" };
let filterError = "";
let filterValueChosen = false;
// Last known grid scroll, preserved across re-renders (e.g. sorting, paging)
// so horizontal position doesn't jump back to 0.
let lastGridScroll = { top: 0, left: 0 };

const isMac = navigator.userAgent.toLowerCase().includes("mac");

try {
  recents = JSON.parse(localStorage.getItem("parquetpeek-recents") || "[]");
  if (!Array.isArray(recents)) recents = [];
} catch {
  recents = [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

function showToast(message: string, kind: Toast["kind"] = "success"): void {
  const id = ++toastSeq;
  toasts.push({ id, kind, message });
  if (toasts.length > 4) toasts = toasts.slice(-4);
  renderToasts();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    renderToasts();
  }, 4500);
}

async function copyText(value: string, label = "Copied to clipboard"): Promise<void> {
  try {
    await writeText(value);
    showToast(label);
  } catch (err) {
    showToast(`Copy failed: ${err}`, "error");
  }
}

function getTab(path: string | null): DatasetTab | null {
  if (!path) return null;
  return tabs.find((t) => t.info.path === path) || null;
}

function activeTab(): DatasetTab | null {
  return getTab(activePath);
}

function columnByName(tab: DatasetTab, name: string): ColumnInfo | undefined {
  return tab.info.columns.find((c) => c.name === name);
}

function persistRecents(): void {
  try {
    localStorage.setItem("parquetpeek-recents", JSON.stringify(recents.slice(0, 12)));
  } catch {
    /* storage unavailable */
  }
}

function rememberRecent(path: string): void {
  recents = [path, ...recents.filter((p) => p !== path)].slice(0, 12);
  persistRecents();
}

function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function opLabel(op: string): string {
  return FILTER_OPS.find((o) => o.value === op)?.label || op;
}

function opNeedsValue(op: string): boolean {
  return FILTER_OPS.find((o) => o.value === op)?.needsValue ?? true;
}

function opIsMulti(op: string): boolean {
  return FILTER_OPS.find((o) => o.value === op)?.multi ?? false;
}

function splitMultiInput(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function hasFilterValue(op: string, value: string): boolean {
  if (!opNeedsValue(op)) return true;
  if (opIsMulti(op)) return splitMultiInput(value).length > 0;
  return value.trim().length > 0;
}

function availableFilterOps(column?: ColumnInfo): typeof FILTER_OPS {
  if (column?.kind === "bool") return FILTER_OPS.filter((op) => ["eq", "ne", "is_null", "is_not_null"].includes(op.value));
  return FILTER_OPS;
}

function setFilterError(message: string): void {
  filterError = message;
  const error = document.getElementById("nf-error");
  if (error) error.textContent = message;
  const input = document.getElementById("nf-value") as HTMLInputElement | HTMLSelectElement | null;
  input?.setAttribute("aria-invalid", message ? "true" : "false");
  input?.setCustomValidity(message);
}

function rowJson(tab: DatasetTab, row: (string | null)[]): string {
  // Insert nested JSON directly so its numbers and containers survive copying.
  return `{\n${tab.pageColumns.map((name, i) => {
    const value = row[i] ?? null;
    const json = value !== null && columnByName(tab, name)?.kind === "nested" ? structuredJsonForCopy(value) : JSON.stringify(value);
    return `  ${JSON.stringify(name)}: ${json}`;
  }).join(",\n")}\n}`;
}

async function getColumnProfile(tab: DatasetTab, column: string): Promise<ColumnProfile> {
  const cached = tab.profileCache.get(column);
  if (cached) return cached;
  const pending = tab.profileRequests.get(column);
  if (pending) return pending;
  const request = invoke<ColumnProfile>("column_profile", { path: tab.info.path, column });
  tab.profileRequests.set(column, request);
  try {
    const profile = await request;
    tab.profileCache.set(column, profile);
    return profile;
  } catch (error) {
    tab.profileCache.set(column, null);
    throw error;
  } finally {
    tab.profileRequests.delete(column);
  }
}

async function ensureFilterProfile(tab: DatasetTab, column: ColumnInfo): Promise<void> {
  if (!["eq", "ne"].includes(newFilter.op) || !["text", "number", "date"].includes(column.kind) || tab.profileCache.has(column.name) || tab.profileRequests.has(column.name)) return;
  try {
    await getColumnProfile(tab, column.name);
    // Update only the value control; never replace an input the user is typing in.
    if (activeTab() === tab && filterPanelOpen && newFilter.column === column.name && document.activeElement?.id !== "nf-value") {
      const control = document.getElementById("nf-value-control");
      if (control) control.innerHTML = renderFilterValue(tab, column);
    }
  } catch {
    // Profiling is optional; a typed input remains available if it fails.
  }
}

function renderFilterValue(tab: DatasetTab, column: ColumnInfo): string {
  if (!opNeedsValue(newFilter.op)) return "";
  const comparison = isComparison(newFilter.op);
  const profile = tab.profileCache.get(column.name);
  const topValues = profile?.topValues.filter((top) => top.value !== null) || [];
  const completeValues = profile && profile.distinctCount > 0 && profile.distinctCount <= 15 && profile.distinctCount === topValues.length;
  const choices = comparison && column.kind === "bool" ? ["true", "false"]
    : ["eq", "ne"].includes(newFilter.op) && completeValues && column.kind !== "nested" ? topValues.map((top) => top.value as string) : null;
  const attrs = `id="nf-value" aria-label="Filter value" aria-describedby="nf-error" aria-invalid="${!!filterError}"`;
  if (choices) {
    const custom = (newFilter.value !== "" || filterValueChosen) && !choices.includes(newFilter.value) ? [newFilter.value] : [];
    return `<select ${attrs} data-change="nf-value-choice">
      <option value="" disabled ${newFilter.value === "" && !filterValueChosen ? "selected" : ""}>Choose value…</option>
      ${[...custom, ...choices].map((value) => `<option value="${escapeHtml(JSON.stringify(value))}" ${value === newFilter.value && (value !== "" || filterValueChosen) ? "selected" : ""}>${escapeHtml(value || "(empty string)")}</option>`).join("")}
    </select>`;
  }
  let type = filterInputType(column, newFilter.op);
  // Native time controls only represent milliseconds. Retain precise or
  // zoned values when editing a filter or selecting a value from a profile.
  if (comparison && column.kind === "date" && newFilter.value &&
      (/\.\d{4,}/.test(newFilter.value) || /infinity/i.test(newFilter.value) ||
       (type === "datetime-local" && /(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(newFilter.value)))) type = "text";
  const value = type === "datetime-local" ? newFilter.value.replace(" ", "T") : newFilter.value;
  const step = type === "number" ? `step="${isIntegerColumn(column) ? "1" : "any"}"` : ["time", "datetime-local"].includes(type) ? 'step="any"' : "";
  const placeholder = opIsMulti(newFilter.op) ? "Values, comma-separated…" : comparison && column.kind === "nested" ? "JSON value…" : comparison && column.dataType.startsWith("TIMESTAMP") ? "YYYY-MM-DD HH:MM:SS±HH:MM" : comparison && column.dataType === "INTERVAL" ? "e.g. 2 days" : "Value…";
  return `<input ${attrs} type="${type}" ${step} placeholder="${placeholder}" value="${escapeHtml(value)}" autocomplete="off" />`;
}

const EXPORT_FORMATS: { value: ExportFormat; label: string; ext: string }[] = [
  { value: "parquet", label: "Parquet", ext: "parquet" },
  { value: "csv", label: "CSV", ext: "csv" },
  { value: "json", label: "JSON", ext: "json" },
];

function exportExt(format: ExportFormat): string {
  return EXPORT_FORMATS.find((f) => f.value === format)?.ext || "parquet";
}

function timestampSuffix(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function defaultExportFileName(fileName: string, format: ExportFormat): string {
  const base = fileName.replace(/\.(parquet|pq)$/i, "") || "export";
  return `${base}-export-${timestampSuffix()}.${exportExt(format)}`;
}

// ---------------------------------------------------------------------------
// Backend calls
// ---------------------------------------------------------------------------

async function openFileByPath(path: string): Promise<void> {
  let info: DatasetInfo;
  try {
    info = await invoke<DatasetInfo>("open_dataset", { path });
  } catch (err) {
    recents = recents.filter((p) => p !== path);
    persistRecents();
    showToast(`Could not open file: ${err}`, "error");
    render();
    return;
  }
  rememberRecent(info.path);
  const existing = getTab(info.path);
  if (existing) {
    existing.info = info;
    existing.profileCache.clear();
    activePath = info.path;
  } else {
    tabs.push({
      info,
      visibleColumns: info.columns.map((c) => c.name),
      page: null,
      pageColumns: [],
      currentPage: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      sortColumn: null,
      sortDesc: false,
      filters: [],
      quickSearch: "",
      loading: true,
      error: null,
      requestId: 0,
      queryMs: null,
      selectedRow: null,
      profileColumn: null,
      profile: null,
      profileLoading: false,
      profileError: null,
      profileCache: new Map(),
      profileRequests: new Map(),
    });
    activePath = info.path;
  }
  const tab = getTab(info.path);
  if (tab) {
    if (!tab.visibleColumns.length) tab.visibleColumns = info.columns.map((c) => c.name);
    newFilter = {
      column: info.columns[0]?.name || "",
      op: defaultFilterOp(info.columns[0]),
      value: "",
    };
    filterError = "";
    filterValueChosen = false;
  }
  filterPanelOpen = false;
  render();
  await loadPage(info.path);
}

async function loadPage(path: string): Promise<void> {
  const tab = getTab(path);
  if (!tab || tab.visibleColumns.length === 0) return;
  for (const filter of tab.filters) {
    const column = columnByName(tab, filter.column);
    const error = column ? validateFilter(column, filter) : `Unknown column: ${filter.column}`;
    if (error) { showToast(error, "error"); return; }
  }
  const requestId = ++tab.requestId;
  tab.loading = true;
  tab.error = null;
  render();
  const args: QueryArgs = {
    path: tab.info.path,
    offset: (tab.currentPage - 1) * tab.pageSize,
    limit: tab.pageSize,
    columns: [...tab.visibleColumns],
    sortColumn: tab.sortColumn,
    sortDesc: tab.sortDesc,
    filters: tab.filters,
    quickSearch: tab.quickSearch,
  };
  const started = performance.now();
  try {
    const page = await invoke<PageResult>("fetch_page", { args });
    if (requestId !== tab.requestId) return;
    tab.page = page;
    tab.pageColumns = args.columns;
    tab.queryMs = Math.round(performance.now() - started);
    tab.currentPage = Math.floor(page.offset / page.limit) + 1;
    tab.selectedRow = null;
  } catch (err) {
    if (requestId !== tab.requestId) return;
    tab.error = String(err);
    tab.page = null;
    tab.pageColumns = [];
  } finally {
    if (requestId === tab.requestId) tab.loading = false;
    render();
  }
}

async function loadProfile(tab: DatasetTab, column: string): Promise<void> {
  tab.profileColumn = column;
  tab.profile = null;
  tab.profileError = null;
  tab.profileLoading = true;
  // Row and column panels are exclusive — showing a column clears row selection.
  tab.selectedRow = null;
  render();
  try {
    const profile = await getColumnProfile(tab, column);
    if (tab.profileColumn !== column) return;
    tab.profile = profile;
  } catch (err) {
    if (tab.profileColumn !== column) return;
    tab.profileError = String(err);
  } finally {
    if (tab.profileColumn === column) tab.profileLoading = false;
    render();
  }
}

async function chooseAndOpenFile(): Promise<void> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "Parquet", extensions: ["parquet", "pq"] }],
  });
  if (typeof selected === "string" && selected) {
    await openFileByPath(selected);
  }
}

async function createSampleFile(): Promise<void> {
  const dest = await save({
    defaultPath: "parquetpeek-sample.parquet",
    filters: [{ name: "Parquet", extensions: ["parquet"] }],
  });
  if (!dest) return;
  try {
    const info = await invoke<DatasetInfo>("generate_sample", { destination: dest });
    showToast(`Sample file created (${formatNumber(info.numRows)} rows)`);
    await openFileByPath(info.path);
  } catch (err) {
    showToast(`Could not create sample: ${err}`, "error");
  }
}

async function runExport(): Promise<void> {
  const tab = activeTab();
  if (!tab || exportBusy) return;
  for (const filter of tab.filters) {
    const column = columnByName(tab, filter.column);
    const error = column ? validateFilter(column, filter) : `Unknown column: ${filter.column}`;
    if (error) { showToast(error, "error"); return; }
  }
  const suggested = defaultExportFileName(tab.info.fileName, exportFormat);
  const dest = await save({
    defaultPath: suggested,
    filters: [
      { name: "Parquet", extensions: ["parquet"] },
      { name: "CSV", extensions: ["csv"] },
      { name: "JSON", extensions: ["json"] },
    ],
  });
  if (!dest) return;
  exportBusy = true;
  render();
  try {
    const result = await invoke<ExportResult>("export_data", {
      args: {
        path: tab.info.path,
        destination: dest,
        columns: tab.visibleColumns,
        sortColumn: tab.sortColumn,
        sortDesc: tab.sortDesc,
        filters: tab.filters,
        quickSearch: tab.quickSearch,
        maxRows: Math.max(1, Math.floor(exportMaxRows) || 100000),
        format: exportFormat,
      },
    });
    lastExport = result;
    showToast(`Exported ${formatNumber(result.exportedRows)} rows`);
  } catch (err) {
    showToast(`Export failed: ${err}`, "error");
  } finally {
    exportBusy = false;
    render();
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function kindBadge(col: ColumnInfo): string {
  const labels: Record<string, string> = {
    number: "#",
    text: "Aa",
    bool: "✓",
    date: "◷",
    other: "◇",
    nested: "{}",
  };
  return `<span class="kind-badge kind-${col.kind}" title="${escapeHtml(col.dataType)}">${labels[col.kind] || "◇"}</span>`;
}

function renderTitlebar(): string {
  const platform = isMac ? "macos" : "windows";
  return `
    <header class="titlebar" data-platform="${platform}" data-tauri-drag-region>
      <div class="titlebar-leading">
        <div class="brand-mark">${icon("table")}</div>
        <span class="titlebar-title">ParquetPeek</span>
        <span class="titlebar-sub">parquet viewer</span>
      </div>
      <div class="titlebar-trailing">
        <div class="window-controls">
          <button class="win-btn win-min" data-action="win-min" title="Minimize">${icon("minimize")}</button>
          <button class="win-btn win-max" data-action="win-max" title="Maximize">${icon("maximize")}</button>
          <button class="win-btn win-close" data-action="win-close" title="Close">${icon("close")}</button>
        </div>
      </div>
    </header>`;
}

function renderSidebar(tab: DatasetTab | null): string {
  const visibleCols = columnSearch.trim().toLowerCase();
  const schemaList = tab
    ? tab.info.columns.filter(
        (c) =>
          !visibleCols ||
          c.name.toLowerCase().includes(visibleCols) ||
          c.dataType.toLowerCase().includes(visibleCols)
      )
    : [];

  return `
    <aside class="sidebar">
      <div class="side-actions">
        <button class="btn-primary" data-action="open-file">${icon("upload")}<span>Open parquet</span><kbd>${isMac ? "⌘O" : "Ctrl+O"}</kbd></button>
        <button class="btn-ghost" data-action="make-sample" title="Generate a demo parquet file to explore">${icon("sparkles")}<span>Sample</span></button>
      </div>

      <div class="side-section">
        <div class="side-heading"><span>Open files</span><span class="count-pill">${tabs.length}</span></div>
        <div class="open-list">
          ${tabs.length === 0 ? `<div class="side-empty">No files open yet.</div>` : tabs.map((t) => `
            <button class="open-item ${t.info.path === activePath ? "active" : ""}" data-action="switch-tab" data-path="${escapeHtml(t.info.path)}" title="${escapeHtml(t.info.path)}">
              <span class="open-dot"></span>
              <span class="open-name">${escapeHtml(t.info.fileName)}</span>
              <span class="open-rows">${formatNumber(t.info.numRows)}</span>
              <span class="open-info" data-action="open-file-info" data-path="${escapeHtml(t.info.path)}" title="File details">${icon("info")}</span>
              <span class="open-close" data-action="close-tab" data-path="${escapeHtml(t.info.path)}" title="Close file">${icon("close")}</span>
            </button>`).join("")}
        </div>
      </div>

      ${tab ? `
      <div class="side-section side-schema">
        <div class="side-heading"><span>Schema · ${tab.visibleColumns.length}/${tab.info.columns.length}</span>
          <button class="link-btn" data-action="columns-reset" title="Show all columns">reset</button>
        </div>
        <div class="schema-search">${icon("search")}<input id="column-search" type="text" placeholder="Search columns…" value="${escapeHtml(columnSearch)}" autocomplete="off" /></div>
        <div class="schema-list">
          ${schemaList.map((c) => {
            const visible = tab.visibleColumns.includes(c.name);
            return `
            <div class="schema-row ${visible ? "" : "hidden-col"} ${tab.profileColumn === c.name ? "profiling" : ""}">
              <button class="eye-btn" data-action="toggle-column" data-col="${escapeHtml(c.name)}" title="${visible ? "Hide column" : "Show column"}">${icon(visible ? "eye" : "eye-off")}</button>
              <button class="schema-main" data-action="show-profile" data-col="${escapeHtml(c.name)}" title="${escapeHtml(c.dataType)}">
                ${kindBadge(c)}
                <span class="schema-name">${escapeHtml(c.name)}</span>
                <span class="schema-type">${escapeHtml(c.dataType)}</span>
              </button>
            </div>`;
          }).join("") || `<div class="side-empty">No columns match.</div>`}
        </div>
      </div>` : ""}

      <div class="side-section side-recents">
        <div class="side-heading"><span>${icon("clock")} Recent</span>
          ${recents.length ? `<button class="link-btn" data-action="clear-recents">clear</button>` : ""}
        </div>
        <div class="recent-list">
          ${recents.length === 0 ? `<div class="side-empty">Files you open will appear here.</div>` : recents.map((p) => `
            <button class="recent-item" data-action="open-recent" data-path="${escapeHtml(p)}" title="${escapeHtml(p)}">
              ${icon("file")}<span>${escapeHtml(baseName(p))}</span>
            </button>`).join("")}
        </div>
      </div>
    </aside>`;
}

function renderTabStrip(): string {
  if (tabs.length === 0) return "";
  return `
    <div class="tabstrip" role="tablist" aria-label="Open datasets">
      ${tabs.map((t) => `
        <button class="dataset-tab ${t.info.path === activePath ? "active" : ""}" data-action="switch-tab" data-path="${escapeHtml(t.info.path)}" role="tab" aria-selected="${t.info.path === activePath}">
          <span class="tab-file">${escapeHtml(t.info.fileName)}</span>
          <span class="tab-meta">${formatNumber(t.info.numRows)} rows · ${t.info.numColumns} cols</span>
          <span class="tab-info" data-action="open-file-info" data-path="${escapeHtml(t.info.path)}" title="File details">${icon("info")}</span>
          <span class="tab-close" data-action="close-tab" data-path="${escapeHtml(t.info.path)}" title="Close">${icon("close")}</span>
        </button>`).join("")}
    </div>`;
}

function renderToolbar(tab: DatasetTab): string {
  const activeFilterCount = tab.filters.length + (tab.quickSearch.trim() ? 1 : 0);
  return `
    <div class="toolbar">
      <div class="search-wrap">
        ${icon("search", "search-ic")}
        <input id="quick-search" type="text" placeholder="Search all text columns…  (${isMac ? "⌘K" : "Ctrl+K"})" value="${escapeHtml(tab.quickSearch)}" autocomplete="off" />
        ${tab.quickSearch ? `<button class="icon-btn" data-action="clear-search" title="Clear search">${icon("close")}</button>` : ""}
      </div>
      <div class="toolbar-actions">
        <button class="btn-tool ${filterPanelOpen || tab.filters.length ? "active" : ""}" data-action="toggle-filters">
          ${icon("filter")}<span>Filters</span>
          ${tab.filters.length ? `<span class="pill">${tab.filters.length}</span>` : ""}
        </button>
        <button class="btn-tool btn-apply" data-action="apply-filters" title="Apply search and filters">${icon("check")}<span>Apply</span></button>
        <button class="btn-tool btn-export" data-action="open-export" title="Export current view">${icon("download")}<span>Export</span></button>
        ${activeFilterCount ? `<button class="btn-tool btn-danger-ghost" data-action="reset-view" title="Clear search, filters and sorting">${icon("x-circle")}<span>Reset</span></button>` : ""}
      </div>
    </div>
    ${filterPanelOpen ? renderFilterPanel(tab) : ""}
    ${tab.filters.length && !filterPanelOpen ? `
      <div class="active-chips">
        ${tab.filters.map((f, i) => `
          <span class="chip"><strong>${escapeHtml(f.column)}</strong> ${escapeHtml(opLabel(f.op))}${opNeedsValue(f.op) ? ` <em>“${escapeHtml(f.value)}”</em>` : ""}
            <button data-action="edit-filter" data-index="${i}" title="Edit filter">${icon("pencil")}</button>
            <button data-action="remove-filter" data-index="${i}" title="Remove filter">${icon("close")}</button>
          </span>`).join("")}
      </div>` : ""}`;
}

function renderFilterPanel(tab: DatasetTab): string {
  const cols = tab.info.columns;
  if (!newFilter.column || !cols.some((c) => c.name === newFilter.column)) {
    newFilter.column = cols[0]?.name || "";
  }
  const column = columnByName(tab, newFilter.column) || cols[0];
  if (column) void ensureFilterProfile(tab, column);
  return `
    <div class="filter-panel">
      <div class="filter-list">
        ${tab.filters.map((f, i) => `
          <span class="chip static"><strong>${escapeHtml(f.column)}</strong> ${escapeHtml(opLabel(f.op))}${opNeedsValue(f.op) ? ` <em>“${escapeHtml(f.value)}”</em>` : ""}
            <button data-action="edit-filter" data-index="${i}" title="Edit filter">${icon("pencil")}</button>
            <button data-action="remove-filter" data-index="${i}" title="Remove filter">${icon("close")}</button>
          </span>`).join("") || `<div class="filter-hint">No column filters yet — add one below, then click Apply in the toolbar.</div>`}
      </div>
      <div class="filter-builder">
        <select id="nf-column" data-change="nf-column" aria-label="Filter column">
          ${cols.map((c) => `<option value="${escapeHtml(c.name)}" ${c.name === newFilter.column ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}
        </select>
        <select id="nf-op" data-change="nf-op" aria-label="Filter operator">
          ${availableFilterOps(column).map((o) => `<option value="${o.value}" ${o.value === newFilter.op ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}
        </select>
        <div id="nf-value-control" class="filter-value-control">${column ? renderFilterValue(tab, column) : ""}</div>
        <button class="icon-btn icon-btn-primary" data-action="add-filter" title="Add filter to the list" aria-label="Add filter">${icon("plus")}</button>
        <button class="icon-btn" data-action="clear-filter-builder" title="Clear filter value" aria-label="Clear filter value">${icon("close")}</button>
      </div>
      <div id="nf-error" class="filter-error" role="alert">${escapeHtml(filterError)}</div>
    </div>`;
}

function cellHtml(value: string | null, kind: string): string {
  if (value === null) return `<span class="null-badge">NULL</span>`;
  if (kind === "bool") {
    const truthy = /^(true|1|t|yes)$/i.test(value.trim());
    return `<span class="bool-pill ${truthy ? "on" : "off"}">${escapeHtml(value)}</span>`;
  }
  return `<span class="cell-text">${escapeHtml(value)}</span>`;
}

function renderGrid(tab: DatasetTab): string {
  // While a next page / sort / filter is loading, keep the current rows on
  // screen — the loading state lives in the footer. Only show the skeleton
  // on the very first load when there is nothing to display yet.
  if (tab.loading && (!tab.page || tab.page.rows.length === 0) && !tab.error) {
    return `
      <div class="grid-wrap loading">
        <div class="skeleton-head"></div>
        ${Array.from({ length: 12 }).map((_, i) => `<div class="skeleton-row" style="animation-delay:${i * 45}ms"></div>`).join("")}
      </div>`;
  }
  if (tab.error) {
    return `
      <div class="grid-empty">
        <div class="empty-art">${icon("x-circle")}</div>
        <h3>Couldn't read this file</h3>
        <p>${escapeHtml(tab.error)}</p>
        <button class="btn-primary" data-action="retry-page">${icon("refresh")}<span>Try again</span></button>
      </div>`;
  }
  const page = tab.page;
  if (!page || page.rows.length === 0) {
    return `
      <div class="grid-empty">
        <div class="empty-art">${icon("search")}</div>
        <h3>No rows match</h3>
        <p>Try widening the search or removing a filter.</p>
        <button class="btn-primary" data-action="reset-view">${icon("x-circle")}<span>Reset view</span></button>
      </div>`;
  }
  const cols = tab.pageColumns;
  const kinds = cols.map((c) => columnByName(tab, c)?.kind || "other");
  return `
    <div class="grid-scroll${tab.loading ? " is-loading" : ""}" id="grid-scroll">
      <table class="grid">
        <thead>
          <tr>
            <th class="rownum-col">#</th>
            ${cols.map((c, ci) => {
              const sorted = tab.sortColumn === c;
              return `
              <th class="data-col ${kinds[ci] === "number" ? "num" : ""} ${sorted ? "sorted" : ""}" data-col-index="${ci}">
                <button class="th-main" data-action="sort-col" data-col="${escapeHtml(c)}" title="Sort by ${escapeHtml(c)}">
                  <span class="th-name">${escapeHtml(c)}</span>
                  <span class="th-sort">${sorted ? icon(tab.sortDesc ? "sort-desc" : "sort-asc") : icon("sort")}</span>
                </button>
                <span class="th-type">${escapeHtml(columnByName(tab, c)?.dataType || "")}</span>
              </th>`;
            }).join("")}
          </tr>
        </thead>
        <tbody>
          ${page.rows.map((row, ri) => {
            const absolute = page.offset + ri + 1;
            return `
            <tr class="${tab.selectedRow === ri ? "selected" : ""}" data-action="select-row" data-row="${ri}">
              <td class="rownum-col">${formatNumber(absolute)}</td>
              ${row.map((value, ci) => `
                <td class="${kinds[ci] === "number" ? "num" : ""}" title="${value === null ? "NULL" : escapeHtml(value)}">${cellHtml(value, kinds[ci])}</td>`).join("")}
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;
}

function renderPagination(tab: DatasetTab): string {
  const total = tab.page?.totalRows ?? tab.info.numRows;
  const totalPages = Math.max(1, Math.ceil(total / tab.pageSize));
  const page = Math.min(tab.currentPage, totalPages);
  const start = total === 0 ? 0 : (page - 1) * tab.pageSize + 1;
  const end = Math.min(page * tab.pageSize, total);
  const busy = tab.loading;
  return `
    <div class="statusbar">
      <div class="page-controls">
        <button class="icon-btn" data-action="goto-page" data-page="1" ${page <= 1 || busy ? "disabled" : ""} title="First page">${icon("chevrons-left")}</button>
        <button class="icon-btn" data-action="goto-page" data-page="${page - 1}" ${page <= 1 || busy ? "disabled" : ""} title="Previous page">${icon("chevron-left")}</button>
        <span class="page-info">Rows <strong>${formatNumber(start)}–${formatNumber(end)}</strong> of <strong>${formatNumber(total)}</strong></span>
        <button class="icon-btn" data-action="goto-page" data-page="${page + 1}" ${page >= totalPages || busy ? "disabled" : ""} title="Next page">${icon("chevron-right")}</button>
        <button class="icon-btn" data-action="goto-page" data-page="${totalPages}" ${page >= totalPages || busy ? "disabled" : ""} title="Last page">${icon("chevrons-right")}</button>
      </div>
      <div class="status-center">${busy ? `<span class="status-loading"><span class="spinner"></span><span>Loading…</span></span>` : ""}</div>
      <div class="status-meta">
        <span class="meta-chip">page ${formatNumber(page)} / ${formatNumber(totalPages)}</span>
        <label class="pagesize">rows
          <select data-change="page-size" ${busy ? "disabled" : ""}>
            ${PAGE_SIZES.map((s) => `<option value="${s}" ${s === tab.pageSize ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </label>
        <span class="meta-chip">${formatBytes(tab.info.fileSize)}</span>
      </div>
    </div>`;
}

function renderMain(tab: DatasetTab | null): string {
  if (!tab) {
    return `
    <main class="main hero-wrap">
      <div class="hero" id="drop-hero">
        <h1>Drop a <em>parquet</em> file<br/>to peek inside</h1>
        <p>Open and explore parquet files right on your machine — filter, sort and export with ease.</p>
        <div class="hero-actions">
          <button class="btn-primary btn-lg" data-action="open-file">${icon("upload")}<span>Open parquet file</span></button>
          <button class="btn-ghost btn-lg" data-action="make-sample">${icon("sparkles")}<span>Try a sample file</span></button>
        </div>
        ${recents.length ? `
        <div class="hero-recents">
          <div class="hero-recents-title">${icon("clock")} Jump back in</div>
          ${recents.slice(0, 5).map((p) => `
            <button class="hero-recent" data-action="open-recent" data-path="${escapeHtml(p)}" title="${escapeHtml(p)}">
              ${icon("file")}<span>${escapeHtml(baseName(p))}</span>
            </button>`).join("")}
        </div>` : ""}
      </div>
    </main>`;
  }
  return `
    <main class="main">
      ${renderTabStrip()}
      ${renderToolbar(tab)}
      ${renderGrid(tab)}
      ${renderPagination(tab)}
    </main>`;
}

function renderDrawer(tab: DatasetTab | null): string {
  if (!tab) return "";
  const hasRow = tab.selectedRow !== null && tab.page?.rows[tab.selectedRow];
  const hasProfile = tab.profileColumn !== null;
  if (!hasRow && !hasProfile) return "";

  if (hasRow) {
    const ri = tab.selectedRow as number;
    const row = (tab.page as PageResult).rows[ri];
    const absolute = (tab.page as PageResult).offset + ri + 1;
    const pairs = tab.pageColumns.map((c, ci) => ({ name: c, value: row[ci] ?? null, kind: columnByName(tab, c)?.kind || "other", type: columnByName(tab, c)?.dataType || "" }));
    const json = rowJson(tab, row);
    return `
    <aside class="drawer">
      <div class="drawer-header">
        <span class="drawer-title">Row ${formatNumber(absolute)}</span>
        <button class="icon-btn drawer-close" data-action="close-drawer" title="Close panel (Esc)">${icon("close")}</button>
      </div>
      <div class="drawer-body">
        <button class="btn-ghost btn-sm drawer-copy" data-action="copy-row-json">${icon("copy")}<span>Copy row as JSON</span></button>
        ${pairs.map((p, ci) => `
          <div class="kv">
            <div class="kv-head">
              <span class="kv-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
              <span class="kv-type">${escapeHtml(p.type)}</span>
              <button class="mini-btn" data-action="copy-cell" data-row="${ri}" data-ci="${ci}" title="Copy value">${icon("copy")}</button>
            </div>
            <div class="kv-value ${p.value === null ? "is-null" : ""} ${p.kind === "nested" ? "is-structured" : ""}">${p.value === null ? "NULL" : p.kind === "nested" ? structuredCellHtml(p.value) : escapeHtml(p.value)}</div>
          </div>`).join("")}
        <div class="kv json-block"><div class="kv-head"><span class="kv-name">JSON</span></div><pre>${escapeHtml(json)}</pre></div>
      </div>
    </aside>`;
  }

  // Column details view (single panel, no tabs)
  const col = tab.profileColumn as string;
  const info = columnByName(tab, col);
  const profile = tab.profile;
  const maxCount = Math.max(1, ...(profile?.topValues.map((t) => t.count) || [1]));
  return `
    <aside class="drawer">
      <div class="drawer-header">
        <span class="drawer-title" title="${escapeHtml(col)}">Column · ${escapeHtml(col)}</span>
        <button class="icon-btn drawer-close" data-action="close-drawer" title="Close panel (Esc)">${icon("close")}</button>
      </div>
      <div class="drawer-body">
        <div class="prof-head">
          ${info ? kindBadge(info) : ""}
          <div><div class="prof-name">${escapeHtml(col)}</div><div class="prof-type">${escapeHtml(info?.dataType || "")}</div></div>
        </div>
        ${tab.profileLoading ? `<div class="prof-loading"><span class="spinner"></span> Loading…</div>` : ""}
        ${tab.profileError ? `<div class="prof-error">${escapeHtml(tab.profileError)}</div>` : ""}
        ${profile ? `
          <div class="stat-grid">
            <div class="stat"><span class="stat-num">${formatNumber(profile.nonNullCount)}</span><span class="stat-label">filled</span></div>
            <div class="stat"><span class="stat-num warn">${formatNumber(profile.nullCount)}</span><span class="stat-label">empty</span></div>
            <div class="stat"><span class="stat-num accent">${formatNumber(profile.distinctCount)}</span><span class="stat-label">distinct</span></div>
          </div>
          <div class="minmax">
            <div><span>min</span><strong>${profile.min === null || profile.min === undefined ? "—" : escapeHtml(profile.min)}</strong></div>
            <div><span>max</span><strong>${profile.max === null || profile.max === undefined ? "—" : escapeHtml(profile.max)}</strong></div>
          </div>
          <div class="tops-title">Top values</div>
          <div class="tops">
            ${profile.topValues.map((t) => `
              <button class="top-row" data-action="filter-top-value" data-col="${escapeHtml(col)}" data-value="${escapeHtml(t.value ?? "")}" data-null="${t.value === null ? "1" : ""}" title="Filter to this value">
                <span class="top-value">${t.value === null ? "<i>NULL</i>" : escapeHtml(t.value.length > 40 ? t.value.slice(0, 40) + "…" : t.value)}</span>
                <span class="top-bar"><span style="width:${Math.max(3, Math.round((t.count / maxCount) * 100))}%"></span></span>
                <span class="top-count">${formatNumber(t.count)}</span>
              </button>`).join("") || `<div class="side-empty">No values.</div>`}
          </div>` : ""}
      </div>
    </aside>`;
}

function renderFileInfoModal(tab: DatasetTab | null): string {
  if (!fileInfoOpen || !tab) return "";
  const info = tab.info;
  return `
    <div class="overlay" data-action="close-modals">
      <div class="modal modal-sm" role="dialog" aria-modal="true" data-modal-card>
        <div class="modal-head">
          <div class="modal-title">${icon("info")}<span>File details</span></div>
          <button class="icon-btn" data-action="close-file-info" title="Close">${icon("close")}</button>
        </div>
        <div class="modal-body">
          <div class="file-title">${icon("file")}<strong>${escapeHtml(info.fileName)}</strong></div>
          <div class="file-path">${escapeHtml(info.path)}</div>
          <div class="modal-actions-row">
            <button class="btn-ghost btn-sm" data-action="reveal-file">${icon("folder")}<span>Reveal</span></button>
            <button class="btn-ghost btn-sm" data-action="open-external">${icon("external")}<span>Open externally</span></button>
          </div>
          <div class="stat-grid stat-grid-3">
            <div class="stat"><span class="stat-num">${formatNumber(info.numRows)}</span><span class="stat-label">rows</span></div>
            <div class="stat"><span class="stat-num">${info.numColumns}</span><span class="stat-label">columns</span></div>
            <div class="stat"><span class="stat-num">${formatBytes(info.fileSize)}</span><span class="stat-label">size</span></div>
          </div>
        </div>
      </div>
    </div>`;
}

function renderExportModal(tab: DatasetTab | null): string {
  if (!exportModalOpen || !tab) return "";
  const filtered = tab.filters.length > 0 || tab.quickSearch.trim() !== "";
  return `
    <div class="overlay" data-action="close-modals">
      <div class="modal modal-sm" role="dialog" aria-modal="true" data-modal-card>
        <div class="modal-head">
          <div class="modal-title">${icon("download")}<span>Export</span></div>
          <button class="icon-btn" data-action="close-modals">${icon("close")}</button>
        </div>
        <div class="modal-body">
          <p class="modal-desc">Exports the <strong>${tab.visibleColumns.length} visible columns</strong>${filtered ? " with your <strong>filters applied</strong>" : ""}${tab.sortColumn ? ` ordered by <strong>${escapeHtml(tab.sortColumn)}</strong>` : ""}.</p>
          <label class="field-label">Format</label>
          <div class="export-formats" role="radiogroup" aria-label="Export format">
            ${EXPORT_FORMATS.map((f) => `
              <label class="export-format ${exportFormat === f.value ? "selected" : ""}">
                <input type="radio" name="export-format" value="${f.value}" data-change="export-format" ${exportFormat === f.value ? "checked" : ""} />
                <span>${f.label}</span>${f.value === "parquet" ? `<em class="default-tag">default</em>` : ""}
              </label>`).join("")}
          </div>
          <label class="field-label" for="export-max">Max rows</label>
          <input id="export-max" type="number" min="1" max="10000000" value="${exportMaxRows}" />
          <p class="modal-desc muted">File name will default to include the current date-time, e.g. <strong>${escapeHtml(defaultExportFileName(tab.info.fileName, exportFormat))}</strong>.</p>
          ${lastExport ? `
          <div class="export-done">
            <div class="export-done-title">${icon("check")} Wrote ${formatNumber(lastExport.exportedRows)} rows</div>
            <div class="export-done-path">${escapeHtml(lastExport.destination)}</div>
            <div class="modal-actions-row">
              <button class="btn-ghost btn-sm" data-action="reveal-export">${icon("folder")}<span>Reveal</span></button>
              <button class="btn-ghost btn-sm" data-action="open-export-file">${icon("external")}<span>Open</span></button>
            </div>
          </div>` : ""}
        </div>
        <div class="modal-foot">
          <button class="btn-ghost" data-action="close-modals">Cancel</button>
          <button class="btn-primary" data-action="run-export" ${exportBusy ? "disabled" : ""}>${exportBusy ? `<span class="spinner"></span><span>Exporting…</span>` : `${icon("download")}<span>Choose location & export</span>`}</button>
        </div>
      </div>
    </div>`;
}

function renderToasts(): void {
  const host = document.getElementById("toasts");
  if (!host) return;
  host.innerHTML = toasts
    .map(
      (t) => `
      <div class="toast ${t.kind}">
        <span class="toast-ic">${icon(t.kind === "success" ? "check" : t.kind === "error" ? "x-circle" : "info")}</span>
        <span>${escapeHtml(t.message)}</span>
        <button data-action="dismiss-toast" data-id="${t.id}">${icon("close")}</button>
      </div>`
    )
    .join("");
}

function render(): void {
  const app = document.getElementById("app");
  if (!app) return;
  // Preserve focus + grid scroll across re-renders.
  // NOTE: during loading there is no #grid-scroll element — keep the last
  // known offsets instead of resetting to 0, so sorting/paging doesn't
  // jump the horizontal scrollbar back to the start.
  const active = document.activeElement as HTMLInputElement | null;
  const focusId = active?.id || null;
  const selStart = active?.selectionStart ?? null;
  const selEnd = active?.selectionEnd ?? null;
  const grid = document.getElementById("grid-scroll");
  if (grid) {
    lastGridScroll = { top: grid.scrollTop, left: grid.scrollLeft };
  }

  const tab = activeTab();
  app.innerHTML = `
    ${renderTitlebar()}
    <div class="shell">
      ${renderSidebar(tab)}
      ${renderMain(tab)}
      ${renderDrawer(tab)}
    </div>
    ${renderFileInfoModal(tab)}
    ${renderExportModal(tab)}
    <div id="toasts" class="toasts"></div>`;

  renderToasts();
  if (focusId) {
    const next = document.getElementById(focusId) as HTMLInputElement | null;
    if (next) {
      next.focus();
      try {
        if (selStart !== null && next.type !== "number") next.setSelectionRange(selStart, selEnd ?? selStart);
      } catch {
        /* ignore */
      }
    }
  }
  const nextGrid = document.getElementById("grid-scroll");
  if (nextGrid) {
    nextGrid.scrollTop = lastGridScroll.top;
    nextGrid.scrollLeft = lastGridScroll.left;
  }
}

// ---------------------------------------------------------------------------
// Events (delegation — the DOM is fully re-rendered on state changes)
// ---------------------------------------------------------------------------

const debouncedColumnSearch = debounce(() => render(), 200);

async function handleAction(el: HTMLElement): Promise<void> {
  const action = el.dataset.action;
  if (!action) return;
  const tab = activeTab();

  switch (action) {
    case "win-min":
      await invoke("window_minimize").catch(() => undefined);
      break;
    case "win-max":
      await invoke("window_maximize").catch(() => undefined);
      break;
    case "win-close":
      await invoke("window_close").catch(() => undefined);
      break;
    case "open-file":
      await chooseAndOpenFile();
      break;
    case "make-sample":
      await createSampleFile();
      break;
    case "open-recent":
      if (el.dataset.path) await openFileByPath(el.dataset.path);
      break;
    case "clear-recents":
      recents = [];
      persistRecents();
      render();
      break;
    case "switch-tab":
      if (el.dataset.path && el.dataset.path !== activePath) {
        activePath = el.dataset.path;
        const next = activeTab();
        if (next) {
          newFilter = { column: next.info.columns[0]?.name || "", op: defaultFilterOp(next.info.columns[0]), value: "" };
          filterError = "";
          filterValueChosen = false;
          filterPanelOpen = false;
          render();
          if (!next.page && !next.loading) await loadPage(next.info.path);
        }
      }
      break;
    case "close-tab": {
      const path = el.dataset.path;
      if (!path) break;
      tabs = tabs.filter((t) => t.info.path !== path);
      if (activePath === path) {
        activePath = tabs.length ? tabs[tabs.length - 1].info.path : null;
        const next = activeTab();
        newFilter = { column: next?.info.columns[0]?.name || "", op: defaultFilterOp(next?.info.columns[0]), value: "" };
        filterError = "";
        filterValueChosen = false;
        filterPanelOpen = false;
      }
      render();
      break;
    }
    case "toggle-column":
      if (tab && el.dataset.col) {
        const col = el.dataset.col;
        if (tab.visibleColumns.includes(col)) {
          if (tab.visibleColumns.length <= 1) {
            showToast("Keep at least one column visible", "info");
            break;
          }
          tab.visibleColumns = tab.visibleColumns.filter((c) => c !== col);
          if (tab.sortColumn === col) tab.sortColumn = null;
        } else {
          const order = tab.info.columns.map((c) => c.name);
          tab.visibleColumns = [...tab.visibleColumns, col].sort(
            (a, b) => order.indexOf(a) - order.indexOf(b)
          );
        }
        tab.currentPage = 1;
        render();
        await loadPage(tab.info.path);
      }
      break;
    case "columns-reset":
      if (tab) {
        tab.visibleColumns = tab.info.columns.map((c) => c.name);
        tab.currentPage = 1;
        render();
        await loadPage(tab.info.path);
      }
      break;
    case "sort-col":
      if (tab && el.dataset.col) {
        const col = el.dataset.col;
        if (tab.sortColumn !== col) {
          tab.sortColumn = col;
          tab.sortDesc = false;
        } else if (!tab.sortDesc) {
          tab.sortDesc = true;
        } else {
          tab.sortColumn = null;
          tab.sortDesc = false;
        }
        tab.currentPage = 1;
        await loadPage(tab.info.path);
      }
      break;
    case "toggle-filters":
      filterPanelOpen = !filterPanelOpen;
      render();
      break;
    case "add-filter": {
      if (!tab) break;
      const column = newFilter.column || tab.info.columns[0]?.name || "";
      if (!column) break;
      const info = columnByName(tab, column);
      if (!info) break;
      const input = document.getElementById("nf-value") as HTMLInputElement | HTMLSelectElement | null;
      const error = input instanceof HTMLSelectElement && !input.value ? "Choose a filter value first." : validateFilter(info, { ...newFilter, column });
      setFilterError(error || "");
      if (error || (input && !input.checkValidity())) {
        if (!error && input) setFilterError(input.validationMessage);
        input?.reportValidity();
        break;
      }
      // Stage only — nothing is queried until Apply is clicked.
      tab.filters.push({ column, op: newFilter.op, value: newFilter.value });
      newFilter = { column, op: defaultFilterOp(info), value: "" };
      filterValueChosen = false;
      tab.currentPage = 1;
      render();
      break;
    }
    case "apply-filters": {
      if (!tab) break;
      // Explicit Apply: never stages the pending builder row — it only
      // queries with the already-added filter chips + search text.
      // Warn when a pending builder value would otherwise be silently ignored
      // (the common "typed values but forgot +" confusion).
      const pendingColumn = newFilter.column || tab.info.columns[0]?.name || "";
      if (!!pendingColumn && (filterValueChosen || hasFilterValue(newFilter.op, newFilter.value))) {
        showToast("Pending filter not added — click + to add it first", "info");
      }
      tab.currentPage = 1;
      await loadPage(tab.info.path);
      break;
    }
    case "clear-filter-builder": {
      if (!tab) break;
      newFilter = {
        column: tab.info.columns[0]?.name || newFilter.column,
        op: defaultFilterOp(tab.info.columns[0]),
        value: "",
      };
      filterError = "";
      filterValueChosen = false;
      render();
      break;
    }
    case "remove-filter":
      if (tab) {
        const idx = Number(el.dataset.index);
        tab.filters = tab.filters.filter((_, i) => i !== idx);
        tab.currentPage = 1;
        render();
      }
      break;
    case "edit-filter": {
      if (!tab) break;
      const idx = Number(el.dataset.index);
      const f = tab.filters[idx];
      if (!f) break;
      // Load the chip back into the builder for editing; drop the original
      // so clicking + re-stages the edited version. Staged only — Apply runs it.
      const colExists = tab.info.columns.some((c) => c.name === f.column);
      newFilter = {
        column: colExists ? f.column : tab.info.columns[0]?.name || "",
        op: f.op,
        value: f.value,
      };
      filterError = "";
      filterValueChosen = true;
      tab.filters = tab.filters.filter((_, i) => i !== idx);
      tab.currentPage = 1;
      filterPanelOpen = true;
      render();
      const focusEl =
        (opNeedsValue(newFilter.op) && document.getElementById("nf-value")) ||
        document.getElementById("nf-op");
      (focusEl as HTMLInputElement | HTMLSelectElement | null)?.focus?.();
      break;
    }
    case "clear-search":
      if (tab) {
        tab.quickSearch = "";
        tab.currentPage = 1;
        render();
      }
      break;
    case "reset-view":
      if (tab) {
        tab.filters = [];
        tab.quickSearch = "";
        tab.sortColumn = null;
        tab.sortDesc = false;
        tab.currentPage = 1;
        filterPanelOpen = false;
        await loadPage(tab.info.path);
      }
      break;
    case "goto-page":
      if (tab) {
        const total = tab.page?.totalRows ?? tab.info.numRows;
        const totalPages = Math.max(1, Math.ceil(total / tab.pageSize));
        tab.currentPage = Math.min(Math.max(1, Number(el.dataset.page) || 1), totalPages);
        await loadPage(tab.info.path);
      }
      break;
    case "retry-page":
      if (tab) await loadPage(tab.info.path);
      break;
    case "select-row":
      if (tab) {
        const ri = Number(el.dataset.row);
        tab.selectedRow = tab.selectedRow === ri ? null : ri;
        if (tab.selectedRow !== null) {
          // Row and column panels are exclusive — no tabs.
          tab.profileColumn = null;
          tab.profile = null;
          tab.profileError = null;
          tab.profileLoading = false;
        }
        render();
      }
      break;
    case "close-drawer":
      if (tab) {
        tab.selectedRow = null;
        tab.profileColumn = null;
        tab.profile = null;
        render();
      }
      break;
    case "show-profile":
      if (tab && el.dataset.col) {
        await loadProfile(tab, el.dataset.col);
      }
      break;
    case "filter-top-value":
      if (tab && el.dataset.col) {
        const isNull = el.dataset.null === "1";
        tab.filters.push({
          column: el.dataset.col,
          op: isNull ? "is_null" : "eq",
          value: isNull ? "" : el.dataset.value || "",
        });
        tab.currentPage = 1;
        filterPanelOpen = true;
        render();
        showToast("Filter added — click Apply to run it", "info");
      }
      break;
    case "copy-cell": {
      if (!tab || tab.selectedRow === null || !tab.page) break;
      const ri = Number(el.dataset.row);
      const ci = Number(el.dataset.ci);
      const rows = tab.page.rows;
      // Fall back to the currently selected row when indices are missing.
      const rowIdx = Number.isFinite(ri) ? ri : tab.selectedRow;
      const val = rows[rowIdx]?.[ci] ?? null;
      if (val === null) await copyText("NULL");
      else await copyText(columnByName(tab, tab.pageColumns[ci])?.kind === "nested" ? structuredJsonForCopy(val) : val);
      break;
    }
    case "copy-row-json": {
      if (tab && tab.selectedRow !== null && tab.page) {
        const row = tab.page.rows[tab.selectedRow];
        await copyText(rowJson(tab, row), "Row copied as JSON");
      }
      break;
    }
    case "json-more": {
      const details = el.closest<HTMLDetailsElement>("details.json-node");
      if (details) populateJsonNode(details, true);
      break;
    }
    case "open-file-info": {
      const targetPath = el.dataset.path || null;
      if (targetPath && targetPath !== activePath && getTab(targetPath)) {
        activePath = targetPath;
        const next = activeTab();
        if (next) {
          newFilter = { column: next.info.columns[0]?.name || "", op: defaultFilterOp(next.info.columns[0]), value: "" };
          filterError = "";
          filterValueChosen = false;
        }
      }
      if (!activeTab()) break;
      fileInfoOpen = true;
      render();
      break;
    }
    case "open-export":
      lastExport = null;
      exportFormat = "parquet";
      exportModalOpen = true;
      render();
      break;
    case "run-export":
      await runExport();
      break;
    case "reveal-file":
      if (tab) {
        try {
          await invoke("reveal_path", { path: tab.info.path });
        } catch (e) {
          showToast(String(e), "error");
        }
      }
      break;
    case "open-external":
      if (tab) {
        try {
          await invoke("open_external", { path: tab.info.path });
        } catch (e) {
          showToast(String(e), "error");
        }
      }
      break;
    case "reveal-export":
      if (lastExport) {
        try {
          await invoke("reveal_path", { path: lastExport.destination });
        } catch (e) {
          showToast(String(e), "error");
        }
      }
      break;
    case "open-export-file":
      if (lastExport) {
        try {
          await invoke("open_external", { path: lastExport.destination });
        } catch (e) {
          showToast(String(e), "error");
        }
      }
      break;
    case "close-modals":
    case "close-file-info":
      fileInfoOpen = false;
      exportModalOpen = false;
      render();
      break;
    case "dismiss-toast": {
      const id = Number(el.dataset.id);
      toasts = toasts.filter((t) => t.id !== id);
      renderToasts();
      break;
    }
  }
}

function setupEvents(): void {
  const app = document.getElementById("app");
  if (!app) return;

  app.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
    if (!target || !app.contains(target)) return;
    // Clicks on the overlay backdrop (outside the modal card) close the modal.
    // Clicks inside the card must NOT bubble up to the overlay handler:
    // only treat it as an overlay click when the action element itself is
    // the overlay. Explicit close buttons (close-modals / close-file-info)
    // always run.
    if (
      target.dataset.action === "close-modals" &&
      target.classList.contains("overlay") &&
      (e.target as HTMLElement).closest("[data-modal-card]")
    ) {
      return;
    }
    // Nested action (tab close inside tab switch): run the innermost only.
    e.stopPropagation();
    void handleAction(target);
  });

  app.addEventListener("input", (e) => {
    const target = e.target as HTMLInputElement;
    const tab = activeTab();
    if (target.id === "quick-search" && tab) {
      // Staged — no query while typing. Click Apply to run.
      tab.quickSearch = target.value;
      tab.currentPage = 1;
    } else if (target.id === "column-search") {
      columnSearch = target.value;
      debouncedColumnSearch();
    } else if (target.id === "nf-value") {
      if (target instanceof HTMLSelectElement) return;
      newFilter.value = target.value;
      filterValueChosen = true;
      setFilterError("");
    } else if (target.id === "export-max") {
      exportMaxRows = Number(target.value) || exportMaxRows;
    }
  });

  app.addEventListener("change", (e) => {
    const target = e.target as HTMLInputElement | HTMLSelectElement;
    const kind = (target as HTMLElement).dataset.change;
    if (!kind) return;
    const tab = activeTab();
    if (kind === "nf-column") {
      newFilter.column = target.value;
      newFilter.op = defaultFilterOp(tab ? columnByName(tab, target.value) : undefined);
      newFilter.value = "";
      filterError = "";
      filterValueChosen = false;
      render();
    } else if (kind === "nf-op") {
      newFilter.op = target.value as FilterOp;
      newFilter.value = "";
      filterError = "";
      filterValueChosen = false;
      render();
    } else if (kind === "nf-value-choice") {
      newFilter.value = target.value ? JSON.parse(target.value) as string : "";
      filterValueChosen = !!target.value;
      setFilterError("");
    } else if (kind === "export-format") {
      const v = target.value as ExportFormat;
      if (v === "csv" || v === "json" || v === "parquet") {
        exportFormat = v;
        render();
      }
    } else if (kind === "page-size" && tab) {
      tab.pageSize = Number(target.value) || DEFAULT_PAGE_SIZE;
      tab.currentPage = 1;
      void loadPage(tab.info.path);
    }
  });

  app.addEventListener("toggle", (e) => {
    const details = e.target;
    if (details instanceof HTMLDetailsElement && details.open && details.classList.contains("json-node")) populateJsonNode(details);
  }, true);

  app.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
      e.preventDefault();
      void chooseAndOpenFile();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      document.getElementById("quick-search")?.focus();
    } else if (e.key === "Escape") {
      if (fileInfoOpen || exportModalOpen) {
        fileInfoOpen = false;
        exportModalOpen = false;
        render();
      } else {
        const tab = activeTab();
        if (tab && (tab.selectedRow !== null || tab.profileColumn !== null)) {
          tab.selectedRow = null;
          tab.profileColumn = null;
          render();
        }
      }
    } else if (e.key === "Enter" && !typing) {
      /* noop */
    }
  });

  // Desktop drag & drop of parquet files.
  getCurrentWebview()
    .onDragDropEvent((event) => {
      if (event.payload.type === "drop" && event.payload.paths.length > 0) {
        const first = event.payload.paths[0];
        if (/\.parquet$|\.pq$/i.test(first)) {
          void openFileByPath(first);
        } else {
          showToast("Only .parquet files can be opened", "error");
        }
      }
    })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init(): void {
  render();
  setupEvents();
  // If launched with a file path (e.g. "open with"), Tauri passes it as argv —
  // best effort: try to surface it via recents. Direct argv handling happens
  // in the opener flow, so here we simply present the hero state.
}

document.addEventListener("DOMContentLoaded", init);
if (document.readyState !== "loading") init();
