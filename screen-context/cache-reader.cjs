'use strict';

// First-party pure reference adapter. No files, network, model, timers or host discovery.
// Validation methods adapted from a completed-cache consumer; deployment wiring removed.
const crypto = require('node:crypto');
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CACHE_KEYS = [
  'schema', 'revision', 'generated_at_utc', 'source_from_utc', 'source_until_utc',
  'coverage', 'pending_count', 'items', 'captured_content_untrusted',
];
const CATEGORIES = new Set(['work', 'learning', 'life', 'interests', 'relationships', 'other']);


// Accept only bounded JSON-compatible own data, including plain foreign-realm records.
// Never invoke an accessor or a user-supplied serialization method.
function snapshotData(value) {
  let nodes = 0;
  const active = new WeakSet();
  const nativeObject = Function.prototype.toString.call(Object);
  const nativeArray = Function.prototype.toString.call(Array);
  function objectPrototype(proto) {
    if (proto === null) return true;
    const ctor = Object.getOwnPropertyDescriptor(proto, 'constructor');
    return Object.getPrototypeOf(proto) === null
      && ctor && Object.hasOwn(ctor, 'value') && typeof ctor.value === 'function'
      && Function.prototype.toString.call(ctor.value) === nativeObject
      && ctor.value.prototype === proto
      && !Object.getOwnPropertyDescriptor(proto, 'toJSON');
  }
  function arrayPrototype(proto) {
    if (proto === null) return true;
    const ctor = Object.getOwnPropertyDescriptor(proto, 'constructor');
    return ctor && Object.hasOwn(ctor, 'value') && typeof ctor.value === 'function'
      && Function.prototype.toString.call(ctor.value) === nativeArray
      && ctor.value.prototype === proto
      && objectPrototype(Object.getPrototypeOf(proto))
      && !Object.getOwnPropertyDescriptor(proto, 'toJSON');
  }
  function copy(input, depth) {
    if (++nodes > 256 || depth > 8) throw new Error('UNSAFE_DATA');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string' && input.length <= 16384) return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input !== 'object' || active.has(input)) throw new Error('UNSAFE_DATA');
    const isArray = Array.isArray(input), proto = Object.getPrototypeOf(input);
    if (!(isArray ? arrayPrototype(proto) : objectPrototype(proto))) throw new Error('UNSAFE_DATA');
    const keys = Reflect.ownKeys(input);
    if (keys.length > 65 || keys.some(key => typeof key !== 'string' || key === 'toJSON')) {
      throw new Error('UNSAFE_DATA');
    }
    active.add(input);
    let output;
    if (isArray) {
      const size = Object.getOwnPropertyDescriptor(input, 'length');
      if (!size || !Object.hasOwn(size, 'value') || !Number.isSafeInteger(size.value)
        || size.value < 0 || size.value > 64 || keys.length !== size.value + 1) {
        throw new Error('UNSAFE_DATA');
      }
      output = [];
      for (let index = 0; index < size.value; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
          throw new Error('UNSAFE_DATA');
        }
        output.push(copy(descriptor.value, depth + 1));
      }
      // An own inert slot prevents inherited hooks during integrity/byte serialization.
      Object.defineProperty(output, 'toJSON', {value: undefined});
    } else {
      output = Object.create(null);
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
          throw new Error('UNSAFE_DATA');
        }
        output[key] = copy(descriptor.value, depth + 1);
      }
    }
    active.delete(input);
    return Object.freeze(output);
  }
  return copy(value, 0);
}

function inertArray(values) {
  Object.defineProperty(values, 'toJSON', {value: undefined});
  return Object.freeze(values);
}

function objectWithKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function utcMillis(value) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return NaN;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return NaN;
  const canonical = new Date(milliseconds).toISOString();
  return canonical === value || canonical === value.replace(/Z$/u, '.000Z') ? milliseconds : NaN;
}

function safeText(text) {
  if (typeof text !== 'string' || !text.trim() || text !== text.trim()
    || text.normalize('NFKC') !== text
    || Array.from(text).length > 160
    || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u.test(text)) return false;
  const forbidden = [
    /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,})/u,
    /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/iu,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
    /(?:password|passwd|pwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|cookie|\u5bc6\u7801|\u53e3\u4ee4|\u5bc6\u94a5|\u9a8c\u8bc1\u7801)\s*[:=\uff1a]\s*\S+/iu,
    /-----BEGIN\s+(?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/u,
    /<\|[^>]*\|>|<\/?(?:system|developer|assistant|tool|script)\b|\[(?:SYSTEM|DEVELOPER|UNTRUSTED_DATA)\]/iu,
    /(?:ignore|disregard|override)\b.{0,45}\b(?:previous|prior|system|developer|instructions|rules)\b/iu,
    /(?:\u5ffd\u7565|\u65e0\u89c6|\u8986\u76d6|\u7ed5\u8fc7).{0,24}(?:\u4e4b\u524d|\u6b64\u524d|\u4ee5\u4e0a|\u4e0a\u9762|\u7cfb\u7edf|\u5f00\u53d1\u8005|\u6307\u4ee4|\u89c4\u5219|\u6743\u9650)|\u7cfb\u7edf\u63d0\u793a\u8bcd|\u5f00\u53d1\u8005\u6307\u4ee4/u,
    /(?:javascript|data)\s*:/iu,
    // Independent consumer-side privacy checks. The collector/publisher may
    // already redact these, but their presence in a cache still rejects it.
    /\b[a-z][a-z0-9+.-]{1,20}:\/\/|\bwww\.|\bmailto:/iu,
    /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|app|cn|dev|co|me|tv)(?![a-z0-9-])/iu,
    /[^\s@]+@[^\s@]+\.[^\s@]+/u,
    /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d(?:[- ]?\d){8}(?!\d)/u,
    /\+\d[\d ()-]{7,}\d|\b\d{3}[- .]\d{3}[- .]\d{4}\b|\b\d{3,4}-\d{7,8}\b/u,
    /(?<!\d)\d{13,19}(?!\d)|(?<!\d)\d{17}[Xx](?!\w)/u,
    /\b[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/]/u,
    /\/(?:home|users?|tmp|var|mnt|media|volumes|private|usr|etc|opt|root|srv|run|proc|dev|data)(?:\/|\b)/iu,
    /(?:^|[\s"'\uff08(\uff1a:])\/(?!\/)[^\s<>"'\uff0c\uff1b\u3002]+/u,
  ];
  return !forbidden.some((pattern) => pattern.test(text));
}

function validateCacheData(cache, now) {
  if (!Number.isSafeInteger(now)) return false;
  if (!objectWithKeys(cache, CACHE_KEYS) || cache.schema !== 'screen-context-cache/v1'
    || !/^[a-f0-9]{64}$/u.test(cache.revision || '')
    || cache.captured_content_untrusted !== true
    || !['complete', 'partial'].includes(cache.coverage)
    || !Number.isSafeInteger(cache.pending_count) || cache.pending_count < 0
    || !Array.isArray(cache.items) || cache.items.length < 1 || cache.items.length > 10) return false;
  const generated = utcMillis(cache.generated_at_utc);
  const from = utcMillis(cache.source_from_utc);
  const until = utcMillis(cache.source_until_utc);
  if (![generated, from, until].every(Number.isFinite) || from > until || until > generated
    || generated > now || now - generated > MAX_AGE_MS || now - until > MAX_AGE_MS) return false;
  let totalCharacters = 0;
  for (const item of cache.items) {
    if (!objectWithKeys(item, ['event_ids', 'category', 'text']) || !CATEGORIES.has(item.category)
      || !Array.isArray(item.event_ids) || item.event_ids.length < 1 || item.event_ids.length > 12
      || new Set(item.event_ids).size !== item.event_ids.length
      || !item.event_ids.every((id) => typeof id === 'string' && /^e_[a-f0-9]{24}$/u.test(id))
      || !safeText(item.text)) return false;
    totalCharacters += Array.from(item.text).length;
  }
  if (totalCharacters > 1600) return false;
  // Rebuild independently in the published key order. This detects accidental
  // corruption; it is an integrity hash, not an authentication signature.
  const body = Object.assign(Object.create(null), {
    schema: cache.schema,
    generated_at_utc: cache.generated_at_utc,
    source_from_utc: cache.source_from_utc,
    source_until_utc: cache.source_until_utc,
    coverage: cache.coverage,
    pending_count: cache.pending_count,
    items: inertArray(cache.items.map((item) => Object.assign(Object.create(null),
      {event_ids: item.event_ids, category: item.category, text: item.text}))),
    captured_content_untrusted: cache.captured_content_untrusted,
  });
  const expected = crypto.createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
  return expected === cache.revision;
}

function validateCache(cache, now) {
  try {
    return validateCacheData(snapshotData(cache), now);
  } catch (_) {
    return false;
  }
}

const PURPOSES = ['on-demand-recall', 'proactive-suggestion', 'recent-context'];
const POLICY_KEYS = [
  'schema', 'runtime_mode', 'purpose_grants', 'maximum_cache_age_ms',
  'maximum_cache_bytes', 'captured_content_untrusted', 'network_access',
  'model_calls', 'periodic_model_refresh', 'automatic_memory_promotion',
  'automatic_project_state_write',
];

function validatePolicy(policy) {
  return objectWithKeys(policy, POLICY_KEYS)
    && policy.schema === 'screen-context-policy/v1'
    && policy.runtime_mode === 'offline-only'
    && objectWithKeys(policy.purpose_grants, PURPOSES)
    && PURPOSES.every(purpose => typeof policy.purpose_grants[purpose] === 'boolean')
    && Number.isSafeInteger(policy.maximum_cache_age_ms)
    && policy.maximum_cache_age_ms > 0 && policy.maximum_cache_age_ms <= MAX_AGE_MS
    && Number.isSafeInteger(policy.maximum_cache_bytes)
    && policy.maximum_cache_bytes > 0 && policy.maximum_cache_bytes <= 16384
    && policy.captured_content_untrusted === true
    && ['network_access', 'model_calls', 'periodic_model_refresh',
      'automatic_memory_promotion', 'automatic_project_state_write']
      .every(key => policy[key] === false);
}

// The caller passes an already-completed in-memory snapshot and explicit clock.
// Grants belong to each purpose; enabling one cannot enable another.
function readCompletedContext(cache, policy, purpose, now) {
  const silent = reason => ({status: 'SILENT', reason});
  try {
    policy = snapshotData(policy);
    if (!Number.isSafeInteger(now) || !validatePolicy(policy)) return silent('INVALID_POLICY_OR_CLOCK');
    if (!PURPOSES.includes(purpose)) return silent('UNKNOWN_PURPOSE');
    if (policy.purpose_grants[purpose] !== true) return silent('PURPOSE_DISABLED');
    if (cache === null || cache === undefined) return silent('NO_COMPLETED_CACHE');
    cache = snapshotData(cache);
    if (!validateCacheData(cache, now)) return silent('INVALID_OR_EXPIRED_CACHE');
    if (Buffer.byteLength(JSON.stringify(cache), 'utf8') > policy.maximum_cache_bytes) {
      return silent('CACHE_BYTE_LIMIT');
    }
    if (now - utcMillis(cache.generated_at_utc) > policy.maximum_cache_age_ms
      || now - utcMillis(cache.source_until_utc) > policy.maximum_cache_age_ms) {
      return silent('POLICY_TTL_EXCEEDED');
    }
    return {
      status: 'READY',
      purpose,
      source_until_utc: cache.source_until_utc,
      generated_at_utc: cache.generated_at_utc,
      coverage: cache.coverage,
      pending_count: cache.pending_count,
      items: cache.items.map(item => ({
        event_ids: [...item.event_ids], category: item.category, text: item.text,
      })),
      captured_content_untrusted: true,
      semantic_authority: false,
      automatic_memory_promotion: false,
      automatic_project_state_write: false,
    };
  } catch (_) {
    return silent('INVALID_INPUT');
  }
}

module.exports = {utcMillis, safeText, validateCache, readCompletedContext};
