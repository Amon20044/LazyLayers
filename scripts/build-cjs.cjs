const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const tsc = join('node_modules', 'typescript', 'bin', 'tsc');

execFileSync(process.execPath, [tsc, '-p', 'tsconfig.cjs.json'], {
  stdio: 'inherit',
});

mkdirSync('dist-cjs', { recursive: true });
writeFileSync(
  join('dist-cjs', 'package.json'),
  `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
);
