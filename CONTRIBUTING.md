# Contributing to LazyLayers

Thank you for your interest in improving LazyLayers!

## Local Development Workflow

1. **Clone and install dependencies**:
   ```bash
   git clone https://github.com/Amon20044/LazyLayers.git
   cd LazyLayers
   npm install
   ```

2. **Build the library**:
   ```bash
   npm run build
   ```

3. **Run unit & integration tests**:
   ```bash
   npm test
   ```

4. **Run type checks**:
   ```bash
   npm run typecheck
   ```

5. **Full CI validation**:
   ```bash
   npm run ci
   ```

## Running Benchmarks

Serialization fixtures use deterministic data; timing results vary by runtime and machine:

```bash
node benchmarks/run.mjs
```

The [cache audit guide](audit/README.md) covers bounded correctness, memory, before/after performance and real Docker fault tests. Use `npm run test:audit`, `npm run bench:audit:e2e` and `npm run test:audit:chaos` for disposable, capped infrastructure. Run equivalent CPU comparisons sequentially and retain raw results, resource budgets and failed gates. Never run load or chaos tools against production or an unapproved external service.

## Website Development

The Fumadocs documentation source lives in `documentation/content/docs`. From the repository root:

```bash
npm run docs:dev
npm run docs:build
```

See [documentation instructions](documentation/README.md) for content validation. The separate `site/` application has its own package and build; edit documentation behavior in the canonical Fumadocs source.

## Pull Request Guidelines

- Keep PRs focused on one logical fix or feature.
- Ensure all new features or bug fixes are accompanied by tests under `./test/`.
- Ensure `npm run ci` passes without warnings or failures.
- Update `CHANGELOG.md` and the relevant README/reference pages for behavioral or configuration changes. Keep unreleased changes labeled as such until a package release is made.
- Treat critical correctness failures and statistically supported performance regressions as visible release-review gates. Do not silently replace a baseline or claim production readiness from one passing benchmark.
