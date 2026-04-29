export function matchesPattern(value: string, pattern: string): boolean {
  if (pattern === '*') {
    return true;
  }

  return wildcardToRegExp(pattern).test(value);
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  const source = escaped.replace(/\*/g, '.*');

  return new RegExp(`^${source}$`);
}
