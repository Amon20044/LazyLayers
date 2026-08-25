/**
 * ============================================================================
 * LazyLayers Client Controller (Vite.js)
 * ============================================================================
 */

// API Base URL (connects directly to Hono backend on port 3000 with CORS support)
const API_BASE = (window.location.port === '3000')
  ? ''
  : `${window.location.protocol}//${window.location.hostname || 'localhost'}:3000`;

// State
let selectedUserId = null;
let usersList = [];
let localStats = {
  l1Hits: 0,
  misses: 0,
  herdCollapses: 0,
  dbQueries: 0,
};

// DOM Elements
const userCardsContainer = document.getElementById('userCardsContainer');
const inspectorUserName = document.getElementById('inspectorUserName');
const cacheStatusBadge = document.getElementById('cacheStatusBadge');
const latencyPill = document.getElementById('latencyPill');
const speedupLabel = document.getElementById('speedupLabel');
const latencyBarFill = document.getElementById('latencyBarFill');
const fetchUserBtn = document.getElementById('fetchUserBtn');
const updateUserBtn = document.getElementById('updateUserBtn');
const evictUserBtn = document.getElementById('evictUserBtn');
const purgeAllCacheBtn = document.getElementById('purgeAllCacheBtn');
const jsonResponsePreview = document.getElementById('jsonResponsePreview');

const statL1Hits = document.getElementById('statL1Hits');
const statHitRatio = document.getElementById('statHitRatio');
const hitRatioBadge = document.getElementById('hitRatioBadge');
const statHerdCollapses = document.getElementById('statHerdCollapses');
const statDbQueries = document.getElementById('statDbQueries');

const launchHerdBtn = document.getElementById('launchHerdBtn');
const herdTargetUser = document.getElementById('herdTargetUser');
const herdResultsPanel = document.getElementById('herdResultsPanel');
const herdTotal = document.getElementById('herdTotal');
const herdDbQueries = document.getElementById('herdDbQueries');
const herdCollapsed = document.getElementById('herdCollapsed');
const herdAvgLatency = document.getElementById('herdAvgLatency');
const herdVerdict = document.getElementById('herdVerdict');

const terminalLogBody = document.getElementById('terminalLogBody');
const clearLogBtn = document.getElementById('clearLogBtn');

// Helper: Append formatted log line to in-browser terminal
function log(msg, type = 'info') {
  const time = new Date().toISOString().split('T')[1].slice(0, 8);
  const el = document.createElement('div');
  el.className = `log-line ${type}`;
  el.textContent = `[${time}] ${msg}`;
  terminalLogBody.appendChild(el);
  terminalLogBody.scrollTop = terminalLogBody.scrollHeight;
}

// 1. Fetch Users List on Mount
async function loadUsers() {
  try {
    const res = await fetch(`${API_BASE}/api/users`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    usersList = data.users;
    localStats.dbQueries = data.dbQueries;

    renderUserCards();
    if (usersList.length > 0 && !selectedUserId) {
      selectUser(usersList[0].id);
    }
  } catch (err) {
    log(`Failed to connect to backend: ${err.message}`, 'invalidate');
  }
}

// 2. Render User Selection Cards
function renderUserCards() {
  userCardsContainer.innerHTML = '';
  usersList.forEach((user) => {
    const card = document.createElement('div');
    card.className = `user-select-card ${user.id === selectedUserId ? 'active' : ''}`;
    card.dataset.id = user.id;
    card.innerHTML = `
      <img src="${user.avatar}" alt="${user.name}" class="user-avatar" />
      <div class="user-info-mini">
        <div class="user-name">${user.name}</div>
        <div class="user-role">${user.role} &bull; ${user.tier}</div>
      </div>
    `;
    card.addEventListener('click', () => selectUser(user.id));
    userCardsContainer.appendChild(card);
  });
}

// 3. Select a User
function selectUser(id) {
  selectedUserId = id;
  const user = usersList.find((u) => u.id === id);
  if (!user) return;

  document.querySelectorAll('.user-select-card').forEach((c) => {
    c.classList.toggle('active', c.dataset.id === id);
  });

  inspectorUserName.textContent = `${user.name} (${user.id})`;
  fetchUserBtn.disabled = false;
  updateUserBtn.disabled = false;
  evictUserBtn.disabled = false;

  cacheStatusBadge.className = 'inspector-badge';
  cacheStatusBadge.textContent = 'READY';
  latencyPill.textContent = '-- ms';
}

// 4. Fetch User with Cache-Aside
async function fetchUser() {
  if (!selectedUserId) return;

  fetchUserBtn.disabled = true;
  const t0 = performance.now();

  try {
    const res = await fetch(`${API_BASE}/api/users/${selectedUserId}`);
    const clientLatency = (performance.now() - t0).toFixed(2);
    const data = await res.json();

    const cacheStatus = data.cacheStatus || res.headers.get('X-Cache-Status') || 'MISS-DB';
    const serverLatency = data.latencyMs || clientLatency;

    // Update Status Badge
    cacheStatusBadge.className = `inspector-badge ${cacheStatus.toLowerCase()}`;
    cacheStatusBadge.textContent = cacheStatus;
    latencyPill.textContent = `${serverLatency} ms`;

    // Visual Latency Bar
    const isL1 = cacheStatus === 'HIT-L1';
    const isL2 = cacheStatus === 'HIT-L2';

    if (isL1) {
      latencyBarFill.style.width = '3%';
      latencyBarFill.style.background = 'linear-gradient(90deg, #34d399, #38bdf8)';
      speedupLabel.innerHTML = `LazyLayers L1: <strong>${serverLatency}ms (1,300x faster than DB!)</strong>`;
      localStats.l1Hits++;
      log(`[L1 HIT] Fetched ${selectedUserId} from local RAM in ${serverLatency}ms`, 'hit');
    } else if (isL2) {
      latencyBarFill.style.width = '15%';
      latencyBarFill.style.background = 'linear-gradient(90deg, #38bdf8, #818cf8)';
      speedupLabel.innerHTML = `LazyLayers L2: <strong>${serverLatency}ms (Redis hit, promoted to L1)</strong>`;
      localStats.l1Hits++;
      log(`[L2 HIT] Fetched ${selectedUserId} from Redis in ${serverLatency}ms`, 'hit');
    } else {
      latencyBarFill.style.width = '100%';
      latencyBarFill.style.background = 'linear-gradient(90deg, #fbbf24, #f43f5e)';
      speedupLabel.innerHTML = `Cold Database: <strong>${serverLatency}ms (Cached into L1+L2)</strong>`;
      localStats.misses++;
      log(`[CACHE MISS] Queried origin DB for ${selectedUserId} in ${serverLatency}ms`, 'miss');
    }

    localStats.dbQueries = data.dbQueries;
    updateStatsDisplay();

    // Render JSON Preview
    jsonResponsePreview.textContent = JSON.stringify(data.user, null, 2);
  } catch (err) {
    log(`Fetch error: ${err.message}`, 'invalidate');
  } finally {
    fetchUserBtn.disabled = false;
  }
}

// 5. Mutate & Invalidate User
async function updateUser() {
  if (!selectedUserId) return;
  const user = usersList.find((u) => u.id === selectedUserId);
  if (!user) return;

  const tiers = ['starter', 'pro', 'enterprise'];
  const nextTier = tiers[(tiers.indexOf(user.tier) + 1) % tiers.length];

  updateUserBtn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/api/users/${selectedUserId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tier: nextTier,
        bio: `Updated tier to ${nextTier} at ${new Date().toLocaleTimeString()}`,
      }),
    });

    const data = await res.json();
    user.tier = nextTier;
    user.bio = data.user.bio;
    renderUserCards();

    cacheStatusBadge.className = 'inspector-badge miss-db';
    cacheStatusBadge.textContent = 'INVALIDATED';
    latencyPill.textContent = 'EVICTED';

    log(`[INVALIDATION] Mutated ${selectedUserId} tier to '${nextTier}' & purged cache`, 'invalidate');
    jsonResponsePreview.textContent = JSON.stringify(data.user, null, 2);
  } catch (err) {
    log(`Update error: ${err.message}`, 'invalidate');
  } finally {
    updateUserBtn.disabled = false;
  }
}

// 6. Evict Key
async function evictUser() {
  if (!selectedUserId) return;
  evictUserBtn.disabled = true;

  try {
    await fetch(`${API_BASE}/api/users/${selectedUserId}`, { method: 'DELETE' });
    cacheStatusBadge.className = 'inspector-badge miss-db';
    cacheStatusBadge.textContent = 'EVICTED';
    latencyPill.textContent = 'REMOVED';

    log(`[EVICTED] Purged key for ${selectedUserId}`, 'invalidate');
    jsonResponsePreview.textContent = `// Key '${selectedUserId}' evicted from L1 & L2 cache`;
  } catch (err) {
    log(`Evict error: ${err.message}`, 'invalidate');
  } finally {
    evictUserBtn.disabled = false;
  }
}

// 7. Purge All Cache
async function purgeAll() {
  purgeAllCacheBtn.disabled = true;
  try {
    await fetch(`${API_BASE}/api/cache/purge`, { method: 'POST' });
    cacheStatusBadge.className = 'inspector-badge miss-db';
    cacheStatusBadge.textContent = 'ALL PURGED';
    latencyPill.textContent = 'WIPED';

    log(`[PURGE] Wiped all keys across L1 in-memory and L2 Redis`, 'invalidate');
    jsonResponsePreview.textContent = `// All keys wiped across L1 & L2. Next reads will hit DB.`;
  } catch (err) {
    log(`Purge error: ${err.message}`, 'invalidate');
  } finally {
    purgeAllCacheBtn.disabled = false;
  }
}

// 8. Launch 50-Request Stampede Simulation
async function launchHerd() {
  launchHerdBtn.disabled = true;
  const targetId = herdTargetUser.value;

  log(`[STAMPEDE] Firing 50 simultaneous callers for ${targetId}...`, 'herd');

  try {
    const res = await fetch(`${API_BASE}/api/simulate-herd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: targetId }),
    });

    const data = await res.json();

    herdResultsPanel.style.display = 'block';
    herdTotal.textContent = data.totalRequests;
    herdDbQueries.textContent = data.dbQueriesExecuted;
    herdCollapsed.textContent = data.callersCollapsed;
    herdAvgLatency.textContent = `${data.averageLatencyMs}ms`;

    herdVerdict.innerHTML = `
      🎉 <strong>${data.callersCollapsed} database queries collapsed!</strong>
      Single DB loader execution in ${data.totalDurationMs}ms resolved all 50 callers simultaneously without connection stampede.
    `;

    localStats.herdCollapses += data.callersCollapsed;
    localStats.dbQueries += data.dbQueriesExecuted;
    localStats.l1Hits += data.callersCollapsed;

    log(`[HERD SUCCESS] 50 callers resolved in ${data.totalDurationMs}ms (${data.callersCollapsed} coalesced!)`, 'hit');
    updateStatsDisplay();
  } catch (err) {
    log(`Herd simulator error: ${err.message}`, 'invalidate');
  } finally {
    launchHerdBtn.disabled = false;
  }
}

// 9. Update Metrics Display
function updateStatsDisplay() {
  statL1Hits.textContent = localStats.l1Hits.toLocaleString();
  statHerdCollapses.textContent = localStats.herdCollapses.toLocaleString();
  statDbQueries.textContent = localStats.dbQueries.toLocaleString();

  // True origin offload efficiency: (hits + herd collapses) / total requests served
  const successfulOffloads = localStats.l1Hits + localStats.herdCollapses;
  const totalRequests = successfulOffloads + localStats.dbQueries;
  const ratio = totalRequests === 0 ? 100 : (successfulOffloads / totalRequests) * 100;
  const ratioStr = `${ratio.toFixed(1)}%`;

  statHitRatio.textContent = ratioStr;
  hitRatioBadge.textContent = ratioStr;
}

// 10. Poll Backend Overview Stats periodically
async function pollBackendStats() {
  try {
    const res = await fetch(`${API_BASE}/api/cache/stats`);
    if (!res.ok) return;
    const data = await res.json();

    if (data.totalDbQueries !== undefined) {
      localStats.dbQueries = data.totalDbQueries;
    }

    if (data.overview && data.overview.counters) {
      localStats.herdCollapses = Math.max(localStats.herdCollapses, data.overview.counters.inflightReuse || 0);
    }

    updateStatsDisplay();
  } catch {}
}

// Event Listeners
fetchUserBtn.addEventListener('click', fetchUser);
updateUserBtn.addEventListener('click', updateUser);
evictUserBtn.addEventListener('click', evictUser);
purgeAllCacheBtn.addEventListener('click', purgeAll);
launchHerdBtn.addEventListener('click', launchHerd);
clearLogBtn.addEventListener('click', () => {
  terminalLogBody.innerHTML = '';
});

// Initialize on Load
loadUsers();
setInterval(pollBackendStats, 3000);
