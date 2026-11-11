import { msg, t, tn } from '../../i18n/index.js';
import { filingLabel, isAmendment, mapAnalystRecord } from './model.js';
export * from './model.js';
export { createInsiderSource } from './source.js';

/** Filings listed in the readout card. */
const READOUT_LIMIT = 5;

/**
 * Own the latest Form 4 list and its refresh lifecycle.
 *
 * Non-spatial by design: EDGAR publishes no coordinates, so this layer draws
 * nothing on the globe and holds no data source. Its surface is the Layers
 * panel readout (count, freshness, last error, latest filings) and the analyst
 * query engine (`getAnalystRecords`).
 */
export function createInsiderLayer({ source } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Insider filings require a snapshot source');
  let _rows = [];
  let _request = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let rowControlsListener = null;

  const notify = () => rowControlsListener?.();

  const layer = {
    id: 'insider',
    name: 'Insider filings (Form 4)',
    icon: '📈',
    source: 'SEC EDGAR',
    updateInterval: 300000,

    init() {
      _rows = [];
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      console.log('[Data:Insider] Initialized');
    },

    enable() {
      _enabled = true;
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
    },

    async update() {
      if (!_enabled) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const rows = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _rows = rows;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:Insider] Updated: ${_rows.length} filings`);
        notify();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Insider] Fetch error:', e);
        _lastError = e?.message || msg('Insider feed unavailable');
        notify();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy() {
      _request?.abort();
      _request = null;
      _enabled = false;
      _rows = [];
      _lastUpdate = null;
      _lastError = null;
      rowControlsListener = null;
    },

    /**
     * The newest filings as list items, shared by the Layers row card and the
     * dedicated insider panel so the two surfaces cannot disagree.
     *
     * @param {number} [limit=50] Maximum items to project.
     * @returns {Array<{id: string, ordinal: number, lead: string, text: string, accent: string}>}
     */
    getRecentFilings(limit = 50) {
      const count = Number.isFinite(limit)
        ? Math.max(1, Math.floor(limit))
        : 50;
      return _rows.slice(0, count).map((row, index) => ({
        id: row.id,
        ordinal: index + 1,
        lead: row.company ?? t('Unknown issuer'),
        text: [
          row.insider ?? t('Unknown reporting owner'),
          row.filedDay,
          isAmendment(row.formType) ? '4/A' : null,
        ]
          .filter(Boolean)
          .join(' · '),
        accent: isAmendment(row.formType) ? '#f59e0b' : '#38bdf8',
      }));
    },

    /**
     * Readout descriptor for the Layers panel: the newest Form 4 filings, with
     * the issuer and the reporting owner on one line.
     *
     * `readout: true` renders the toggle and source line only; this card owns
     * the rest. Records stay English data and are translated here.
     */
    getRowControls() {
      const statusText = _lastError
        ? msg(_lastError)
        : tn(_rows.length, '{count} filing', '{count} filings');
      return {
        // Generic row descriptor (see conflict-events): `readout: true` would
        // hand the card to the weather readout host and hide this row's list.
        info: `${t('SEC EDGAR')} · ${statusText}`,
        list: {
          ariaLabel: t('Latest insider filings'),
          items: this.getRecentFilings(READOUT_LIMIT),
        },
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      return {
        count: _rows.length,
        lastUpdate: _lastUpdate,
        lastError: _lastError,
      };
    },

    /**
     * Snapshot the held filings as JSON-safe records. On-demand only — no
     * listeners, no per-frame cost.
     * @param {number} [maxCount=400] - Maximum records to return.
     * @returns {Array<object>}
     */
    getAnalystRecords(maxCount = 400) {
      if (!_rows.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 400;
      return _rows
        .slice(0, limit)
        .map((row, index) => mapAnalystRecord(row, index));
    },

    /** One-line label used by the panel row and the analyst answers. */
    getFilingLabel(index = 0) {
      return filingLabel(_rows[index]);
    },

    getState() {
      return {
        id: layer.id,
        enabled: _enabled,
        count: _rows.length,
        lastUpdate: _lastUpdate,
        lastError: _lastError,
      };
    },
  };

  return layer;
}
