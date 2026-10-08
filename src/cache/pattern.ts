export function matchesPattern(value: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return value === pattern;
  // Anchored literal segments with KMP searches: O(value.length +
  // pattern.length) time, O(pattern.length) auxiliary space. Searches consume
  // disjoint value ranges, and each literal's failure table is built once.
  // Only '*' is special; retain the former '.' behavior for line terminators.
  const parts = pattern.split('*');
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (!value.startsWith(first) || !value.endsWith(last)) return false;
  let position = first.length;
  const end = value.length - last.length;
  if (position > end) return false;
  for (let index = 1; index < parts.length - 1; index++) {
    const literal = parts[index]!;
    if (!literal.length) continue;
    const found = findLiteral(value, literal, position, end);
    if (found < 0 || hasLineTerminator(value, position, found)) return false;
    position = found + literal.length;
  }
  return !hasLineTerminator(value, position, end);
}

function isLineTerminator(code: number): boolean {
  return code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
}

function hasLineTerminator(value: string, start: number, end: number): boolean {
  for (let index = start; index < end; index++) if (isLineTerminator(value.charCodeAt(index))) return true;
  return false;
}

function findLiteral(value: string, literal: string, start: number, end: number): number {
  const failure = new Uint32Array(literal.length);
  for (let index = 1, matched = 0; index < literal.length; index++) {
    while (matched > 0 && literal[index] !== literal[matched]) matched = failure[matched - 1]!;
    if (literal[index] === literal[matched]) matched++;
    failure[index] = matched;
  }
  for (let index = start, matched = 0; index < end; index++) {
    while (matched > 0 && value[index] !== literal[matched]) matched = failure[matched - 1]!;
    if (value[index] === literal[matched]) matched++;
    if (matched === literal.length) return index - literal.length + 1;
  }
  return -1;
}
