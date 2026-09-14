import { createHash } from 'node:crypto';

export interface RedisPipelineFailureContext {
  command: string;
  index: number;
  keyDigest?: string;
  partialSuccess: true;
}

/** Error raised when one command in a Redis pipeline fails.
 *
 * Pipeline execution is not atomic: callers must treat the operation as
 * failed, while accepting that earlier (or later) commands may have run.
 * `keyDigest` is deliberately one-way so default telemetry can identify a
 * key consistently without exposing key material.
 */
export class RedisPipelineCommandError extends Error {
  readonly code = 'REDIS_PIPELINE_COMMAND_FAILED';
  readonly partialSuccess = true as const;
  readonly command: string;
  readonly index: number;
  readonly keyDigest?: string;

  constructor(context: RedisPipelineFailureContext, cause: unknown) {
    super(`Redis pipeline ${context.command} failed at command index ${context.index}`);
    this.name = 'RedisPipelineCommandError';
    this.command = context.command;
    this.index = context.index;
    this.keyDigest = context.keyDigest;
    this.cause = cause;
  }
}

export function redisKeyDigest(key: unknown): string {
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
}

export type RedisPipelineTuple = [Error | null, unknown];

/** Validate ioredis Pipeline.exec() tuples and surface command-level errors. */
export function validateRedisPipeline(
  results: RedisPipelineTuple[] | null | undefined,
  commands: readonly { command: string; key?: unknown }[],
): RedisPipelineTuple[] {
  if (!results) return [];
  for (let index = 0; index < results.length; index += 1) {
    const tuple = results[index];
    if (tuple?.[0]) {
      const descriptor = commands[index] ?? { command: 'unknown' };
      throw new RedisPipelineCommandError({
        command: descriptor.command,
        index,
        keyDigest: descriptor.key === undefined ? undefined : redisKeyDigest(descriptor.key),
        partialSuccess: true,
      }, tuple[0]);
    }
  }
  return results;
}
