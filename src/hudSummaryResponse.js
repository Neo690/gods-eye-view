import {
  feedProvenanceEnvelope,
  layerSnapshots,
} from './data/layerSnapshot.js';

export const HUD_SUMMARY_UNCONFIGURED_CODE = 'OPENAI_NOT_CONFIGURED';

/**
 * Describe the optional HUD summary capability without turning a deliberately
 * keyless boot into an HTTP failure.
 *
 * @param {unknown} apiKey - Candidate server-side OpenAI credential.
 * @returns {{ statusCode: 200, payload: { configured: false, code: string, error: null, summary: null } }|null}
 *   A graceful unconfigured response, or null when the provider is configured.
 */
export function keylessHudSummaryResponse(apiKey) {
  if (String(apiKey ?? '').trim()) return null;
  return {
    statusCode: 200,
    payload: {
      configured: false,
      code: HUD_SUMMARY_UNCONFIGURED_CODE,
      error: null,
      summary: null,
    },
  };
}

/** Return true only for the deliberate, successful no-key capability response. */
export function isHudSummaryUnconfigured(status, data) {
  const keys =
    data !== null && typeof data === 'object' && !Array.isArray(data)
      ? Object.keys(data)
      : [];
  return (
    keys.length === 4 &&
    status === 200 &&
    data?.configured === false &&
    data?.code === HUD_SUMMARY_UNCONFIGURED_CODE &&
    data?.error === null &&
    data?.summary === null
  );
}

/**
 * HUD summary model instructions. The five-word line may only describe
 * supplied labels, and must carry feed-state when any enabled layer is not
 * nominal.
 */
export const HUD_SUMMARY_INSTRUCTIONS = [
  "Write one concise intelligence-HUD summary for God's Eye View.",
  'Use only the supplied place, street, nearby-place, enabled-layer labels, and feedProvenance.',
  'Prefer the clearest named place and include a relevant enabled layer only when useful.',
  'If any enabled layer is not nominal, the five words MUST include that feedState token (STALE, DEGRADED, FALLBACK, LOADING, or UNAVAILABLE) and must not present the view as live.',
  'Do not infer from coordinates or invent a place or feed state.',
  'For every enabled layer whose count is above zero, the five words MUST state that count (digits or a word), and must not describe the layer as empty.',
  'Never write ZERO, NONE or NO for a layer whose supplied count is above zero.',
  'A layer highlight is a real record: a count and its highlights must never contradict each other.',
  'Output exactly five words with no title, punctuation, markdown, or introductory phrase.',
].join(' ');

/**
 * Read one layer's own readout card.
 *
 * `DataLayerManager.getAll()` hands out plain projections — id, name, stats,
 * status — with no methods on them, so a layer's `getRowControls()` is only
 * reachable through the manager's module map. The caller supplies that lookup;
 * a row that still carries the method itself (a test, another build) is read
 * directly as a fallback. A layer with no card, or one that throws, contributes
 * nothing.
 *
 * @param {object} [layer] `getAll()` row.
 * @param {((id: string|null) => object|null)|undefined} getRowControls
 * @returns {string[]} `"lead · text"` strings, at most two.
 */
function layerHighlights(layer, getRowControls) {
  const id = layer?.id ?? layer?.layerKey ?? null;
  let descriptor = null;
  try {
    descriptor =
      typeof getRowControls === 'function'
        ? getRowControls(id)
        : layer?.getRowControls?.();
  } catch {
    return [];
  }
  if (!descriptor || typeof descriptor !== 'object') return [];
  const items = descriptor.list?.items;
  if (!Array.isArray(items)) return [];
  return items
    .slice(0, 2)
    .map((item) => [item?.lead, item?.text].filter(Boolean).join(' · '))
    .filter(Boolean);
}

/**
 * Stamp HUD summary context with the same layer snapshots voice tools use.
 *
 * Each enabled layer also carries two highlights taken from its records, so
 * the model can state a count it can see rather than inferring an empty feed.
 *
 * @param {Array<object>} [layers] `DataLayerManager.getAll()` rows.
 * @param {{ now?: number, getRowControls?: (id: string|null) => object|null }} [options]
 *   `getRowControls` resolves a layer's card from the manager (see
 *   `layerHighlights`); without it, a row carrying the method is used as is.
 * @returns {{
 *   enabledLayerLabels: string[],
 *   enabledLayers: Array<{id: string|null, name: string|null, feedState: string, source: string|null, count: number, highlights?: string[]}>,
 *   feedProvenance: object,
 * }}
 */
export function hudSummaryLayerContext(layers = [], options = {}) {
  const rows = Array.isArray(layers) ? layers : [];
  const { getRowControls } = options || {};
  const snapshots = layerSnapshots(rows, options).filter((s) => s.enabled);
  const enabledRows = new Map(
    rows
      .filter((row) => row?.enabled)
      .map((row) => [row.id ?? row.layerKey ?? null, row]),
  );
  const envelope = feedProvenanceEnvelope(snapshots, options);
  return {
    enabledLayerLabels: snapshots.map((s) => s.name).filter(Boolean),
    enabledLayers: snapshots.map((s) => {
      const highlights = layerHighlights(enabledRows.get(s.id), getRowControls);
      return {
        id: s.id,
        name: s.name,
        feedState: s.feedState,
        source: s.source,
        count: s.count,
        ...(highlights.length ? { highlights } : {}),
      };
    }),
    feedProvenance: envelope,
  };
}

/**
 * The feed state and up to two layer names for the HUD telemetry suffix when
 * an enabled feed is not nominal. Values stay English (`state` is a feed-state
 * id, `names` are `layer.name`); the HUD translates them for display.
 * @param {Array<object>} [layers]
 * @param {{ now?: number }} [options]
 * @returns {{ state: string, names: string[] }|null}
 */
export function hudTelemetryProvenance(layers = [], options) {
  const snapshots = layerSnapshots(layers, options).filter((s) => s.enabled);
  const envelope = feedProvenanceEnvelope(snapshots, options);
  if (!envelope.overall || envelope.overall === 'nominal') return null;
  const names = envelope.layers
    .filter(
      (s) => s.feedState && s.feedState !== 'nominal' && s.feedState !== 'off',
    )
    .map((s) => String(s.name || s.id || 'LAYER'))
    .slice(0, 2);
  return { state: envelope.overall, names };
}

/**
 * Reject an AI line that calls a populated roster empty.
 *
 * The prompt asks the model to state supplied counts, but a prompt is not a
 * guarantee. A zero claim is only acceptable when at least one enabled layer
 * really holds nothing; when every enabled layer has records, "ZERO" is wrong
 * and the caller must keep the deterministic fallback instead.
 *
 * @param {string} summary Candidate five-word line.
 * @param {Array<{count?: number}>} [enabledLayers] `enabledLayers` from the context.
 * @returns {boolean} True when the line does not contradict the counts.
 */
export function hudSummaryCountsHonest(summary, enabledLayers = []) {
  const counts = (Array.isArray(enabledLayers) ? enabledLayers : []).map(
    (layer) => Number(layer?.count),
  );
  if (!counts.length || counts.some((count) => !(count > 0))) return true;
  const words = String(summary || '')
    .toUpperCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return !words.some((word) => word === 'ZERO' || word === 'NONE');
}

/** Require the supplied non-nominal state before showing an AI summary. */
export function hudSummaryMatchesProvenance(summary, provenance) {
  const state = provenance?.overall;
  if (!state || state === 'nominal' || state === 'off') return true;
  return String(summary || '')
    .toUpperCase()
    .split(/\W+/)
    .includes(String(state).toUpperCase());
}
