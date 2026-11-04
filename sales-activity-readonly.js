'use strict';

// Dormant, injected-transport activity probe for future Bitrix contract validation.
// This file never makes requests on import and is NOT used by the live Sales
// engine until a real portal's read-only response shapes are verified.
// https://apidocs.bitrix24.com/api-reference/crm/timeline/activities/activity-base/crm-activity-list.html
const PAGE_SIZE = 50;
const MAX_PAGES = 10;
const DATE_WITH_ZONE = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d{1,3}))?(Z|([+-])(\\d{2}):(\\d{2}))$/;

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

function boundToDeal(activity, id) {
  // Bitrix's documented crm.activity.list response may omit BINDINGS even
  // when a BINDINGS filter was used. Accept the primary owner only when both
  // typed identity fields prove this activity belongs to the requested deal.
  if (activity.BINDINGS === undefined) {
    return canonicalId(activity.OWNER_TYPE_ID) === '2' && canonicalId(activity.OWNER_ID) === id;
  }
  if (!Array.isArray(activity.BINDINGS)) throw new Error('Invalid Bitrix activity bindings');
  // When explicit bindings are supplied they are authoritative; never
  // override contradictory bindings just because the primary ID matches.
  return activity.BINDINGS.some(binding =>
    binding && typeof binding === 'object' && !Array.isArray(binding) &&
    canonicalId(binding.OWNER_TYPE_ID) === '2' && canonicalId(binding.OWNER_ID) === id);
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
  let earliest = null;
  let checked = 0;
  let activitiesWithNoDeadline = 0;
  let expectedTotal = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const start = page * PAGE_SIZE;
    const response = await request('crm.activity.list', {
      order: { ID: 'ASC' },
      filter: { BINDINGS: [{ OWNER_TYPE_ID: 2, OWNER_ID: Number(id) }], COMPLETED: 'N' },
      select: ['ID', 'OWNER_TYPE_ID', 'OWNER_ID', 'BINDINGS', 'COMPLETED', 'DEADLINE'],
      start,
    });
    if (!response || typeof response !== 'object' || Array.isArray(response) ||
        response.error || !Array.isArray(response.result) || response.result.length > PAGE_SIZE) {
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
      // Bitrix documents 9999-12-31 as the placeholder for no deadline.
      // Do not report it as a scheduled action in the year 9999.
      if (activity.DEADLINE.slice(0, 10) === '9999-12-31') {
        activitiesWithNoDeadline += 1;
        continue;
      }
      if (earliest === null || timestamp < earliest) earliest = timestamp;
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
    if (!more) return { nextActivityAt: earliest === null ? null : new Date(earliest).toISOString(), activitiesWithNoDeadline, checked };
  }
  throw new Error('Bitrix activity page limit reached; incomplete scan');
}

module.exports = Object.freeze({ probeDealNextActivity });
