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

const log = (level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', fn: (...a: unknown[]) => void, args: unknown[]) => {
  if (isDebugEnabled()) {
    fn(`[${level}]`, ...args);
  }
};

export const debugLog = (...args: unknown[]) => log('DEBUG', console.log, args);
export const infoLog = (...args: unknown[]) => log('INFO', console.info, args);
export const warnLog = (...args: unknown[]) => log('WARN', console.warn, args);
export const errorLog = (...args: unknown[]) => log('ERROR', console.error, args);
