/**
 * The observability dashboard, served as a single self-contained HTML document
 * (no framework, no build step, zero extra dependencies). The cache's base route
 * is injected as `window.__OBS_BASE__` so all fetch/SSE calls are relative to it.
 */
export function renderDashboard(base: string): string {
  const baseJson = JSON.stringify(base);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>lazy-layers-cache · observability</title>
<style>
  :root {
    --bg: #0b0e14; --panel: #121722; --panel-2: #182030; --border: #232c3d;
    --text: #e6edf3; --muted: #8b98ad; --accent: #5cc8ff; --accent-2: #7c9cff;
    --good: #3fb950; --warn: #d29922; --bad: #f85149; --radius: 12px;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: var(--bg); color: var(--text); }
  a { color: var(--accent); }
  .app { display: grid; grid-template-columns: 240px 1fr; min-height: 100vh; }
  nav { background: var(--panel); border-right: 1px solid var(--border); padding: 20px 14px; }
  .brand { font-weight: 700; font-size: 15px; letter-spacing: .3px; padding: 0 10px 18px; }
  .brand small { display: block; color: var(--muted); font-weight: 500; font-size: 11px; }
  nav button { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
    background: transparent; color: var(--muted); border: 0; padding: 10px 12px; border-radius: 10px;
    cursor: pointer; font-size: 14px; }
  nav button:hover { background: var(--panel-2); color: var(--text); }
  nav button.active { background: var(--panel-2); color: var(--text); box-shadow: inset 2px 0 0 var(--accent); }
  main { padding: 26px 30px; overflow: auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 22px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 14px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; }
  .card .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .5px; }
  .card .value { font-size: 26px; font-weight: 700; margin-top: 6px; }
  .card .value.small { font-size: 18px; }
  .section { display: none; }
  .section.active { display: block; }
  .toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
  input[type=text] { background: var(--panel-2); border: 1px solid var(--border); color: var(--text);
    padding: 8px 12px; border-radius: 8px; min-width: 220px; }
  button.btn { background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
    padding: 8px 14px; border-radius: 8px; cursor: pointer; }
  button.btn:hover { border-color: var(--accent); }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border);
    border-radius: var(--radius); overflow: hidden; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--border); font-size: 13px;
    vertical-align: top; }
  th { color: var(--muted); text-transform: uppercase; font-size: 11px; letter-spacing: .5px; }
  tr:last-child td { border-bottom: 0; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600;
    background: var(--panel-2); border: 1px solid var(--border); }
  .pill.msgpack { color: var(--accent); } .pill.msgpack-gzip { color: var(--accent-2); }
  .pill.json { color: var(--warn); } .pill.live { color: var(--good); } .pill.legacy { color: var(--muted); }
  pre { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px;
    margin: 0; overflow: auto; max-height: 280px; font-size: 12px; }
  .tree { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px; }
  .node { padding-left: 14px; }
  .branch > .row { cursor: pointer; }
  .row { display: flex; gap: 8px; align-items: center; padding: 4px 6px; border-radius: 6px; }
  .row:hover { background: var(--panel-2); }
  .row .name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .row .meta { color: var(--muted); font-size: 12px; margin-left: auto; }
  .caret { width: 12px; display: inline-block; color: var(--muted); }
  .events { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; max-height: 64vh; overflow: auto; }
  .ev { display: grid; grid-template-columns: 92px 180px 1fr; gap: 10px; padding: 6px 12px;
    border-bottom: 1px solid var(--border); }
  .ev .t { color: var(--muted); } .ev .ty { color: var(--accent); }
  .ev .d { color: var(--text); white-space: pre-wrap; word-break: break-word; }
  .muted { color: var(--muted); }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .dot.on { background: var(--good); } .dot.off { background: var(--bad); }
  kbd { background: var(--panel-2); border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px; font-size: 11px; }
</style>
</head>
<body>
<div class="app">
  <nav>
    <div class="brand">lazy-layers-cache <small>observability</small></div>
    <button data-tab="overview" class="active">📊 Overview</button>
    <button data-tab="l1">⚡ L1 / LRU</button>
    <button data-tab="l2">🗄️ L2 / Redis</button>
    <button data-tab="events">📡 Event Stream</button>
    <button data-tab="config">⚙️ Config</button>
  </nav>
  <main>
    <section id="overview" class="section active">
      <h1>Overview</h1>
      <p class="sub">Live metrics derived from the in-memory event stream.</p>
      <div id="ov-cards" class="cards"></div>
    </section>

    <section id="l1" class="section">
      <h1>L1 · in-memory LRU</h1>
      <p class="sub">Read with <code>peek()</code> — inspecting never changes eviction order.</p>
      <div class="toolbar">
        <input id="l1-match" type="text" placeholder="match e.g. user:*" />
        <button class="btn" onclick="loadL1(true)">Search</button>
        <button class="btn" onclick="loadL1(false)">Load more</button>
        <span id="l1-info" class="muted"></span>
      </div>
      <table><thead><tr><th>Key</th><th>Encoding</th><th>Wire</th><th>In-memory</th><th>Saved</th><th>TTL</th><th>Value</th></tr></thead>
      <tbody id="l1-body"></tbody></table>
    </section>

    <section id="l2" class="section">
      <h1>L2 · Redis</h1>
      <p class="sub">Cursor-paginated SCAN. Keys nest on <kbd>:</kbd> like Redis Insight.</p>
      <div class="toolbar">
        <input id="l2-match" type="text" placeholder="match e.g. session:*" />
        <button class="btn" onclick="loadL2(true)">Search</button>
        <button class="btn" onclick="loadL2(false)">Load more</button>
        <span id="l2-info" class="muted"></span>
      </div>
      <div id="l2-tree" class="tree"></div>
    </section>

    <section id="events" class="section">
      <h1>Event Stream</h1>
      <p class="sub">Live via SSE. Nothing is persisted — this is a bounded in-memory feed.</p>
      <div class="toolbar">
        <span><span id="sse-dot" class="dot off"></span> <span id="sse-state" class="muted">connecting…</span></span>
        <button class="btn" id="pause-btn" onclick="togglePause()">Pause</button>
        <button class="btn" onclick="clearEvents()">Clear</button>
        <input id="ev-filter" type="text" placeholder="filter by type…" oninput="renderEvents()" />
      </div>
      <div id="events-feed" class="events"></div>
    </section>

    <section id="config" class="section">
      <h1>Config</h1>
      <p class="sub">Resolved lazy-layer configuration, resilience state, and event-bus health.</p>
      <div id="cfg"></div>
    </section>
  </main>
</div>
<script>
window.__OBS_BASE__ = ${baseJson};
(function () {
  var BASE = window.__OBS_BASE__;
  function api(path) { return fetch(BASE + path, { credentials: "same-origin" }).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }); }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) {
    return c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"; }); }
  function bytes(n) { if (n == null) return "—"; if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB"; return (n / 1048576).toFixed(2) + " MB"; }
  function ttl(ms) { if (ms == null) return "—"; if (ms < 0) return "no expiry";
    if (ms < 1000) return ms + "ms"; return Math.round(ms / 1000) + "s"; }
  function pct(r) { return r ? (r * 100).toFixed(0) + "%" : "—"; }

  // ---- tab switching ----
  var buttons = document.querySelectorAll("nav button");
  buttons.forEach(function (b) { b.addEventListener("click", function () {
    buttons.forEach(function (x) { x.classList.remove("active"); });
    b.classList.add("active");
    document.querySelectorAll(".section").forEach(function (s) { s.classList.remove("active"); });
    document.getElementById(b.dataset.tab).classList.add("active");
    if (b.dataset.tab === "l1") loadL1(true);
    if (b.dataset.tab === "l2") loadL2(true);
    if (b.dataset.tab === "config") loadConfig();
  }); });

  // ---- overview ----
  function card(label, value, small) { return '<div class="card"><div class="label">' + esc(label) +
    '</div><div class="value' + (small ? " small" : "") + '">' + esc(value) + "</div></div>"; }
  function loadOverview() { api("/api/overview").then(function (o) {
    var c = o.counters; var html = "";
    html += card("Hit ratio", (o.hitRatio * 100).toFixed(1) + "%");
    html += card("Hits", o.hits);
    html += card("Misses", o.misses);
    html += card("Total events", o.totalEvents);
    html += card("Buffered", o.bufferedEvents + " / " + o.maxEvents, true);
    html += card("Uptime", Math.round(o.uptimeMs / 1000) + "s", true);
    html += card("Sets", c.sets);
    html += card("Deletes", c.deletes + c.deletePatterns);
    html += card("Loader ok / err", c.loaderSuccess + " / " + c.loaderError, true);
    html += card("Loader timeouts", c.loaderTimeout, true);
    html += card("Inflight reuse", c.inflightReuse, true);
    html += card("Stale served", c.staleHit, true);
    html += card("Negative cached", c.negativeSet, true);
    html += card("L2 errors / skip", c.l2Error + " / " + c.l2Skipped, true);
    html += card("Invalidations", c.invalidationReceived, true);
    html += card("Set broadcasts", c.setBroadcast, true);
    document.getElementById("ov-cards").innerHTML = html;
  }).catch(function () {}); }

  // ---- L1 ----
  var l1Cursor = null;
  function rowFor(k) { var val = k.truncated ? '<span class="muted">truncated (' + bytes(k.serializedBytes) + ")</span>" :
      "<pre>" + esc(typeof k.value === "string" ? k.value : JSON.stringify(k.value, null, 2)) + "</pre>";
    return "<tr><td><code>" + esc(k.key) + "</code></td><td><span class=\\"pill " + esc(k.encoding) + '">' +
      esc(k.encoding) + "</span></td><td>" + bytes(k.serializedBytes) + "</td><td>" + bytes(k.deserializedBytes) +
      "</td><td>" + pct(k.compressionRatio) + "</td><td>" + ttl(k.ttlRemainingMs) +
      "</td><td>" + val + "</td></tr>"; }
  window.loadL1 = function (reset) {
    if (reset) { l1Cursor = null; document.getElementById("l1-body").innerHTML = ""; }
    var m = document.getElementById("l1-match").value.trim();
    var q = "/api/l1?limit=100" + (m ? "&match=" + encodeURIComponent(m) : "") + (l1Cursor ? "&cursor=" + encodeURIComponent(l1Cursor) : "");
    api(q).then(function (r) {
      if (!r) { document.getElementById("l1-info").textContent = "L1 not available"; return; }
      document.getElementById("l1-body").innerHTML += r.keys.map(rowFor).join("");
      l1Cursor = r.cursor || null;
      document.getElementById("l1-info").textContent = "size " + r.size + (l1Cursor ? " · more available" : " · end");
    }).catch(function () { document.getElementById("l1-info").textContent = "L1 not available"; });
  };

  // ---- L2 (nested tree) ----
  var l2Cursor = null; var l2Keys = [];
  function buildTree(items) {
    var root = {};
    items.forEach(function (k) {
      var parts = k.key.split(":"); var node = root;
      for (var i = 0; i < parts.length; i++) {
        var leaf = i === parts.length - 1;
        node._c = node._c || {};
        node._c[parts[i]] = node._c[parts[i]] || {};
        node = node._c[parts[i]];
        if (leaf) node._leaf = k;
      }
    });
    return root;
  }
  function renderNode(name, node) {
    if (node._leaf) {
      var k = node._leaf;
      var val = k.truncated ? '<span class="muted">truncated (' + bytes(k.serializedBytes) + ")</span>" :
        "<pre>" + esc(typeof k.value === "string" ? k.value : JSON.stringify(k.value, null, 2)) + "</pre>";
      var det = '<div class="node" style="display:none"><div class="meta">' +
        '<span class="pill ' + esc(k.encoding) + '">' + esc(k.encoding) + "</span> · wire " +
        bytes(k.serializedBytes) + " · mem " + bytes(k.deserializedBytes) + " · saved " + pct(k.compressionRatio) +
        " · ttl " + ttl(k.ttlRemainingMs) + "</div>" + val + "</div>";
      return '<div class="branch"><div class="row" onclick="this.nextSibling.style.display=this.nextSibling.style.display===\\'none\\'?\\'block\\':\\'none\\'">' +
        '<span class="caret">▸</span><span class="name">' + esc(name) + "</span></div>" + det + "</div>";
    }
    var children = Object.keys(node._c || {}).map(function (c) { return renderNode(c, node._c[c]); }).join("");
    return '<div class="branch"><div class="row" onclick="var n=this.nextSibling;n.style.display=n.style.display===\\'none\\'?\\'block\\':\\'none\\'">' +
      '<span class="caret">▾</span><span class="name">' + esc(name) + '</span><span class="meta">' +
      Object.keys(node._c || {}).length + "</span></div><div class=\\"node\\">" + children + "</div></div>";
  }
  window.loadL2 = function (reset) {
    if (reset) { l2Cursor = null; l2Keys = []; }
    var m = document.getElementById("l2-match").value.trim();
    var q = "/api/l2?limit=100" + (m ? "&match=" + encodeURIComponent(m) : "") + (l2Cursor ? "&cursor=" + encodeURIComponent(l2Cursor) : "");
    api(q).then(function (r) {
      if (!r) { document.getElementById("l2-tree").innerHTML = '<p class="muted">L2 not configured.</p>';
        document.getElementById("l2-info").textContent = ""; return; }
      l2Keys = l2Keys.concat(r.keys);
      l2Cursor = r.cursor || null;
      var tree = buildTree(l2Keys);
      document.getElementById("l2-tree").innerHTML = Object.keys(tree._c || {})
        .map(function (c) { return renderNode(c, tree._c[c]); }).join("") || '<p class="muted">No keys.</p>';
      document.getElementById("l2-info").textContent = "size " + r.size + " · " + l2Keys.length + " loaded" + (l2Cursor ? " · more" : " · end");
    }).catch(function () { document.getElementById("l2-tree").innerHTML = '<p class="muted">L2 not available.</p>'; });
  };

  // ---- events (SSE) ----
  var events = []; var paused = false; var MAX_UI = 500;
  window.togglePause = function () { paused = !paused; document.getElementById("pause-btn").textContent = paused ? "Resume" : "Pause"; };
  window.clearEvents = function () { events = []; renderEvents(); };
  window.renderEvents = function () {
    var f = document.getElementById("ev-filter").value.trim().toLowerCase();
    var rows = events.filter(function (e) { return !f || e.type.toLowerCase().indexOf(f) >= 0; }).slice(-MAX_UI).reverse();
    document.getElementById("events-feed").innerHTML = rows.map(function (e) {
      var d = Object.assign({}, e.data);
      return '<div class="ev"><span class="t">' + new Date(e.ts).toLocaleTimeString() +
        '</span><span class="ty">' + esc(e.type) + '</span><span class="d">' + esc(JSON.stringify(d)) + "</span></div>";
    }).join("");
  };
  function pushEvent(e) { events.push(e); if (events.length > MAX_UI * 2) events = events.slice(-MAX_UI); if (!paused) renderEvents(); }
  function connectSSE() {
    var es = new EventSource(BASE + "/stream", { withCredentials: true });
    es.onopen = function () { document.getElementById("sse-dot").className = "dot on";
      document.getElementById("sse-state").textContent = "connected"; };
    es.onerror = function () { document.getElementById("sse-dot").className = "dot off";
      document.getElementById("sse-state").textContent = "reconnecting…"; };
    es.onmessage = function (msg) { try { pushEvent(JSON.parse(msg.data)); } catch (e) {} };
  }

  // ---- config ----
  function loadConfig() { api("/api/config").then(function (c) {
    var html = "";
    function box(t, body) { return '<div class="card" style="margin-bottom:14px"><div class="label">' + esc(t) +
      '</div><pre style="margin-top:10px">' + esc(JSON.stringify(body, null, 2)) + "</pre></div>"; }
    var ebDot = c.eventBus.health ? (c.eventBus.health.ok ? '<span class="dot on"></span>' : '<span class="dot off"></span>') : "";
    html += '<div class="cards" style="margin-bottom:14px">' +
      card("Source", c.source, true) +
      card("L1 inspectable", c.layers.l1.inspectable ? "yes" : "no", true) +
      card("L2 inspectable", c.layers.l2.inspectable ? "yes" : "no", true) +
      card("L2 breaker", c.resilience.l2CircuitBreaker, true) +
      card("Bus breaker", c.resilience.eventBusCircuitBreaker, true) +
      "</div>";
    html += box("Layers", c.layers);
    html += box("Features", c.features);
    html += box("Event bus " + (c.eventBus.health ? (c.eventBus.health.ok ? "(healthy)" : "(unhealthy)") : ""), c.eventBus);
    var integrations = {
      prometheus: c.prometheus ? { enabled: true, endpoint: c.prometheus.endpoint, prefix: c.prometheus.prefix }
        : { enabled: false, hint: "set prometheus:true to expose " + (BASE + "/metrics") },
      telemetry: { channel: c.telemetry && c.telemetry.channel, hint: "subscribe via node:diagnostics_channel for OpenTelemetry/APM" }
    };
    html += box("Integrations · Prometheus & Telemetry", integrations);
    document.getElementById("cfg").innerHTML = html;
  }).catch(function () { document.getElementById("cfg").innerHTML = '<p class="muted">Config unavailable.</p>'; }); }

  // ---- boot ----
  loadOverview(); setInterval(loadOverview, 2000);
  connectSSE();
})();
</script>
</body>
</html>`;
}
