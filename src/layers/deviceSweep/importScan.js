/**
 * The operator's import path: one picked file in, one line of row text out.
 *
 * The row is the only place an import surfaces, and the layer around it is
 * built on Cesium's engine, so the reading lives here where a unit test can
 * drive it with a File and a store. The three answers an operator ever sees —
 * a refusal, a cap, and what was new since the last scan — are all this file's.
 */
import { formatNumber, t } from '../../i18n/index.js';
import { SCAN_MAX_DEVICES, parseInventory } from './scan.js';

/**
 * Read one picked file into the store.
 *
 * Everything that can go wrong is the operator's file or this browser's
 * storage, never the network, so the answer is a line of row text instead of a
 * degraded feed.
 *
 * @param {object} input
 * @param {{name?: string, text?: () => Promise<string>}} input.file
 *   The picked file: what the picker hands over, read once.
 * @param {{write: (payload: {devices: Array<object>, name?: string}) =>
 *   {added?: number}}} input.store
 * @returns {Promise<string>} The feedback line the row shows.
 */
export async function importScanFile({ file, store }) {
  try {
    const text = await file?.text?.();
    const parsed = parseInventory(String(text ?? ''));
    if (!parsed.format)
      return t('That file is not an inventory this layer reads');
    if (!parsed.devices.length) return t('No devices found in that scan');

    const { added } = store.write({
      devices: parsed.devices,
      name: file.name,
    });
    const suffix = [
      added
        ? t('{count} new since your last scan', {
            count: formatNumber(added),
          })
        : '',
      parsed.truncated
        ? t('capped at {limit}', { limit: SCAN_MAX_DEVICES })
        : '',
    ].filter(Boolean);
    return [
      t('Imported {count} devices from {name}', {
        count: formatNumber(parsed.devices.length),
        name: file.name || t('the selected file'),
      }),
      ...suffix,
    ].join(' · ');
  } catch (error) {
    console.warn('[Data:device-sweep] import failed:', error);
    return error?.code === 'too-large' || error?.code === 'unavailable'
      ? t('The scan is too large for this device')
      : t('That scan could not be saved');
  }
}
