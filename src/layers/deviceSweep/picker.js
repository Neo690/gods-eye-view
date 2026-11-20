/**
 * The file chooser for a scan import.
 *
 * The input is created once and kept in the document, with its change handler
 * installed at that moment, for three reasons: a reader that wants the same
 * file twice gets the same element, a WebView that recycles its file chooser
 * keeps answering the element it was given, and the import path can be
 * exercised without a native picker. Nothing is read until a file arrives, and
 * what arrives is handed straight to the layer — this module never sends it
 * anywhere.
 */

export const DEVICE_SWEEP_FILE_INPUT_ID = 'device-sweep-file';

/** The handler the input calls; replaced whenever a picker opens. */
let activeHandler = null;

/**
 * Install the function that receives the picked file.
 * @param {((file: File) => Promise<void>|void)|null} handler
 */
export function bindDeviceSweepFileHandler(handler) {
  activeHandler = typeof handler === 'function' ? handler : null;
}

/**
 * @param {object} [options]
 * @param {Document} [options.documentRef]
 * @returns {HTMLInputElement|null}
 */
export function ensureDeviceSweepFileInput({
  documentRef = globalThis.document,
} = {}) {
  if (!documentRef?.getElementById || !documentRef?.createElement) return null;
  const existing = documentRef.getElementById(DEVICE_SWEEP_FILE_INPUT_ID);
  if (existing) return existing;
  const input = documentRef.createElement('input');
  input.type = 'file';
  input.id = DEVICE_SWEEP_FILE_INPUT_ID;
  // The extensions cover the pickers that honour them; the MIME list covers
  // the ones that only look at the type, and Android often reports
  // application/octet-stream for an .xml report.
  input.accept = '.xml,.txt,.nmap,.gnmap,text/xml,application/xml,text/plain';
  input.hidden = true;
  input.setAttribute('aria-hidden', 'true');
  input.addEventListener('change', async () => {
    const file = input.files?.[0] || null;
    // Reset first: picking the same file twice must fire change twice.
    input.value = '';
    if (!file) return;
    try {
      await activeHandler?.(file);
    } catch (error) {
      console.warn('[Data:device-sweep] file read failed:', error);
    }
  });
  documentRef.body.appendChild(input);
  return input;
}

/**
 * Open the picker. The handler is the one bound once by the layer; a picker
 * open never rebinds it, so two opens cannot leave two owners.
 * @param {object} [options]
 * @param {Document} [options.documentRef]
 * @returns {HTMLInputElement|null} The input, for a caller that needs it.
 */
export function openDeviceSweepPicker({
  documentRef = globalThis.document,
} = {}) {
  const input = ensureDeviceSweepFileInput({ documentRef });
  if (!input) return null;
  input.click();
  return input;
}
