/**
 * The operator's import path: one picked file in, one line of row text out.
 *
 * The row is the only place an import surfaces, and the layer around it is
 * built on Cesium's engine, so the reading lives here where a unit test can
 * drive it with a File and a store. The answers an operator ever sees — a
 * refusal, a cap, what was new, and a question when the file does not look like
 * their own network — are all this file's.
 *
 * A file that is not the operator's is the one import worth stopping. The store
 * keeps what it already has and greys it, so importing somebody else's scan
 * would mute the whole sweep and add a stranger's devices to it. Nothing is
 * written until the row's own question is answered; the picked file comes back
 * with the question so the answer does not need the file picked twice.
 */
import { formatNumber, t } from '../../i18n/index.js';
import { SCAN_MAX_DEVICES, parseInventory } from './scan.js';
import { deviceSweepKey } from './store.js';

/**
 * Share of the stored devices a file must name to be imported without asking.
 * A re-scan of the same network names all of them, minus the ones that went
 * quiet; a scan of another network names none of them.
 */
export const IMPORT_OVERLAP_FLOOR = 0.25;

/**
 * How much of the stored sweep a picked file accounts for.
 *
 * @param {{known?: Array<object>, incoming?: Array<object>}} [input]
 * @returns {{known: number, matched: number, unfamiliar: boolean}} `known` is
 *   the size of the sweep already stored and `matched` how many of those
 *   devices the file names. Nothing is unfamiliar while nothing is stored: a
 *   first import has nothing to contradict.
 */
export function importOverlap({ known = [], incoming = [] } = {}) {
  const knownKeys = new Set(known.map(deviceSweepKey).filter(Boolean));
  if (!knownKeys.size) return { known: 0, matched: 0, unfamiliar: false };
  const incomingKeys = new Set(incoming.map(deviceSweepKey).filter(Boolean));
  let matched = 0;
  for (const key of incomingKeys) if (knownKeys.has(key)) matched += 1;
  return {
    known: knownKeys.size,
    matched,
    unfamiliar: matched / knownKeys.size < IMPORT_OVERLAP_FLOOR,
  };
}

/**
 * Read one picked file into the store, or ask first.
 *
 * Everything that can go wrong is the operator's file or this browser's
 * storage, never the network, so the answer is a line of row text instead of a
 * degraded feed.
 *
 * @param {object} input
 * @param {{name?: string, text?: () => Promise<string>}} input.file
 *   The picked file: what the picker hands over, read once per call.
 * @param {{read: Function, write: (payload: {devices: Array<object>,
 *   name?: string}) => {added?: number}}} input.store
 * @param {boolean} [input.confirm] True once the operator has said yes to a
 *   file the store did not recognise.
 * @returns {Promise<{line: string, pending?: {file: object, matched: number,
 *   total: number}}>} `line` is the row's text; `pending` is set when nothing
 *   was written and the row must ask, carrying the file back for the answer.
 */
export async function importScanFile({ file, store, confirm = false }) {
  try {
    const text = await file?.text?.();
    const parsed = parseInventory(String(text ?? ''));
    if (!parsed.format)
      return { line: t('That file is not an inventory this layer reads') };
    if (!parsed.devices.length)
      return { line: t('No devices found in that scan') };

    const overlap = importOverlap({
      known: store.read().devices,
      incoming: parsed.devices,
    });
    if (!confirm && overlap.unfamiliar)
      return {
        line: t(
          'Only {matched} of your {total} devices are in this file. Import it anyway? Your scan would stay, greyed, and this one would be added to it.',
          {
            matched: formatNumber(overlap.matched),
            total: formatNumber(overlap.known),
          },
        ),
        pending: {
          file,
          matched: overlap.matched,
          total: overlap.known,
        },
      };

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
    return {
      line: [
        t('Imported {count} devices from {name}', {
          count: formatNumber(parsed.devices.length),
          name: file.name || t('the selected file'),
        }),
        ...suffix,
      ].join(' · '),
    };
  } catch (error) {
    console.warn('[Data:device-sweep] import failed:', error);
    return {
      line:
        error?.code === 'too-large' || error?.code === 'unavailable'
          ? t('The scan is too large for this device')
          : t('That scan could not be saved'),
    };
  }
}
