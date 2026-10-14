// Fills the documentation page from the connector's live metadata.
// All values are inserted with textContent; nothing is rendered as HTML.
"use strict";

const el = (tag, props = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};

function typeOf(s) {
  if (!s) return "";
  if (s.anyOf) return s.anyOf.map(typeOf).join(" | ");
  if (s.const !== undefined) return JSON.stringify(s.const);
  const t = Array.isArray(s.type) ? s.type.join(" | ") : s.type || "";
  if (t === "array" && s.items) return `array of ${typeOf(s.items)}`;
  return s.format ? `${t} (${s.format})` : t;
}

function rules(s) {
  const out = [];
  for (const k of ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"]) {
    if (s?.[k] !== undefined) out.push(`${k} ${s[k]}`);
  }
  if (s?.pattern) out.push(`pattern ${s.pattern}`);
  return out.join(", ");
}

// Flattens an object schema into rows: path, type, required, notes.
function rows(schema, prefix = "") {
  const out = [];
  const props = schema?.properties || {};
  const required = new Set(schema?.required || []);
  for (const [name, raw] of Object.entries(props)) {
    const s = raw.anyOf ? raw.anyOf.find((x) => x.type === "object" || x.type === "array") || raw : raw;
    const path = prefix ? `${prefix}.${name}` : name;
    out.push({ path, type: typeOf(raw), required: required.has(name), notes: [raw.description, rules(raw)].filter(Boolean).join(" · ") });
    if (s.type === "object") out.push(...rows(s, path));
    if (s.type === "array" && s.items?.type === "object") out.push(...rows(s.items, `${path}[]`));
  }
  return out;
}

function table(schema) {
  const body = el("tbody");
  for (const r of rows(schema)) {
    body.append(
      el("tr", {},
        el("td", {}, el("code", {}, r.path), r.required ? el("span", { class: "req", title: "required" }, " *") : ""),
        el("td", {}, r.type),
        el("td", {}, r.notes)),
    );
  }
  return el("table", { class: "tbl" }, el("thead", {}, el("tr", {}, el("th", {}, "Field"), el("th", {}, "Type"), el("th", {}, "Notes"))), body);
}

function renderTool(t) {
  const badges = el("div", { class: "badges" });
  const a = t.annotations || {};
  if (a.readOnlyHint) badges.append(el("span", { class: "pill ok" }, "read-only"));
  if (a.destructiveHint === false) badges.append(el("span", { class: "pill ok" }, "non-destructive"));
  if (a.idempotentHint) badges.append(el("span", { class: "pill" }, "idempotent"));
  return el("div", { class: "tool" },
    el("h3", {}, el("code", {}, t.name), t.title ? ` · ${t.title}` : ""),
    badges,
    el("p", {}, t.description || ""),
    el("p", { class: "muted small" }, "Input (* = required)"),
    table(t.inputSchema),
    el("p", { class: "muted small" }, "Output: structuredContent"),
    table(t.outputSchema),
    el("details", {}, el("summary", {}, "Raw JSON Schemas"),
      el("pre", { class: "code" }, JSON.stringify({ inputSchema: t.inputSchema, outputSchema: t.outputSchema }, null, 2))),
  );
}

async function json(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

document.addEventListener("DOMContentLoaded", async () => {
  const list = document.getElementById("tool-list");
  try {
    const cat = await json("/docs/tools.json");
    document.getElementById("endpoint").textContent = cat.endpoint;
    list.textContent = "";
    for (const t of cat.tools) list.append(renderTool(t));
  } catch (e) {
    list.textContent = `Could not load tool definitions (${e.message}). See /docs/tools.json.`;
  }

  try {
    const prm = await json("/.well-known/oauth-protected-resource/mcp");
    const issuer = prm.authorization_servers?.[0] || "unknown";
    document.getElementById("as-issuer").textContent = issuer;
    const u = new URL(issuer);
    const as = await json(`${u.origin}/.well-known/oauth-authorization-server${u.pathname.replace(/\/$/, "")}`);
    const methods = [];
    if (as.client_id_metadata_document_supported) methods.push("Client ID Metadata Documents (preferred)");
    if (as.registration_endpoint) methods.push(`Dynamic Client Registration (${as.registration_endpoint})`);
    if (methods.length) document.getElementById("as-registration").textContent = methods.join("; ");
  } catch {
    /* static text remains */
  }
});
