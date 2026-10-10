// Split only at the current JSON level. Values stay as JSON text: converting
// nested BIGINT/DECIMAL values to JS numbers would silently lose precision.
function splitEntries(json: string): { key: string; value: string }[] {
  const object = json[0] === "{";
  const body = json.slice(1, -1);
  const parts: string[] = [];
  let quoted = false, escaped = false, depth = 0, start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = body.slice(start).trim();
  if (last) parts.push(last);
  return parts.map((part, index) => {
    if (!object) return { key: `[${index}]`, value: part };
    const key = /^("(?:[^"\\]|\\.)*")\s*:/.exec(part);
    if (!key) throw new Error("Invalid JSON field");
    return { key: JSON.parse(key[1]) as string, value: part.slice(key[0].length).trim() };
  });
}

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const BATCH_SIZE = 100;

export function structuredJsonForCopy(json: string): string {
  // DuckDB emits non-finite floats as JSON extensions. Standard JSON has no
  // numeric equivalent, so copy those as strings, leaving quoted text alone.
  return json.replace(/"(?:[^"\\]|\\.)*"|-?Infinity|NaN/g, (token) => token.startsWith('"') ? token : JSON.stringify(token));
}

function renderNode(json: string, key?: string, open = false): string {
  const label = key === undefined ? "" : `<span class="json-key">${escape(key)}</span><span class="json-colon">: </span>`;
  if (json.startsWith("[") || json.startsWith("{")) {
    const kind = json.startsWith("[") ? "Array" : "Object";
    return `<details class="json-node" ${open ? "open" : ""} data-json="${escape(json)}"><summary>${label}<span class="json-container-kind">${kind}</span></summary><div class="json-children"></div></details>`;
  }
  const kind = json.startsWith('"') ? "string" : json === "null" ? "null" : /^(true|false)$/.test(json) ? "bool" : "number";
  const value = kind === "string" ? JSON.parse(json) as string : json;
  return `<div class="json-leaf">${label}<span class="json-${kind}">${escape(kind === "string" ? `“${value}”` : value)}</span></div>`;
}

export function populateJsonNode(details: HTMLDetailsElement, more = false): void {
  if (!details.dataset.json || (!more && details.dataset.loaded)) return;
  const children = details.querySelector<HTMLElement>(":scope > .json-children");
  if (!children) return;
  try {
    const entries = splitEntries(details.dataset.json);
    const start = more ? Number(details.dataset.offset || 0) : 0;
    const end = Math.min(start + BATCH_SIZE, entries.length);
    children.querySelector(":scope > .json-more")?.remove();
    children.insertAdjacentHTML("beforeend", entries.slice(start, end).map((entry) => renderNode(entry.value, entry.key)).join(""));
    if (!entries.length) children.innerHTML = `<span class="json-empty">Empty ${details.dataset.json[0] === "[" ? "array" : "object"}</span>`;
    if (end < entries.length) {
      children.insertAdjacentHTML("beforeend", `<button class="btn-ghost btn-sm json-more" data-action="json-more">Show ${Math.min(BATCH_SIZE, entries.length - end)} more (${entries.length - end} remaining)</button>`);
    }
    const kind = details.querySelector(":scope > summary > .json-container-kind");
    if (kind) kind.textContent = `${details.dataset.json[0] === "[" ? "Array" : "Object"} · ${entries.length} ${details.dataset.json[0] === "[" ? "items" : "fields"}`;
    details.dataset.offset = String(end);
    details.dataset.loaded = "1";
  } catch {
    children.textContent = details.dataset.json;
    details.dataset.loaded = "1";
  }
}

export function structuredCellHtml(value: string): string {
  return `<div class="json-tree">${renderNode(value.trim(), undefined, true)}</div>`;
}
