import {
  setFeedVisible as nextHiddenFeeds,
  transitNetworkList,
  writeHiddenFeeds,
} from './feedToggles.js';

/**
 * Manager wiring. Transit's data arrives from camera-driven proximity polls,
 * not only from the manager's own tick, so the layer keeps a handle it can use
 * to repaint its panel row the moment a snapshot lands.
 * @param {object} context
 * @returns {object}
 */
export function createControls({ state, parts }) {
  /** Repaints the Layers row after a switch flips, without waiting for a poll. */
  let rowControlsListener = null;
  const notify = () => rowControlsListener?.();

  const methods = {
    /**
     * @param {object} dataManager DataLayerManager instance.
     */
    attachDataManager(dataManager) {
      state._dataManager = dataManager;
    },

    /**
     * The Layers row's network switches.
     *
     * Every registered network is listed, on or off, because "which of these
     * is being polled" is exactly the question the switch answers — a list of
     * only the visible ones could not show what was switched off.
     */
    getRowControls() {
      return {
        list: transitNetworkList({
          hidden: state._hiddenFeeds,
          onToggle: (feedId, visible) =>
            methods.setFeedVisible(feedId, visible),
        }),
      };
    },

    /**
     * Show or hide one network.
     *
     * The proximity check runs immediately rather than on the next poll: hiding
     * a network has to take its vehicles off the globe now, and showing one has
     * to start its first request now, both of which `runProximityCheck` already
     * knows how to do (it aborts and drops what is no longer wanted).
     * @param {string} feedId
     * @param {boolean} visible
     * @returns {boolean} Whether the set changed.
     */
    setFeedVisible(feedId, visible) {
      const next = nextHiddenFeeds(state._hiddenFeeds, feedId, visible);
      const changed =
        next.size !== state._hiddenFeeds.size ||
        [...next].some((id) => !state._hiddenFeeds.has(id));
      if (!changed) return false;
      state._hiddenFeeds = next;
      writeHiddenFeeds(state._storage, next);
      parts.viewport?.runProximityCheck?.();
      notify();
      return true;
    },

    /** @returns {string[]} The ids switched off, in registry order. */
    getHiddenFeeds() {
      return [...state._hiddenFeeds];
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /** Drop the panel's listener; the panel may outlive this layer. */
    clearRowControlsListener() {
      rowControlsListener = null;
    },
  };
  return { methods };
}
