'use strict';

const { timingSafeEqual } = require('crypto');

const MAX_EVENT_BODY = 1024 * 1024;
const ALLOWED_EVENTS = new Set([
  'ONCRMDEALADD',
  'ONCRMDEALUPDATE',
  'ONCRMACTIVITYADD',
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
    try { body = JSON.parse(bytes.toString('utf8')); } catch { return null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const data = body.data && typeof body.data === 'object' ? body.data : {};
    const fields = data.FIELDS && typeof data.FIELDS === 'object' ? data.FIELDS : {};
    event = body.event || body.EVENT;
    entityId = fields.ID || data.ID || body.dealId || body.activityId;
    activityProviderId = fields.PROVIDER_ID || null;
    activityDirection = fields.DIRECTION || null;
    activityOwnerTypeId = fields.OWNER_TYPE_ID || null;
    suppliedToken = (body.auth && typeof body.auth === 'object' && body.auth.application_token) || body.application_token;
  } else {
    const params = new URLSearchParams(bytes.toString('utf8'));
    event = params.get('event') || params.get('EVENT');
    entityId = params.get('data[FIELDS][ID]') || params.get('data[ID]') ||
      params.get('dealId') || params.get('activityId');
    activityProviderId = params.get('data[FIELDS][PROVIDER_ID]');
    activityDirection = params.get('data[FIELDS][DIRECTION]');
    activityOwnerTypeId = params.get('data[FIELDS][OWNER_TYPE_ID]');
    suppliedToken = params.get('auth[application_token]') || params.get('application_token');
  }

  const tokenA = Buffer.from(String(suppliedToken || ''), 'utf8');
  const tokenB = Buffer.from(expected, 'utf8');
  if (!tokenA.length || tokenA.length !== tokenB.length || !timingSafeEqual(tokenA, tokenB)) return null;

  const name = String(event || '').toUpperCase();
  if (!ALLOWED_EVENTS.has(name)) return null;
  const id = String(entityId == null ? '' : entityId).trim();
  if (!/^[1-9]\d{0,14}$/.test(id) || !Number.isSafeInteger(Number(id))) return null;

  if (name === 'ONCRMACTIVITYADD') {
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
