#!/usr/bin/env node
/**
 * TOP-SENS safe public website probe. Standard Node.js 18+, no paid API.
 * Input: [{id, company, expected_inn?, official_site?, site_candidate?}]
 * Output: JSON Lines of page-level evidence; NEVER auto-confirms an address or legal entity.
 * This tool is deliberately separate from the Bitrix24 CRM receiver.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { isIP } from 'node:net';

const DEFAULT_PATHS = ['/', '/contacts/', '/contact/', '/rekvizity/', '/about/', '/filialy/'];
const DEFAULT_CONCURRENCY = 8;
const MAX_PAGE_BYTES = 450_000;
const FETCH_TIMEOUT_MS = 9_000;
const USER_AGENT = 'TOP-SENS-PublicResearch/0.1 (company contact directory; no login)';

export function safeUrl(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    if (isIP(host) || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null;
    return url;
  } catch { return null; }
}

function decodeEntities(s) {
  return s.replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&quot;/gi, '"').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

export function extractHints(html) {
  const clean = decodeEntities(String(html)
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|p|div|li|tr|address)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '));
  const lines = clean.split(/\n/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const text = lines.join('\n').slice(0, 80_000);
  const emails = [...new Set([...text.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)].map(x => x[0].toLowerCase()))].slice(0, 15);
  const inns = [...new Set([...text.matchAll(/(?:ИНН|INN)\s*[:№#]?\s*(\d{10}|\d{12})\b/gi)].map(x => x[1]))].slice(0, 15);
  const phones = [...new Set([...text.matchAll(/(?:\+7|8)\s*\(?\d{3,5}\)?[\s-]*\d[\d\s()-]{5,12}\d/g)].map(x => x[0].trim()))].slice(0, 15);
  const addressHints = lines.filter(l => /(?:адрес|офис|филиал|представительств|юридическ|фактическ|ул\.|улица|проспект|шоссе|переулок)/i.test(l)).slice(0, 20).map(l => l.slice(0, 250));
  return {emails, inns, phones, address_hints: addressHints, excerpt: text.slice(0, 400)};
}

function simplifyName(s) {
  return String(s || '').toUpperCase().replace(/[«»"'.,–—-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function containsExpectedName(html, company) {
  const text = simplifyName(html.replace(/<[^>]+>/g, ' '));
  const name = simplifyName(company);
  return Boolean(name && text.includes(name));
}

async function getPage(url, firstHost) {
  const ctrl = new AbortController();
  const clock = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    // No automatic cross-origin redirects; no credentials, no non-public hosts.
    const resp = await fetch(url.toString(), {redirect: 'manual', headers: {'user-agent': USER_AGENT, 'accept': 'text/html,text/plain;q=0.8'}, signal: ctrl.signal});
    const location = resp.headers.get('location');
    if (resp.status >= 300 && resp.status < 400) {
      const next = location && safeUrl(new URL(location, url).toString());
      if (next && next.hostname === firstHost) return {http_status: resp.status, redirect_to: next.toString(), outcome: 'REDIRECT_NOT_FOLLOWED'};
      return {http_status: resp.status, outcome: 'UNTRUSTED_REDIRECT'};
    }
    if (!resp.ok) return {http_status: resp.status, outcome: 'HTTP_ERROR'};
    const contentType = (resp.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('html') && !contentType.includes('text')) return {http_status: resp.status, outcome: 'NOT_TEXT'};
    const reader = resp.body?.getReader();
    if (!reader) return {http_status: resp.status, outcome: 'NO_BODY'};
    const chunks = []; let size = 0; let stopped = false;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PAGE_BYTES) { stopped = true; await reader.cancel(); break; }
      chunks.push(value);
    }
    const body = new TextDecoder().decode(Buffer.concat(chunks.map(x => Buffer.from(x))));
    return {http_status: resp.status, outcome: stopped ? 'TRUNCATED' : 'HTTP_OK', hints: extractHints(body), _html: body};
  } catch (e) { return {http_status: null, outcome: e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR', error: String(e.message).slice(0, 180)}; }
  finally { clearTimeout(clock); }
}

export async function probe(record) {
  const url = safeUrl(record.official_site || record.site_candidate || '');
  const base = {id: record.id, company: record.company, attempted_at: new Date().toISOString(), given_url: record.official_site || record.site_candidate || null,
    expected_inn: record.expected_inn || null, site_previously_verified: Boolean(record.official_site)};
  if (!url) return {...base, status: 'NO_SAFE_URL', pages: [], verified_fields: []};
  const pages = [];
  const origin = url.origin;
  const targets = [...new Set([url.toString(), ...DEFAULT_PATHS.map(p => origin + p)])].slice(0, 7);
  for (const u of targets) {
    const page = await getPage(new URL(u), url.hostname);
    const { _html, ...publicFields } = page;
    const identity_mentioned = _html ? containsExpectedName(_html, record.company) : false;
    const inn_matched = Boolean(record.expected_inn && page.hints?.inns.includes(String(record.expected_inn)));
    pages.push({url: u, ...publicFields, identity_mentioned, inn_matched});
    // Limit load when site blocks access. Never hammer 403/429/5xx or timed-out domains.
    if ([403, 429, 500, 502, 503].includes(page.http_status) || page.outcome === 'TIMEOUT') break;
  }
  const ok = pages.some(p => p.http_status === 200);
  const identityEvidence = pages.some(p => p.identity_mentioned && p.inn_matched);
  return {...base,
    status: !ok ? 'SITE_UNREACHABLE_OR_BLOCKED' : identityEvidence ? 'IDENTITY_EVIDENCE_REQUIRES_REVIEW' : 'HTTP_OK_LEGAL_ENTITY_UNVERIFIED',
    pages, verified_fields: []}; // Any official status/address confirmation requires separate explicit review.
}

export async function run(records, concurrency=DEFAULT_CONCURRENCY) {
  if (!Array.isArray(records)) throw new Error('Input must be an array');
  const valid = records.slice(0, 300);
  const ids = valid.map(x => x.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate IDs in batch');
  let index = 0; const result = new Array(valid.length);
  const worker = async () => { while (index < valid.length) { const i = index++; result[i] = await probe(valid[i]); } };
  await Promise.all(Array.from({length: Math.min(Math.max(1,concurrency),16,valid.length)}, worker));
  return result;
}

async function cli() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {console.error('Usage: node top-sens-site-probe.mjs input.json output.jsonl'); process.exitCode = 2; return;}
  const data = JSON.parse(await readFile(input, 'utf8'));
  const result = await run(data, Number(process.env.SITE_PROBE_CONCURRENCY || DEFAULT_CONCURRENCY));
  await writeFile(output, result.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  const counts = {}; result.forEach(x => counts[x.status] = (counts[x.status] || 0) + 1);
  console.log(JSON.stringify({attempted_ids: result.length, outcomes: counts, newly_confirmed_sites: 0, newly_confirmed_addresses: 0, output}, null, 2));
}
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) cli().catch(e => { console.error(e); process.exitCode = 1; });