# LazyLayers documentation

The documentation site uses Fumadocs and Next.js. Public pages live in `content/docs/`.

## Edit content

Verify behavior against `../src/` and `../test/`, then edit the page in `content/docs/`. Navigation lives in `content/docs/**/meta.json`.

Keep the introduction and quickstart focused on the first successful cache integration. Put method signatures and exhaustive option details in the reference pages, and link to them from guides.

## Preview and validate

From the repository root:

```bash
npm run docs:dev
npm run docs:build
```

The development site runs at http://localhost:3000. The build compiles the MDX pages and generates their documentation routes.

The live `/llms.txt`, `/llms-full.txt`, and `/llms.mdx/docs/...` routes derive content from the same Fumadocs source.

For the 0.6.3 cache changes, consult the [changelog](../CHANGELOG.md#063-2026-10-08), [audit](../audit/README.md) and [migration notes](../audit/migration.md). Keep resource limits, publication guarantees, KV consistency and readiness qualifications aligned with the source and regression tests. Documentation lint/type checks passed during the audit. The 0.6.3 Vercel production build completed all 108 static pages on its 2-core / 8 GiB build machine; the earlier local memory-budget failures remain documented in the [readiness report](../audit/12-production-readiness.md).
