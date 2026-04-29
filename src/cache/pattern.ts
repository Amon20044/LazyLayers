const MAX_PATTERN_CACHE = 500;
const patternCache = new Map<string, RegExp>();

export function matchesPattern(value: string, pattern: string): boolean {
  if (pattern === '*') {
    return true;
  }

  return wildcardToRegExp(pattern).test(value);
}

function wildcardToRegExp(pattern: string): RegExp {
  const cached = patternCache.get(pattern);

  if (cached) {
    return cached;
  }

  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  const source = escaped.replace(/\*/g, '.*');
  const regex = new RegExp(`^${source}$`);

  if (patternCache.size >= MAX_PATTERN_CACHE) {
    const oldest = patternCache.keys().next().value;

    if (oldest !== undefined) {
      patternCache.delete(oldest);
    }
  }

  patternCache.set(pattern, regex);

  return regex;
}
