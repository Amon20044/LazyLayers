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

For the current unreleased cache changes, consult the [changelog](../CHANGELOG.md#062-unreleased), [audit](../audit/README.md) and [migration notes](../audit/migration.md). Keep resource limits, publication guarantees, KV consistency and readiness qualifications aligned with the source and regression tests. Documentation lint/type checks passed during the audit; full static generation exceeded the local test memory budget and remains an explicit [release gate](../audit/12-production-readiness.md).
