/**
 * SEC EDGAR Form 4 acquisition records.
 *
 * EDGAR's "Latest Filings" Atom feed publishes each filing TWICE: one entry
 * for the issuer (the company) and one for the reporting owner (the insider).
 * Both share an accession number, so the parser groups them back into a single
 * filing record carrying both names.
 *
 * The globe-relevant caveat is deliberate: EDGAR publishes no coordinates, so
 * this family never invents geography. Records stay non-spatial and feed the
 * layer panel plus the analyst query engine.
 *
 * The XML parser runs server-side only (the proxy hands the browser prepared
 * rows); `normalizeInsiderPayload` is the browser-side validator.
 */

/** Hard ceiling on filings kept from one snapshot. */
export const MAX_INSIDER_FILINGS = 400;

const ENTRY_PATTERN = /<entry>([\s\S]*?)<\/entry>/g;
const TITLE_PATTERN = /<title>([\s\S]*?)<\/title>/;
const LINK_PATTERN = /<link[^>]*href="([^"]+)"/;
const UPDATED_PATTERN = /<updated>([^<]+)<\/updated>/;
const SUMMARY_PATTERN = /<summary[^>]*>([\s\S]*?)<\/summary>/;
const ACCESSION_PATTERN = /accession-number=([0-9-]+)/;
const FILED_PATTERN = /Filed:\s*(\d{4}-\d{2}-\d{2})/;
const HEADLINE_PATTERN =
  /^(4\/A|4|3|5)\s*-\s*(.+?)\s*\((\d{1,10})\)\s*\((Issuer|Reporting)\)$/;

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(text) {
  // Decode FIRST: EDGAR escapes its HTML (&lt;b&gt;), so the tags only become
  // removable after decoding. Stripping before decoding leaves literal <b>
  // between "Filed:" and its date and breaks the summary read.
  return decodeEntities(String(text))
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMatch(text, pattern) {
  const match = String(text).match(pattern);
  return match ? stripTags(match[1]) : null;
}

function toMs(isoText) {
  const ms = Date.parse(isoText);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Parse EDGAR's latest-filings Atom feed into grouped filing records.
 * @param {string} xml - Raw Atom document.
 * @returns {{rows: Array<object>, updatedAt: number|null}|null}
 *   Null when the document is not an Atom feed at all.
 */
export function parseSecAtomFeed(xml) {
  if (typeof xml !== 'string' || !xml.includes('<feed')) return null;
  const byAccession = new Map();
  for (const [, block] of xml.matchAll(ENTRY_PATTERN)) {
    const headline = firstMatch(block, TITLE_PATTERN);
    const accession = firstMatch(block, ACCESSION_PATTERN);
    if (!headline || !accession) continue;
    const parsed = headline.match(HEADLINE_PATTERN);
    if (!parsed) continue;
    const [, formType, name, cik, role] = parsed;
    const summary = firstMatch(block, SUMMARY_PATTERN);
    const filedDay = summary?.match(FILED_PATTERN)?.[1] ?? null;
    const updatedAt = toMs(firstMatch(block, UPDATED_PATTERN) ?? '');
    let row = byAccession.get(accession);
    if (!row) {
      row = {
        id: accession,
        formType: formType === '4/A' ? '4/A' : formType,
        company: null,
        insider: null,
        issuerCik: null,
        insiderCik: null,
        filedAt: updatedAt,
        filedDay,
        filingUrl: firstMatch(block, LINK_PATTERN),
      };
      byAccession.set(accession, row);
    }
    if (role === 'Issuer') {
      row.company = row.company ?? name;
      row.issuerCik = row.issuerCik ?? cik;
    } else {
      row.insider = row.insider ?? name;
      row.insiderCik = row.insiderCik ?? cik;
    }
    if (row.filedAt == null) row.filedAt = updatedAt;
    if (row.filedDay == null) row.filedDay = filedDay;
    if (row.filingUrl == null) row.filingUrl = firstMatch(block, LINK_PATTERN);
  }
  const rows = [...byAccession.values()]
    .sort(
      (a, b) => (b.filedAt ?? 0) - (a.filedAt ?? 0) || a.id.localeCompare(b.id),
    )
    .slice(0, MAX_INSIDER_FILINGS);
  return { rows, updatedAt: toMs(firstMatch(xml, UPDATED_PATTERN) ?? '') };
}

function asText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

function asFinite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Validate the proxy payload in the browser. Rows with no accession-derived id
 * are dropped; a payload that is not a rows array fails the whole snapshot so
 * the layer keeps its last good list.
 * @param {unknown} payload
 * @returns {Array<object>|null}
 */
export function normalizeInsiderPayload(payload) {
  const rows = payload?.rows;
  if (!Array.isArray(rows)) return null;
  const out = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const id = asText(raw.id);
    if (!id) continue;
    out.push({
      id,
      formType: asText(raw.formType),
      company: asText(raw.company),
      insider: asText(raw.insider),
      issuerCik: asText(raw.issuerCik),
      insiderCik: asText(raw.insiderCik),
      filedAt: asFinite(raw.filedAt),
      filedDay: asText(raw.filedDay),
      filingUrl: asText(raw.filingUrl),
    });
    if (out.length >= MAX_INSIDER_FILINGS) break;
  }
  return out;
}
