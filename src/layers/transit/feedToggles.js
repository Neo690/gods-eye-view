import {
  TRANSIT_ENABLED_FEEDS,
  TRANSIT_MODE_ICON,
} from '../../data/transitFeeds.js';
import { t } from '../../i18n/index.js';

/**
 * The networks a person switched off in the Layers row.
 *
 * Transit polls whatever is in range of the camera, which is the right default
 * and still the wrong answer when two networks overlap: Cannes' buses are in
 * range of Nice, and a reader watching Nice may not want them. The row lists
 * every registered network with a switch, and the off ones are simply not
 * polled.
 *
 * Storage is local on purpose. This is a viewing preference, not part of a
 * shared scene: a link that carried thirty network switches would be a link
 * nobody could read, so it stays out of the share format.
 */
export const TRANSIT_HIDDEN_FEEDS_STORAGE_KEY = 'gev.transit.hidden-feeds.v1';

const REGISTERED_FEED_IDS = new Set(
  TRANSIT_ENABLED_FEEDS.map((feed) => feed.id),
);

/** localStorage without trusting it: private mode throws on write. */
export function readDefaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Keep only ids this build actually registers. A feed removed from the
 * registry, or a hand-edited storage value, must not leave the layer with a
 * hidden id it can never show again.
 * @param {unknown} value Array, Set, or JSON string.
 * @returns {Set<string>}
 */
export function sanitizeHiddenFeeds(value) {
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
      (id) => typeof id === 'string' && REGISTERED_FEED_IDS.has(id),
    ),
  );
  // Rebuilt in registry order, so the stored array reads the same whatever
  // order the clicks arrived in.
  const hidden = new Set();
  for (const feed of TRANSIT_ENABLED_FEEDS)
    if (wanted.has(feed.id)) hidden.add(feed.id);
  return hidden;
}

/**
 * @param {{getItem?: Function}|null} storage
 * @returns {Set<string>}
 */
export function readHiddenFeeds(storage) {
  try {
    const raw = storage?.getItem?.(TRANSIT_HIDDEN_FEEDS_STORAGE_KEY);
    return raw ? sanitizeHiddenFeeds(raw) : new Set();
  } catch {
    return new Set();
  }
}

/**
 * @param {{setItem?: Function}|null} storage
 * @param {Set<string>|string[]} hidden
 * @returns {Set<string>} What was written, sanitized.
 */
export function writeHiddenFeeds(storage, hidden) {
  const clean = sanitizeHiddenFeeds(hidden);
  try {
    storage?.setItem?.(
      TRANSIT_HIDDEN_FEEDS_STORAGE_KEY,
      JSON.stringify([...clean]),
    );
  } catch {
    /* A preference is not worth breaking a session over. */
  }
  return clean;
}

/**
 * A new set with `feedId` shown or hidden. Returning a new set rather than
 * mutating keeps the caller's `===` checks honest and makes the write trivial.
 * @param {Set<string>} hidden
 * @param {string} feedId
 * @param {boolean} visible
 * @returns {Set<string>}
 */
export function setFeedVisible(hidden, feedId, visible) {
  const next = new Set(hidden);
  if (!REGISTERED_FEED_IDS.has(feedId)) return next;
  if (visible) next.delete(feedId);
  else next.add(feedId);
  return next;
}

/**
 * The row's switch list: one entry per registered network, in the registry's
 * own order (which groups North America, then Europe), carrying the mode icon
 * as its lead so a bus network and a tram network read differently.
 *
 * `checked` is what the switch says: on means this network's vehicles are
 * being polled when the camera is near it.
 *
 * @param {{hidden: Set<string>, onToggle: (feedId: string, visible: boolean) => void}} input
 * @returns {{ordered: false, ariaLabel: string, items: object[]}}
 */
export function transitNetworkList({ hidden, onToggle }) {
  return {
    ordered: false,
    ariaLabel: t('Transit networks'),
    items: TRANSIT_ENABLED_FEEDS.map((feed) => {
      const checked = !hidden.has(feed.id);
      return {
        id: feed.id,
        lead: TRANSIT_MODE_ICON[feed.defaultMode] || TRANSIT_MODE_ICON.unknown,
        text: feed.name,
        checked,
        title: `${feed.operator} · ${feed.region} — ${
          checked ? t('Shown') : t('Hidden')
        }`,
        onClick: () => onToggle(feed.id, !checked),
      };
    }),
  };
}
