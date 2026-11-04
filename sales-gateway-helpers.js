'use strict';

const { timingSafeEqual } = require('crypto');

const MAX_EVENT_BODY = 1024 * 1024;
const ALLOWED_EVENTS = new Set([
  'ONCRMDEALADD',
  'ONCRMDEALUPDATE',
  'ONCRMACTIVITYADD',
  // Bitrix also emits updates when an existing scheduled activity is changed.
  // The same read-only activity.get -> deal.get path refreshes Next Step.
  'ONCRMACTIVITYUPDATE',
]);

function decodeBasicCredentials(header) {
  if (typeof header !== 'string') return null;
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(header.trim());
  if (!match) return null;

  const encoded = match[1];
  if (encoded.length % 4 === 1) return null;
  const padded = encoded + '='.repeat((4 - (encoded.length % 4)) % 4);
  const bytes = Buffer.from(padded, 'base64');
  if (bytes.toString('base64') !== padded) return null;
  const decoded = bytes.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) return null;
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

// Multiple documented aliases describe one event identity. Reject ambiguous
// input rather than silently trusting the first name in parser precedence.
// A malformed shadow field must not be rescued by a valid canonical value.
function aliasesConsistent(values, kind) {
  const present = values.filter(value => value != null);
  if (present.length < 2) return true;
  const scalar = kind === 'id'
    ? value => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
    : value => typeof value === 'string';
  if (!present.every(scalar)) return false;
  const normalized = present.map(value =>
    kind === 'event' ? value.toUpperCase() : String(value));
  return normalized.every(value => value === normalized[0]);
}

// JSON.parse silently discards earlier values when an object repeats a key.
// Distinct HTTP parsers can then disagree about the event, CRM identity or
// credential they verified. Scan *parsed-valid* JSON lexically to reject
// duplicate object names, including equivalent Unicode-escaped spellings.
// Use an iterative stack to avoid recursion failures on deeply nested input.
function hasDuplicateJsonObjectKeys(json) {
  const stack = [];
  for (let i = 0; i < json.length; i += 1) {
    const ch = json[i];
    if (ch === '"') {
      const start = i;
      for (i += 1; i < json.length; i += 1) {
        if (json[i] === '\\') { i += 1; continue; }
        if (json[i] === '"') break;
      }
      const container = stack[stack.length - 1];
      if (container?.kind === 'object' && container.expectKey) {
        const key = JSON.parse(json.slice(start, i + 1));
        if (container.keys.has(key)) return true;
        container.keys.add(key);
        container.expectKey = false;
      }
    } else if (ch === '{') {
      stack.push({ kind: 'object', expectKey: true, keys: new Set() });
    } else if (ch === '[') {
      stack.push({ kind: 'array' });
    } else if (ch === '}' || ch === ']') {
      stack.pop();
    } else if (ch === ',' && stack[stack.length - 1]?.kind === 'object') {
      stack[stack.length - 1].expectKey = true;
    }
  }
  return false;
}

function parseBitrixEvent(raw, contentType, expectedToken) {
  const expected = typeof expectedToken === 'string' ? expectedToken : '';
  if (!expected) return null;
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw || ''), 'utf8');
  if (!bytes.length || bytes.length > MAX_EVENT_BODY) return null;

  let event;
  let entityId;
  let activityProviderId = null;
  let activityDirection = null;
  let activityOwnerTypeId = null;
  let suppliedToken;

  if (String(contentType || '').toLowerCase().includes('application/json')) {
    let body;
    const json = bytes.toString('utf8');
    try { body = JSON.parse(json); } catch { return null; }
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        hasDuplicateJsonObjectKeys(json)) return null;
    // Do not silently replace malformed JSON envelopes with empty objects:
    // a valid fallback ID or token could otherwise mask a malformed primary
    // data/FIELDS/auth container. Null or absent containers retain support
    // for legacy flat Bitrix event payloads.
    const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (body.data != null && !isRecord(body.data)) return null;
    const data = body.data ?? {};
    if (data.FIELDS != null && !isRecord(data.FIELDS)) return null;
    const fields = data.FIELDS ?? {};
    if (body.auth != null && !isRecord(body.auth)) return null;
    if (!aliasesConsistent([body.event, body.EVENT], 'event') ||
        !aliasesConsistent([fields.ID, data.ID, body.dealId, body.activityId], 'id') ||
        !aliasesConsistent([body.auth?.application_token, body.application_token], 'token')) {
      return null;
    }
    // A present but malformed primary field must not be erased by an
    // otherwise valid fallback alias. Only null/missing values fall back.
    event = body.event ?? body.EVENT;
    // The legacy flat-ID fallback must match the event entity type. A
    // deal event carrying only activityId (or the reverse) is not a valid
    // identifier for the claimed event, even with a matching shared token.
    const activityEvent = typeof event === 'string' &&
      /^ONCRMACTIVITY(?:ADD|UPDATE)$/i.test(event);
    // A correctly typed FIELDS.ID must not hide an alias belonging to the
    // opposite CRM entity. Reject the foreign alias even if IDs coincide.
    if ((activityEvent ? body.dealId : body.activityId) != null) return null;
    entityId = fields.ID ?? data.ID ?? (activityEvent ? body.activityId : body.dealId);
    // Preserve explicit JSON values until type validation. Truthy fallbacks
    // silently discard false (invalid) and 0 (valid finite number).
    activityProviderId = fields.PROVIDER_ID ?? null;
    activityDirection = fields.DIRECTION ?? null;
    activityOwnerTypeId = fields.OWNER_TYPE_ID ?? null;
    suppliedToken = (body.auth && typeof body.auth === 'object' ? body.auth.application_token : undefined) ?? body.application_token;
  } else {
    const params = new URLSearchParams(bytes.toString('utf8'));
    // URLSearchParams.get silently takes the first of several occurrences.
    // Repeated identity, credential or activity metadata keys are ambiguous:
    // a conflicting later value must not be ignored when accepting an event.
    // Leave unrelated vendor-specific repeated fields untouched.
    for (const key of [
      'event', 'EVENT', 'data[FIELDS][ID]', 'data[ID]', 'dealId', 'activityId',
      'auth[application_token]', 'application_token',
      'data[FIELDS][PROVIDER_ID]', 'data[FIELDS][DIRECTION]',
      'data[FIELDS][OWNER_TYPE_ID]',
    ]) {
      if (params.getAll(key).length > 1) return null;
    }
    if (!aliasesConsistent([params.get('event'), params.get('EVENT')], 'event') ||
        !aliasesConsistent([
          params.get('data[FIELDS][ID]'), params.get('data[ID]'),
          params.get('dealId'), params.get('activityId'),
        ], 'id') ||
        !aliasesConsistent([
          params.get('auth[application_token]'), params.get('application_token'),
        ], 'token')) {
      return null;
    }
    // URLSearchParams.get returns null for absent keys, and '' for explicit
    // empty values. Preserve that distinction to reject masked bad fields.
    event = params.get('event') ?? params.get('EVENT');
    const activityEvent = typeof event === 'string' &&
      /^ONCRMACTIVITY(?:ADD|UPDATE)$/i.test(event);
    if ((activityEvent ? params.get('dealId') : params.get('activityId')) !== null) return null;
    entityId = params.get('data[FIELDS][ID]') ?? params.get('data[ID]') ??
      (activityEvent ? params.get('activityId') : params.get('dealId'));
    activityProviderId = params.get('data[FIELDS][PROVIDER_ID]');
    activityDirection = params.get('data[FIELDS][DIRECTION]');
    activityOwnerTypeId = params.get('data[FIELDS][OWNER_TYPE_ID]');
    suppliedToken = params.get('auth[application_token]') ?? params.get('application_token');
  }

  // JSON arrays/objects are never canonical webhook identities or credentials.
  // String coercion could turn ['941002'] into a valid deal ID, an event-name
  // array into an allowed event, or [secret] into a matching application token.
  // Apply the same scalar contract to form and JSON payloads before validation.
  if (typeof event !== 'string' || typeof suppliedToken !== 'string' ||
      (typeof entityId !== 'string' && typeof entityId !== 'number')) return null;
  // Bitrix activity metadata is optional, but still untrusted input. JSON
  // arrays can masquerade as scalar IDs via String(['2']), while objects
  // with a non-callable toString can throw and terminate the HTTP handler.
  // Form posts are already strings; JSON may legitimately carry numbers.
  const optionalScalar = value => value == null || typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value));
  if (![activityProviderId, activityDirection, activityOwnerTypeId].every(optionalScalar)) return null;

  const tokenA = Buffer.from(String(suppliedToken || ''), 'utf8');
  const tokenB = Buffer.from(expected, 'utf8');
  if (!tokenA.length || tokenA.length !== tokenB.length || !timingSafeEqual(tokenA, tokenB)) return null;

  const name = String(event || '').toUpperCase();
  if (!ALLOWED_EVENTS.has(name)) return null;
  const id = String(entityId == null ? '' : entityId).trim();
  if (!/^[1-9]\d{0,14}$/.test(id) || !Number.isSafeInteger(Number(id))) return null;

  // Both create and update events identify the activity, not a deal.
  // Route each through the same read-only activity.get -> deal.get resolver.
  if (name === 'ONCRMACTIVITYADD' || name === 'ONCRMACTIVITYUPDATE') {
    return Object.freeze({
      event: name,
      dealId: null,
      activityId: id,
      activityProviderId: activityProviderId == null ? null : String(activityProviderId),
      activityDirection: activityDirection == null ? null : String(activityDirection),
      activityOwnerTypeId: activityOwnerTypeId == null ? null : String(activityOwnerTypeId),
    });
  }
  return Object.freeze({ event: name, dealId: id, activityId: null });
}

function sanitizeProxyHeaders(headers, dashboardToken) {
  const output = { ...(headers || {}) };
  for (const key of Object.keys(output)) {
    if (key.toLowerCase() === 'proxy-authorization') delete output[key];
  }
  const authKey = Object.keys(output).find(key => key.toLowerCase() === 'authorization');
  if (!authKey) return output;
  const auth = output[authKey];
  if (typeof auth !== 'string') {
    delete output[authKey];
    return output;
  }
  if (!/^Basic\s/i.test(auth)) return output;
  const credentials = decodeBasicCredentials(auth);
  if (!credentials || credentials.username === 'sales' ||
      (typeof dashboardToken === 'string' && dashboardToken.length > 0 && credentials.password === dashboardToken)) {
    delete output[authKey];
  }
  return output;
}

module.exports = Object.freeze({
  MAX_EVENT_BODY,
  decodeBasicCredentials,
  parseBitrixEvent,
  sanitizeProxyHeaders,
});
