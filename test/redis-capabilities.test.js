import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

const {
  REDIS_CAPABILITY_COMMANDS,
  REDIS_CAPABILITY_CLIENT_CONTRACT,
  RedisCapabilityRegistry,
  discoverRedisCapabilities,
  hasRedisCapability,
} = await import('../dist/cache/redisCapabilities.js');

const SERVER_INFO = '# Server\r\nredis_version:7.2.4\r\n';

function commandReply(args, unavailable = new Set()) {
  return args.slice(1).map((name) => (
    unavailable.has(name)
      ? null
      : [name, 1, [], 1, 1, 1]
  ));
}

test('bounded discovery reports advertised and unavailable commands without CONFIG', async () => {
  const infoCalls = [];
  const commandCalls = [];
  let configCalls = 0;
  const client = {
    info: async (section) => {
      infoCalls.push(section);
      return SERVER_INFO;
    },
    command: async (...args) => {
      commandCalls.push(args);
      return commandReply(args, new Set(['watch']));
    },
    config: async () => {
      configCalls += 1;
      throw new Error('CONFIG must never be called by discovery');
    },
  };

  const manifest = await discoverRedisCapabilities(client);

  assert.equal(manifest.bounded, true);
  assert.deepEqual(manifest.version, { major: 7, minor: 2, patch: 4 });
  assert.equal(manifest.info.status, 'supported');
  assert.equal(manifest.commandInfo.status, 'supported');
  assert.equal(manifest.capabilities.eval.status, 'supported');
  assert.equal(manifest.capabilities.watch.status, 'unavailable');
  assert.equal(manifest.capabilities.watch.reason, 'unknown-command');
  assert.equal(hasRedisCapability(manifest, 'eval'), true);
  assert.equal(hasRedisCapability(manifest, 'watch'), false);
  assert.deepEqual(infoCalls, ['server']);
  assert.equal(commandCalls.length, 1);
  assert.equal(commandCalls[0][0], 'INFO');
  assert.ok(commandCalls[0].length <= REDIS_CAPABILITY_COMMANDS.length + 1);
  assert.equal(configCalls, 0);
  assert.ok(Object.isFrozen(manifest.capabilities));
});

test('command discovery is hard bounded and exposes its limits', async () => {
  const commandCalls = [];
  const client = {
    info: async () => SERVER_INFO,
    command: async (...args) => {
      commandCalls.push(args);
      return commandReply(args);
    },
  };

  const manifest = await discoverRedisCapabilities(client, {
    maxCommandNames: 10_000,
    maxInfoBytes: 10_000,
    maxCommandReplyBytes: 10_000,
  });

  assert.equal(manifest.limits.maxCommandNames, 64);
  assert.ok(commandCalls[0].length - 1 <= 64);
  assert.equal(manifest.capabilities.eval.status, 'supported');
});

test('ACL denial is classified safely and leaves operation capabilities unknown', async () => {
  const aclError = Object.assign(
    new Error('NOPERM this user has no permissions to run the COMMAND command'),
    { code: 'NOPERM' },
  );
  const manifest = await discoverRedisCapabilities({
    info: async () => SERVER_INFO,
    command: async () => { throw aclError; },
  });

  assert.equal(manifest.commandInfo.status, 'unavailable');
  assert.equal(manifest.commandInfo.reason, 'acl-denied');
  assert.equal(manifest.commandInfo.code, 'NOPERM');
  assert.equal(manifest.capabilities.eval.status, 'unknown');
  assert.equal(manifest.capabilities.eval.reason, 'acl-denied');
  assert.ok(!JSON.stringify(manifest).includes('permissions to run'));
});

test('missing client methods are unknown rather than optimistic', async () => {
  const manifest = await discoverRedisCapabilities({});

  assert.equal(manifest.info.status, 'unknown');
  assert.equal(manifest.info.reason, 'client-method-unavailable');
  assert.equal(manifest.commandInfo.status, 'unknown');
  assert.equal(manifest.commandInfo.reason, 'client-method-unavailable');
  assert.equal(manifest.capabilities.eval.status, 'unknown');
  assert.equal(manifest.capabilities.eval.reason, 'client-method-unavailable');
});

test('timeouts remain bounded and classify the affected discovery as unknown', async () => {
  const manifest = await discoverRedisCapabilities({
    info: async () => SERVER_INFO,
    command: async () => new Promise(() => undefined),
  }, { timeoutMs: 5 });

  assert.equal(manifest.commandInfo.status, 'unknown');
  assert.equal(manifest.commandInfo.reason, 'timeout');
  assert.equal(manifest.capabilities.eval.status, 'unknown');
  assert.equal(manifest.capabilities.eval.reason, 'timeout');
});

test('malformed and oversized replies are unavailable without parsing unbounded data', async () => {
  const malformed = await discoverRedisCapabilities({
    info: async () => 'not redis info',
    command: async () => [],
  });
  assert.equal(malformed.info.status, 'unavailable');
  assert.equal(malformed.info.reason, 'malformed-response');
  assert.equal(malformed.commandInfo.status, 'unavailable');
  assert.equal(malformed.commandInfo.reason, 'malformed-response');

  const oversized = await discoverRedisCapabilities({
    info: async () => `${SERVER_INFO}${'x'.repeat(512)}`,
    command: async (...args) => commandReply(args),
  }, { maxInfoBytes: 64 });
  assert.equal(oversized.info.status, 'unavailable');
  assert.equal(oversized.info.reason, 'response-too-large');
});

test('unsupported Redis versions stop capability probing', async () => {
  let commandCalls = 0;
  const manifest = await discoverRedisCapabilities({
    info: async () => '# Server\r\nredis_version:5.0.14\r\n',
    command: async () => {
      commandCalls += 1;
      return [];
    },
  });

  assert.equal(commandCalls, 0);
  assert.equal(manifest.commandInfo.reason, 'unsupported-version');
  assert.equal(manifest.capabilities.eval.status, 'unavailable');
  assert.equal(manifest.capabilities.eval.reason, 'unsupported-version');
});

test('registry deduplicates discovery and invalidates on reconnect', async () => {
  const client = new EventEmitter();
  let infoCalls = 0;
  let commandCalls = 0;
  client.info = async () => {
    infoCalls += 1;
    return SERVER_INFO;
  };
  client.command = async (...args) => {
    commandCalls += 1;
    return commandReply(args);
  };

  const registry = new RedisCapabilityRegistry(client);
  const firstPromise = registry.get();
  assert.strictEqual(registry.get(), firstPromise);
  await firstPromise;
  assert.equal(infoCalls, 1);
  assert.equal(commandCalls, 1);

  client.emit('ready');
  await registry.get();
  assert.equal(infoCalls, 2);
  assert.equal(commandCalls, 2);

  registry.close();
  await registry.get();
  assert.equal(infoCalls, 3);
  client.emit('ready');
  await registry.get();
  assert.equal(infoCalls, 3);
});

test('published client contract is read-only and reconnect hooks are optional', () => {
  assert.deepEqual(REDIS_CAPABILITY_CLIENT_CONTRACT.requiredMethods, ['info', 'command']);
  assert.deepEqual(REDIS_CAPABILITY_CLIENT_CONTRACT.discoveryCommands, [
    'INFO server',
    'COMMAND INFO <allow-list>',
  ]);
  assert.equal(REDIS_CAPABILITY_CLIENT_CONTRACT.mutatesRedisConfiguration, false);
});
