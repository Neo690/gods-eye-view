import { normalizeInsiderPayload } from './records.js';

const DEFAULT_URL = '/api/insider';

/**
 * Same-origin acquisition source for insider filings.
 *
 * EDGAR requires a declared User-Agent and sends no CORS headers, so the browser
 * never talks to sec.gov: the server proxy parses the Atom feed and answers
 * prepared rows. Validation happens before a snapshot can replace the list.
 */
export function createInsiderSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  url,
} = {}) {
  let endpoint = url;
  if (!endpoint) {
    try {
      endpoint = import.meta.env?.VITE_INSIDER_API_URL;
    } catch {
      endpoint = null;
    }
  }
  const resolved = endpoint || DEFAULT_URL;
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(resolved, {
        signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`Insider HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      const rows = normalizeInsiderPayload(payload);
      if (!rows) throw new Error('Malformed insider response');
      return rows;
    },
  };
}
