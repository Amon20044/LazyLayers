import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  CacheSetupError,
  MINIMUM_REDIS_MAJOR_VERSION,
  classifyRedisError,
  getRedisCoreHealth,
  parseRedisServerVersion,
  setupCache,
} = await import('../dist/index.js');

function createRedisClient(info) {
  return {
    status: 'ready',
    async info(section) {
      assert.equal(section, 'server');
      if (info instanceof Error) throw info;
      return info;
    },
    async ping() {
      return 'PONG';
    },
  };
}

test('Redis 6 INFO replies meet the core cache compatibility baseline', async () => {
  assert.equal(MINIMUM_REDIS_MAJOR_VERSION, 6);
  assert.deepEqual(
    parseRedisServerVersion('# Server\r\nredis_version:6.2.14\r\n'),
    { major: 6, minor: 2, patch: 14 },
  );
  assert.deepEqual(
    await getRedisCoreHealth(createRedisClient('# Server\r\nredis_version:6.2.14\r\n')),
    { ok: true, version: { major: 6, minor: 2, patch: 14 } },
  );
});

test('Redis 8 INFO replies are recognized without probing modules', async () => {
  const health = await getRedisCoreHealth(
    createRedisClient('# Server\r\nredis_version:8.0.1\r\n'),
  );

  assert.deepEqual(health, {
    ok: true,
    version: { major: 8, minor: 0, patch: 1 },
  });
});

test('malformed INFO replies return a safe compatibility issue', async () => {
  const health = await getRedisCoreHealth(
    createRedisClient('# Server\r\nredis_mode:standalone\r\n'),
  );

  assert.deepEqual(health, {
    ok: false,
    issue: { kind: 'malformed-info' },
  });
  assert.equal(JSON.stringify(health).includes('redis_mode'), false);
});

test('Redis errors distinguish ACL, unsupported-command, and transport failures', () => {
  assert.deepEqual(
    classifyRedisError(new Error("NOPERM this user has no permissions to run the 'info' command")),
    { kind: 'acl' },
  );
  assert.deepEqual(
    classifyRedisError(new Error("ERR unknown command 'INFO'")),
    { kind: 'unknown-command' },
  );
  assert.deepEqual(
    classifyRedisError(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })),
    { kind: 'transport', code: 'ECONNREFUSED' },
  );
});

test('setupCache accepts Redis 6 and reports unsupported Redis versions actionably', async () => {
  const cache = await setupCache({
    redis: {
      client: createRedisClient('# Server\r\nredis_version:6.0.0\r\n'),
      eventBus: false,
    },
  });
  await cache.close();

  await assert.rejects(
    () => setupCache({
      redis: {
        client: createRedisClient('# Server\r\nredis_version:5.0.14\r\n'),
        eventBus: false,
      },
    }),
    (error) => error instanceof CacheSetupError
      && /requires Redis 6 or newer/.test(error.message),
  );
});

test('setupCache never downgrades ACL and INFO command failures to optional health', async () => {
  await assert.rejects(
    () => setupCache({
      redis: {
        client: createRedisClient(new Error("NOPERM this user has no permissions to run the 'info' command")),
        eventBus: false,
      },
      startup: { requireHealthy: false },
    }),
    (error) => error instanceof CacheSetupError
      && /ACL denied the INFO command/.test(error.message)
      && !error.message.includes('NOPERM'),
  );

  await assert.rejects(
    () => setupCache({
      redis: {
        client: createRedisClient(new Error("ERR unknown command 'INFO'")),
        eventBus: false,
      },
      startup: { requireHealthy: false },
    }),
    (error) => error instanceof CacheSetupError
      && /does not support the INFO command/.test(error.message),
  );
});

test('transport health failures remain classified separately from compatibility failures', async () => {
  const transportError = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
  assert.deepEqual(
    await getRedisCoreHealth(createRedisClient(transportError)),
    { ok: false, issue: { kind: 'transport', code: 'ECONNREFUSED' } },
  );
});
