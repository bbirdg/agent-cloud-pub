/**
 * The memory browser MCP App (ui://memory/browser): one self-contained page, no network requests of its own.
 * It talks to the host over the MCP Apps postMessage bridge (JSON-RPC: ui/initialize, tools/call, ...), so every
 * action goes through this server's own tools and their auth. Note text is only ever set with textContent.
 */
export const BROWSER_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent memory</title>
<style>
:root { --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --accent: #0969da; --warn: #9a6700; --bad: #cf222e; color-scheme: light dark; }
:root[data-theme="dark"] { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --accent: #4493f8; --warn: #d29922; --bad: #f85149; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --accent: #4493f8; --warn: #d29922; --bad: #f85149; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 12px; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
h1 { font-size: 16px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 0 0 6px; overflow-wrap: anywhere; }
form { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
input, select, button { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; }
input[type="search"] { flex: 1 1 160px; min-width: 0; }
button { cursor: pointer; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
#backup { color: var(--muted); font-size: 13px; }
#backup.warn { color: var(--warn); }
ul { list-style: none; margin: 0; padding: 0; }
li + li { border-top: 1px solid var(--line); }
.note { display: block; width: 100%; text-align: left; border: 0; border-radius: 0; padding: 8px 4px; }
.note:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.name { font-weight: 600; }
.ref, .desc { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.badge { font-size: 12px; padding: 0 6px; border: 1px solid var(--line); border-radius: 10px; margin-left: 6px; }
.badge.muted { color: var(--warn); } .badge.deleted { color: var(--bad); }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid var(--line); border-radius: 6px; padding: 8px; max-height: 420px; overflow: auto; font-size: 12.5px; }
#msg { min-height: 1.2em; color: var(--muted); }
[hidden] { display: none !important; }
</style>
</head>
<body>
<header>
  <h1>Agent memory</h1>
  <p id="backup" role="status"></p>
</header>
<main>
  <section id="browse" aria-labelledby="browse-h">
    <h2 id="browse-h" class="sr">Notes</h2>
    <form id="search" role="search">
      <label class="sr" for="q">Search notes</label>
      <input id="q" type="search" placeholder="Search notes">
      <label class="sr" for="project">Project</label>
      <select id="project"><option value="">All projects</option></select>
      <label class="sr" for="status">Status</label>
      <select id="status">
        <option value="all">Any status</option><option value="active">Active</option>
        <option value="muted">Muted</option><option value="deleted">In the bin</option>
      </select>
      <button type="submit">Search</button>
    </form>
    <ul id="list" aria-label="Notes"></ul>
  </section>
  <section id="view" aria-labelledby="view-h" hidden>
    <button id="back" type="button">&larr; Back to list</button>
    <h2 id="view-h"></h2>
    <div class="ref" id="view-ref"></div>
    <div class="actions" id="actions"></div>
    <pre id="text" tabindex="0" aria-label="Note text and history"></pre>
  </section>
  <p id="msg" aria-live="polite"></p>
</main>
<script>
(function () {
  "use strict";
  var nextId = 1, pending = {}, state = { notes: [], current: null };
  var $ = function (id) { return document.getElementById(id); };

  function send(message) { window.parent.postMessage(message, "*"); }
  function request(method, params) {
    var id = nextId++;
    send({ jsonrpc: "2.0", id: id, method: method, params: params });
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }
  function notify(method, params) { send({ jsonrpc: "2.0", method: method, params: params || {} }); }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var m = event.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && !m.method && pending[m.id]) {
      var p = pending[m.id]; delete pending[m.id];
      if (m.error) p.reject(new Error(m.error.message || "Request failed")); else p.resolve(m.result);
    } else if (m.method === "ui/notifications/tool-result") {
      show(m.params);
    } else if (m.method === "ui/notifications/host-context-changed") {
      applyContext(m.params);
    } else if (m.method === "ui/resource-teardown" && m.id !== undefined) {
      send({ jsonrpc: "2.0", id: m.id, result: {} });
    }
  });

  function applyContext(ctx) {
    if (ctx && (ctx.theme === "dark" || ctx.theme === "light")) document.documentElement.setAttribute("data-theme", ctx.theme);
  }
  function say(text) { $("msg").textContent = text; }
  function textOf(result) {
    return ((result && result.content) || []).filter(function (c) { return c.type === "text"; }).map(function (c) { return c.text; }).join("\\n");
  }
  function callTool(name, args) {
    return request("tools/call", { name: name, arguments: args }).then(function (result) {
      if (result && result.isError) throw new Error(textOf(result) || "The tool failed");
      return result;
    });
  }

  function show(result) {
    var data = result && result.structuredContent;
    if (!data || !Array.isArray(data.notes)) { say(textOf(result)); return; }
    state.notes = data.notes;
    var backup = $("backup");
    backup.textContent = data.backup && data.backup.warning ? data.backup.warning
      : data.backup && data.backup.lastOkAt ? "Last backup: " + data.backup.lastOkAt : "";
    backup.className = data.backup && data.backup.warning ? "warn" : "";
    var select = $("project"), chosen = data.project || select.value;
    if (Array.isArray(data.projects)) {
      while (select.options.length > 1) select.remove(1);
      data.projects.forEach(function (p) { select.add(new Option(p.key + " — " + p.title, p.key)); });
    }
    select.value = chosen || "";
    if (typeof data.query === "string") $("q").value = data.query;
    if (data.status) $("status").value = data.status;
    renderList();
    say(data.notes.length + (data.notes.length === 1 ? " note" : " notes"));
  }

  function renderList() {
    var list = $("list");
    list.replaceChildren();
    state.notes.forEach(function (n) {
      var li = document.createElement("li"), b = document.createElement("button");
      b.type = "button"; b.className = "note";
      var name = document.createElement("span"); name.className = "name"; name.textContent = n.name;
      b.appendChild(name);
      if (n.status !== "active") { var s = document.createElement("span"); s.className = "badge " + n.status; s.textContent = n.status === "deleted" ? "in the bin" : n.status; b.appendChild(s); }
      var ref = document.createElement("div"); ref.className = "ref"; ref.textContent = n.project + "/" + n.id; b.appendChild(ref);
      var desc = document.createElement("div"); desc.className = "desc"; desc.textContent = n.description; b.appendChild(desc);
      b.addEventListener("click", function () { open(n); });
      li.appendChild(b); list.appendChild(li);
    });
  }

  var ACTIONS = { active: [["mute", "Mute"], ["delete", "Move to bin"]], muted: [["unmute", "Unmute"], ["delete", "Move to bin"]], deleted: [["restore", "Restore"]] };
  function open(n) {
    state.current = n;
    $("browse").hidden = true; $("view").hidden = false;
    $("view-h").textContent = n.name;
    $("view-ref").textContent = n.project + "/" + n.id + " · " + (n.status === "deleted" ? "in the bin" : n.status);
    var actions = $("actions"); actions.replaceChildren();
    (ACTIONS[n.status] || []).forEach(function (a) {
      var b = document.createElement("button"); b.type = "button"; b.textContent = a[1];
      b.addEventListener("click", function () { act(n, a[0]); });
      actions.appendChild(b);
    });
    $("text").textContent = "Loading…";
    callTool("memory_read", { ids: [n.project + "/" + n.id], with_history: true })
      .then(function (r) { $("text").textContent = textOf(r); })
      .catch(function (e) { $("text").textContent = ""; say(e.message); });
    $("back").focus();
  }

  function act(n, action) {
    var done = "";
    say("Working…");
    callTool("memory_set_status", { id: n.project + "/" + n.id, action: action, reason: "from the memory browser" })
      .then(function (r) { done = textOf(r); return refresh(); })
      .then(function () {
        var again = state.notes.filter(function (x) { return x.project === n.project && x.id === n.id; })[0];
        if (again) open(again); else back();
        say(done);
      })
      .catch(function (e) { say(e.message); });
  }

  function back() { $("view").hidden = true; $("browse").hidden = false; state.current = null; }

  function refresh() {
    var args = { status: $("status").value };
    if ($("q").value.trim()) args.query = $("q").value.trim();
    if ($("project").value) args.project = $("project").value;
    return callTool("memory_browse", args).then(show);
  }

  $("search").addEventListener("submit", function (e) { e.preventDefault(); say("Searching…"); refresh().catch(function (err) { say(err.message); }); });
  $("back").addEventListener("click", back);

  if (window.ResizeObserver) {
    new ResizeObserver(function () { notify("ui/notifications/size-changed", { height: Math.ceil(document.documentElement.scrollHeight) }); })
      .observe(document.documentElement);
  }
  request("ui/initialize", { appInfo: { name: "agent-memory-browser", version: "1.0.0" }, appCapabilities: {}, protocolVersion: "2026-01-26" })
    .then(function (r) { applyContext(r && r.hostContext); notify("ui/notifications/initialized"); })
    .catch(function () { say("Open this in an MCP Apps host to browse memory."); });
})();
</script>
</body>
</html>
`;
