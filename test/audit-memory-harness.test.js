import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('memory profile exits unsuccessfully for a false ledger assertion', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(os.tmpdir(), 'lazy-audit-assertions-'));
  const fixture = join(directory, 'fixture.mjs');
  await writeFile(fixture, `
const leak = process.env.AUDIT_FAKE_LEAK === '1';
export class MemoryBudget {
  constructor(options) { this.target = options.maxMemory; }
  snapshot() { return { accountedBytes: leak ? 1 : 0, target: this.target, categories: { fresh: leak ? 1 : 0 } }; }
}
export class MemoryStore { async set() {} async delete() {} async clear() {} close() {} }
`);
  try {
    for (const leak of [false, true]) {
      const child = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=64', 'scripts/audit-memory-profile.mjs', '--child'], {
        cwd: new URL('..', import.meta.url),
        env: { NODE_ENV: 'test', LAZY_AUDIT_MODULE: fixture, LAZY_AUDIT_CASE: JSON.stringify({ scenario: 'working-set', repeat: 0 }), AUDIT_FAKE_LEAK: leak ? '1' : '0' },
        encoding: 'utf8', timeout: 4000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024,
      });
      assert.equal(child.error, undefined);
      const result = JSON.parse(child.stdout);
      assert.equal(child.status, leak ? 1 : 0);
      if (leak) {
        assert.equal(result.assertions.noFreshBytesAfterClear, false);
        assert.ok(result.failedAssertions.includes('noFreshBytesAfterClear'));
        assert.ok(result.failedAssertions.includes('closedBudgetReleased'));
      } else assert.deepEqual(result.failedAssertions, []);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
