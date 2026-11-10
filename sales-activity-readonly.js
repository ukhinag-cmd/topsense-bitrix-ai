'use strict';

// Dormant, injected-transport activity probe for future Bitrix contract validation.
// This file never makes requests on import and is NOT used by the live Sales
// engine until a real portal's read-only response shapes are verified.
// https://apidocs.bitrix24.com/api-reference/crm/timeline/activities/activity-base/crm-activity-list.html
const PAGE_SIZE = 50;
const MAX_PAGES = 10;
// Bitrix represents a missing deadline as 9999-12-31 in portal time.
// The same placeholder serialized in UTC can be 9999-12-30T21:00:00Z.
const NO_DEADLINE_FROM = Date.parse('9999-12-30T00:00:00Z');
// ISO 8601 allows subsecond precision beyond milliseconds. Retain up to
// nanoseconds while Date.parse normalizes the display instant to milliseconds.
const DATE_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function validDeadline(value) {
  const match = DATE_WITH_ZONE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  // Date.parse normalizes impossible civil dates and 24:00. Reject them
  // before they can become a misleading CRM next-action deadline.
  if (!year || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] ||
      hour > 23 || minute > 59 || second > 59) return false;
  if (match[8] !== 'Z') {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    // Real UTC offsets cannot exceed 14 hours. +14:30 is invalid.
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0))
      return false;
  }
  return Number.isFinite(Date.parse(value));
}

function canonicalId(value) {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) return null;
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) return null;
  return text;
}

function pageNumber(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (!/^(0|[1-9]\d*)$/.test(text) || !Number.isSafeInteger(Number(text))) return null;
  return Number(text);
}

// Injected transports may parse their JSON in a separate JS realm. Ordinary
// cross-realm Object/Array prototypes are safe to copy, but custom prototypes
// can conceal inherited pagination or activity identity metadata.
function sameIntrinsicKeys(prototype, intrinsic) {
  if (!prototype) return false;
  const keys = Reflect.ownKeys(prototype);
  const expected = Reflect.ownKeys(intrinsic);
  return keys.length === expected.length &&
    expected.every(key => Object.prototype.hasOwnProperty.call(prototype, key));
}
function plainObjectPrototype(prototype) {
  return prototype === null ||
    (Object.getPrototypeOf(prototype) === null &&
     sameIntrinsicKeys(prototype, Object.prototype));
}
function plainArrayPrototype(prototype) {
  return prototype !== null && Array.isArray(prototype) &&
    sameIntrinsicKeys(prototype, Array.prototype) &&
    plainObjectPrototype(Object.getPrototypeOf(prototype));
}

// Treat an injected transport as untrusted even after it resolves: mock
// getters/proxies may throw credential-bearing URL errors while reading
// response fields. Snapshot JSON-shaped values inside the redaction boundary
// so all later validation inspects inert data only.
function copyReadResponse(value, ancestors = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) throw new Error('Invalid Bitrix activity response cycle');
  const isArray = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (isArray ? !plainArrayPrototype(proto) : !plainObjectPrototype(proto))
    throw new Error('Invalid Bitrix activity response object');
  // JSON arrays have one own enumerable index per position. A sparse
  // injected page can otherwise become [] while copying, turning an
  // unknown activity into a false "no next step" result.
  const keys = Object.keys(value);
  // Parsed JSON never has hidden own keys; only an array's length is
  // non-enumerable. Reject hidden strings and symbols rather than silently
  // discarding pagination metadata and claiming a complete Next Step scan.
  if (Reflect.ownKeys(value).length !== keys.length + (isArray ? 1 : 0))
    throw new Error('Invalid Bitrix activity response hidden properties');
  if (isArray && (keys.length !== value.length ||
      keys.some((key, index) => key !== String(index))))
    throw new Error('Invalid Bitrix activity response array');
  ancestors.add(value);
  const copy = isArray ? [] : Object.create(null);
  for (const key of keys) {
    // defineProperty never invokes the array's inherited __proto__ setter.
    Object.defineProperty(copy, key, {
      value: copyReadResponse(value[key], ancestors),
      enumerable: true, writable: true, configurable: true,
    });
  }
  ancestors.delete(value);
  return copy;
}

function boundToDeal(activity, id) {
  // Bitrix's documented crm.activity.list response may omit BINDINGS even
  // when a BINDINGS filter was used. Accept the primary owner only when both
  // typed identity fields prove this activity belongs to the requested deal.
  if (activity.BINDINGS === undefined) {
    return canonicalId(activity.OWNER_TYPE_ID) === '2' && canonicalId(activity.OWNER_ID) === id;
  }
  if (!Array.isArray(activity.BINDINGS)) throw new Error('Invalid Bitrix activity bindings');
  // Explicit bindings are the activity's identity evidence. Validate every
  // entry before trusting a match: Array.some() stops at the first valid deal
  // binding and would silently discard malformed later entries.
  let matched = false;
  for (const binding of activity.BINDINGS) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
        canonicalId(binding.OWNER_TYPE_ID) === null ||
        canonicalId(binding.OWNER_ID) === null) {
      throw new Error('Invalid Bitrix activity binding');
    }
    if (canonicalId(binding.OWNER_TYPE_ID) === '2' &&
        canonicalId(binding.OWNER_ID) === id) matched = true;
  }
  return matched;
}

/**
 * One explicit, paginated read-only probe for a deal's open activities.
 * request is an injected transport returning the full Bitrix REST envelope.
 * Throws on ambiguous, malformed, unbound, or partial REST data rather than
 * reporting "no next step" from an incomplete scan.
 */
async function probeDealNextActivity(request, dealId) {
  if (typeof request !== 'function') throw new TypeError('Missing injected read-only Bitrix transport');
  const id = canonicalId(dealId);
  if (!id) throw new TypeError('Invalid Bitrix deal ID');
  const seen = new Set();
  let lastActivityId = 0;
  // Preserve the full verified nanosecond remainder when choosing the
  // earliest activity in a single JavaScript millisecond.
  let earliest = null;
  let checked = 0;
  let activitiesWithNoDeadline = 0;
  let expectedTotal = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const start = page * PAGE_SIZE;
    let response;
    try {
      response = copyReadResponse(await request('crm.activity.list', {
      order: { ID: 'ASC' },
      filter: { BINDINGS: [{ OWNER_TYPE_ID: 2, OWNER_ID: Number(id) }], COMPLETED: 'N' },
      select: ['ID', 'OWNER_TYPE_ID', 'OWNER_ID', 'BINDINGS', 'COMPLETED', 'DEADLINE'],
      start,
      }));
    } catch {
      // Never expose raw REST errors, accessors, or their causes to logs.
      throw new Error('Bitrix activity read failed');
    }
    if (!response || typeof response !== 'object' || Array.isArray(response) ||
        Object.prototype.hasOwnProperty.call(response, "error") ||
        !Array.isArray(response.result) || response.result.length > PAGE_SIZE) {
      throw new Error('Invalid Bitrix activity list response');
    }
    const rows = response.result;
    const consumed = start + rows.length;
    const total = response.total == null ? null : pageNumber(response.total);
    if (response.total != null && (total === null || total < consumed ||
        (expectedTotal !== null && total !== expectedTotal))) {
      throw new Error('Inconsistent Bitrix activity list total');
    }
    if (total !== null) expectedTotal = total;
    for (const activity of rows) {
      if (!activity || typeof activity !== 'object' || Array.isArray(activity))
        throw new Error('Invalid Bitrix activity record');
      const activityId = canonicalId(activity.ID);
      if (!activityId || seen.has(activityId)) throw new Error('Invalid or duplicate Bitrix activity ID');
      // An ID-ascending scan can drift across offset pages as CRM data changes.
      // Unique IDs and a stable total alone do not prove a complete scan if
      // results arrive out of order. Fail closed rather than certify a false
      // Next Step from a potentially skipped activity.
      const numericActivityId = Number(activityId);
      if (numericActivityId <= lastActivityId)
        throw new Error('Out-of-order Bitrix activity list');
      lastActivityId = numericActivityId;
      seen.add(activityId);
      // A search result may be bound to a company/contact as well as a deal.
      // Require evidence of the requested deal binding before using its date.
      if (!boundToDeal(activity, id)) throw new Error('Unrelated Bitrix activity in deal response');
      if (activity.COMPLETED !== 'N') throw new Error('Unexpected completed activity in open-activity response');
      checked += 1;
      if (activity.DEADLINE == null || activity.DEADLINE === '') {
        activitiesWithNoDeadline += 1;
        continue;
      }
      if (typeof activity.DEADLINE !== 'string' || !validDeadline(activity.DEADLINE))
        throw new Error('Invalid Bitrix activity deadline');
      const timestamp = Date.parse(activity.DEADLINE);
      if (!Number.isFinite(timestamp)) throw new Error('Invalid Bitrix activity deadline');
      // Check the instant, not the source date prefix: timezone conversion
      // can move 9999-12-31 00:00+03:00 to the preceding UTC calendar day.
      if (timestamp >= NO_DEADLINE_FROM) {
        activitiesWithNoDeadline += 1;
        continue;
      }
      // Date.parse truncates after milliseconds. Comparing only timestamps
      // could choose a later Next Step when Bitrix deadlines share the same
      // millisecond. Canonical nine-digit fractions compare lexicographically
      // after their millisecond instants have been normalized to UTC.
      const fraction = DATE_WITH_ZONE.exec(activity.DEADLINE)[7] || '';
      const extra = fraction.padEnd(9, '0').slice(3);
      if (earliest === null || timestamp < earliest.timestamp ||
          (timestamp === earliest.timestamp && extra < earliest.extra)) {
        earliest = { timestamp, extra, sourceExtra: fraction.slice(3) };
      }
    }
    const next = response.next == null ? null : pageNumber(response.next);
    if (response.next != null && (next === null || next !== consumed || rows.length !== PAGE_SIZE))
      throw new Error('Invalid Bitrix activity pagination cursor');
    if (expectedTotal !== null && ((next === null && consumed !== expectedTotal) ||
        (next !== null && next > expectedTotal)))
      throw new Error('Incomplete Bitrix activity scan');
    // Bitrix normally includes a next marker for pages with more data.
    // If a full page has neither next nor total, probe one additional page.
    const more = next !== null || (rows.length === PAGE_SIZE && expectedTotal === null);
    if (!more) {
      const preciseExtra = earliest === null ? '' : earliest.sourceExtra;
      const normalized = earliest === null ? null : new Date(earliest.timestamp).toISOString();
      return {
        nextActivityAt: normalized === null ? null : normalized.slice(0, -1) + preciseExtra + 'Z',
        activitiesWithNoDeadline, checked,
      };
    }
  }
  throw new Error('Bitrix activity page limit reached; incomplete scan');
}

module.exports = Object.freeze({ probeDealNextActivity });
