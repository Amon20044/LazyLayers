/**
 * Isolated Redis protocol double for adversarial cache tests. This models the
 * existing script contracts, not Redis Lua execution or failover guarantees.
 */
export class AuditRedis {
  status = 'ready';
  values = new Map();
  definitions = new Map();

  defineCommand(name, definition) {
    this.definitions.set(name, definition);
    this[name] = async (...args) => this.execute(name, args);
    this[`${name}Buffer`] = async (...args) => this.execute(name, args);
  }

  live(key) {
    const entry = this.values.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) this.values.delete(key);
    return this.values.get(key);
  }

  async set(key, value, ...options) {
    if (options.includes('NX') && this.live(key)) return null;
    const px = options.indexOf('PX');
    this.values.set(key, {
      value: Buffer.isBuffer(value) ? Buffer.from(value) : String(value),
      expiresAt: px < 0 ? undefined : Date.now() + Number(options[px + 1]),
    });
    return 'OK';
  }

  async getBuffer(key) {
    const entry = this.live(key);
    return entry ? Buffer.from(entry.value) : null;
  }

  async pttl(key) {
    const entry = this.live(key);
    return !entry ? -2 : entry.expiresAt === undefined ? -1 : Math.max(0, entry.expiresAt - Date.now());
  }

  async exists(key) { return this.live(key) ? 1 : 0; }
  async del(...keys) {
    let deleted = 0;
    for (const key of keys) deleted += this.values.delete(key) ? 1 : 0;
    return deleted;
  }
  async unlink(...keys) { return this.del(...keys); }
  async zadd() { return 1; }
  async zrem() { return 1; }
  async zcard() { return 0; }

  pipeline() {
    const commands = [];
    const redis = this;
    const pipeline = { async exec() {
      const results = [];
      for (const [command, args] of commands) {
        try { results.push([null, await redis[command](...args)]); }
        catch (error) { results.push([error, null]); }
      }
      return results;
    } };
    for (const command of ['set', 'getBuffer', 'pttl', 'del', 'unlink', 'zadd', 'zrem']) {
      pipeline[command] = (...args) => { commands.push([command, args]); return pipeline; };
    }
    return pipeline;
  }

  async scan(_cursor, _match, match) {
    return ['0', [...this.values.keys()].filter((key) => this.live(key) && redisGlob(match).test(key))];
  }

  scanStream({ match }) {
    const redis = this;
    return (async function* () {
      const keys = [...redis.values.keys()].filter((key) => redis.live(key) && redisGlob(match).test(key));
      if (keys.length) yield keys;
    })();
  }

  execute(name, args) {
    const definition = this.definitions.get(name);
    const keys = args.slice(0, definition.numberOfKeys);
    const argv = args.slice(definition.numberOfKeys);
    if (name === 'lazyLayersGetSnapshotV1') {
      const entry = this.live(keys[0]);
      if (!entry) return [false, -2];
      const ttl = entry.expiresAt === undefined ? -1 : Math.max(0, entry.expiresAt - Date.now());
      const bytes = Buffer.byteLength(entry.value);
      if (definition.lua.includes('strlen') && argv[0] !== undefined && bytes > Number(argv[0])) {
        return [false, -3, bytes, ttl];
      }
      return [Buffer.from(entry.value), ttl, bytes];
    }
    if (name === 'lazyLayersSetAndFenceV1') {
      this.values.set(keys[0], { value: Buffer.from(argv[0]), expiresAt: Date.now() + Number(argv[1]) });
      this.values.delete(keys[1]);
      return 1;
    }
    if (name === 'lazyLayersDeleteAndFenceV1') {
      const deleted = this.values.delete(keys[0]) ? 1 : 0;
      this.values.delete(keys[1]);
      return deleted;
    }
    const lockIndex = name === 'lazyLayersPublishIfOwnerV1' ? 1 : 0;
    const lock = this.live(keys[lockIndex]);
    if (!lock || String(lock.value) !== String(argv[0])) return 0;
    if (name === 'lazyLayersReleaseLockV1') {
      this.values.delete(keys[0]);
      return 1;
    }
    if (name === 'lazyLayersRenewLockV1') {
      lock.expiresAt = Date.now() + Number(argv[1]);
      return 1;
    }
    if (name === 'lazyLayersPublishIfOwnerV1') {
      this.values.set(keys[0], { value: Buffer.from(argv[1]), expiresAt: Date.now() + Number(argv[2]) });
      return 1;
    }
    throw new Error(`Unexpected Redis script ${name}`);
  }
}

/** Redis SCAN glob syntax; deliberately separate from the cache's matcher. */
function redisGlob(pattern) {
  let expression = '^';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*') expression += '.*';
    else if (char === '?') expression += '.';
    else if (char === '\\' && index + 1 < pattern.length) expression += escape(pattern[++index]);
    else if (char === '[') {
      const end = pattern.indexOf(']', index + 1);
      if (end >= 0) { expression += pattern.slice(index, end + 1); index = end; }
      else expression += '\\[';
    } else expression += escape(char);
  }
  return new RegExp(`${expression}$`, 's');
}

function escape(char) { return /[\\^$.*+?()[\]{}|]/u.test(char) ? `\\${char}` : char; }
