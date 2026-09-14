import { createHash, randomBytes } from 'node:crypto';

import type { Identity } from './types.js';
import { OperationValidationError } from './types.js';

/** Protocol limits are deliberately small because the Redis record is metadata. */
export const TRANSACTION_KEY_SCHEMA = 1 as const;
export const MAX_NAMESPACE_BYTES = 96;
export const MAX_TENANT_BYTES = 128;
export const MAX_OPERATION_BYTES = 96;
export const MAX_IDEMPOTENCY_KEY_BYTES = 256;
export const MAX_DURABLE_ID_BYTES = 128;
export const MAX_RESULT_REFERENCE_BYTES = 256;
export const MAX_PAYMENT_ACCOUNT_BYTES = 128;
export const MAX_PAYMENT_AMOUNT_MINOR = '9223372036854775807';

const HEX_64 = /^[0-9a-f]{64}$/;
const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const REFERENCE = /^[A-Za-z0-9_:/%.\-]+$/;
const PAYMENT_ACCOUNT = /^[A-Za-z0-9_:/%.\-]+$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function boundedString(name: string, value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OperationValidationError(`${name} must be a non-empty string`);
  }
  if (!isWellFormedUnicode(value)) {
    throw new OperationValidationError(`${name} must contain well-formed UTF-8`);
  }
  if (byteLength(value) > maxBytes) {
    throw new OperationValidationError(`${name} exceeds its ${maxBytes}-byte limit`);
  }
  if (/\u0000|[\u0001-\u001f\u007f]/u.test(value)) {
    throw new OperationValidationError(`${name} contains a control character`);
  }
  return value;
}

export function validateNamespace(namespace: unknown): string {
  const value = boundedString('namespace', namespace, MAX_NAMESPACE_BYTES);
  if (!NAMESPACE.test(value) || value.includes('{') || value.includes('}')) {
    throw new OperationValidationError('namespace contains unsupported characters');
  }
  return value;
}

export function validateReference(name: string, value: unknown, maxBytes = MAX_RESULT_REFERENCE_BYTES): string {
  const result = boundedString(name, value, maxBytes);
  if (!REFERENCE.test(result)) {
    throw new OperationValidationError(`${name} contains unsupported identifier characters`);
  }
  return result;
}

export function validateFingerprint(value: unknown): string {
  const fingerprint = boundedString('fingerprint', value, 64);
  if (!HEX_64.test(fingerprint)) {
    throw new OperationValidationError('fingerprint must be a lowercase SHA-256 hex digest');
  }
  return fingerprint;
}

export function validateOwner(value: unknown): string {
  const owner = boundedString('owner', value, 64);
  if (!HEX_64.test(owner)) {
    throw new OperationValidationError('owner must be a lowercase 256-bit hex token');
  }
  return owner;
}

/** Validate the identity that was prepared by the durable application record. */
export function validateIdentity(identity: Identity): Identity {
  if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) {
    throw new OperationValidationError('identity must be an object');
  }
  const value = identity as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'durableId,fingerprint,idempotencyKey,operation,tenant') {
    throw new OperationValidationError('identity has unknown or missing fields');
  }
  const tenant = boundedString('tenant', value.tenant, MAX_TENANT_BYTES);
  const operation = boundedString('operation', value.operation, MAX_OPERATION_BYTES);
  const idempotencyKey = boundedString('idempotencyKey', value.idempotencyKey, MAX_IDEMPOTENCY_KEY_BYTES);
  const fingerprint = validateFingerprint(value.fingerprint);
  const durableId = validateReference('durableId', value.durableId, MAX_DURABLE_ID_BYTES);
  return Object.freeze({ tenant, operation, idempotencyKey, fingerprint, durableId });
}

/**
 * Derive the one record key for an operation.  The digest in braces is a
 * Redis Cluster hash tag, so all coordination for this operation is routed to
 * one slot.  A scope digest is retained in the key for namespace/tenant
 * separation without exposing tenant material to Redis key listings.
 */
export function operationKey(namespace: string, identity: Identity): string {
  const ns = validateNamespace(namespace);
  const id = validateIdentity(identity);
  const scope = digest(JSON.stringify([ns, id.tenant]));
  const operation = digest(JSON.stringify([ns, id.tenant, id.operation, id.idempotencyKey]));
  return `lltx:v${TRANSACTION_KEY_SCHEMA}:${scope}:{${operation}}:record`;
}

/** A fresh acquisition token; it is never reused as a provider idempotency key. */
export function newOwner(): string {
  return randomBytes(32).toString('hex');
}

/** Hash a fixed ordered tuple of validated strings. */
export function fingerprintFields(domain: string, fields: readonly string[]): string {
  const d = boundedString('fingerprint domain', domain, 64);
  if (!Array.isArray(fields) || fields.some((value) => typeof value !== 'string')) {
    throw new OperationValidationError('fingerprint fields must be strings');
  }
  const checked = fields.map((value, index) => boundedString(`fingerprint field ${index}`, value, 512));
  return digest(JSON.stringify([d, ...checked]));
}

export type PaymentFingerprintInput = Readonly<{
  tenant: string;
  fromAccount: string;
  toAccount: string;
  currency: string;
  amountMinor: string;
}>;

export function validateAmountMinor(amountMinor: unknown): string {
  const amount = boundedString('amountMinor', amountMinor, 32);
  if (!POSITIVE_DECIMAL.test(amount)) {
    throw new OperationValidationError('amountMinor must be a positive canonical decimal string');
  }
  try {
    if (BigInt(amount) > BigInt(MAX_PAYMENT_AMOUNT_MINOR)) {
      throw new OperationValidationError(`amountMinor exceeds ${MAX_PAYMENT_AMOUNT_MINOR}`);
    }
  } catch (error) {
    if (error instanceof OperationValidationError) throw error;
    throw new OperationValidationError('amountMinor is outside the supported integer range');
  }
  return amount;
}

function paymentAccount(name: string, value: unknown): string {
  const account = boundedString(name, value, MAX_PAYMENT_ACCOUNT_BYTES);
  if (!PAYMENT_ACCOUNT.test(account)) {
    throw new OperationValidationError(`${name} contains unsupported identifier characters`);
  }
  return account;
}

export function validatePaymentFingerprintInput(input: PaymentFingerprintInput): PaymentFingerprintInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new OperationValidationError('payment input must be an object');
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'amountMinor,currency,fromAccount,tenant,toAccount') {
    throw new OperationValidationError('payment input has unknown or missing fields');
  }
  const tenant = boundedString('tenant', value.tenant, MAX_TENANT_BYTES);
  const fromAccount = paymentAccount('fromAccount', value.fromAccount);
  const toAccount = paymentAccount('toAccount', value.toAccount);
  const currency = boundedString('currency', value.currency, 8);
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new OperationValidationError('currency must be an uppercase ISO-4217 code');
  }
  const amountMinor = validateAmountMinor(value.amountMinor);
  if (fromAccount === toAccount) {
    throw new OperationValidationError('fromAccount and toAccount must differ');
  }
  return Object.freeze({ tenant, fromAccount, toAccount, currency, amountMinor });
}

/** Canonical payment fingerprint: field order is fixed and object key order is irrelevant. */
export function paymentFingerprint(input: PaymentFingerprintInput): string {
  const payment = validatePaymentFingerprintInput(input);
  return fingerprintFields('payment-v1', [
    payment.tenant,
    payment.fromAccount,
    payment.toAccount,
    payment.currency,
    payment.amountMinor,
  ]);
}

/** Stable provider identity derived from the durable operation, never its lease owner. */
export function paymentProviderKey(durableId: string, providerAccount: string): string {
  const id = validateReference('durableId', durableId, MAX_DURABLE_ID_BYTES);
  const account = validateReference('providerAccount', providerAccount, 128);
  return `lltx-provider-v1-${fingerprintFields('provider-v1', [account, id])}`;
}

export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX_64.test(value);
}

export function isReference(value: unknown, maxBytes = MAX_RESULT_REFERENCE_BYTES): value is string {
  return typeof value === 'string'
    && value.length > 0
    && byteLength(value) <= maxBytes
    && REFERENCE.test(value);
}
