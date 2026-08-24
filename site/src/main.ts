import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/sections.css';
import 'locomotive-scroll/locomotive-scroll.css';

import { initCalculator } from './lib/calculator';

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector<T>(s);
const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => [...r.querySelectorAll<T>(s)];

/* ── Smooth scroll (Locomotive v5 / Lenis) ───────────────────────────── */

async function initScroll() {
  if (reduced) return null;
  const { default: LocomotiveScroll } = await import('locomotive-scroll');
  return new LocomotiveScroll({
    lenisOptions: {
      lerp: 0.085,
      wheelMultiplier: 0.95,
      smoothWheel: true,
      autoResize: true,
      // Lenis owns the scroll position, so native anchor jumps get reverted on
      // the next frame. This hands #hash links back to Lenis, offset for the
      // fixed 62px header.
      anchors: { offset: -80 },
    },
  });
}

/* ── Scroll reveals ──────────────────────────────────────────────────── */

function initReveals() {
  const targets = $$('.reveal, .reveal-stagger');
  if (!('IntersectionObserver' in window)) {
    targets.forEach((t) => t.classList.add('is-in'));
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        const el = e.target as HTMLElement;

        // Stagger children by index rather than hard-coding delays in markup.
        if (el.classList.contains('reveal-stagger')) {
          [...el.children].forEach((c, i) => {
            (c as HTMLElement).style.transitionDelay = `${i * 70}ms`;
          });
        }
        el.classList.add('is-in');
        io.unobserve(el);
      });
    },
    { rootMargin: '0px 0px -12% 0px', threshold: 0.08 },
  );

  targets.forEach((t) => io.observe(t));
}

/* ── Count-up stats ──────────────────────────────────────────────────── */

function initCounters() {
  const els = $$('[data-count]');
  if (!els.length) return;

  const final = (el: HTMLElement) => {
    el.textContent = `${el.dataset.count ?? 0}${el.dataset.suffix ?? ''}`;
  };

  // The markup already ships the correct final values, so anything that stops
  // us animating must land on those values rather than a half-counted number.
  if (reduced || !('IntersectionObserver' in window)) {
    els.forEach(final);
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        const el = e.target as HTMLElement;
        io.unobserve(el);

        // rAF is throttled to a standstill in a hidden tab; counting from zero
        // there would strand the number mid-animation.
        if (document.hidden) { final(el); return; }

        const to = Number(el.dataset.count ?? 0);
        const suffix = el.dataset.suffix ?? '';
        const t0 = performance.now();
        const dur = 1100;
        let done = false;

        const settle = () => { if (!done) { done = true; final(el); } };
        // Belt and braces: if the tab is hidden mid-count, snap to the answer.
        document.addEventListener('visibilitychange', settle, { once: true });
        const guard = setTimeout(settle, dur + 400);

        const step = (now: number) => {
          if (done) return;
          const t = Math.min(1, (now - t0) / dur);
          const eased = 1 - Math.pow(1 - t, 4);
          el.textContent = `${Math.round(to * eased)}${suffix}`;
          if (t < 1) { requestAnimationFrame(step); }
          else { clearTimeout(guard); done = true; final(el); }
        };
        requestAnimationFrame(step);
      });
    },
    { threshold: 0.5 },
  );
  els.forEach((el) => io.observe(el));
}

/* ── Theme ───────────────────────────────────────────────────────────── */

function initTheme() {
  const btn = $<HTMLButtonElement>('#themetoggle');
  if (!btn) return;

  const root = document.documentElement;
  const media = matchMedia('(prefers-color-scheme: light)');

  const current = (): 'light' | 'dark' =>
    (root.getAttribute('data-theme') as 'light' | 'dark' | null)
    ?? (media.matches ? 'light' : 'dark');

  const apply = (theme: 'light' | 'dark', remember: boolean) => {
    root.setAttribute('data-theme', theme);
    btn.setAttribute('aria-label', `Switch to ${theme === 'light' ? 'dark' : 'light'} theme`);
    if (remember) {
      try { localStorage.setItem('ll-theme', theme); } catch { /* private mode */ }
    }
  };

  apply(current(), false);

  btn.addEventListener('click', () => apply(current() === 'light' ? 'dark' : 'light', true));

  // Follow the OS only while the user has not made a choice of their own.
  media.addEventListener('change', (e) => {
    let stored: string | null = null;
    try { stored = localStorage.getItem('ll-theme'); } catch { /* ignore */ }
    if (!stored) apply(e.matches ? 'light' : 'dark', false);
  });
}

/* ── Nav: stuck state, active section, mobile menu ───────────────────── */

function initNav() {
  const nav = $('#nav')!;
  const toggle = $<HTMLButtonElement>('#navtoggle')!;
  const links = $('#navlinks')!;

  // A sentinel beats a scroll listener here: smooth-scroll libraries own the
  // scroll position, and anything that offsets content without moving
  // window.scrollY would leave the bar transparent over real content.
  const sentinel = document.createElement('div');
  sentinel.setAttribute('aria-hidden', 'true');
  sentinel.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:24px;pointer-events:none';
  document.body.prepend(sentinel);

  const hasIO = typeof IntersectionObserver !== 'undefined';
  if (hasIO) {
    new IntersectionObserver(
      ([e]) => nav.classList.toggle('is-stuck', !e.isIntersecting),
      { threshold: 0 },
    ).observe(sentinel);
  } else {
    const onScroll = () => nav.classList.toggle('is-stuck', window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
    links.classList.toggle('is-open', !open);
  });

  links.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('a')) {
      toggle.setAttribute('aria-expanded', 'false');
      links.classList.remove('is-open');
    }
  });

  // Highlight whichever section owns the viewport.
  // Only same-page anchors can be scroll-spied. An external href is not a
  // valid CSS selector, and passing one to querySelector throws — which would
  // abort boot() and leave every .reveal element stuck at opacity 0.
  const navLinks = $$<HTMLAnchorElement>('.nav__link')
    .filter((a) => (a.getAttribute('href') ?? '').startsWith('#'));
  const sections = navLinks
    .map((a) => document.querySelector(a.getAttribute('href')!))
    .filter((s): s is Element => Boolean(s));

  if ('IntersectionObserver' in window && sections.length) {
    const spy = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          navLinks.forEach((a) =>
            a.classList.toggle('is-active', a.getAttribute('href') === `#${e.target.id}`),
          );
        });
      },
      { rootMargin: '-45% 0px -50% 0px' },
    );
    sections.forEach((s) => spy.observe(s));
  }
}

/* ── Micro-interactions ──────────────────────────────────────────────── */

/** Buttons drift a few px toward the cursor. Subtle; you feel it more than see it. */
function initMagnetic() {
  if (reduced || matchMedia('(hover: none)').matches) return;

  $$('[data-magnetic]').forEach((el) => {
    const strength = 0.28;
    let raf = 0;

    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) * strength;
      const dy = (e.clientY - (r.top + r.height / 2)) * strength;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      });
    });

    el.addEventListener('pointerleave', () => {
      cancelAnimationFrame(raf);
      el.style.transform = '';
    });
  });
}

/** Cards get a light that follows the pointer across their surface. */
function initSpotlight() {
  if (matchMedia('(hover: none)').matches) return;

  $$('.card--spot').forEach((card) => {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  });
}

/** Ambient glow trailing the cursor, eased so it lags slightly behind. */
function initCursorGlow() {
  const glow = $('.bg-cursor');
  if (!glow || reduced || matchMedia('(hover: none)').matches) return;

  document.body.classList.add('has-pointer');
  let tx = innerWidth / 2, ty = innerHeight / 2;
  let cx = tx, cy = ty;

  addEventListener('pointermove', (e) => { tx = e.clientX; ty = e.clientY; }, { passive: true });

  const loop = () => {
    cx += (tx - cx) * 0.075;
    cy += (ty - cy) * 0.075;
    glow.style.transform = `translate3d(${cx}px, ${cy}px, 0)`;
    requestAnimationFrame(loop);
  };
  loop();
}

/* ── Tabs ────────────────────────────────────────────────────────────── */

function initTabs() {
  const list = $('[role="tablist"]');
  if (!list) return;
  const tabs = $$<HTMLButtonElement>('[role="tab"]', list);

  const select = (tab: HTMLButtonElement) => {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      const panel = document.getElementById(t.getAttribute('aria-controls')!);
      if (panel) panel.hidden = !on;
    });
  };

  tabs.forEach((tab) => tab.addEventListener('click', () => select(tab)));

  // Roving arrow-key navigation, per the WAI-ARIA tabs pattern.
  list.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    tabs[next].focus();
    select(tabs[next]);
  });
}

/* ── FAQ accordion ───────────────────────────────────────────────────── */

function initFaq() {
  $$('[data-faq]').forEach((item) => {
    const btn = $<HTMLButtonElement>('.faq__q', item)!;
    btn.addEventListener('click', () => {
      const open = item.classList.toggle('is-open');
      btn.setAttribute('aria-expanded', String(open));
    });
  });
}

/* ── Copy to clipboard ───────────────────────────────────────────────── */

function initCopy() {
  $$<HTMLButtonElement>('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy ?? '');
        const prev = btn.textContent;
        btn.textContent = 'copied';
        btn.classList.add('is-done');
        setTimeout(() => { btn.textContent = prev; btn.classList.remove('is-done'); }, 1600);
      } catch {
        btn.textContent = 'press ⌘C';
      }
    });
  });
}

/* ── Boot ────────────────────────────────────────────────────────────── */

/** A failure in one enhancement must not stop the rest from running. */
function safely(name: string, fn: () => void) {
  try { fn(); } catch (err) { console.error(`[lazylayers] ${name} failed`, err); }
}

function boot() {
  safely('theme', initTheme);
  safely('nav', initNav);
  safely('initReveals', initReveals);
  safely('initCounters', initCounters);
  safely('initTabs', initTabs);
  safely('initFaq', initFaq);
  safely('initCopy', initCopy);
  safely('initMagnetic', initMagnetic);
  safely('initSpotlight', initSpotlight);
  safely('initCursorGlow', initCursorGlow);

  const calc = document.getElementById('calc');
  if (calc) initCalculator(calc);

  void initScroll().then((instance) => {
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__loco = instance;
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
