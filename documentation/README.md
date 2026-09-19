# LazyLayers documentation

The production documentation site uses Fumadocs and Next.js. Public pages live in `content/docs/`. Matching MDX source under `../docs/` also supports Mintlify compatibility checks.

## Edit content

Read `../docs/AGENTS.md` and verify behavior against `../src/` and `../test/`. Update a page in `../docs/`, then copy the same content to its matching `content/docs/` path. Keep both copies aligned. Navigation for this site lives in `content/docs/**/meta.json`, while the Mintlify navigation lives in `../docs.json`.

Keep the introduction and quickstart focused on the first successful cache integration. Put method signatures and exhaustive option details in the reference pages, and link to them from guides.

## Preview and validate

From the repository root:

```bash
npm run docs:dev
npm run docs:build
mint broken-links
mint validate
```

The development site runs at http://localhost:3000. The build compiles the MDX pages and generates their documentation routes.

The live `/llms.txt`, `/llms-full.txt`, and `/llms.mdx/docs/...` routes derive content from the same Fumadocs source. Files in `../docs/llms*.txt` are compatibility entry points that link readers to these generated routes.
