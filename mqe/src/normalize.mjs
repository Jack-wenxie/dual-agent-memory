import { createHash } from 'node:crypto';

export function normalizeStrict(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/gu, ' ').trim();
}

export function normalizeLoose(value) {
  return normalizeStrict(value).replace(/[^\p{L}\p{N}_]+/gu, '');
}

export function isRelayMessage(queryText, messageKind) {
  if (messageKind === 'relay') return true;
  const firstLine = String(queryText ?? '').trimStart().split(/\r?\n/u, 1)[0].trim();
  return firstLine === '/co' || firstLine === '/cl';
}

export function querySpans(queryText, maxSpans = 64) {
  const strict = normalizeStrict(queryText);
  const loose = normalizeLoose(queryText);
  const output = new Set([strict, loose]);
  for (const token of strict.split(/\s+/u)) {
    if (token) output.add(token);
  }
  const points = [...loose];
  for (let width = Math.min(12, points.length); width >= 2 && output.size < maxSpans; width -= 1) {
    for (let start = 0; start + width <= points.length && output.size < maxSpans; start += 1) {
      output.add(points.slice(start, start + width).join(''));
    }
  }
  return [...output].filter(Boolean).slice(0, maxSpans);
}

export function exactQueryKeys(queryText) {
  const strict = normalizeStrict(queryText);
  const loose = normalizeLoose(queryText);
  return [...new Set([strict, loose].filter(Boolean))];
}

export function queryTrigrams(queryText, maxShingles = 64) {
  const points = [...normalizeLoose(queryText)];
  if (points.length < 3) return [];
  const all = [];
  for (let index = 0; index + 3 <= points.length; index += 1) {
    const value = points.slice(index, index + 3).join('');
    if (!all.includes(value)) all.push(value);
  }
  if (all.length <= maxShingles) return all;
  const stride = Math.max(1, Math.ceil(all.length / maxShingles));
  return all.filter((_, index) => index % stride === 0).slice(0, maxShingles);
}

export function expressionFromShingles(shingles) {
  if (!shingles.length) return null;
  return shingles.map((value) => `"${value.replaceAll('"', '""')}"`).join(' OR ');
}

export function ftsExpression(queryText, maxShingles = 12) {
  const shingles = queryTrigrams(queryText, maxShingles);
  const expression = expressionFromShingles(shingles);
  return { expression, shingles };
}

export function stableHash(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}
