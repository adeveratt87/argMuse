// argMuse Playground — a same-origin MCP test client for this connector.
// Everything received from the server is rendered with textContent only.
"use strict";

const ORIGIN = location.origin;
const MCP_URL = `${ORIGIN}/mcp`;
const PRM_URL = `${ORIGIN}/.well-known/oauth-protected-resource/mcp`;
const CIMD_URL = `${ORIGIN}/oauth/client-metadata.json`;
const REDIRECT_URI = `${ORIGIN}/`;
const SCOPE = "openid offline_access";

const $ = (id) => document.getElementById(id);

// ---------- storage (tab-scoped; tolerant of blocked storage) ----------
const store = {
  get(k) { try { return JSON.parse(sessionStorage.getItem(k) || "null"); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};
const local = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ---------- helpers ----------
function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomString(n = 32) { return b64url(crypto.getRandomValues(new Uint8Array(n))); }
async function sha256(text) { return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)); }

function decodeJwt(token) {
  try {
    const part = token.split(".")[1];
    const bin = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))));
  } catch { return null; }
}

// RFC 8414 §3: insert the well-known segment between host and path.
function asMetadataUrl(issuer) {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/$/, "");
  return `${u.origin}/.well-known/oauth-authorization-server${path}`;
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { res, body };
}

function setMsg(text, kind = "") {
  const el = $("auth-msg");
  el.textContent = text;
  el.className = `msg ${kind}`;
}

// ---------- discovery ----------
let discoveryCache = null;
async function discover() {
  if (discoveryCache) return discoveryCache;
  const prm = await fetchJson(PRM_URL);
  if (!prm.res.ok) throw new Error(`Protected resource metadata returned HTTP ${prm.res.status}`);
  const advertisedIssuer = prm.body.authorization_servers?.[0];
  if (!advertisedIssuer) throw new Error("No authorization server advertised");
  const as = await fetchJson(asMetadataUrl(advertisedIssuer));
  if (!as.res.ok) throw new Error(`Authorization server metadata returned HTTP ${as.res.status}`);
  discoveryCache = { prm: prm.body, as: as.body, advertisedIssuer };
  return discoveryCache;
}

// ---------- endpoint checks ----------
function addCheck(name, status, detail) {
  const li = document.createElement("li");
  const line = document.createElement("div");
  line.className = "line";
  const n = document.createElement("span");
  n.className = "name";
  n.textContent = name;
  const pill = document.createElement("span");
  pill.className = `pill ${status}`;
  pill.textContent = status === "ok" ? "Pass" : status === "warn" ? "Check" : "Fail";
  line.append(n, pill);
  const d = document.createElement("div");
  d.className = "detail";
  d.textContent = detail;
  li.append(line, d);
  $("checks").append(li);
}

async function runChecks() {
  const btn = $("run-checks");
  btn.disabled = true;
  $("checks").textContent = "";
  discoveryCache = null;
  const safe = async (name, fn) => {
    try { await fn(); } catch (e) { addCheck(name, "bad", String(e && e.message ? e.message : e)); }
  };

  await safe("GET /health", async () => {
    const { res, body } = await fetchJson(`${ORIGIN}/health`);
    const ok = res.status === 200 && body?.status === "ok";
    addCheck("GET /health", ok ? "ok" : "bad", `HTTP ${res.status} · ${JSON.stringify(body)}`);
  });

  let prm = null;
  await safe("Protected resource metadata", async () => {
    const { res, body } = await fetchJson(PRM_URL);
    prm = body;
    const ok = res.status === 200 && body?.resource === MCP_URL && Array.isArray(body?.authorization_servers);
    addCheck("Protected resource metadata", ok ? "ok" : "bad",
      `HTTP ${res.status} · resource ${body?.resource} · authorization server ${body?.authorization_servers?.[0]}`);
  });

  await safe("Authorization server metadata", async () => {
    if (!prm?.authorization_servers?.[0]) throw new Error("Skipped: no authorization server advertised");
    const advertised = prm.authorization_servers[0];
    const { res, body } = await fetchJson(asMetadataUrl(advertised));
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${asMetadataUrl(advertised)}`);
    const problems = [];
    if (body.issuer !== advertised) problems.push(`issuer mismatch: server says "${body.issuer}", connector advertises "${advertised}" (fix AUTH_ISSUER in Vercel — tokens will be rejected)`);
    if (!body.code_challenge_methods_supported?.includes("S256")) problems.push("PKCE S256 not advertised");
    if (!body.client_id_metadata_document_supported) problems.push("CIMD not enabled");
    if (!body.registration_endpoint) problems.push("dynamic registration not enabled");
    addCheck("Authorization server metadata", problems.length ? "bad" : "ok",
      problems.length ? problems.join(" · ") : `issuer matches · PKCE S256 · CIMD on · dynamic registration on`);
  });

  await safe("Client metadata document", async () => {
    const { res, body } = await fetchJson(CIMD_URL);
    const ok = res.status === 200 && body?.client_id === CIMD_URL && body?.redirect_uris?.includes(REDIRECT_URI);
    addCheck("Client metadata document", ok ? "ok" : "bad", `HTTP ${res.status} · client_id ${body?.client_id}`);
  });

  await safe("GET /mcp is refused", async () => {
    const res = await fetch(MCP_URL);
    addCheck("GET /mcp is refused", res.status === 405 ? "ok" : "bad", `HTTP ${res.status} (expected 405: stateless, POST only)`);
  });

  await safe("POST /mcp without a token", async () => {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const www = res.headers.get("www-authenticate") || "";
    const ok = res.status === 401 && www.includes("resource_metadata=");
    addCheck("POST /mcp without a token", ok ? "ok" : "bad", `HTTP ${res.status} · WWW-Authenticate: ${www || "(missing)"}`);
  });

  await safe("POST /mcp with a bad token", async () => {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer not-a-real-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    addCheck("POST /mcp with a bad token", res.status === 401 ? "ok" : "bad", `HTTP ${res.status} (expected 401)`);
  });

  const tok = store.get("tokens")?.access_token;
  if (tok) {
    await safe("tools/list with your token", async () => {
      const { res, body } = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, tok);
      const names = body?.result?.tools?.map((t) => t.name).sort() || [];
      const ok = res.status === 200 && names.join(",") === "getProducts,search";
      addCheck("tools/list with your token", ok ? "ok" : "bad", `HTTP ${res.status} · tools: ${names.join(", ") || JSON.stringify(body)}`);
    });
  } else {
    addCheck("tools/list with your token", "warn", "Sign in (step 2) to include this check.");
  }

  btn.disabled = false;
}

// ---------- OAuth ----------
async function clientIdFor(as) {
  if ($("reg-mode").value === "cimd") return CIMD_URL;
  const cached = local.get("dcr");
  if (cached?.issuer === as.issuer && cached?.client_id) return cached.client_id;
  const { res, body } = await fetchJson(as.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "argMuse Playground",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok || !body?.client_id) throw new Error(`Dynamic registration failed: HTTP ${res.status}`);
  local.set("dcr", { issuer: as.issuer, client_id: body.client_id });
  return body.client_id;
}

async function signIn() {
  setMsg("Discovering the sign-in server…");
  try {
    const { prm, as } = await discover();
    const clientId = await clientIdFor(as);
    const verifier = randomString(48);
    const state = randomString(16);
    const challenge = b64url(await sha256(verifier));
    store.set("pkce", { verifier, state, clientId, tokenEndpoint: as.token_endpoint, resource: prm.resource });
    const url = new URL(as.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      resource: prm.resource,
      scope: SCOPE,
    }).toString();
    location.assign(url.toString());
  } catch (e) {
    setMsg(`Sign-in could not start: ${e.message}`, "bad");
  }
}

async function tokenRequest(endpoint, params) {
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(params).toString(),
    });
  } catch {
    throw new Error(`The browser blocked the call to the token endpoint. In WorkOS, add ${ORIGIN} as an allowed CORS origin, then try again.`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Token request failed (HTTP ${res.status}): ${body.error || "unknown"} ${body.error_description || ""}`.trim());
  }
  return body;
}

async function handleRedirect() {
  const params = new URLSearchParams(location.search);
  if (!params.has("code") && !params.has("error")) return;
  history.replaceState(null, "", "/");
  const pending = store.get("pkce");
  store.del("pkce");
  if (params.has("error")) {
    setMsg(`Sign-in returned an error: ${params.get("error")} ${params.get("error_description") || ""}`, "bad");
    return;
  }
  if (!pending || params.get("state") !== pending.state) {
    setMsg("Sign-in response did not match this tab's request (state mismatch). Please try again.", "bad");
    return;
  }
  setMsg("Exchanging the code for a token…");
  try {
    const tokens = await tokenRequest(pending.tokenEndpoint, {
      grant_type: "authorization_code",
      code: params.get("code"),
      redirect_uri: REDIRECT_URI,
      client_id: pending.clientId,
      code_verifier: pending.verifier,
      resource: pending.resource,
    });
    store.set("tokens", { ...tokens, client_id: pending.clientId, token_endpoint: pending.tokenEndpoint, resource: pending.resource });
    setMsg("Signed in.", "ok");
  } catch (e) {
    setMsg(e.message, "bad");
  }
}

async function refresh() {
  const t = store.get("tokens");
  if (!t?.refresh_token) { setMsg("No refresh token available.", "bad"); return; }
  try {
    const tokens = await tokenRequest(t.token_endpoint, {
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: t.client_id,
      resource: t.resource,
    });
    store.set("tokens", { ...t, ...tokens });
    setMsg("Token refreshed.", "ok");
  } catch (e) { setMsg(e.message, "bad"); }
  renderAuth();
}

function signOut() {
  store.del("tokens");
  setMsg("Signed out of the playground (your WorkOS session may still be active).");
  renderAuth();
}

function renderAuth() {
  const t = store.get("tokens");
  const pill = $("auth-pill");
  const claims = $("claims");
  claims.textContent = "";
  $("refresh").disabled = !t?.refresh_token;
  $("sign-out").disabled = !t;
  if (!t?.access_token) {
    pill.textContent = "Signed out";
    pill.className = "pill";
    claims.hidden = true;
    return;
  }
  const c = decodeJwt(t.access_token) || {};
  const expired = c.exp && c.exp * 1000 < Date.now();
  pill.textContent = expired ? "Token expired" : "Signed in";
  pill.className = `pill ${expired ? "warn" : "ok"}`;
  const rows = [
    ["Subject", c.sub],
    ["Issuer", c.iss, discoveryCache && c.iss !== discoveryCache.advertisedIssuer ? "Does not match the connector's AUTH_ISSUER" : ""],
    ["Audience", Array.isArray(c.aud) ? c.aud.join(", ") : c.aud, c.aud && ![].concat(c.aud).includes(MCP_URL) ? `Should be ${MCP_URL}` : ""],
    ["Scope", c.scope || (c.scp || []).join(" ") || "(none)"],
    ["Expires", c.exp ? new Date(c.exp * 1000).toLocaleString() : "(no exp)"],
  ];
  for (const [k, v, problem] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v ?? "(missing)";
    if (problem) {
      dd.classList.add("bad");
      dd.textContent += ` — ${problem}`;
    }
    claims.append(dt, dd);
  }
  claims.hidden = false;
}

// ---------- MCP calls ----------
let protocolVersion = null;

async function mcp(body, token) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;
  const started = performance.now();
  const res = await fetch(MCP_URL, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  const ms = Math.round(performance.now() - started);
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { res, body: parsed, ms };
}

function showResponse({ res, body, ms }) {
  const cid = res.headers.get("x-correlation-id");
  $("resp-meta").textContent = `HTTP ${res.status} · ${ms} ms${cid ? ` · ref ${cid}` : ""}`;
  $("resp-body").textContent = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  const textBox = $("resp-text");
  const content = body?.result?.content;
  if (Array.isArray(content)) {
    textBox.textContent = content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n");
    textBox.className = `product-text${body.result.isError ? " error" : ""}`;
    textBox.hidden = false;
  } else {
    textBox.hidden = true;
  }
  if (body?.result?.protocolVersion) protocolVersion = body.result.protocolVersion;
  $("resp-h").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function send(body, { noAuth = false } = {}) {
  const token = noAuth ? null : store.get("tokens")?.access_token;
  if (!token && !noAuth) {
    $("resp-meta").textContent = "";
    $("resp-text").hidden = true;
    $("resp-body").textContent = "Sign in first (step 2), or tick “Send without token” on the Raw tab to see the 401.";
    return;
  }
  $("resp-body").textContent = "Sending…";
  try {
    showResponse(await mcp(body, token));
  } catch (e) {
    $("resp-body").textContent = `Request failed: ${e.message}`;
  }
}

let nextId = 1;
const call = (name, args) => ({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } });

const PRESETS = {
  list: () => ({ jsonrpc: "2.0", id: nextId++, method: "tools/list" }),
  init: () => ({
    jsonrpc: "2.0", id: nextId++, method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "argmuse-playground", version: "1" } },
  }),
  ping: () => ({ jsonrpc: "2.0", id: nextId++, method: "ping" }),
  unknown: () => call("addToBasket", { productId: "7615436" }),
  invalid: () => call("search", { query: "", limit: 999 }),
  batch: () => [{ jsonrpc: "2.0", id: 1, method: "tools/list" }, { jsonrpc: "2.0", id: 2, method: "ping" }],
};

function loadPreset() {
  $("raw").value = JSON.stringify(PRESETS[$("preset").value](), null, 2);
}

// ---------- wiring ----------
function selectTab(name) {
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  for (const p of document.querySelectorAll(".tab")) p.hidden = p.dataset.panel !== name;
}

document.addEventListener("DOMContentLoaded", async () => {
  $("base-url").textContent = ORIGIN;
  $("resource-url").textContent = MCP_URL;
  const savedMode = local.get("regMode");
  if (savedMode) $("reg-mode").value = savedMode;

  $("run-checks").addEventListener("click", runChecks);
  $("sign-in").addEventListener("click", signIn);
  $("refresh").addEventListener("click", refresh);
  $("sign-out").addEventListener("click", signOut);
  $("reg-mode").addEventListener("change", () => local.set("regMode", $("reg-mode").value));
  $("use-token").addEventListener("click", () => {
    const v = $("paste-token").value.trim();
    if (!v) return;
    store.set("tokens", { access_token: v });
    $("paste-token").value = "";
    setMsg("Using the pasted token.", "ok");
    renderAuth();
  });

  for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => selectTab(b.dataset.tab));
  $("preset").addEventListener("change", loadPreset);
  loadPreset();

  $("tab-search").addEventListener("submit", (e) => {
    e.preventDefault();
    const limit = Number($("limit").value);
    send(call("search", { query: $("q").value, ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}) }));
  });
  $("tab-products").addEventListener("submit", (e) => {
    e.preventDefault();
    const ids = $("ids").value.split(",").map((s) => s.trim()).filter(Boolean);
    send(call("getProducts", { ids }));
  });
  $("tab-raw").addEventListener("submit", (e) => {
    e.preventDefault();
    send($("raw").value, { noAuth: $("raw-noauth").checked });
  });

  await handleRedirect();
  try { await discover(); } catch { /* checks will report it */ }
  renderAuth();
  runChecks();
});
