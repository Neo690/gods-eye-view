import { t } from '../i18n/index.js';
import { localizeLayerName, PANEL_LABEL_KEYS } from './layerNames.js';

/**
 * Ctrl/Cmd+K palette over the three things an operator reaches for by name:
 * the data layers, the panels, and a place.
 *
 * It is a front door, not a fourth implementation: a layer row calls the same
 * `setEnabled(id, !enabled, { origin: 'user' })` the layer panel's toggle does,
 * a panel row calls the same collapse routine the panel's own button uses, and
 * a place row calls the same `searchAndFlyTo` the location bar types into. What
 * it adds is one keystroke and one search box across all three.
 *
 * Matching is local and synchronous for layers and panels; only the place row
 * asks the network, and it does so after a debounce so typing a word is one
 * request rather than one per character.
 */

const DIACRITICS = /[\u0300-\u036f]/g;
/** Below this, a query is too short to spend a geocoder request on. */
export const PLACE_MIN_LENGTH = 2;
export const PLACE_DEBOUNCE_MS = 300;
export const RESULT_LIMIT = 12;
const KIND_ORDER = Object.freeze({ layer: 0, panel: 1, place: 2 });

/** Case- and accent-insensitive form, so "meteo" finds "MÉTÉO". */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .trim();
}

/**
 * How well a label answers a query, or null when it does not.
 *
 * Lower is better: an exact label first, then a prefix, then a word that starts
 * with the query ("Radio Sites" for "sit"), then anywhere inside. A query that
 * only appears mid-word still matches — typing "onsemap" should find
 * openSenseMap — but it ranks under anything that starts the label.
 *
 * @param {string} label
 * @param {string} query
 * @returns {number|null} 0 exact, 1 prefix, 2 word start, 3 substring, null.
 */
export function matchScore(label, query) {
  const needle = fold(query);
  if (!needle) return 0;
  const haystack = fold(label);
  if (!haystack) return null;
  if (haystack === needle) return 0;
  if (haystack.startsWith(needle)) return 1;
  if (haystack.split(/[^a-z0-9]+/).some((word) => word.startsWith(needle)))
    return 2;
  return haystack.includes(needle) ? 3 : null;
}

/**
 * Rank entries for a query and keep the list short enough to read.
 *
 * An entry marked `always` (the place row, which is the explicit action for
 * whatever was typed) survives the cap even when the layers already fill it:
 * the operator typed a place name and must be able to go there. It is also
 * pinned to the last tier, because a geocoder will happily resolve almost any
 * word — "sites" matches a town in California — and that must never outrank
 * the layer that carries the word in its name.
 *
 * @param {Array<{id:string, kind:string, label:string, always?:boolean}>} entries
 * @param {string} query
 * @param {{limit?: number}} [options]
 * @returns {Array<object>} Matching entries, each with its `score`.
 */
export function rankEntries(entries, query, { limit = RESULT_LIMIT } = {}) {
  const ranked = [];
  for (const entry of entries) {
    const score = entry.always ? 4 : matchScore(entry.label, query);
    if (score === null) continue;
    ranked.push({ ...entry, score });
  }
  // A stable sort: entries of equal score keep the order their owner gave them,
  // so the palette does not reshuffle itself between two identical keystrokes.
  ranked.sort(
    (a, b) =>
      a.score - b.score ||
      (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9),
  );
  if (ranked.length <= limit) return ranked;
  const kept = ranked.slice(0, limit);
  const place = ranked.find((entry) => entry.always);
  if (place && !kept.includes(place)) kept.splice(kept.length - 1, 1, place);
  return kept;
}

/** Wrap-around cursor movement over the flattened result list. */
export function moveSelection(index, delta, length) {
  if (!length) return 0;
  const next = index + delta;
  if (next < 0) return length - 1;
  if (next >= length) return 0;
  return next;
}

/**
 * Consecutive entries of one kind, in ranked order.
 * @param {Array<object>} entries
 * @returns {Array<{kind:string, entries:Array<object>}>}
 */
export function groupEntries(entries) {
  const groups = [];
  for (const entry of entries) {
    let group = groups.find((candidate) => candidate.kind === entry.kind);
    if (!group) {
      group = { kind: entry.kind, entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

/** Section headings, each call site literal so `npm run i18n` can extract it. */
function sectionTitle(kind) {
  if (kind === 'layer') return t('DATA LAYERS');
  if (kind === 'panel') return t('PANELS');
  return t('PLACES');
}

export class CommandPalette {
  /**
   * @param {object} [options]
   * @param {HTMLElement} [options.root] The `#command-palette` overlay.
   * @param {Document} [options.documentRef]
   * @param {object} [options.actions] Application seams; every one is optional
   *   and a missing one simply removes that row from the palette.
   * @param {Function} [options.actions.getLayers] () => layer rows from the manager.
   * @param {Function} [options.actions.isLayerEnabled] (id) => boolean.
   * @param {Function} [options.actions.setLayerEnabled] (id, enabled) => Promise.
   * @param {Function} [options.actions.getPanels] () => [{ id, label }].
   * @param {Function} [options.actions.openPanel] (id) => void.
   * @param {Function} [options.actions.geocode] (text, { signal }) => Promise<{ place }>.
   * @param {Function} [options.actions.flyTo] (text) => Promise.
   * @param {Function} [options.actions.toast] (text) => void.
   * @param {number} [options.placeDelayMs]
   * @param {number} [options.limit]
   */
  constructor({
    root = null,
    documentRef = globalThis.document,
    actions = {},
    placeDelayMs = PLACE_DEBOUNCE_MS,
    limit = RESULT_LIMIT,
  } = {}) {
    this.documentRef = documentRef;
    this.root =
      root || documentRef?.getElementById?.('command-palette') || null;
    this.actions = actions;
    this._limit = limit;
    this._placeDelayMs = placeDelayMs;
    this._mounted = false;
    this._isOpen = false;
    this._query = '';
    this._index = 0;
    this._options = [];
    this._place = null;
    this._placeController = null;
    this._placeTimer = null;
    this._placeGeneration = 0;
    this._returnFocus = null;
    this._unbind = [];
  }

  get isOpen() {
    return this._isOpen;
  }

  /** Attach the keystroke and the in-dialog handlers. Idempotent. */
  mount() {
    if (this._mounted || !this.root) return;
    this._mounted = true;
    this._resultsEl = this.root.querySelector('#command-palette-results');
    this._input = this.root.querySelector('#command-palette-input');
    this._scrim = this.root.querySelector('.command-palette-scrim');
    const listen = (target, type, handler, options) => {
      target?.addEventListener?.(type, handler, options);
      this._unbind.push(() =>
        target?.removeEventListener?.(type, handler, options),
      );
    };
    // Capture, so the shortcut works while a text field has focus; nothing else
    // in the app binds Ctrl/Cmd+K, and 'k' alone stays free.
    listen(
      this.documentRef,
      'keydown',
      (event) => this._onKeyDown(event),
      true,
    );
    listen(this._input, 'input', () => {
      this._query = this._input.value || '';
      this._index = 0;
      this._render();
      this._schedulePlace();
    });
    listen(this._input, 'keydown', (event) => this._onInputKeyDown(event));
    listen(this._resultsEl, 'click', (event) => {
      const index = Number(
        event.target?.closest?.('[data-palette-index]')?.dataset?.paletteIndex,
      );
      if (Number.isInteger(index)) this._run(this._options[index]?.entry);
    });
    listen(this._scrim, 'click', () => this.close());
    this._hide();
  }

  destroy() {
    for (const unbind of this._unbind.splice(0)) unbind();
    this._clearPlaceTimer();
    this._placeController?.abort();
    this._placeController = null;
    this._mounted = false;
    this._isOpen = false;
    this._options = [];
    this._hide();
  }

  /** Show the palette with an optional starting query. */
  open(query = '') {
    if (!this._mounted || !this.root) return;
    this._returnFocus =
      this.documentRef?.activeElement instanceof Object
        ? this.documentRef.activeElement
        : null;
    this._isOpen = true;
    this.root.hidden = false;
    this.root.removeAttribute?.('aria-hidden');
    this._query = String(query ?? '');
    if (this._input) this._input.value = this._query;
    this._index = 0;
    this._render();
    this._schedulePlace();
    this._input?.focus?.();
    // Select the query so typing replaces it, the way a fresh palette behaves.
    this._input?.select?.();
  }

  close({ restoreFocus = true } = {}) {
    if (!this._isOpen) return;
    this._isOpen = false;
    this._hide();
    this._clearPlaceTimer();
    this._placeController?.abort();
    this._placeController = null;
    this._placeGeneration += 1;
    this._place = null;
    this._options = [];
    if (restoreFocus) {
      const target = this._returnFocus;
      if (target?.isConnected !== false) target?.focus?.();
    }
    this._returnFocus = null;
  }

  toggle() {
    if (this._isOpen) this.close();
    else this.open();
  }

  _hide() {
    if (this.root) this.root.hidden = true;
  }

  _onKeyDown(event) {
    const key = String(event.key || '');
    const opens =
      key.toLowerCase() === 'k' &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey;
    if (opens) {
      event.preventDefault();
      event.stopPropagation();
      this.toggle();
      return;
    }
    if (!this._isOpen) return;
    if (key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }
  }

  _onInputKeyDown(event) {
    const key = String(event.key || '');
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      this._index = moveSelection(
        this._index,
        key === 'ArrowDown' ? 1 : -1,
        this._options.length,
      );
      this._paintSelection();
      return;
    }
    if (key === 'Enter') {
      event.preventDefault();
      const entry = this._options[this._index]?.entry;
      if (entry) this._run(entry);
      return;
    }
    if (key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    // The dialog holds one focusable control, so Tab has nowhere to go: keeping
    // focus on the input keeps the trap closed without a second tab stop.
    if (key === 'Tab') event.preventDefault();
  }

  /**
   * The rows a query can act on, ranked.
   * @param {string} [query] Defaults to what the input holds.
   */
  results(query = this._query) {
    const entries = this._buildEntries(String(query ?? ''));
    return rankEntries(entries, String(query ?? '').trim(), {
      limit: this._limit,
    });
  }

  _buildEntries(rawQuery) {
    const entries = [];
    for (const layer of this.actions.getLayers?.() || []) {
      if (!layer?.id) continue;
      const key = PANEL_LABEL_KEYS[layer.id];
      const label = key ? t(key) : localizeLayerName(layer.name || layer.id);
      const enabled = this.actions.isLayerEnabled?.(layer.id) === true;
      entries.push({
        id: `layer:${layer.id}`,
        kind: 'layer',
        label,
        detail: enabled ? t('ON') : t('OFF'),
        run: () => this.actions.setLayerEnabled?.(layer.id, !enabled),
      });
    }
    for (const panel of this.actions.getPanels?.() || []) {
      if (!panel?.id || !panel.label) continue;
      entries.push({
        id: `panel:${panel.id}`,
        kind: 'panel',
        label: panel.label,
        detail: t('panel'),
        run: () => this.actions.openPanel?.(panel.id),
      });
    }
    const query = rawQuery.trim();
    if (query.length >= PLACE_MIN_LENGTH && this.actions.flyTo) {
      const resolved = this._place?.query === query ? this._place.place : null;
      const label = resolved?.label || resolved?.name || query;
      const coords =
        Number.isFinite(resolved?.lat) && Number.isFinite(resolved?.lng)
          ? `${resolved.lat.toFixed(3)}, ${resolved.lng.toFixed(3)}`
          : '';
      entries.push({
        id: 'place',
        kind: 'place',
        label,
        detail: coords,
        always: true,
        run: () => this.actions.flyTo?.(query),
      });
    }
    return entries;
  }

  _render() {
    if (!this._resultsEl) return;
    const results = this.results();
    this._options = [];
    this._resultsEl.textContent = '';
    if (!results.length) {
      const empty = this.documentRef.createElement('p');
      empty.className = 'command-palette-empty';
      empty.textContent = t('No matching command');
      this._resultsEl.appendChild(empty);
      this._input?.removeAttribute?.('aria-activedescendant');
      return;
    }
    let index = 0;
    for (const group of groupEntries(results)) {
      const heading = this.documentRef.createElement('div');
      heading.className = 'command-palette-group';
      heading.setAttribute('role', 'presentation');
      heading.textContent = sectionTitle(group.kind);
      this._resultsEl.appendChild(heading);
      for (const entry of group.entries) {
        const option = this.documentRef.createElement('div');
        option.className = 'command-palette-option';
        option.id = `command-palette-option-${index}`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        option.dataset.paletteIndex = String(index);
        option.dataset.kind = entry.kind;
        const label = this.documentRef.createElement('span');
        label.className = 'command-palette-label';
        label.textContent = entry.label;
        option.appendChild(label);
        if (entry.detail) {
          const detail = this.documentRef.createElement('span');
          detail.className = 'command-palette-detail';
          detail.textContent = entry.detail;
          option.appendChild(detail);
        }
        this._resultsEl.appendChild(option);
        this._options.push({ entry, node: option });
        index += 1;
      }
    }
    this._index = Math.min(this._index, this._options.length - 1);
    this._paintSelection();
  }

  _paintSelection() {
    if (!this._options.length) return;
    this._options.forEach(({ node }, index) => {
      const selected = index === this._index;
      node.classList?.toggle?.('is-active', selected);
      node.setAttribute('aria-selected', String(selected));
    });
    const active = this._options[this._index]?.node;
    if (this._input && active) {
      this._input.setAttribute('aria-activedescendant', active.id);
    }
    active?.scrollIntoView?.({ block: 'nearest' });
  }

  async _run(entry) {
    if (!entry) return;
    // Close before acting: the map takes the interaction, and the palette must
    // not swallow the camera animation it just started.
    this.close();
    try {
      await entry.run();
    } catch (error) {
      console.warn('[Palette] command failed:', error);
      this.actions.toast?.(t('Command failed'));
    }
  }

  _clearPlaceTimer() {
    if (this._placeTimer === null) return;
    clearTimeout(this._placeTimer);
    this._placeTimer = null;
  }

  _schedulePlace() {
    this._clearPlaceTimer();
    this._placeController?.abort();
    this._placeController = null;
    const generation = (this._placeGeneration += 1);
    const query = this._query.trim();
    if (
      query.length < PLACE_MIN_LENGTH ||
      typeof this.actions.geocode !== 'function'
    )
      return;
    this._placeTimer = setTimeout(() => {
      this._placeTimer = null;
      const controller = new AbortController();
      this._placeController = controller;
      Promise.resolve()
        .then(() => this.actions.geocode(query, { signal: controller.signal }))
        .then(
          (answer) => answer?.place || null,
          (error) => {
            if (error?.name !== 'AbortError')
              console.warn('[Palette] place lookup failed:', error);
            return null;
          },
        )
        .then((place) => {
          if (generation !== this._placeGeneration || !this._isOpen) return;
          this._placeController = null;
          this._place = { query, place };
          this._render();
        });
    }, this._placeDelayMs);
  }
}
