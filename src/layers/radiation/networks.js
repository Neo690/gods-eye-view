import { RADIATION_NETWORKS } from './records.js';
import { t } from '../../i18n/index.js';

/**
 * The radiation networks a person switched off in the Layers row.
 *
 * The four keyless networks overlap by design — Germany is covered by BfS and
 * by whoever runs a radmon.org station there, and Safecast is everywhere — so
 * a reader watching one country may still not want three sets of dots on the
 * same map. The row lists every registered network with a switch and its
 * station count, and the off ones are simply not drawn or counted.
 *
 * Storage is local on purpose. This is a viewing preference, not part of a
 * shared scene, so it stays out of the share format.
 */
export const RADIATION_HIDDEN_NETWORKS_STORAGE_KEY =
  'gev.radiation.hidden-networks.v1';

const REGISTERED_NETWORK_IDS = Object.freeze(Object.keys(RADIATION_NETWORKS));

/** localStorage without trusting it: private mode throws on access. */
export function readDefaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Keep only ids this build actually registers. A network dropped from the
 * registry, or a hand-edited storage value, must not leave the layer hiding an
 * id it can never show again.
 * @param {unknown} value Array, Set, or JSON string.
 * @returns {Set<string>}
 */
export function sanitizeHiddenNetworks(value) {
  let list = value;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return new Set();
    }
  }
  if (!Array.isArray(list) && !(list instanceof Set)) return new Set();
  const wanted = new Set(
    [...list].filter(
      (id) => typeof id === 'string' && REGISTERED_NETWORK_IDS.includes(id),
    ),
  );
  // Rebuilt in registry order, so the stored value reads the same whatever
  // order the clicks arrived in.
  const hidden = new Set();
  for (const id of REGISTERED_NETWORK_IDS) if (wanted.has(id)) hidden.add(id);
  return hidden;
}

/**
 * @param {{getItem?: Function}|null} storage
 * @returns {Set<string>}
 */
export function readHiddenNetworks(storage) {
  try {
    const raw = storage?.getItem?.(RADIATION_HIDDEN_NETWORKS_STORAGE_KEY);
    return raw ? sanitizeHiddenNetworks(raw) : new Set();
  } catch {
    return new Set();
  }
}

/**
 * @param {{setItem?: Function}|null} storage
 * @param {Set<string>|string[]} hidden
 * @returns {Set<string>} What was written, sanitized.
 */
export function writeHiddenNetworks(storage, hidden) {
  const clean = sanitizeHiddenNetworks(hidden);
  try {
    storage?.setItem?.(
      RADIATION_HIDDEN_NETWORKS_STORAGE_KEY,
      JSON.stringify([...clean]),
    );
  } catch {
    /* A preference is not worth breaking a session over. */
  }
  return clean;
}

/**
 * A new set with `networkId` shown or hidden. A new set rather than a mutation
 * keeps the caller's `===` checks honest and the write trivial.
 * @param {Set<string>} hidden
 * @param {string} networkId
 * @param {boolean} visible
 * @returns {Set<string>}
 */
export function setNetworkVisible(hidden, networkId, visible) {
  const next = new Set(hidden);
  if (!REGISTERED_NETWORK_IDS.includes(networkId)) return next;
  if (visible) next.delete(networkId);
  else next.add(networkId);
  return next;
}

/**
 * The stations of the networks that are still on.
 *
 * Returns the caller's array untouched when nothing is hidden: the snapshot is
 * thousands of rows and the common case must not copy them.
 * @param {Array<object>} stations
 * @param {Set<string>} hidden
 * @returns {Array<object>}
 */
export function visibleStations(stations, hidden) {
  if (!Array.isArray(stations) || !hidden?.size) return stations || [];
  return stations.filter((station) => !hidden.has(station?.network));
}

/**
 * The row's switch list: one entry per registered network, in the registry's
 * own order, carrying the network's station count — taken from the server's
 * `sources` rather than from the drawn rows, so a network that answered with
 * nothing still shows "0" instead of disappearing.
 *
 * `checked` is what the switch says: on means this network's stations are
 * drawn.
 * @param {object} input
 * @param {Set<string>} input.hidden
 * @param {Array<object>} [input.sources] Per-network answer from `/api/radiation`.
 * @param {(networkId: string, visible: boolean) => void} input.onToggle
 * @returns {{ordered: false, ariaLabel: string, items: object[]}}
 */
export function radiationNetworkList({ hidden, sources = [], onToggle }) {
  const answers = new Map(
    (Array.isArray(sources) ? sources : [])
      .filter((source) => source && typeof source.id === 'string')
      .map((source) => [source.id, source]),
  );
  return {
    ordered: false,
    ariaLabel: t('Radiation networks'),
    items: REGISTERED_NETWORK_IDS.map((id) => {
      const network = RADIATION_NETWORKS[id];
      const answer = answers.get(id);
      const checked = !hidden.has(id);
      const count = Number.isFinite(answer?.count) ? answer.count : 0;
      const notes = [`${network.operator} · ${network.coverage}`];
      // A count label rather than a plural phrase: a title has no room for the
      // singular/plural rules four languages would each need.
      notes.push(
        `${t(checked ? 'Shown' : 'Hidden')} · ${t('Stations: {count}', { count })}`,
      );
      // A source that failed, and one this build cannot reach without a key,
      // read the same on screen ("0") but mean different things.
      if (answer && answer.ok === false) notes.push(t('Unavailable'));
      if (!answer && network.requiresKey) notes.push(t('Needs an API key'));
      return {
        id,
        text: count ? `${network.label} · ${count}` : network.label,
        checked,
        title: notes.join(' · '),
        onClick: () => onToggle(id, !checked),
      };
    }),
  };
}
