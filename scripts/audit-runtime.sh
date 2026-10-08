#!/usr/bin/env bash
set -euo pipefail
cd /work
# Only explicit source/test/build fixtures are copied; no host credentials or modules.
tar -C /input --exclude=node_modules --exclude=.env --exclude='.env.*' --exclude=.next -cf - src test examples scripts benchmarks package.json package-lock.json tsconfig.json tsconfig.cjs.json README.md CHANGELOG.md LICENSE | tar -xf -
npm ci --include=dev --no-audit --no-fund
npm run typecheck
npm run build
node --test --test-reporter=tap --test-concurrency=1 --test-timeout=15000 test/*.test.js
npm run verify:package
