import { proj, pts } from './isocore';
import { markAt, icon, BRAND, type IconName } from './icons';

/** Build-time SVG artwork. Labels and paths remain readable without JavaScript. */
type Tone = 'lime' | 'violet' | 'cyan' | 'muted' | 'rose';
const escapeText = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function block(x: number, y: number, w = 58, d = 48, h = 12, tone: Tone = 'muted'): string {
  const a = -w / 2, b = w / 2, c = -d / 2, e = d / 2;
  return `<g class="cv-solid cv-${tone}" transform="translate(${x} ${y})">
    <polygon class="cv-left" points="${pts([proj(a,e,0),proj(b,e,0),proj(b,e,h),proj(a,e,h)])}"/>
    <polygon class="cv-right" points="${pts([proj(b,c,0),proj(b,e,0),proj(b,e,h),proj(b,c,h)])}"/>
    <polygon class="cv-top" points="${pts([proj(a,c,h),proj(b,c,h),proj(b,e,h),proj(a,e,h)])}"/>
  </g>`;
}

function label(x: number, y: number, text: string, cls = '', anchor = 'middle'): string {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" class="cv-label ${cls}">${escapeText(text)}</text>`;
}

function wire(d: string, tone: Tone = 'lime', moving = true): string {
  return `<path d="${d}" class="cv-wire cv-${tone}"/>${moving ? `<path d="${d}" class="cv-flow cv-${tone}"/>` : ''}`;
}

/** A shared bus has volume, end caps and couplings; data wires stay thin. */
function conduit(points: [number, number][], tone: Tone = 'cyan', width = 11): string {
  const d = points.map(([x,y],i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ');
  const cuffs = points.map(([x,y]) => `<ellipse cx="${x}" cy="${y}" rx="${width*.48}" ry="${width*.7}" class="cv-pipe-cuff"/>`).join('');
  return `<g class="cv-conduit cv-${tone}">
    <path d="${d}" class="cv-pipe-shadow" stroke-width="${width+3}" transform="translate(0 4)"/>
    <path d="${d}" class="cv-pipe-shell" stroke-width="${width+2}"/>
    <path d="${d}" class="cv-pipe-core" stroke-width="${width-1}"/>
    <path d="${d}" class="cv-pipe-light" stroke-width="1.2" transform="translate(0 -3)"/>
    ${cuffs}<path d="${d}" class="cv-flow"/>
  </g>`;
}

function brandAt(x: number, y: number, size: number): string {
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="95 91 509 509" fill="none" class="cv-brand" aria-hidden="true"><!--@brand-art--></svg>`;
}

function tech(name: IconName, x: number, y: number, size = 20): string {
  return `<g class="cv-tech" aria-label="${name}">${markAt(name,x,y,size,BRAND[name])}</g>`;
}

function transportKey(): string {
  return `<div class="cv-transports" aria-label="Supported event bus transports">
    <span>${icon('redis',18)}Redis Pub/Sub</span><span>${icon('rabbit',18)}RabbitMQ</span><span>${icon('nats',18)}NATS / JetStream</span>
  </div>`;
}

function chip(x: number, y: number, tone: Tone = 'lime', size = 48): string {
  const slots = Array.from({length: 9}, (_, i) => {
    const [sx, sy] = proj((i % 3 - 1) * size / 4, (Math.floor(i / 3) - 1) * size / 4, 13);
    return block(x + sx, y + sy, size / 7, size / 7, 2, i === 2 || i === 6 ? 'muted' : tone);
  }).join('');
  return block(x,y,size,size,12,tone) + slots;
}

function server(x: number, y: number, tone: Tone = 'lime'): string {
  return block(x,y + 7,64,56,5) + [0, 1, 2].map(i => block(x,y - i * 12,49,43,9,i === 2 ? tone : 'muted')).join('') +
    `<g class="cv-${tone}"><path class="cv-led" d="M${x-27} ${y-18}l8 4m-8 9l8 4m-8 9l8 4"/></g>` + tech('node',x+6,y-13,13);
}

function database(x: number, y: number, tone: Tone = 'violet', redis = false): string {
  return `<g class="cv-solid cv-${tone}" transform="translate(${x} ${y})">
    <path class="cv-left" d="M-26-43v39a26 13 0 0 0 52 0v-39"/>
    <path class="cv-db-line" d="M-26-29a26 13 0 0 0 52 0M-26-16a26 13 0 0 0 52 0"/>
    <ellipse class="cv-top" cy="-43" rx="26" ry="13"/>
    <path class="cv-led" d="M-16-19l5 2m-5 10l5 2"/>
  </g>${redis ? tech('redis',x-11,y-32,22) : ''}`;
}

function check(x: number, y: number): string {
  return `<g transform="translate(${x} ${y})" class="cv-check"><circle r="9"/><path d="m-4 0 3 3 5-6"/></g>`;
}

function cross(x: number, y: number): string {
  return `<g transform="translate(${x} ${y})" class="cv-cross"><circle r="9"/><path d="m-3-3 6 6m-6 0 6-6"/></g>`;
}

function svg(id: string, title: string, desc: string, art: string, viewBox = '0 0 320 190'): string {
  return `<svg viewBox="${viewBox}" role="img" aria-labelledby="${id}-title ${id}-desc" xmlns="http://www.w3.org/2000/svg">
    <title id="${id}-title">${escapeText(title)}</title><desc id="${id}-desc">${escapeText(desc)}</desc>${art}</svg>`;
}

function stampede(): string {
  const incoming = [0,1,2,3,4].map(i => {
    const y = 44 + i * 24;
    return wire(`M48 ${y}l40 23L147 103`,'violet') + block(40,y,15,15,5,'violet');
  }).join('');
  return incoming + wire('M166 104l58 33 46-27') + chip(156,108,'lime',52) + database(272,108,'muted') +
    check(184,74) + label(42,176,'N requests','cv-dim') + label(158,156,'dedupe + lock','cv-small') + label(270,150,'1 load','cv-good');
}

function local(): string {
  return wire('M69 98l65 38 62-36') + wire('M198 109l63 37','muted',false) +
    server(66,97,'violet') + chip(194,105,'lime',60) +
    `<path class="cv-return cv-lime" d="M195 67 151 42 104 70"/><path class="cv-return cv-lime" d="m112 59-8 11 15 1"/>` +
    database(268,142,'muted',true) + label(66,154,'app','cv-dim') + label(191,158,'L1 hit','cv-good') + label(272,182,'L2 skipped','cv-dim cv-small');
}

function coherence(): string {
  return conduit([[64,95],[64,96],[160,151],[256,96],[256,95]],'cyan',7) + conduit([[160,82],[160,151]],'cyan',6) +
    [64,160,256].map((x,i) => server(x,i === 1 ? 75 : 91,'cyan') + label(x,i === 1 ? 22 : 38,'v2','cv-good cv-small')).join('') +
    label(160,186,'invalidate · prime · fan out','cv-small');
}

function negative(): string {
  return [0,1,2].map(i => block(37,65+i*29,18,18,6,'violet') + wire(`M47 ${65+i*29}l43 25L148 108`,'violet')).join('') +
    wire('M177 115l70 40','muted',false) + chip(162,108,'lime',60) +
    label(164,78,'∅','cv-null') + database(266,151,'muted') +
    `<path class="cv-stop" d="m218 126-10 18m17-14-10 18"/>` +
    label(49,177,'not found','cv-dim') + label(167,154,'short TTL','cv-good') + label(270,187,'DB spared','cv-dim cv-small');
}

function compression(): string {
  return wire('M87 105l67 39 74-42','cyan') +
    [0,1,2,3].map(i=> block(69,107-i*15,57,49,9,'violet')).join('') +
    `<path class="cv-funnel" d="m124 77 48 28-18 11v28l-10-6v-28z"/>` +
    block(230,108,33,28,10,'lime') + check(251,77) + tech('msgpack',228,116,17) +
    label(66,159,'JSON','cv-dim') + label(156,182,'MessagePack + compression','cv-small') + label(251,154,'fewer bytes','cv-good');
}

function telemetry(): string {
  return wire('M65 104l80 46 86-49','cyan') + server(65,101,'cyan') +
    block(224,138,79,54,5) +
    `<g transform="translate(186 39) skewY(30)">
      <rect width="81" height="70" rx="5" class="cv-screen"/>
      <path d="M9 53h63M9 12h24" class="cv-chart-grid"/>
      <path d="m10 45 11-6 10 3 12-23 12 9 16-13" class="cv-chart"/>
      <circle cx="71" cy="15" r="3" class="cv-chart-dot"/>
    </g>` + label(67,157,'cache events','cv-dim') + label(237,181,'live metrics','cv-good');
}

function hub(): string {
  const rings = [0,1,2].map(i => {
    const w = 154+i*14;
    return `<polygon class="cv-orbit" points="${pts([proj(-w/2,-w/2,0),proj(w/2,-w/2,0),proj(w/2,w/2,0),proj(-w/2,w/2,0)])}" transform="translate(160 ${265+i*4})"/>`;
  }).join('');
  return svg('cache-hub','LazyLayers','LazyLayers connects local memory, shared storage, and coordinated application instances.',`
    <defs><radialGradient id="cv-hub-glow"><stop stop-color="#D3F15D" stop-opacity=".2"/><stop offset="1" stop-color="#D3F15D" stop-opacity="0"/></radialGradient></defs>
    <ellipse cx="160" cy="248" rx="155" ry="115" fill="url(#cv-hub-glow)"/>
    ${rings}
    ${block(160,258,158,158,16)}
    ${block(160,223,142,142,12,'lime')}
    ${block(160,185,123,123,14,'lime')}
    <path class="cv-uplink" d="M53 222v-46m214 46v-46M160 290v-43"/>
    ${brandAt(119,95,82)}
    ${label(160,356,'LazyLayers','cv-hub-name')}
    ${label(160,381,'LESS WORK. AT EVERY LAYER.','cv-small cv-dim')}
  `,'0 0 320 420');
}

const stories = [
  {id:'stampede', problem:'Cold-key stampedes', result:'Collapse duplicate loads', draw:stampede, desc:'Concurrent requests for the same key share one loader per process. An optional Redis distributed lock coordinates cold loads across instances.'},
  {id:'local', problem:'Network round trips', result:'Keep hot reads local', draw:local, desc:'An L1 memory hit returns locally, without a Redis round trip.'},
  {id:'coherence', problem:'Drifting L1 caches', result:'Coordinate every instance', draw:coherence, desc:'A healthy event bus carries invalidations and optional value priming between peers. Propagation is asynchronous.'},
  {id:'negative', problem:'Repeated missing keys', result:'Remember the misses', draw:negative, desc:'Short-lived negative entries avoid repeated origin lookups for a missing key.'},
  {id:'compression', problem:'Oversized payloads', result:'Store less. Send less.', draw:compression, desc:'MessagePack and size-aware compression reduce payload bytes, with a serialization CPU trade-off.'},
  {id:'telemetry', problem:'Invisible cache behavior', result:'See every layer', draw:telemetry, desc:'Optional live metrics expose hits, misses, invalidations, and dependency health.'},
];

export function cacheScale(): string {
  return `<figure class="cache-visual cache-visual--scale" aria-labelledby="cache-scale-caption">
    <figcaption class="cv-caption" id="cache-scale-caption"><span><i></i> CACHE AT SCALE</span><span class="cv-caption-key"><b></b> WORK SAVED</span></figcaption>
    <div class="cv-map">
      <svg class="cv-connections" viewBox="0 0 1100 760" preserveAspectRatio="none" aria-hidden="true">
        ${wire('M245 146 367 216 550 321','lime')}
        ${wire('M855 146 733 216 550 321','lime')}
        ${wire('M260 380H432','cyan')}${wire('M840 380H668','cyan')}
        ${wire('M245 621 363 554 550 446','violet')}
        ${wire('M855 621 737 554 550 446','violet')}
      </svg>
      <div class="cv-hub">${hub()}</div>
      ${stories.map((s,i) => `<div class="cv-story cv-story--${i}">
        <div class="cv-problem"><span>${String(i+1).padStart(2,'0')}</span>${s.problem}</div>
        ${svg(`scale-${s.id}`,s.result,s.desc,s.draw())}
        <div class="cv-result"><span aria-hidden="true">↳</span>${s.result}</div>
      </div>`).join('')}
    </div>
    <div class="cv-bottom" aria-hidden="true"><span>L1 MEMORY</span><i></i><span>REDIS L2</span><i></i><span>EVENT BUS</span></div>
  </figure>`;
}

export function cacheHero(): string {
  // Data paths reach shared Redis directly; the separate cyan rail is the bus.
  const dataPaths = [110,250,390].map(x => wire(`M${x} 140V294L250 375`,'lime')).join('');
  const peers = [110,250,390].map((x,i) => server(x,132,'muted') + chip(x,96,'lime',43) + tech('node',x-10,8) + label(x,46,`INSTANCE 0${i+1}`,'cv-dim cv-small')).join('');
  const art = `
    ${dataPaths}
    ${conduit([[110,163],[110,212],[250,293],[390,212],[390,163]])}
    ${conduit([[250,163],[250,293]],'cyan',8)}
    ${brandAt(229,244,42)}
    ${block(250,395,116,94,9,'muted')}
    ${database(250,383,'violet',true)}
    ${peers}
    ${check(138,74)}${check(278,74)}${check(418,74)}
    ${label(184,190,'L1 HITS','cv-good cv-small')}
    ${label(405,266,'EVENT BUS','cv-small')}
    ${tech('redis',369,281,18)}${tech('rabbit',396,281,18)}${tech('nats',423,281,18)}
    ${label(108,383,'REDIS L2','cv-small')}
    ${wire('M250 412v48l92 54','muted',false)}
    ${database(352,511,'muted')}
    ${label(157,487,'Load only on a miss','cv-dim cv-small')}
    ${label(353,546,'ORIGIN','cv-dim cv-small')}
  `;
  return `<figure class="cache-visual hero__visual" aria-labelledby="hero-visual-caption">
    <figcaption class="cv-caption" id="hero-visual-caption"><span><i></i> ONE API. EVERY LAYER.</span><span class="hero__visual-label">getOrSet()</span></figcaption>
    ${svg('hero-cache','Fast local reads, coordinated across instances','Three Node.js instances each have a local L1 cache. Thin data paths connect directly to shared Redis L2. A separate teal pipe is the event bus, supporting Redis Pub/Sub, RabbitMQ, or NATS. LazyLayers coordinates peers; the origin loader runs when a requested value is missing.',art,'0 0 500 565')}
    <div class="hero__code"><code><span>await</span> cache.<b>getOrSet</b>(key, load);</code></div>
  </figure>`;
}

export function cacheDrift(): string {
  const peers = [130,360,590].map((x,i) => `<g transform="translate(${x} 144) scale(1.5)">${server(0,0,'muted')}${chip(0,-37,i===0?'lime':'rose',43)}</g>` +
    label(x,35,`INSTANCE 0${i+1}`,'cv-dim') + label(x,229,i === 0 ? 'fresh · v2' : 'stale · v1',i===0?'cv-good':'cv-bad')).join('');
  return `<figure class="cache-visual cv-wide">${svg('cache-drift','Without a bus, L1 caches drift','The first Node.js instance has a new value, while two disconnected peers retain their old L1 values until expiry.',`
    ${conduit([[185,148],[229,174]],'rose',8)}${conduit([[261,174],[303,148]],'rose',8)}${cross(245,174)}
    ${conduit([[415,148],[459,174]],'rose',8)}${conduit([[491,174],[533,148]],'rose',8)}${cross(475,174)}
    ${peers}`,'0 0 720 260')}</figure>`;
}

export function cacheFanout(): string {
  const peers = [130,360,590].map((x,i) => `<g transform="translate(${x} 145) scale(1.5)">${server(0,0,'muted')}${chip(0,-37,'lime',43)}</g>` +
    label(x,16,`INSTANCE 0${i+1}`,'cv-dim') + label(x,34,i===0?'publish':'apply','cv-good'));
  return `<figure class="cache-visual cv-wide">${svg('cache-fanout','One shared event bus, coordinated peers','The publishing instance sends an event through a shared tubular event bus. Connected peers apply invalidations or optional value priming. Redis Pub/Sub, RabbitMQ, and NATS are supported transports.',`
    ${[130,360,590].map(x=>conduit([[x,177],[x,252]],'cyan',10)).join('')}
    ${conduit([[95,252],[625,252]],'cyan',16)}
    ${peers.join('')}
    ${brandAt(338,211,44)}
    ${[230,465].map(x=>block(x,252,14,14,5,'lime')).join('')}
    ${label(360,306,'EVENT BUS  ·  del / pattern / set','cv-small')}
  `,'0 0 720 335')}${transportKey()}</figure>`;
}

function outage(): string {
  return wire('M72 106l103 60 114-65','muted',false) + wire('M74 113v47l155 89 112-65V119','lime') +
    server(73,108,'lime') + database(180,146,'rose',true) + database(343,119,'lime') +
    cross(181,82) + check(367,64) +
    label(70,36,'APP','cv-dim cv-small') + label(181,188,'Redis offline','cv-bad') +
    label(343,165,'origin','cv-good') + label(220,276,'circuit open → bypass L2','cv-small');
}

function fallback(): string {
  return wire('M74 111l107 62 148-83','muted',false) + wire('M202 213 74 139v-27','lime') +
    server(75,111,'lime') + database(326,91,'rose') + chip(202,213,'lime',72) +
    `<g class="cv-clock" transform="translate(253 119)"><circle r="17"/><path d="M0-10V0l7 4"/></g>` +
    label(328,22,'loader timeout','cv-bad') + label(204,274,'serve retained stale value','cv-small') +
    label(76,36,'APP','cv-dim cv-small') + check(227,178);
}

function retries(): string {
  return conduit([[77,118],[77,149],[177,207]],'rose',9) + conduit([[224,207],[333,144],[333,118]],'rose',9) + server(77,110,'cyan') + server(333,109,'cyan') +
    cross(202,207) +
    [0,1,2,3].map(i=>block(135+i*28,210-i*16,17,17,9,'cyan')).join('') +
    `<path class="cv-return cv-cyan" d="M270 168q63 46 22 72m-7-14 7 14 14-5"/>` +
    label(205,72,'bus disconnected','cv-bad') + label(213,276,'bounded publish retries','cv-small') +
    label(74,36,'PEER A','cv-dim cv-small') + label(336,36,'PEER B','cv-dim cv-small');
}

function ordering(): string {
  return wire('M66 94l97 56 175-36','lime') +
    [0,1,2].map(i=> block(64,82+i*45,25,25,8,i === 0 ? 'lime' : 'rose') + label(32,65+i*45,['v3','v2','v2'][i],'cv-small cv-dim')).join('') +
    `<path class="cv-gate" d="m175 79 39 22v95l-39-22z"/>` +
    wire('M82 139l61 36','rose',false) + wire('M82 184l61 36','rose',false) +
    cross(148,175) + cross(148,219) + server(332,115,'lime') +
    label(333,57,'v3','cv-good') + label(214,276,'generation + event ID checks','cv-small') + check(365,79);
}

export function cacheResilience(): string {
  const scenes = [
    {id:'outage', name:'Redis unavailable', result:'Requests keep moving', draw:outage, desc:'When L2 fails, the circuit breaker skips the unhealthy cache and requests can fall through to the origin loader. Origin availability still matters.'},
    {id:'fallback', name:'Loader fails or stalls', result:'A fallback, when it matters', draw:fallback, desc:'When fail-safe is enabled and a retained stale value is available, serve that value on loader error or timeout.'},
    {id:'retry', name:'The bus disconnects', result:'Buffer brief interruptions', draw:retries, desc:'Bounded publish queues retry brief event-bus failures. This does not guarantee delivery during prolonged outages or process restarts.'},
    {id:'ordering', name:'Events arrive late or twice', result:'Reject stale & duplicate events', draw:ordering, desc:'Generation checks filter stale invalidations and event IDs deduplicate replayed events. This is not a global ordering guarantee.'},
  ];
  return `<figure class="cache-visual cache-visual--resilience" aria-labelledby="cache-resilience-caption">
    <figcaption class="cv-caption" id="cache-resilience-caption"><span><i></i> UNDER PRESSURE</span><span class="cv-caption-key"><b></b> FALLBACK PATHS</span></figcaption>
    <div class="cv-resilience-grid">${scenes.map((s,i)=>`<div class="cv-failure">
      <div class="cv-problem"><span>${String(i+1).padStart(2,'0')}</span>${s.name}</div>
      ${svg(`failure-${s.id}`,s.result,s.desc,s.draw(),'0 0 420 300')}
      <div class="cv-result"><span aria-hidden="true">↳</span>${s.result}</div>
    </div>`).join('')}</div>
  </figure>`;
}
