/**
 * Presentation and analyst mapping for insider filings.
 *
 * This family carries no coordinates: EDGAR publishes company and officer names
 * but no latitude/longitude, so nothing is drawn on the globe. Keeping the
 * mapping pure here means the panel and the analyst engine can use the records
 * without a viewer.
 */

/** Form 4 is the standard ownership report; 4/A amends an earlier one. */
export function isAmendment(formType) {
  return formType === '4/A';
}

/** Short, stable panel label: "NVIDIA — Jane Doe". */
export function filingLabel(row) {
  const company = row?.company ?? 'Unknown issuer';
  const insider = row?.insider ?? 'Unknown reporting owner';
  return `${company} — ${insider}`;
}

/**
 * Map one filing to a JSON-safe analyst record.
 * Pure — no viewer, no Cesium types. Missing fields are null.
 * @param {Object|null|undefined} raw
 * @param {number} [index=0] - Fallback id suffix.
 * @returns {{id: string, formType: string|null, company: string|null,
 *   insider: string|null, issuerCik: string|null, insiderCik: string|null,
 *   filedAt: number|null, filedDay: string|null, filingUrl: string|null,
 *   amendment: boolean}}
 */
export function mapAnalystRecord(raw, index = 0) {
  const text = (v) => {
    const t = String(v ?? '').trim();
    return t || null;
  };
  const num = (v) => (Number.isFinite(v) ? v : null);
  const formType = text(raw?.formType);
  return {
    id: text(raw?.id) || `INSIDER-${String(index).padStart(4, '0')}`,
    formType,
    company: text(raw?.company),
    insider: text(raw?.insider),
    issuerCik: text(raw?.issuerCik),
    insiderCik: text(raw?.insiderCik),
    filedAt: num(raw?.filedAt),
    filedDay: text(raw?.filedDay),
    filingUrl: text(raw?.filingUrl),
    amendment: isAmendment(formType),
  };
}

export { normalizeInsiderPayload } from './records.js';
