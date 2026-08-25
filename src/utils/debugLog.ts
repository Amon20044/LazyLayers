export type CacheRuntimeEnv = 'development' | 'production' | 'test';

export interface CacheLoggerOptions {
  env?: CacheRuntimeEnv;
  enabled?: boolean;
}

let loggerOptions: CacheLoggerOptions = {
  env: process.env.NODE_ENV === 'production' ? 'production' : 'development',
};

export function configureCacheLogger(options: CacheLoggerOptions = {}): void {
  loggerOptions = {
    ...loggerOptions,
    ...options,
  };
}

export const isDebugEnabled = () => loggerOptions.enabled ?? loggerOptions.env !== 'production';

/**
 * Errors are never suppressed by the env switch. Production silences debug
 * chatter, not the one line that tells an operator their event bus stopped
 * consuming. `enabled: false` is still an explicit hard mute for everything.
 */
const isErrorEnabled = () => loggerOptions.enabled !== false;

const log = (level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', fn: (...a: unknown[]) => void, args: unknown[]) => {
  const enabled = level === 'ERROR' ? isErrorEnabled() : isDebugEnabled();

  if (enabled) {
    fn(`[${level}]`, ...args);
  }
};

export const debugLog = (...args: unknown[]) => log('DEBUG', console.log, args);
export const infoLog = (...args: unknown[]) => log('INFO', console.info, args);
export const warnLog = (...args: unknown[]) => log('WARN', console.warn, args);
export const errorLog = (...args: unknown[]) => log('ERROR', console.error, args);
