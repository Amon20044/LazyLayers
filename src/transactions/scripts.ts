import { createHash } from 'node:crypto';

/** The script protocol is versioned independently from the cache payload codec. */
export const TRANSACTION_SCRIPT_VERSION = 1 as const;
export const TRANSACTION_SCRIPT_COMMAND = 'lltx_operation_v1';

/**
 * One bounded STRING record and one SET are used for every state transition.
 * The script never scans, calls a network, invokes application code, or writes
 * a second key.  It is intentionally separate from ordinary cache scripts.
 */
export const OPERATION_COORDINATION_LUA = String.raw`-- LazyLayers transaction coordination protocol v1.
-- KEYS[1]: one operation record. ARGV: command, fingerprint, durableId,
-- owner, leaseMs, retentionMs, resultRef.
local cmd, fp, durable, owner = ARGV[1], ARGV[2], ARGV[3], ARGV[4]
local lease, retention, result = tonumber(ARGV[5]), tonumber(ARGV[6]), ARGV[7]
local function fail(code) return redis.error_reply(code) end
local function integer(n, lo, hi)
  return n and n == math.floor(n) and n >= lo and n <= hi
end
local function bounded(s, n)
  return type(s) == 'string' and #s > 0 and #s <= n
end
local function hex64(s)
  return bounded(s, 64) and #s == 64 and not string.find(s, '[^0-9a-f]')
end
local function reference(s, cap)
  return bounded(s, cap) and not string.find(s, '[^A-Za-z0-9_:/%.%-]')
end
local function decimal(n) return string.format('%.0f', n) end
local function timestamp(s)
  if type(s) ~= 'string' or #s > 16 then return nil end
  if s ~= '0' and not string.match(s, '^[1-9][0-9]*$') then return nil end
  local n = tonumber(s)
  if not integer(n, 0, 9007199254740991) then return nil end
  return n
end
local function validate_record(r)
  if type(r) ~= 'table' or r.schema ~= 1 or not hex64(r.fingerprint)
      or not hex64(r.owner) or not reference(r.durableId, 128) then return false end
  local allowed = {schema=true, fingerprint=true, durableId=true, owner=true,
    state=true, leaseUntilMs=true, retainUntilMs=true, resultRef=true}
  local count = 0
  for k, _ in pairs(r) do
    if not allowed[k] then return false end
    count = count + 1
  end
  if count ~= 8 then return false end
  local untilMs, retainMs = timestamp(r.leaseUntilMs), timestamp(r.retainUntilMs)
  if not untilMs or not retainMs or retainMs <= 0 then return false end
  if r.state == 'pending' then
    return untilMs > 0 and retainMs >= untilMs and r.resultRef == ''
  end
  return r.state == 'completed' and untilMs == 0 and reference(r.resultRef, 256)
end
local function encode_record_checked(r)
  if not validate_record(r) then error('TX_INVALID_RECORD') end
  local encoded = cjson.encode(r)
  if #encoded > 2048 then error('TX_INVALID_RECORD') end
  return encoded
end
if #KEYS ~= 1 or #ARGV ~= 7 then return fail('TX_INVALID_ARGS') end
if cmd ~= 'begin' and cmd ~= 'renew' and cmd ~= 'complete' and cmd ~= 'read' then
  return fail('TX_INVALID_COMMAND')
end
if not hex64(fp) or not reference(durable, 128) then return fail('TX_INVALID_ID') end
if cmd ~= 'read' and not hex64(owner) then return fail('TX_INVALID_OWNER') end
if not integer(lease, 1, 3600000) or not integer(retention, lease, 2592000000) then
  return fail('TX_INVALID_TTL')
end
if cmd == 'complete' and not reference(result, 256) then return fail('TX_INVALID_RESULT') end

-- GET rejects wrong-type keys before any write.
local raw = redis.call('GET', KEYS[1])
local r = nil
if raw then
  if #raw > 2048 then return fail('TX_INVALID_RECORD') end
  local ok, decoded = pcall(cjson.decode, raw)
  if not ok or not validate_record(decoded) then return fail('TX_INVALID_RECORD') end
  r = decoded
  if r.fingerprint ~= fp or r.durableId ~= durable then return {'conflict'} end
end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if not integer(now, 0, 9007199254740991 - retention) then return fail('TX_INVALID_TIME') end
local function retainedDeadline()
  return decimal(math.max(now + retention, r and tonumber(r.retainUntilMs) or 0))
end
local function remaining()
  return math.max(0, tonumber(r.leaseUntilMs) - now)
end
local function persist(nextRecord)
  local encoded = encode_record_checked(nextRecord) -- validate before SET
  local ttl = tonumber(nextRecord.retainUntilMs) - now
  if not integer(ttl, 1, 2592000000) then return fail('TX_INVALID_TTL') end
  redis.call('SET', KEYS[1], encoded, 'PX', decimal(ttl))
  return nil
end

if cmd == 'read' then
  if not r then return {'missing'} end
  if r.state == 'completed' then return {'completed', r.resultRef} end
  if remaining() == 0 then return {'recovery_required'} end
  return {'in_progress', decimal(remaining())}
end
if r and r.state == 'completed' then
  if cmd == 'renew' then return {'lost'} end
  if cmd == 'complete' and r.resultRef ~= result then return {'conflict'} end
  return {'completed', r.resultRef}
end
if cmd == 'begin' then
  if r and remaining() > 0 then
    if r.owner == owner then return {'acquired', owner, decimal(remaining()), 'reconcile'} end
    return {'in_progress', decimal(remaining())}
  end
  -- A known expired owner can never be reused for a new acquisition.
  if r and r.owner == owner then return fail('TX_FRESH_OWNER_REQUIRED') end
  local nextRecord = {
    schema = 1, fingerprint = fp, durableId = durable, owner = owner,
    state = 'pending', leaseUntilMs = decimal(now + lease),
    retainUntilMs = retainedDeadline(), resultRef = ''
  }
  local err = persist(nextRecord)
  if err then return err end
  return {'acquired', owner, decimal(lease), 'reconcile'}
end
if not r or r.owner ~= owner or remaining() == 0 then return {'lost'} end
if cmd == 'renew' then
  r.leaseUntilMs = decimal(now + lease)
  r.retainUntilMs = retainedDeadline()
  local err = persist(r)
  if err then return err end
  return {'renewed', decimal(lease)}
end
-- cmd == complete: the caller has already committed its durable result.
r.state, r.resultRef = 'completed', result
r.leaseUntilMs, r.retainUntilMs = '0', retainedDeadline()
local err = persist(r)
if err then return err end
return {'completed', result}`;

export const OPERATION_COORDINATION_SHA1 = createHash('sha1')
  .update(OPERATION_COORDINATION_LUA, 'utf8')
  .digest('hex');

export interface RedisScriptClient {
  defineCommand?: (name: string, definition: {
    lua: string;
    numberOfKeys: number;
    readOnly?: boolean;
  }) => void;
  evalsha?: (sha1: string, numberOfKeys: number, ...args: Array<string | number | Buffer>) => Promise<unknown>;
  eval?: (script: string, numberOfKeys: number, ...args: Array<string | number | Buffer>) => Promise<unknown>;
  [key: string]: unknown;
}

const registeredCommands = new WeakMap<object, Set<string>>();

function validateCommandName(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw new TypeError('Redis transaction command name contains unsupported characters');
  }
  return name;
}

/** Register once per client; ioredis then uses its EVALSHA cache on the hot path. */
export function registerOperationScript(
  client: RedisScriptClient,
  commandName = TRANSACTION_SCRIPT_COMMAND,
): string {
  if (typeof client !== 'object' || client === null) {
    throw new TypeError('A Redis primary client is required');
  }
  const name = validateCommandName(commandName);
  let names = registeredCommands.get(client);
  if (!names) {
    names = new Set<string>();
    registeredCommands.set(client, names);
  }
  if (!names.has(name) && typeof client.defineCommand === 'function') {
    client.defineCommand(name, {
      lua: OPERATION_COORDINATION_LUA,
      numberOfKeys: 1,
    });
    names.add(name);
  }
  return OPERATION_COORDINATION_SHA1;
}

export function scriptIsNoScript(error: unknown): boolean {
  const text = error instanceof Error
    ? `${error.message} ${(error as Error & { code?: unknown }).code ?? ''}`
    : String(error);
  return /\bNOSCRIPT\b/i.test(text);
}

export function scriptErrorCode(error: unknown): string | undefined {
  const text = error instanceof Error ? error.message : String(error);
  const match = text.match(/(?:ERR\s+)?(TX_[A-Z0-9_]+)/i);
  return match?.[1]?.toUpperCase();
}
