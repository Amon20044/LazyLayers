import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function packageVersion(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(resolve(repoRoot, 'package.json'), 'utf8'),
  ) as { version?: unknown };

  const version = packageJson.version;
  const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  if (typeof version !== 'string' || !semver.test(version)) {
    throw new Error('Root package.json must provide a valid semver version.');
  }

  return version;
}

/**
 * Injects generated markup into index.html at build time (and in dev), so the
 * shipped document is fully static. Benchmarks, FAQ and JSON-LD all come from
 * one source of truth in src/lib/data.ts.
 */
function staticContent(): Plugin {
  return {
    name: 'lazylayers-static-content',
    async transformIndexHtml(html) {
      const version = await packageVersion();
      const r = await import('./src/lib/render');
      const slots: Record<string, string> = {
        '<!--@stack-->': r.stack(),
        '<!--@cloudflare-->': r.cloudflareSection(),
        '<!--@statbar-->': r.statbar(),
        '<!--@iso-->': r.iso(),
        '<!--@stale-->': r.stale(),
        '<!--@fanout-->': r.fanout(),
        '<!--@bytes-->': r.byteStory(),
        '<!--@wire-->': r.wireEvents(),
        '<!--@bento-->': r.bento(),
        '<!--@progressive-->': r.progressive(),
        '<!--@pillars-->': r.pillars(),
        '<!--@cache-scale-->': r.cacheScale(),
        '<!--@cache-hero-->': r.cacheHero(),
        '<!--@cache-resilience-->': r.cacheResilience(),
        '<!--@comparison-->': r.comparisonTable(),
        '<!--@limitations-->': r.limitations(),
        '<!--@transports-->': r.transportMatrix(),
        '<!--@observability-->': r.observabilityShowcase(),
        '<!--@bench-->': r.benchTable(),
        '<!--@tradeoff-->': r.tradeoff(),
        '<!--@faq-->': r.faq(),
        '<!--@faq-jsonld-->': r.faqJsonLd(),
        '<!--@bench-meta-->': r.benchMeta(),
      };
      // Reuse the current header artwork for the footer and the cache hub.
      const brandArt = html.match(/<svg class="brand__mark"[^>]*>([\s\S]*?)<\/svg>/)?.[1] ?? '';
      return Object.entries(slots).reduce((acc, [k, v]) => acc.split(k).join(v), html)
        .replaceAll('__LAZY_LAYERS_VERSION__', version)
        .replaceAll('<!--@brand-art-->', brandArt);
    },
  };
}

export default defineConfig({
  plugins: [staticContent()],
  build: {
    target: 'es2020',
    cssCodeSplit: false,
    assetsInlineLimit: 8192,
    reportCompressedSize: true,
  },
});
