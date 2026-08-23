import { BENCH, saved, type BenchRow } from './data';

const fmtBytes = (b: number) => {
  const u = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b >= 100 || i === 0 ? 0 : 2)} ${u[i]}`;
};

const fmtMoney = (n: number) =>
  n >= 1000 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(n < 10 ? 2 : 0)}`;

const fmtCount = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n / 1e6 < 10 ? 1 : 0)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`;

/** Animate a text node between values — small touch, makes the panel feel live. */
function tween(el: HTMLElement, from: number, to: number, render: (v: number) => string, ms = 520) {
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = render(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function initCalculator(root: HTMLElement) {
  const shape = root.querySelector<HTMLSelectElement>('#c-shape')!;
  const keys = root.querySelector<HTMLInputElement>('#c-keys')!;
  const price = root.querySelector<HTMLInputElement>('#c-price')!;
  const replicas = root.querySelector<HTMLInputElement>('#c-replicas')!;

  const keysV = root.querySelector<HTMLOutputElement>('#c-keys-v')!;
  const priceV = root.querySelector<HTMLOutputElement>('#c-price-v')!;
  const repV = root.querySelector<HTMLOutputElement>('#c-replicas-v')!;

  const headline = root.querySelector<HTMLElement>('#c-headline')!;
  const sub = root.querySelector<HTMLElement>('#c-sub')!;
  const outJson = root.querySelector<HTMLElement>('#c-json')!;
  const outLl = root.querySelector<HTMLElement>('#c-ll')!;
  const outDiff = root.querySelector<HTMLElement>('#c-diff')!;
  const outEnc = root.querySelector<HTMLElement>('#c-enc')!;

  shape.innerHTML = BENCH.map(
    (r, i) => `<option value="${i}">${r.fixture} — ${(saved(r) * 100).toFixed(0)}% smaller</option>`,
  ).join('');
  shape.value = '1'; // user profile: the most relatable default

  let lastSaving = 0;

  const paintRange = (el: HTMLInputElement) => {
    const pct = ((+el.value - +el.min) / (+el.max - +el.min)) * 100;
    el.style.setProperty('--pct', `${pct}%`);
  };

  function update(animate = true) {
    const row: BenchRow = BENCH[+shape.value];
    const nKeys = Math.pow(10, +keys.value);
    const perGb = +price.value;
    const nRep = +replicas.value;

    const jsonBytes = row.bentoBytes * nKeys * nRep;
    const llBytes = row.llBytes * nKeys * nRep;
    const diff = jsonBytes - llBytes;

    const gbSaved = diff / 1024 ** 3;
    const annual = gbSaved * perGb * 12;

    keysV.textContent = fmtCount(nKeys);
    priceV.textContent = `$${perGb}`;
    repV.textContent = String(nRep);

    outJson.textContent = fmtBytes(jsonBytes);
    outLl.textContent = fmtBytes(llBytes);
    outDiff.textContent = fmtBytes(diff);
    outEnc.textContent = row.encoding;

    if (animate) tween(headline, lastSaving, annual, fmtMoney);
    else headline.textContent = fmtMoney(annual);
    lastSaving = annual;

    sub.textContent =
      `${fmtCount(nKeys)} keys shaped like "${row.fixture}", held across ${nRep} ` +
      `${nRep === 1 ? 'node' : 'nodes'} at ${fmtMoney(perGb)}/GB/month.`;

    [keys, price, replicas].forEach(paintRange);
  }

  [shape, keys, price, replicas].forEach((el) =>
    el.addEventListener('input', () => update(el === shape)),
  );

  update(false);
}
