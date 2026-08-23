import { defineConfig, type Plugin } from 'vite';

/**
 * Injects generated markup into index.html at build time (and in dev), so the
 * shipped document is fully static. Benchmarks, FAQ and JSON-LD all come from
 * one source of truth in src/lib/data.ts.
 */
function staticContent(): Plugin {
  return {
    name: 'lazylayers-static-content',
    async transformIndexHtml(html) {
      const r = await import('./src/lib/render');
      const slots: Record<string, string> = {
        '<!--@statbar-->': r.statbar(),
        '<!--@iso-->': r.iso(),
        '<!--@stale-->': r.stale(),
        '<!--@fanout-->': r.fanout(),
        '<!--@lenses-->': r.lenses(),
        '<!--@bytes-->': r.byteStory(),
        '<!--@bento-->': r.bento(),
        '<!--@bench-->': r.benchTable(),
        '<!--@tradeoff-->': r.tradeoff(),
        '<!--@layers-->': r.layers(),
        '<!--@faq-->': r.faq(),
        '<!--@faq-jsonld-->': r.faqJsonLd(),
        '<!--@bench-meta-->': r.benchMeta(),
      };
      return Object.entries(slots).reduce((acc, [k, v]) => acc.split(k).join(v), html);
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
