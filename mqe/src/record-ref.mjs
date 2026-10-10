import { createHmac } from 'node:crypto';

const DOMAINS = Object.freeze({
  record: { prefix: 'rr1', parts: 1 },
  authority: { prefix: 'ar1', parts: 3 },
  entity: { prefix: 'er1', parts: 2 },
});
const PREFIX_TO_DOMAIN = new Map(Object.entries(DOMAINS).map(([domain, value]) => [value.prefix, domain]));
const RECORD_REF = /^(rr1|ar1|er1)_[a-f0-9]{64}$/u;
const KEY_ID = /^rk1_[a-f0-9]{32}$/u;

function requireKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('invalid_ref_hmac_key');
  return key;
}

function requireParts(domain, parts) {
  const contract = DOMAINS[domain];
  if (!contract || !Array.isArray(parts) || parts.length !== contract.parts
    || parts.some((part) => typeof part !== 'string')) {
    throw new TypeError('invalid_ref_identity');
  }
  return contract;
}

export function makeTypedRef(domain, parts, key) {
  const contract = requireParts(domain, parts);
  const hmac = createHmac('sha256', requireKey(key));
  hmac.update('mqe-ref/v1\0', 'utf8');
  hmac.update(domain, 'utf8');
  hmac.update('\0', 'utf8');
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length, 0);
    hmac.update(length);
    hmac.update(bytes);
  }
  return `${contract.prefix}_${hmac.digest('hex')}`;
}

export function makeRecordRef(recordId, key) {
  return makeTypedRef('record', [recordId], key);
}

export function makeAuthorityRef(parts, key) {
  return makeTypedRef('authority', parts, key);
}

export function makeEntityRef(parts, key) {
  return makeTypedRef('entity', parts, key);
}

export function refKeyId(key) {
  const digest = createHmac('sha256', requireKey(key))
    .update('mqe-ref-key-id/v1', 'utf8')
    .digest('hex');
  return `rk1_${digest.slice(0, 32)}`;
}

export function parseRecordRef(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(RECORD_REF);
  if (!match) return null;
  return { domain: PREFIX_TO_DOMAIN.get(match[1]), prefix: match[1] };
}

export function isRecordRef(value, expectedDomain = null) {
  const parsed = parseRecordRef(value);
  return Boolean(parsed && (expectedDomain === null || parsed.domain === expectedDomain));
}

export function isRefKeyId(value) {
  return typeof value === 'string' && KEY_ID.test(value);
}
