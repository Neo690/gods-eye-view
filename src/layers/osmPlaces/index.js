import { t } from '../../i18n/index.js';
import {
  cameraBounds,
  createViewportPointsLayer,
} from '../viewportPoints/engine.js';
import { clampViewport } from '../viewportPoints/records.js';
import {
  CATEGORY_COLOURS,
  LAYER_ID,
  MAX_VIEWPORT_DEGREES,
  REFRESH_MS,
  overpassTurboUrl,
} from './policy.js';
import { createOverpassPlacesSource } from './source.js';

export * from './policy.js';
export * from './records.js';
export { createOverpassPlacesSource } from './source.js';

/**
 * One viewport-bounded display of named OpenStreetMap places.
 *
 * The engine owns the camera-driven refresh, the 800-point cap, retries and
 * the row's count; this factory only chooses the source, the per-family
 * colours and the Overpass Turbo link.
 *
 * @param {object} [options]
 * @param {{getSnapshot: Function}} [options.source]
 */
export function createOsmPlacesLayer({
  source = createOverpassPlacesSource(),
} = {}) {
  let viewer = null;

  const currentBounds = () =>
    viewer
      ? clampViewport(cameraBounds(viewer), MAX_VIEWPORT_DEGREES).bounds
      : null;

  const layer = createViewportPointsLayer({
    id: LAYER_ID,
    name: 'OSM Places',
    icon: '📍',
    attribution: 'OpenStreetMap · Overpass',
    source,
    colour: CATEGORY_COLOURS.other,
    pointColour: (point) =>
      CATEGORY_COLOURS[point.meta?.category] || CATEGORY_COLOURS.other,
    legend: [
      { label: t('Food & drink'), color: CATEGORY_COLOURS.food },
      { label: t('Shops'), color: CATEGORY_COLOURS.shop },
      { label: t('Culture & leisure'), color: CATEGORY_COLOURS.culture },
      { label: t('Services'), color: CATEGORY_COLOURS.services },
      { label: t('Other'), color: CATEGORY_COLOURS.other },
    ],
    pixelSize: 6,
    refreshMs: REFRESH_MS,
    maxSpanDeg: MAX_VIEWPORT_DEGREES,
    hoverTip: (point) =>
      point.meta?.kind ? `${point.label} · ${point.meta.kind}` : point.label,
    extras: () => {
      const bounds = currentBounds();
      return {
        chips: [
          {
            id: 'overpass-turbo',
            label: t('Overpass Turbo'),
            title: t('Open this view in Overpass Turbo'),
            disabled: !overpassTurboUrl(bounds),
            onClick: () => {
              const url = overpassTurboUrl(currentBounds());
              if (url)
                globalThis.window?.open?.(url, '_blank', 'noopener,noreferrer');
            },
          },
        ],
      };
    },
  });

  // The engine's renderer does not expose its viewer; the link needs the
  // current camera, so keep a reference at the lifecycle boundary.
  const init = layer.init;
  layer.init = (nextViewer) => {
    viewer = nextViewer;
    return init.call(layer, nextViewer);
  };
  const destroy = layer.destroy;
  layer.destroy = (nextViewer) => {
    viewer = null;
    return destroy.call(layer, nextViewer);
  };

  return layer;
}
