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

Benchmarks are deterministic across runs for byte counts and measure serialization vs baselines:

```bash
node benchmarks/run.mjs
```

## Website Development

The documentation landing page lives in `./site`:

```bash
cd site
npm install
npm run dev
```

To test a production build:
```bash
npm run build
```

## Pull Request Guidelines

- Keep PRs focused on one logical fix or feature.
- Ensure all new features or bug fixes are accompanied by tests under `./test/`.
- Ensure `npm run ci` passes without warnings or failures.
