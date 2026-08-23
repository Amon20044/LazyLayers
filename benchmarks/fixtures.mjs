// Realistic cache payloads. Deterministic (seeded) so runs are reproducible.
let seed = 42;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
function pick(a) { return a[Math.floor(rnd() * a.length)]; }
function id(n = 12) { let s = ''; const c = 'abcdef0123456789'; for (let i = 0; i < n; i++) s += c[Math.floor(rnd() * 16)]; return s; }

const FIRST = ['Ada','Grace','Alan','Linus','Barbara','Ken','Margaret','Dennis','Radia','Katherine'];
const LAST  = ['Lovelace','Hopper','Turing','Torvalds','Liskov','Thompson','Hamilton','Ritchie','Perlman','Johnson'];
const CITY  = ['Bengaluru','Berlin','Austin','Lisbon','Toronto','Singapore','Warsaw','Nairobi'];
const PLAN  = ['free','pro','team','enterprise'];

export function user() {
  return {
    id: id(24), email: `${id(8)}@example.com`,
    firstName: pick(FIRST), lastName: pick(LAST),
    plan: pick(PLAN), createdAt: 1700000000000 + Math.floor(rnd() * 5e8),
    lastSeenAt: 1740000000000 + Math.floor(rnd() * 5e7),
    verified: rnd() > 0.3, mfaEnabled: rnd() > 0.6,
    city: pick(CITY), timezone: 'Asia/Kolkata', locale: 'en-US',
    roles: ['member', ...(rnd() > 0.8 ? ['admin'] : [])],
    quota: { seats: Math.floor(rnd() * 50) + 1, storageBytes: Math.floor(rnd() * 1e10), apiCallsMonth: Math.floor(rnd() * 1e6) },
  };
}

// "session" — small, hottest key shape in most apps
export function session() {
  return { uid: id(24), sid: id(32), exp: 1740000000000 + 86400000, scopes: ['read','write'], ip: `10.${Math.floor(rnd()*255)}.${Math.floor(rnd()*255)}.${Math.floor(rnd()*255)}` };
}

// "api response" — list endpoint, the classic cache target
export function apiList(n = 50) {
  return { page: 1, perPage: n, total: 4821, hasMore: true, items: Array.from({ length: n }, user) };
}

// "timeseries" — numeric-heavy analytics, where binary encoding wins hardest
export function timeseries(points = 1440) {
  const t0 = 1740000000000;
  return {
    metric: 'http.request.duration', unit: 'ms', resolution: '1m',
    series: Array.from({ length: points }, (_, i) => ({
      t: t0 + i * 60000,
      p50: Math.round(rnd() * 120 * 100) / 100,
      p95: Math.round(rnd() * 900 * 100) / 100,
      p99: Math.round(rnd() * 2400 * 100) / 100,
      count: Math.floor(rnd() * 5000),
      errors: Math.floor(rnd() * 40),
    })),
  };
}

// "product catalog" — big, repetitive text; the gzip path
export function catalog(n = 400) {
  const DESC = 'Durable stainless steel construction with a powder-coated finish. Dishwasher safe. Ships in recyclable packaging.';
  return {
    updatedAt: 1740000000000,
    products: Array.from({ length: n }, () => ({
      sku: id(10).toUpperCase(), title: `${pick(FIRST)} ${pick(LAST)} Signature Series`,
      description: DESC, price: Math.floor(rnd() * 20000) / 100, currency: 'USD',
      inStock: rnd() > 0.2, categories: ['home','kitchen','cookware'],
      rating: Math.round(rnd() * 50) / 10, reviewCount: Math.floor(rnd() * 4000),
    })),
  };
}

export const FIXTURES = [
  { name: 'Session token',    build: () => session() },
  { name: 'User profile',     build: () => user() },
  { name: 'API list (50)',    build: () => apiList(50) },
  { name: 'Metrics (24h/1m)', build: () => timeseries(1440) },
  { name: 'Product catalog',  build: () => catalog(400) },
];
