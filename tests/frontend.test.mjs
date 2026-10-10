import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

// Run the real frontend functions with mocked desktop APIs and no mounted DOM.
// Pending invokes let us inspect the UI while a replacement page is loading.
function frontend() {
  const requests = [];
  const copied = [];
  const context = vm.createContext({
    navigator: { userAgent: "Mac" },
    localStorage: { getItem: () => null },
    document: { readyState: "loading", addEventListener() {}, getElementById: () => null },
    performance,
    setTimeout: () => 0,
    console,
  });
  const modules = new Map();
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const source = readFileSync(fileURLToPath(new URL(`../src/${name}.ts`, import.meta.url)), "utf8");
    const code = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const module = { exports: {} };
    const bridge = name === "main" ? `
      module.exports.testing = {
        renderGrid, renderDrawer, rowJson, handleAction, loadPage,
        useTab(tab) { tabs = [tab]; activePath = tab.info.path; }
      };
    ` : "";
    const require = (id) => {
      if (id === "@tauri-apps/api/core") return {
        invoke(command, args) {
          return new Promise((resolve, reject) => requests.push({ command, args, resolve, reject }));
        },
      };
      if (id === "@tauri-apps/plugin-clipboard-manager") return {
        writeText: async (value) => { copied.push(value); },
      };
      if (id === "./icons") return { icon: () => "" };
      if (id === "./filters" || id === "./structured") return load(id.slice(2));
      return {};
    };
    vm.runInContext(`(function(require, module, exports) { ${code}\n${bridge}\n})`, context)(require, module, module.exports);
    modules.set(name, module.exports);
    return module.exports;
  }
  return { ...load("main").testing, requests, copied };
}

function dataset() {
  return {
    info: {
      path: "/test.parquet", numRows: 1,
      columns: [
        { name: "id", kind: "number", dataType: "BIGINT" },
        { name: "name", kind: "text", dataType: "VARCHAR" },
        { name: "details", kind: "nested", dataType: "STRUCT(value BIGINT)" },
      ],
    },
    visibleColumns: ["id", "name", "details"],
    pageColumns: ["id", "name", "details"],
    page: { rows: [["123", "Alice", '{"value":9007199254740993}']], offset: 0, limit: 100, totalRows: 1 },
    currentPage: 1, pageSize: 100, sortColumn: null, sortDesc: false,
    filters: [], quickSearch: "", loading: false, error: null,
    requestId: 0, selectedRow: 0, profileColumn: null,
  };
}

test("column changes preserve grid, drawer and copy mappings until the new page arrives", async () => {
  const ui = frontend();
  const tab = dataset();
  ui.useTab(tab);
  const loading = ui.handleAction({ dataset: { action: "toggle-column", col: "id" } });
  assert.equal(tab.loading, true);
  assert.equal(tab.visibleColumns.join(","), "name,details");
  assert.equal(ui.requests[0].args.args.columns.join(","), "name,details");
  assert.match(ui.renderGrid(tab), /th-name">id</);
  assert.match(ui.renderDrawer(tab), /kv-name" title="id">id</);
  assert.equal(ui.rowJson(tab, tab.page.rows[0]), '{\n  "id": "123",\n  "name": "Alice",\n  "details": {"value":9007199254740993}\n}');
  await ui.handleAction({ dataset: { action: "copy-row-json" } });
  assert.equal(ui.copied[0], ui.rowJson(tab, tab.page.rows[0]));
  await ui.handleAction({ dataset: { action: "copy-cell", row: "0", ci: "2" } });
  assert.equal(ui.copied[1], '{"value":9007199254740993}');

  ui.requests[0].resolve({ rows: [["Alice", '{"value":9007199254740993}']], offset: 0, limit: 100, totalRows: 1 });
  await loading;
  assert.equal(tab.loading, false);
  assert.equal(tab.pageColumns.join(","), "name,details");
  assert.doesNotMatch(ui.renderGrid(tab), /th-name">id</);
  assert.equal(ui.rowJson(tab, tab.page.rows[0]), '{\n  "name": "Alice",\n  "details": {"value":9007199254740993}\n}');
});

test("a superseded page cannot overwrite the latest column mapping", async () => {
  const ui = frontend();
  const tab = dataset();
  ui.useTab(tab);
  const hidden = ui.handleAction({ dataset: { action: "toggle-column", col: "id" } });
  const restored = ui.handleAction({ dataset: { action: "columns-reset" } });
  ui.requests[1].resolve(tab.page);
  await restored;
  ui.requests[0].resolve({ rows: [["Alice", '{}']], offset: 0, limit: 100, totalRows: 1 });
  await hidden;
  assert.equal(tab.pageColumns.join(","), "id,name,details");
  assert.equal(tab.page.rows[0][0], "123");
});

test("failed column reload clears both page data and its mapping", async () => {
  const ui = frontend();
  const tab = dataset();
  ui.useTab(tab);
  const loading = ui.handleAction({ dataset: { action: "toggle-column", col: "id" } });
  ui.requests[0].reject(new Error("File unavailable"));
  await loading;
  assert.equal(tab.page, null);
  assert.equal(tab.pageColumns.length, 0);
  assert.match(ui.renderGrid(tab), /File unavailable/);
  assert.equal(ui.renderDrawer(tab), "");
});
