import { msg } from '../../i18n/index.js';
import { createViewportPointsLayer } from '../viewportPoints/engine.js';
import { createNetmonSource } from './source.js';

export { NETMON_ROUTE, createNetmonSource } from './source.js';
export * from '../viewportPoints/records.js';

/** The three probe answers a marker can show. */
export const NETMON_LEGEND = Object.freeze([
  Object.freeze({ label: msg('Reachable'), color: '#4de18e' }),
  Object.freeze({ label: msg('Unreachable'), color: '#ff5f6d' }),
  Object.freeze({ label: msg('Unknown'), color: '#8a94a6' }),
]);

/**
 * Colour one marker from its own probe answer. A point whose row carries no
 * status falls back to the unknown shade rather than to the theme, so a
 * parser change cannot quietly recolour the map.
 */
export function netmonPointColour(point) {
  if (point?.meta?.status === 'up') return '#4de18e';
  if (point?.meta?.status === 'down') return '#ff5f6d';
  return '#8a94a6';
}

/**
 * Own one display of the operator's own, authorized network nodes: targets
 * declared in this server's `GEV_NETMON_TARGETS`, probed by that server with
 * a plain TCP connect and drawn at the positions the operator declared.
 *
 * A green marker is a port that accepted a connection; a red one timed out
 * or refused it, and an unmatched one is still on its first probe round.
 * Neither colour says more than that: nothing is sent behind the probe and
 * no node position is inferred from a host name.
 *
 * @param {object} [options]
 * @param {{getSnapshot: Function}} [options.source]
 */
export function createNetmonLayer({ source = createNetmonSource() } = {}) {
  return createViewportPointsLayer({
    id: 'netmon',
    name: 'Network Monitor',
    icon: '📡',
    attribution: 'Operator nodes · probed by this server',
    source,
    colour: '#4de18e',
    pixelSize: 7,
    // Status is per point, not per feed: the engine draws each marker in the
    // colour its own probe round answered.
    pointColour: netmonPointColour,
    legend: NETMON_LEGEND,
    // Probes are cheap but a node list is state, not a stream: the engine's
    // own pacing already re-reads on camera moves, this only bounds idle polls.
    refreshMs: 60000,
    emptyHint:
      'Targets are read from GEV_NETMON_TARGETS on the server; a node without lat/lon is probed but not drawn.',
  });
}
