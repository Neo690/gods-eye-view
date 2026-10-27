import { formatNumber, msg, t } from '../../i18n/index.js';
import { createViewportPointsLayer } from '../viewportPoints/engine.js';
import { WIGLE_MAX_NETWORKS, parseWigleCsv } from './csv.js';
import {
  bindPrivateWifiFileHandler,
  ensurePrivateWifiFileInput,
  openPrivateWifiPicker,
} from './picker.js';
import { createPrivateWifiSource } from './source.js';
import { createPrivateWifiStore } from './store.js';

export { WIGLE_MAX_NETWORKS, parseWigleCsv, splitCsvLine } from './csv.js';
export { networksInBounds, createPrivateWifiSource } from './source.js';
export {
  PRIVATE_WIFI_STORAGE_KEY,
  PrivateWifiStoreError,
  createPrivateWifiStore,
} from './store.js';
export {
  PRIVATE_WIFI_FILE_INPUT_ID,
  bindPrivateWifiFileHandler,
  ensurePrivateWifiFileInput,
  openPrivateWifiPicker,
} from './picker.js';

/**
 * Your own wardrive, drawn as a layer.
 *
 * WiGLE publishes a database of everyone's observations; this layer is the
 * opposite of that. It reads one CSV the operator exported themselves, keeps
 * it in this browser (src/layers/privateWifi/store.js), and draws only that.
 * The layer is registered as local-only, so its state never enters a share
 * link, and the source it reads has no fetch in it at all — there is no path
 * by which an imported file could reach a server, ours or WiGLE's.
 *
 * Rendering, capping and the "N in view" line come from the shared viewport
 * engine, so this layer behaves like Radio Sites without a second renderer.
 *
 * @param {object} [options]
 * @param {{read: Function, write: Function, clear: Function}} [options.store]
 */
export function createPrivateWifiLayer({
  store = createPrivateWifiStore(),
} = {}) {
  let feedback = '';
  // The panel refresh hands the layer the reload it should call after an
  // import; until the row has rendered there is nothing to reload, and the
  // next refresh reads the store anyway.
  const refreshRef = { current: () => {} };

  /**
   * Read one picked file into the store. Everything that can go wrong here is
   * the operator's file, not the network, so the row reports it in its own
   * line instead of marking the feed degraded.
   */
  async function importFile(file, refresh) {
    try {
      const text = await file?.text?.();
      const parsed = parseWigleCsv(String(text ?? ''));
      if (!parsed.header) {
        feedback = t('That file has no WiGLE header');
      } else if (!parsed.networks.length) {
        feedback = t('No Wi-Fi networks found in that file');
      } else {
        store.write({ networks: parsed.networks, name: file.name });
        feedback =
          t('Imported {count} networks from {name}', {
            count: formatNumber(parsed.networks.length),
            name: file.name || t('the selected file'),
          }) +
          (parsed.truncated
            ? ` · ${t('capped at {limit}', { limit: WIGLE_MAX_NETWORKS })}`
            : '');
      }
    } catch (error) {
      console.warn('[Data:private-wifi] import failed:', error);
      feedback =
        error?.code === 'too-large' || error?.code === 'unavailable'
          ? t('The import is too large for this device')
          : t('That import could not be saved');
    }
    refresh();
  }

  const layer = createViewportPointsLayer({
    id: 'private-wifi',
    name: 'Private Wi-Fi',
    icon: '📡',
    attribution: msg('Your WiGLE export'),
    source: createPrivateWifiSource({ store }),
    colour: '#3ad6c4',
    pixelSize: 6,
    // The data only changes when the operator imports again; a camera move is
    // what re-reads it, so the interval can be long.
    refreshMs: 600000,
    extras: ({ refresh }) => {
      refreshRef.current = refresh;
      const { networks } = store.read();
      const count = networks.length;
      return {
        chips: [
          {
            id: 'import',
            label: t('IMPORT CSV'),
            onClick: () => openPrivateWifiPicker(),
          },
          {
            id: 'clear',
            label: t('CLEAR IMPORT'),
            disabled: count === 0,
            onClick: () => {
              store.clear();
              feedback = t('Import removed from this device');
              refresh();
            },
          },
        ],
        detail:
          feedback ||
          (count
            ? t('{count} networks imported · stays on this device', {
                count: formatNumber(count),
              })
            : t('No import yet · stays on this device')),
      };
    },
  });
  // The input exists from construction so a second import reuses it, and so
  // the Android shell always has the element its file chooser answers.
  ensurePrivateWifiFileInput();
  bindPrivateWifiFileHandler((file) => importFile(file, refreshRef.current));
  return layer;
}
