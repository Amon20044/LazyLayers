/**
 * ============================================================================
 * LazyLayers Observability Dashboard (Shadcn UI + Light/Dark Mode + Interactive Charts)
 * ============================================================================
 * Self-contained, zero-dependency modern observability suite with:
 * - Theme Switcher (Light / Dark Mode with persistent localStorage)
 * - Official LazyLayers SVG mark in header
 * - Shadcn-grade Interactive Charts with real-time mouse-tracking crosshairs & floating tooltips
 * - Live Tier Traffic Distribution visualizer (L1 Memory vs L2 Redis vs In-Flight vs DB)
 * - Real-time auto-refreshing L1 Memory LRU Inspector & L2 Redis Explorer (with Table/Tree toggle)
 * - Millisecond-precision Live Event Stream with instant event-type filter badges
 * - Compression savings gauge and Lucide vector SVG icons
 * - Interactive hover tooltips on every single metric card
 */

export function renderDashboard(base: string): string {
  const baseJson = JSON.stringify(base);
  return `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>lazy-layers-cache · observability</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --brand-cyan: #0284c7;
    --brand-emerald: #10b981;
    --brand-indigo: #6366f1;
    --brand-purple: #a855f7;
    --brand-amber: #f59e0b;
    --brand-rose: #f43f5e;

    --font-sans: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --font-mono: 'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace;

    --radius-lg: 14px;
    --radius-md: 10px;
    --radius-sm: 6px;
    --radius-full: 9999px;
  }

  /* ── Dark Theme (Default) ── */
  html.dark {
    --bg-base: #090a0f;
    --bg-surface: #0f131c;
    --bg-elevated: #151a26;
    --bg-hover: #1b2232;
    --border-subtle: rgba(255, 255, 255, 0.08);
    --border-highlight: rgba(255, 255, 255, 0.16);
    --border-active: rgba(56, 189, 248, 0.35);

    --text-primary: #f8fafc;
    --text-secondary: #94a3b8;
    --text-muted: #64748b;

    --chart-line: #38bdf8;
    --chart-glow: rgba(56, 189, 248, 0.25);
    --chart-grid: rgba(255, 255, 255, 0.04);
    --popover-bg: #06080e;
    --shadow-popover: 0 14px 35px rgba(0, 0, 0, 0.8), 0 0 20px rgba(56, 189, 248, 0.12);
  }

  /* ── Light Theme ── */
  html.light {
    --bg-base: #f8fafc;
    --bg-surface: #ffffff;
    --bg-elevated: #f1f5f9;
    --bg-hover: #e2e8f0;
    --border-subtle: #e2e8f0;
    --border-highlight: #cbd5e1;
    --border-active: rgba(2, 132, 199, 0.4);

    --text-primary: #0f172a;
    --text-secondary: #475569;
    --text-muted: #94a3b8;

    --chart-line: #0284c7;
    --chart-glow: rgba(2, 132, 199, 0.15);
    --chart-grid: rgba(0, 0, 0, 0.04);
    --popover-bg: #ffffff;
    --shadow-popover: 0 14px 35px rgba(0, 0, 0, 0.12), 0 0 15px rgba(2, 132, 199, 0.1);
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background-color: var(--bg-base);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 13px;
    line-height: 1.5;
    min-height: 100vh;
    transition: background-color 0.2s ease, color 0.2s ease;
    -webkit-font-smoothing: antialiased;
  }

  .app-shell {
    display: grid;
    grid-template-columns: 240px 1fr;
    min-height: 100vh;
  }

  /* ── Sidebar ── */
  aside {
    background: var(--bg-surface);
    border-right: 1px solid var(--border-subtle);
    padding: 20px 14px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    transition: background 0.2s ease, border-color 0.2s ease;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 2px 8px 12px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .brand-icon {
    width: 34px;
    height: 34px;
    border-radius: var(--radius-md);
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(211, 241, 93, 0.08);
    border: 1px solid rgba(211, 241, 93, 0.25);
  }

  .brand-title {
    font-size: 14px;
    font-weight: 700;
    letter-spacing: -0.2px;
  }

  .brand-tag {
    font-size: 10px;
    color: var(--text-muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  nav {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  nav button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    text-align: left;
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid transparent;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-family: var(--font-sans);
    font-size: 12.5px;
    font-weight: 500;
    transition: all 0.15s ease;
  }

  nav button:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  nav button.active {
    background: rgba(56, 189, 248, 0.08);
    border-color: rgba(56, 189, 248, 0.25);
    color: var(--brand-cyan);
    font-weight: 600;
  }

  .sidebar-footer {
    margin-top: auto;
    padding-top: 14px;
    border-top: 1px solid var(--border-subtle);
    font-size: 11px;
    color: var(--text-muted);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  /* ── Main Canvas ── */
  main {
    padding: 28px 36px;
    overflow-y: auto;
    max-width: 1380px;
  }

  .section { display: none; }
  .section.active { display: block; }

  /* ── Header ── */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
  }

  .header-title h2 {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.4px;
  }

  .header-title p {
    color: var(--text-muted);
    font-size: 12.5px;
    margin-top: 2px;
  }

  .header-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  /* ── Buttons & UI Controls ── */
  .btn {
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    padding: 7px 12px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-family: var(--font-sans);
    font-size: 12px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: all 0.15s ease;
  }

  .btn:hover {
    background: var(--bg-hover);
    border-color: var(--border-highlight);
  }

  .btn-primary {
    background: linear-gradient(135deg, #0284c7, #2563eb);
    border: 1px solid rgba(56, 189, 248, 0.4);
    color: #fff;
    box-shadow: 0 1px 4px rgba(2, 132, 199, 0.3);
  }

  .btn-primary:hover {
    background: linear-gradient(135deg, #0369a1, #1d4ed8);
    box-shadow: 0 2px 8px rgba(2, 132, 199, 0.4);
  }

  .theme-toggle-btn {
    width: 32px;
    height: 32px;
    padding: 0;
    justify-content: center;
    border-radius: var(--radius-sm);
  }

  /* ── Hero Metric Cards Container (Shopify Style) ── */
  .hero-container {
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    overflow: hidden;
    margin-bottom: 20px;
    transition: all 0.2s ease;
    box-shadow: 0 2px 8px rgba(0,0,0,0.04);
  }

  .hero-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
  }

  @media (max-width: 1024px) {
    .hero-grid { grid-template-columns: repeat(2, 1fr); }
  }

  .hero-col {
    padding: 20px 22px;
    border-right: 1px solid var(--border-subtle);
    border-bottom: 1px solid var(--border-subtle);
    position: relative;
    cursor: help;
    transition: background 0.15s ease;
  }

  .hero-col:nth-child(4n) { border-right: none; }
  .hero-col:hover { background: var(--bg-elevated); }

  .hero-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .hero-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .hero-val {
    font-size: 28px;
    font-weight: 800;
    letter-spacing: -0.6px;
    line-height: 1.1;
  }

  .hero-sub {
    font-size: 11.5px;
    color: var(--text-secondary);
    margin-top: 6px;
  }

  /* ── Interactive Popovers (Hover Tooltips) ── */
  .tooltip-pop {
    position: absolute;
    bottom: calc(100% + 10px);
    left: 50%;
    transform: translateX(-50%) translateY(4px);
    width: 260px;
    background: var(--popover-bg);
    border: 1px solid var(--border-active);
    border-radius: var(--radius-md);
    padding: 12px 14px;
    box-shadow: var(--shadow-popover);
    pointer-events: none;
    opacity: 0;
    visibility: hidden;
    transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
    z-index: 200;
  }

  .hero-col:hover .tooltip-pop,
  .metric-item:hover .tooltip-pop {
    opacity: 1;
    visibility: visible;
    transform: translateX(-50%) translateY(0);
  }

  .tooltip-title {
    font-size: 11px;
    font-weight: 700;
    color: var(--brand-cyan);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .tooltip-body {
    font-size: 11.5px;
    color: var(--text-secondary);
    line-height: 1.45;
  }

  .tooltip-formula {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid var(--border-subtle);
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-muted);
  }

  .tooltip-arrow {
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    border-width: 5px;
    border-style: solid;
    border-color: var(--popover-bg) transparent transparent transparent;
  }

  /* ── Interactive Shadcn Graph Container ── */
  .chart-section {
    padding: 20px 24px;
    background: var(--bg-surface);
    position: relative;
  }

  .chart-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }

  .chart-legend {
    display: flex;
    align-items: center;
    gap: 16px;
    font-size: 11.5px;
    color: var(--text-muted);
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .legend-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .chart-wrapper {
    position: relative;
    width: 100%;
    height: 160px;
  }

  canvas#interactive-chart {
    width: 100%;
    height: 100%;
    display: block;
    cursor: crosshair;
  }

  /* Floating Graph Tooltip */
  #chart-tooltip {
    position: absolute;
    top: 0;
    left: 0;
    background: var(--popover-bg);
    border: 1px solid var(--border-active);
    border-radius: var(--radius-sm);
    padding: 8px 12px;
    box-shadow: var(--shadow-popover);
    font-size: 11px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.1s ease;
    z-index: 100;
    min-width: 150px;
  }

  /* ── Traffic Distribution Visualizer (Stacked Bar) ── */
  .distribution-card {
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    padding: 18px 22px;
    margin-bottom: 20px;
  }

  .dist-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }

  .dist-title {
    font-size: 12.5px;
    font-weight: 700;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .stacked-bar-container {
    height: 14px;
    width: 100%;
    background: var(--bg-elevated);
    border-radius: var(--radius-full);
    overflow: hidden;
    display: flex;
    margin-bottom: 12px;
  }

  .stacked-seg {
    height: 100%;
    transition: width 0.3s ease;
    position: relative;
  }

  .seg-l1 { background: var(--brand-cyan); }
  .seg-l2 { background: var(--brand-indigo); }
  .seg-inflight { background: var(--brand-purple); }
  .seg-db { background: var(--brand-rose); }

  .dist-legend {
    display: flex;
    gap: 18px;
    flex-wrap: wrap;
    font-size: 11.5px;
  }

  .dist-legend-item {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-secondary);
  }

  .dist-legend-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  /* ── Secondary Metric Grid ── */
  .secondary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px;
  }

  .metric-item {
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 14px 16px;
    position: relative;
    cursor: help;
    transition: all 0.15s ease;
  }

  .metric-item:hover {
    background: var(--bg-hover);
    border-color: var(--border-highlight);
  }

  .metric-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }

  .metric-label {
    font-size: 10.5px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .metric-num {
    font-size: 18px;
    font-weight: 700;
  }

  .metric-sub {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 2px;
  }

  /* ── Tables & Inspectors ── */
  .toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 14px;
    flex-wrap: wrap;
  }

  input[type=text] {
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    color: var(--text-primary);
    padding: 7px 12px;
    border-radius: var(--radius-sm);
    min-width: 220px;
    font-family: var(--font-sans);
    font-size: 12.5px;
    outline: none;
  }

  input[type=text]:focus {
    border-color: var(--brand-cyan);
  }

  .table-box {
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
  }

  th {
    background: rgba(255, 255, 255, 0.02);
    color: var(--text-muted);
    text-transform: uppercase;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.5px;
    padding: 10px 14px;
    text-align: left;
    border-bottom: 1px solid var(--border-subtle);
  }

  td {
    padding: 10px 14px;
    border-bottom: 1px solid var(--border-subtle);
    vertical-align: top;
  }

  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--bg-hover); }

  code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--brand-cyan);
    background: rgba(56, 189, 248, 0.08);
    padding: 2px 5px;
    border-radius: 4px;
  }

  .pill {
    display: inline-block;
    padding: 1px 6px;
    border-radius: var(--radius-full);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .pill.msgpack { color: var(--brand-cyan); background: rgba(56, 189, 248, 0.1); border-color: rgba(56, 189, 248, 0.25); }
  .pill.msgpack-zstd { color: var(--brand-emerald); background: rgba(16, 185, 129, 0.1); border-color: rgba(16, 185, 129, 0.25); }
  .pill.msgpack-lz4 { color: var(--brand-indigo); background: rgba(99, 102, 241, 0.1); border-color: rgba(99, 102, 241, 0.25); }
  .pill.msgpack-gzip { color: var(--brand-purple); background: rgba(168, 85, 247, 0.1); border-color: rgba(168, 85, 247, 0.25); }
  .pill.json { color: var(--brand-amber); background: rgba(245, 158, 11, 0.1); border-color: rgba(245, 158, 11, 0.25); }
  .pill.HC1Z { color: var(--brand-emerald); background: rgba(16, 185, 129, 0.1); border-color: rgba(16, 185, 129, 0.25); }
  .pill.HC1L { color: var(--brand-cyan); background: rgba(56, 189, 248, 0.1); border-color: rgba(56, 189, 248, 0.25); }
  .pill.HC1M { color: var(--brand-indigo); background: rgba(99, 102, 241, 0.1); border-color: rgba(99, 102, 241, 0.25); }
  .pill.HC1J { color: var(--brand-amber); background: rgba(245, 158, 11, 0.1); border-color: rgba(245, 158, 11, 0.25); }

  pre {
    background: #04060a;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    padding: 8px 12px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: #cbd5e1;
    max-height: 240px;
    overflow: auto;
  }

  /* ── Filter Badges for Live Events ── */
  .filter-group {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .filter-badge {
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    color: var(--text-secondary);
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .filter-badge:hover { background: var(--bg-hover); color: var(--text-primary); }
  .filter-badge.active { background: rgba(56, 189, 248, 0.12); border-color: var(--brand-cyan); color: var(--brand-cyan); }

  /* ── Live SSE Feed ── */
  .event-feed {
    background: #04060a;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    max-height: 64vh;
    overflow-y: auto;
    font-family: var(--font-mono);
    font-size: 11.5px;
  }

  .ev-row {
    display: grid;
    grid-template-columns: 105px 140px 1fr;
    gap: 10px;
    padding: 7px 14px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.03);
    align-items: center;
  }

  .ev-time { color: var(--text-muted); font-size: 10.5px; }
  .ev-type { font-weight: 600; }
  .ev-type.hit { color: var(--brand-emerald); }
  .ev-type.miss { color: var(--brand-amber); }
  .ev-type.inflight { color: var(--brand-indigo); }
  .ev-type.set { color: var(--brand-purple); }
  .ev-type.delete { color: var(--brand-rose); }
  .ev-data { color: #94a3b8; white-space: pre-wrap; word-break: break-all; }

  /* ── Pulsing Status Dot ── */
  .pulse-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    display: inline-block;
  }
  .pulse-dot.on {
    background: var(--brand-emerald);
    box-shadow: 0 0 6px var(--brand-emerald);
  }
  .pulse-dot.off {
    background: var(--brand-rose);
  }

  #toast {
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: var(--popover-bg);
    border: 1px solid rgba(16, 185, 129, 0.35);
    color: var(--brand-emerald);
    padding: 8px 14px;
    border-radius: var(--radius-sm);
    font-size: 12px;
    font-weight: 600;
    box-shadow: 0 6px 20px rgba(0,0,0,0.3);
    opacity: 0;
    transform: translateY(8px);
    transition: all 0.18s ease;
    pointer-events: none;
    z-index: 1000;
  }
  #toast.show { opacity: 1; transform: translateY(0); }
</style>
</head>
<body>

<div class="app-shell">
  <!-- Sidebar -->
  <aside>
    <div class="brand">
      <div class="brand-icon">
        <svg viewBox="95 91 509 509" width="22" height="22" fill="none" role="img" aria-label="LazyLayers">
          <path d="M131 443 L349 559 L568 443 L531 424 L351 520 L170 425 L131 443 Z" fill="#F2F3EC"/>
          <path d="M570 443 L350 561 L129 444 L128 462 L350 584 L563 472 L570 443 Z" fill="#D3F15D"/>
          <path d="M128 378 L349 496 L570 378 L566 405 L351 518 L128 399 L128 378 Z" fill="#D3F15D"/>
          <path d="M207 139 L230 150 L230 349 L207 338 L207 139 Z" fill="#D3F15D"/>
          <path d="M404 107 L426 118 L427 299 L404 287 L404 107 Z" fill="#D3F15D"/>
          <path d="M326 328 L480 411 L447 416 L326 351 L326 328 Z" fill="#D3F15D"/>
          <path d="M403 107 L326 146 L326 326 L481 413 L373 429 L208 341 L205 139 L129 178 L129 377 L347 493 L569 377 L403 288 L403 107 Z" fill="#F2F3EC"/>
        </svg>
      </div>
      <div>
        <div class="brand-title">LazyLayers</div>
        <div class="brand-tag">Observability</div>
      </div>
    </div>

    <nav>
      <button data-tab="overview" class="active">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
        <span>Overview</span>
      </button>
      <button data-tab="l1">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        <span>L1 / Memory LRU</span>
      </button>
      <button data-tab="l2">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
        <span>L2 / Redis Store</span>
      </button>
      <button data-tab="events">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"/></svg>
        <span>Live Events</span>
      </button>
      <button data-tab="config">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
        <span>System Config</span>
      </button>
    </nav>

    <div class="sidebar-footer">
      <span>LazyLayers v0.5.0</span>
      <span class="pill HC1Z">Healthy</span>
    </div>
  </aside>

  <!-- Main Canvas -->
  <main>
    <!-- 1. OVERVIEW -->
    <section id="overview" class="section active">
      <div class="header">
        <div class="header-title">
          <h2>Telemetry Overview</h2>
          <p>Real-time origin database protection, thundering herd collapse, and tier performance.</p>
        </div>
        <div class="header-actions">
          <!-- Theme Toggle Switcher -->
          <button class="btn theme-toggle-btn" id="theme-toggle" title="Toggle Light/Dark Theme" onclick="toggleTheme()">
            <svg id="theme-icon-moon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            <svg id="theme-icon-sun" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
          </button>
          <button class="btn btn-primary" onclick="resetMetrics()">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>
            <span>Reset Counters</span>
          </button>
        </div>
      </div>

      <!-- Hero Metrics Container with Interactive Graph -->
      <div class="hero-container">
        <div class="hero-grid" id="hero-grid"></div>

        <!-- Interactive Shadcn Chart with Hover Crosshairs -->
        <div class="chart-section">
          <div class="chart-header">
            <div class="chart-legend">
              <span class="legend-item">
                <span class="legend-dot" style="background:var(--brand-cyan)"></span>
                <span>Origin Offload (%)</span>
              </span>
              <span class="legend-item">
                <span class="legend-dot" style="background:var(--brand-indigo)"></span>
                <span>Direct Hits (L1/L2)</span>
              </span>
              <span class="legend-item">
                <span class="legend-dot" style="background:var(--brand-purple)"></span>
                <span>In-Flight Coalesced</span>
              </span>
            </div>
            <div style="font-size:11px; color:var(--text-muted);">Hover graph for crosshair inspection</div>
          </div>
          <div class="chart-wrapper">
            <canvas id="interactive-chart"></canvas>
            <div id="chart-tooltip"></div>
          </div>
        </div>
      </div>

      <!-- Real-Time Traffic Distribution Visualizer -->
      <div class="distribution-card">
        <div class="dist-header">
          <div class="dist-title">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--brand-cyan)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
            <span>Traffic Resolution Distribution</span>
          </div>
          <span id="dist-total-label" style="font-size:11.5px; color:var(--text-muted);">0 total requests</span>
        </div>
        <div class="stacked-bar-container">
          <div class="stacked-seg seg-l1" id="seg-l1" style="width: 0%;" title="L1 In-Memory Hits"></div>
          <div class="stacked-seg seg-l2" id="seg-l2" style="width: 0%;" title="L2 Redis Hits"></div>
          <div class="stacked-seg seg-inflight" id="seg-inflight" style="width: 0%;" title="In-Flight Mutex Coalesced"></div>
          <div class="stacked-seg seg-db" id="seg-db" style="width: 0%;" title="Origin DB Cold Queries"></div>
        </div>
        <div class="dist-legend">
          <div class="dist-legend-item"><span class="dist-legend-dot seg-l1"></span><span id="label-l1">L1 Memory: 0 (0%)</span></div>
          <div class="dist-legend-item"><span class="dist-legend-dot seg-l2"></span><span id="label-l2">L2 Redis: 0 (0%)</span></div>
          <div class="dist-legend-item"><span class="dist-legend-dot seg-inflight"></span><span id="label-inflight">In-Flight: 0 (0%)</span></div>
          <div class="dist-legend-item"><span class="dist-legend-dot seg-db"></span><span id="label-db">Origin DB: 0 (0%)</span></div>
        </div>
      </div>

      <!-- Secondary Metric Grid -->
      <div class="secondary-grid" id="secondary-grid"></div>
    </section>

    <!-- 2. L1 MEMORY INSPECTOR -->
    <section id="l1" class="section">
      <div class="header">
        <div class="header-title">
          <h2>L1 In-Memory LRU Inspector</h2>
          <p>Live peek into keys stored in RAM cache without altering LRU recency.</p>
        </div>
        <div class="header-actions">
          <button class="btn btn-sm" onclick="loadL1(true)">🔄 Refresh L1</button>
        </div>
      </div>

      <div class="toolbar">
        <input id="l1-match" type="text" placeholder="Filter key (e.g. usr_1)..." oninput="loadL1(true)" />
        <span id="l1-info" style="color:var(--text-muted); font-size:12px; margin-left:auto;"></span>
      </div>

      <div class="table-box">
        <table>
          <thead>
            <tr>
              <th>Cache Key</th>
              <th>Encoding</th>
              <th>Wire Size</th>
              <th>Memory Size</th>
              <th>Compression Savings</th>
              <th>TTL Remaining</th>
              <th>Live Value Preview</th>
            </tr>
          </thead>
          <tbody id="l1-body"></tbody>
        </table>
      </div>
    </section>

    <!-- 3. L2 REDIS INSPECTOR -->
    <section id="l2" class="section">
      <div class="header">
        <div class="header-title">
          <h2>L2 Redis Remote Store Explorer</h2>
          <p>Real-time keys stored in Redis with size metrics and compression breakdown.</p>
        </div>
        <div class="header-actions">
          <button class="btn btn-sm" id="l2-view-btn" onclick="toggleL2View()">Toggle View: Table</button>
          <button class="btn btn-sm" onclick="loadL2(true)">🔄 Refresh L2</button>
        </div>
      </div>

      <div class="toolbar">
        <input id="l2-match" type="text" placeholder="Match pattern (e.g. * or usr_*)..." oninput="loadL2(true)" />
        <span id="l2-info" style="color:var(--text-muted); font-size:12px; margin-left:auto;"></span>
      </div>

      <div id="l2-content" class="table-box"></div>
    </section>

    <!-- 4. LIVE EVENTS -->
    <section id="events" class="section">
      <div class="header">
        <div class="header-title">
          <h2>Live Event Stream (SSE)</h2>
          <p>Real-time telemetry stream capturing cache hits, misses, stampede deduplications, and invalidations.</p>
        </div>
        <div class="header-actions">
          <button class="btn" id="pause-btn" onclick="togglePause()">Pause</button>
          <button class="btn" onclick="clearEvents()">Clear Feed</button>
        </div>
      </div>

      <div class="toolbar">
        <span style="display:flex; align-items:center; gap:8px;">
          <span id="sse-dot" class="pulse-dot off"></span>
          <span id="sse-state" style="color:var(--text-muted); font-size:12px;">connecting...</span>
        </span>
        <div class="filter-group" style="margin-left:auto;">
          <span class="filter-badge active" onclick="setEventFilter('')">All</span>
          <span class="filter-badge" onclick="setEventFilter('hit')">Hits</span>
          <span class="filter-badge" onclick="setEventFilter('miss')">Misses</span>
          <span class="filter-badge" onclick="setEventFilter('inflight')">In-Flight</span>
          <span class="filter-badge" onclick="setEventFilter('set')">Sets</span>
          <span class="filter-badge" onclick="setEventFilter('delete')">Deletes</span>
        </div>
      </div>

      <div id="events-feed" class="event-feed"></div>
    </section>

    <!-- 5. CONFIG -->
    <section id="config" class="section">
      <div class="header">
        <div class="header-title">
          <h2>System Topologies &amp; Config</h2>
          <p>Resolved runtime settings, compression tiers, and event bus transports.</p>
        </div>
      </div>
      <div id="cfg"></div>
    </section>
  </main>
</div>

<div id="toast">Counters reset to 0</div>

<script>
window.__OBS_BASE__ = ${baseJson};
(function () {
  var BASE = window.__OBS_BASE__;
  var chartHistory = [];
  var MAX_POINTS = 35;
  var currentTab = "overview";
  var eventFilter = "";
  var l2ViewMode = "table"; // "table" or "tree"

  // ── Theme Switcher ──
  function applyTheme(theme) {
    if (theme === "light") {
      document.documentElement.classList.remove("dark");
      document.documentElement.classList.add("light");
      document.getElementById("theme-icon-moon").style.display = "none";
      document.getElementById("theme-icon-sun").style.display = "block";
    } else {
      document.documentElement.classList.remove("light");
      document.documentElement.classList.add("dark");
      document.getElementById("theme-icon-moon").style.display = "block";
      document.getElementById("theme-icon-sun").style.display = "none";
    }
    localStorage.setItem("lazylayers-theme", theme);
    redrawChart();
  }

  window.toggleTheme = function () {
    var isDark = document.documentElement.classList.contains("dark");
    applyTheme(isDark ? "light" : "dark");
  };

  var savedTheme = localStorage.getItem("lazylayers-theme") || "dark";
  applyTheme(savedTheme);

  function api(path) {
    return fetch(BASE + path, { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;";
    });
  }

  function bytes(n) {
    if (n == null) return "—";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(2) + " MB";
  }

  function ttl(ms) {
    if (ms == null) return "—";
    if (ms < 0) return "no expiry";
    if (ms < 1000) return ms.toFixed(0) + "ms";
    return Math.round(ms / 1000) + "s";
  }

  function pct(r) { return r != null ? (r * 100).toFixed(1) + "%" : "—"; }

  function showToast(msg) {
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(function () { t.classList.remove("show"); }, 2000);
  }

  // ── Tab Navigation ──
  var buttons = document.querySelectorAll("nav button");
  buttons.forEach(function (b) {
    b.addEventListener("click", function () {
      buttons.forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      document.querySelectorAll(".section").forEach(function (s) { s.classList.remove("active"); });
      var tab = b.dataset.tab;
      currentTab = tab;
      document.getElementById(tab).classList.add("active");
      if (tab === "l1") loadL1(true);
      if (tab === "l2") loadL2(true);
      if (tab === "config") loadConfig();
    });
  });

  // ── Hero Column Card with Hover Popover ──
  function heroCard(label, val, sub, tipTitle, tipDesc, formula, iconSvg) {
    return '<div class="hero-col">' +
      '<div class="hero-header">' +
        '<span class="hero-label">' + iconSvg + ' ' + esc(label) + '</span>' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-muted);"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' +
      '</div>' +
      '<div class="hero-val">' + esc(val) + '</div>' +
      '<div class="hero-sub">' + esc(sub) + '</div>' +
      '<div class="tooltip-pop">' +
        '<div class="tooltip-title">' + iconSvg + ' ' + esc(tipTitle) + '</div>' +
        '<div class="tooltip-body">' + esc(tipDesc) + '</div>' +
        (formula ? '<div class="tooltip-formula">' + esc(formula) + '</div>' : '') +
        '<div class="tooltip-arrow"></div>' +
      '</div>' +
    '</div>';
  }

  function metricItem(label, val, sub, tipTitle, tipDesc) {
    return '<div class="metric-item">' +
      '<div class="metric-top">' +
        '<span class="metric-label">' + esc(label) + '</span>' +
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-muted);"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>' +
      '</div>' +
      '<div class="metric-num">' + esc(val) + '</div>' +
      '<div class="metric-sub">' + esc(sub) + '</div>' +
      '<div class="tooltip-pop">' +
        '<div class="tooltip-title">' + esc(tipTitle) + '</div>' +
        '<div class="tooltip-body">' + esc(tipDesc) + '</div>' +
        '<div class="tooltip-arrow"></div>' +
      '</div>' +
    '</div>';
  }

  // ── Interactive Canvas Chart with Crosshairs & Popover ──
  var chartCanvas = document.getElementById("interactive-chart");
  var chartTooltip = document.getElementById("chart-tooltip");
  var mouseX = -1;

  function resizeCanvas() {
    if (!chartCanvas) return;
    var rect = chartCanvas.getBoundingClientRect();
    chartCanvas.width = rect.width * (window.devicePixelRatio || 1);
    chartCanvas.height = rect.height * (window.devicePixelRatio || 1);
    redrawChart();
  }
  window.addEventListener("resize", resizeCanvas);

  function redrawChart() {
    if (!chartCanvas || chartHistory.length < 2) return;
    var ctx = chartCanvas.getContext("2d");
    var w = chartCanvas.width;
    var h = chartCanvas.height;
    var dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, w, h);

    var isDark = document.documentElement.classList.contains("dark");
    var gridColor = isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)";
    var cyanLine = isDark ? "#38bdf8" : "#0284c7";

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1 * dpr;
    for (var i = 1; i <= 3; i++) {
      var y = (h / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    var pts = chartHistory;
    var step = w / (MAX_POINTS - 1);
    var startIdx = MAX_POINTS - pts.length;

    // Draw Offload Area & Line
    ctx.beginPath();
    pts.forEach(function (pt, idx) {
      var x = (startIdx + idx) * step;
      var y = h - (pt.offload / 100) * (h - 30 * dpr) - 15 * dpr;
      if (idx === 0) ctx.moveTo(x, y);
      else {
        var prevX = (startIdx + idx - 1) * step;
        var prevY = h - (pts[idx - 1].offload / 100) * (h - 30 * dpr) - 15 * dpr;
        var cx = (prevX + x) / 2;
        ctx.bezierCurveTo(cx, prevY, cx, y, x, y);
      }
    });

    var lastX = (startIdx + pts.length - 1) * step;
    var firstX = startIdx * step;
    ctx.lineTo(lastX, h);
    ctx.lineTo(firstX, h);
    ctx.closePath();
    var grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, isDark ? "rgba(56, 189, 248, 0.25)" : "rgba(2, 132, 199, 0.18)");
    grad.addColorStop(1, "rgba(56, 189, 248, 0.0)");
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    pts.forEach(function (pt, idx) {
      var x = (startIdx + idx) * step;
      var y = h - (pt.offload / 100) * (h - 30 * dpr) - 15 * dpr;
      if (idx === 0) ctx.moveTo(x, y);
      else {
        var prevX = (startIdx + idx - 1) * step;
        var prevY = h - (pts[idx - 1].offload / 100) * (h - 30 * dpr) - 15 * dpr;
        var cx = (prevX + x) / 2;
        ctx.bezierCurveTo(cx, prevY, cx, y, x, y);
      }
    });
    ctx.strokeStyle = cyanLine;
    ctx.lineWidth = 2.5 * dpr;
    ctx.stroke();

    // Crosshairs on Mouse Hover
    if (mouseX >= 0 && mouseX <= w / dpr) {
      var targetIdx = Math.round((mouseX * dpr - firstX) / step);
      if (targetIdx >= 0 && targetIdx < pts.length) {
        var hoverPt = pts[targetIdx];
        var hx = (startIdx + targetIdx) * step;
        var hy = h - (hoverPt.offload / 100) * (h - 30 * dpr) - 15 * dpr;

        ctx.strokeStyle = isDark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.25)";
        ctx.setLineDash([4 * dpr, 4 * dpr]);
        ctx.beginPath();
        ctx.moveTo(hx, 0);
        ctx.lineTo(hx, h);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.beginPath();
        ctx.arc(hx, hy, 5 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = cyanLine;
        ctx.fill();
        ctx.strokeStyle = isDark ? "#090a0f" : "#ffffff";
        ctx.lineWidth = 2 * dpr;
        ctx.stroke();

        chartTooltip.style.opacity = "1";
        var rect = chartCanvas.getBoundingClientRect();
        var tipLeft = Math.min(Math.max(10, hx / dpr - 75), rect.width - 160);
        chartTooltip.style.transform = "translate(" + tipLeft + "px, " + Math.max(10, hy / dpr - 70) + "px)";
        chartTooltip.innerHTML = 
          '<div style="font-weight:700; color:' + cyanLine + '; margin-bottom:3px;">' + hoverPt.offload.toFixed(1) + '% Offload</div>' +
          '<div style="color:var(--text-muted); font-size:10px;">Hits: ' + hoverPt.hits + ' · Inflight: ' + hoverPt.inflight + '</div>' +
          '<div style="color:var(--text-muted); font-size:10px;">Origin DB Loads: ' + hoverPt.dbQueries + '</div>';
      }
    }
  }

  if (chartCanvas) {
    chartCanvas.addEventListener("mousemove", function (e) {
      var rect = chartCanvas.getBoundingClientRect();
      mouseX = e.clientX - rect.left;
      redrawChart();
    });

    chartCanvas.addEventListener("mouseleave", function () {
      mouseX = -1;
      chartTooltip.style.opacity = "0";
      redrawChart();
    });
  }

  // ── Overview Data Fetcher ──
  function loadOverview() {
    api("/api/overview").then(function (o) {
      var c = o.counters;
      var directHits = o.hits;
      var inflightSaved = c.inflightReuse;
      var originQueries = c.loaderSuccess;
      var totalHandled = directHits + inflightSaved + originQueries;
      var offloadRatio = totalHandled > 0 ? ((directHits + inflightSaved) / totalHandled) * 100 : 100;
      var offloadPct = offloadRatio.toFixed(1) + "%";

      chartHistory.push({
        ts: Date.now(),
        offload: offloadRatio,
        hits: directHits,
        inflight: inflightSaved,
        dbQueries: originQueries
      });
      if (chartHistory.length > MAX_POINTS) chartHistory.shift();
      redrawChart();

      // Update Traffic Distribution Stacked Bar
      var l1Hits = c.hitsL1;
      var l2Hits = c.hitsL2;
      var l1Pct = totalHandled > 0 ? (l1Hits / totalHandled) * 100 : 0;
      var l2Pct = totalHandled > 0 ? (l2Hits / totalHandled) * 100 : 0;
      var infPct = totalHandled > 0 ? (inflightSaved / totalHandled) * 100 : 0;
      var dbPct = totalHandled > 0 ? (originQueries / totalHandled) * 100 : 0;

      document.getElementById("seg-l1").style.width = l1Pct.toFixed(1) + "%";
      document.getElementById("seg-l2").style.width = l2Pct.toFixed(1) + "%";
      document.getElementById("seg-inflight").style.width = infPct.toFixed(1) + "%";
      document.getElementById("seg-db").style.width = dbPct.toFixed(1) + "%";

      document.getElementById("dist-total-label").textContent = totalHandled.toLocaleString() + " total requests";
      document.getElementById("label-l1").textContent = "L1 Memory: " + l1Hits + " (" + l1Pct.toFixed(1) + "%)";
      document.getElementById("label-l2").textContent = "L2 Redis: " + l2Hits + " (" + l2Pct.toFixed(1) + "%)";
      document.getElementById("label-inflight").textContent = "In-Flight: " + inflightSaved + " (" + infPct.toFixed(1) + "%)";
      document.getElementById("label-db").textContent = "Origin DB: " + originQueries + " (" + dbPct.toFixed(1) + "%)";

      // 4 Hero Metric Cards
      var shieldSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--brand-emerald)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
      var zapSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--brand-cyan)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
      var tornadoSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--brand-purple)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4H3"/><path d="M18 8H6"/><path d="M19 12H9"/><path d="M16 16h-6"/><path d="M11 20H9"/></svg>';
      var dbSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--brand-amber)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>';

      var heroHtml = "";
      heroHtml += heroCard("Origin Offload", offloadPct, "Traffic saved from DB query",
        "Origin Database Protection",
        "Percentage of total read traffic resolved entirely from L1/L2 memory or in-flight deduplication without touching your database.",
        "(Hits + Inflight) / Total × 100%", shieldSvg);

      heroHtml += heroCard("Direct Cache Hits", directHits.toLocaleString(), "L1 RAM / L2 Redis lookups",
        "Direct Cache Hits",
        "Sub-millisecond reads served immediately from in-memory L1 LRU (<0.1ms) or remote L2 Redis (<1.5ms).",
        "L1 Hits + L2 Hits", zapSvg);

      heroHtml += heroCard("In-Flight Coalesced", inflightSaved.toLocaleString(), "Thundering herd queries saved",
        "In-Flight Mutex Deduplication",
        "Concurrent duplicate requests attached to a single in-flight database loader promise, eliminating database stampedes.",
        "Deduplicated Concurrent Callers", tornadoSvg);

      heroHtml += heroCard("Origin DB Queries", originQueries.toLocaleString(), "Cold fallback loads",
        "Origin Database Queries",
        "Actual database queries executed to fetch fresh data on cold cache misses.",
        "Cache Miss Database Loads", dbSvg);

      document.getElementById("hero-grid").innerHTML = heroHtml;

      // Secondary Grid
      var secHtml = "";
      secHtml += metricItem("Total Requests", totalHandled.toLocaleString(), "Hits + Inflight + DB loads",
        "Total Serviced Requests", "Cumulative total of all read requests processed across all layers.");

      secHtml += metricItem("Server Uptime", Math.round(o.uptimeMs / 1000) + "s", "Active instance time",
        "Active Uptime", "Elapsed duration since the LazyLayers cache engine was initialized.");

      secHtml += metricItem("Cache Sets", c.sets.toLocaleString(), "Keys stored into cache",
        "Cache Writes (Sets)", "Values serialized, compressed (Zstd/LZ4), and stored into L1/L2.");

      secHtml += metricItem("Evictions & Purges", (c.deletes + c.deletePatterns).toLocaleString(), "Keys removed",
        "Invalidations & Deletions", "Keys evicted via direct delete, wildcard pattern wipe, or cluster broadcast.");

      secHtml += metricItem("Loader Status", c.loaderSuccess + " / " + c.loaderError, "Success / Failures",
        "Loader Status", "Ratio of successful origin database loads vs runtime errors.");

      secHtml += metricItem("Loader Timeouts", c.loaderTimeout.toLocaleString(), "Hard timeouts aborted",
        "Hard Timeouts", "Queries that exceeded the configured timeout threshold and were cleanly aborted.");

      secHtml += metricItem("Stale Served", c.staleHit.toLocaleString(), "Fail-safe fallbacks",
        "Fail-Safe Stale Fallbacks", "Stale cached copies served during origin database outages to guarantee 100% uptime.");

      secHtml += metricItem("Negative Cached", c.negativeSet.toLocaleString(), "Missing 404 keys cached",
        "Negative Caching (404s)", "Non-existent records cached to protect origin database against penetration attacks.");

      secHtml += metricItem("Circuit Breaker", c.l2Error > 0 ? "TRIPPED" : "CLOSED", "Resilience state",
        "Circuit Breaker Status", "Fail-open resilience protecting Redis and Event Buses from cascading failures.");

      secHtml += metricItem("Cluster Events", c.invalidationReceived.toLocaleString(), "Event bus messages",
        "Cluster Sync Messages", "Cross-instance sync events received via Redis Pub/Sub, RabbitMQ, or NATS.");

      document.getElementById("secondary-grid").innerHTML = secHtml;

      // If L1 or L2 tab is active, auto-refresh them
      if (currentTab === "l1") loadL1(false);
      if (currentTab === "l2") loadL2(false);
    }).catch(function () {});
  }

  window.resetMetrics = function () {
    fetch(BASE + "/api/reset", { method: "POST", credentials: "same-origin" }).then(function () {
      chartHistory = [];
      loadOverview();
      showToast("Counters reset to 0");
    }).catch(function () {});
  };

  // ── L1 Memory Inspector ──
  var l1Cursor = null;
  function rowFor(k) {
    var val = k.truncated
      ? '<span style="color:var(--text-muted);">truncated (' + bytes(k.serializedBytes) + ")</span>"
      : "<pre>" + esc(typeof k.value === "string" ? k.value : JSON.stringify(k.value, null, 2)) + "</pre>";
    return "<tr>" +
      "<td><code>" + esc(k.key) + "</code></td>" +
      '<td><span class="pill ' + esc(k.encoding) + '">' + esc(k.encoding) + "</span></td>" +
      "<td>" + bytes(k.serializedBytes) + "</td>" +
      "<td>" + bytes(k.deserializedBytes) + "</td>" +
      '<td style="color:var(--brand-emerald); font-weight:600;">' + pct(k.compressionRatio) + "</td>" +
      "<td>" + ttl(k.ttlRemainingMs) + "</td>" +
      "<td>" + val + "</td>" +
      "</tr>";
  }

  window.loadL1 = function (reset) {
    if (reset) { l1Cursor = null; }
    var m = document.getElementById("l1-match") ? document.getElementById("l1-match").value.trim() : "";
    var q = "/api/l1?limit=100" + (m ? "&match=" + encodeURIComponent(m) : "");
    api(q).then(function (r) {
      if (!r || !r.keys) {
        document.getElementById("l1-info").textContent = "L1 empty or not configured";
        document.getElementById("l1-body").innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:20px;">No cached keys in L1 Memory.</td></tr>';
        return;
      }
      if (r.keys.length === 0) {
        document.getElementById("l1-body").innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:20px;">No keys match the filter.</td></tr>';
      } else {
        document.getElementById("l1-body").innerHTML = r.keys.map(rowFor).join("");
      }
      document.getElementById("l1-info").textContent = r.keys.length + " keys loaded (total size: " + r.size + ")";
    }).catch(function () {
      document.getElementById("l1-info").textContent = "L1 unavailable";
    });
  };

  // ── L2 Redis Explorer (Table & Tree Views) ──
  var l2Keys = [];
  window.toggleL2View = function () {
    l2ViewMode = l2ViewMode === "table" ? "tree" : "table";
    document.getElementById("l2-view-btn").textContent = "Toggle View: " + (l2ViewMode === "table" ? "Tree" : "Table");
    renderL2View();
  };

  function renderL2View() {
    var container = document.getElementById("l2-content");
    if (!l2Keys || l2Keys.length === 0) {
      container.innerHTML = '<div style="padding:24px; text-align:center; color:var(--text-muted);">No keys found in L2 Redis.</div>';
      return;
    }

    if (l2ViewMode === "table") {
      var html = '<table><thead><tr><th>Redis Key</th><th>Encoding</th><th>Wire Size</th><th>Memory Size</th><th>Compression Savings</th><th>TTL Remaining</th><th>Value Preview</th></tr></thead><tbody>';
      html += l2Keys.map(rowFor).join("");
      html += '</tbody></table>';
      container.innerHTML = html;
    } else {
      var tree = buildTree(l2Keys);
      container.innerHTML = '<div style="padding:16px;">' + (Object.keys(tree._c || {}).map(function (c) { return renderNode(c, tree._c[c]); }).join("") || '<p style="color:var(--text-muted);">No keys in L2.</p>') + '</div>';
    }
  }

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
      var val = k.truncated
        ? '<span style="color:var(--text-muted);">truncated (' + bytes(k.serializedBytes) + ")</span>"
        : "<pre>" + esc(typeof k.value === "string" ? k.value : JSON.stringify(k.value, null, 2)) + "</pre>";
      var det = '<div style="display:none; padding:8px 12px; margin-top:6px; background:var(--bg-elevated); border-radius:6px;">' +
        '<div style="font-size:11px; color:var(--text-muted); margin-bottom:6px;">' +
        '<span class="pill ' + esc(k.encoding) + '">' + esc(k.encoding) + "</span> · Wire: " +
        bytes(k.serializedBytes) + " · Mem: " + bytes(k.deserializedBytes) + " · Saved: " + pct(k.compressionRatio) +
        " · TTL: " + ttl(k.ttlRemainingMs) + "</div>" + val + "</div>";
      return '<div style="margin:3px 0;">' +
        '<div onclick="var d=this.nextSibling; d.style.display=d.style.display===\\'none\\'?\\'block\\':\\'none\\';" style="cursor:pointer; padding:4px 8px; border-radius:4px; display:flex; align-items:center; gap:6px;">' +
        '<span style="color:var(--text-muted); font-size:10px;">▸</span>' +
        '<span style="font-family:var(--font-mono); color:var(--brand-cyan);">' + esc(name) + '</span>' +
        '</div>' + det + '</div>';
    }
    var children = Object.keys(node._c || {}).map(function (c) { return renderNode(c, node._c[c]); }).join("");
    return '<div style="margin:3px 0; padding-left:12px; border-left:1px solid var(--border-subtle);">' +
      '<div style="color:var(--text-secondary); font-weight:600; font-size:12px; padding:2px 0;">📁 ' + esc(name) + '</div>' +
      '<div>' + children + '</div></div>';
  }

  window.loadL2 = function (reset) {
    var m = document.getElementById("l2-match") ? document.getElementById("l2-match").value.trim() : "";
    var q = "/api/l2?limit=100" + (m ? "&match=" + encodeURIComponent(m) : "");
    api(q).then(function (r) {
      if (!r || !r.keys) {
        document.getElementById("l2-info").textContent = "L2 Redis empty or not configured";
        l2Keys = [];
        renderL2View();
        return;
      }
      l2Keys = r.keys;
      document.getElementById("l2-info").textContent = l2Keys.length + " keys loaded (total: " + r.size + ")";
      renderL2View();
    }).catch(function () {
      document.getElementById("l2-info").textContent = "L2 Redis unavailable";
    });
  };

  // ── Live SSE Stream with Filter Badges & Millisecond Precision ──
  var events = []; var paused = false; var MAX_UI = 500;
  window.togglePause = function () {
    paused = !paused;
    document.getElementById("pause-btn").textContent = paused ? "Resume" : "Pause";
  };
  window.clearEvents = function () { events = []; renderEvents(); };

  window.setEventFilter = function (f) {
    eventFilter = f.toLowerCase();
    document.querySelectorAll(".filter-badge").forEach(function (b) {
      if (b.textContent.toLowerCase() === (f || "all")) b.classList.add("active");
      else b.classList.remove("active");
    });
    renderEvents();
  };

  window.renderEvents = function () {
    var rows = events.filter(function (e) {
      return !eventFilter || e.type.toLowerCase().indexOf(eventFilter) >= 0;
    }).slice(-MAX_UI).reverse();

    if (rows.length === 0) {
      document.getElementById("events-feed").innerHTML = '<div style="padding:24px; text-align:center; color:var(--text-muted);">No events recorded yet. Run requests from the demo to see live telemetry.</div>';
      return;
    }

    document.getElementById("events-feed").innerHTML = rows.map(function (e) {
      var d = Object.assign({}, e.data);
      var typeClass = e.type.indexOf("hit") >= 0 ? "hit" : (e.type.indexOf("miss") >= 0 ? "miss" : (e.type.indexOf("inflight") >= 0 ? "inflight" : (e.type.indexOf("set") >= 0 ? "set" : "delete")));
      var dt = new Date(e.ts);
      var timeStr = dt.toLocaleTimeString() + "." + String(dt.getMilliseconds()).padStart(3, "0");
      return '<div class="ev-row">' +
        '<span class="ev-time">' + timeStr + '</span>' +
        '<span class="ev-type ' + typeClass + '">' + esc(e.type) + '</span>' +
        '<span class="ev-data">' + esc(JSON.stringify(d)) + '</span>' +
        '</div>';
    }).join("");
  };

  function pushEvent(e) {
    events.push(e);
    if (events.length > MAX_UI * 2) events = events.slice(-MAX_UI);
    if (!paused) renderEvents();
  }

  function connectSSE() {
    var es = new EventSource(BASE + "/stream", { withCredentials: true });
    es.onopen = function () {
      document.getElementById("sse-dot").className = "pulse-dot on";
      document.getElementById("sse-state").textContent = "Live SSE Connected";
    };
    es.onerror = function () {
      document.getElementById("sse-dot").className = "pulse-dot off";
      document.getElementById("sse-state").textContent = "Reconnecting...";
    };
    es.onmessage = function (msg) {
      try { pushEvent(JSON.parse(msg.data)); } catch (e) {}
    };
  }

  // ── Config ──
  function loadConfig() {
    api("/api/config").then(function (c) {
      var html = "";
      function cardBox(title, obj) {
        return '<div class="table-box" style="padding:16px; margin-bottom:14px;">' +
          '<div style="font-size:11px; font-weight:700; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;">' + esc(title) + '</div>' +
          '<pre>' + esc(JSON.stringify(obj, null, 2)) + '</pre></div>';
      }
      html += cardBox("Layers Architecture", c.layers);
      html += cardBox("Resilience & Circuit Breakers", c.resilience);
      html += cardBox("Event Bus Transports", c.eventBus);
      html += cardBox("Features & Policies", c.features);
      document.getElementById("cfg").innerHTML = html;
    }).catch(function () {
      document.getElementById("cfg").innerHTML = '<p style="color:var(--text-muted);">Config unavailable.</p>';
    });
  }

  // ── Boot ──
  setTimeout(resizeCanvas, 60);
  loadOverview();
  setInterval(loadOverview, 2000);
  connectSSE();
})();
</script>
</body>
</html>`;
}
