/**
 * The file chooser for a private import.
 *
 * The input is created once and kept in the document, with its change handler
 * installed at that moment, for three reasons: a reader that wants the same
 * file twice gets the same element, a WebView that recycles its file chooser
 * keeps answering the element it was given, and the import path can be
 * exercised without a native picker. Nothing is read until a file arrives,
 * and what arrives is handed straight to the layer — this module never sends
 * it anywhere.
 */

export const PRIVATE_WIFI_FILE_INPUT_ID = 'private-wifi-file';

/** The handler the input calls; replaced whenever a picker opens. */
let activeHandler = null;

/**
 * Install the function that receives the picked file.
 * @param {((file: File) => Promise<void>|void)|null} handler
 */
export function bindPrivateWifiFileHandler(handler) {
  activeHandler = typeof handler === 'function' ? handler : null;
}

/**
 * @param {object} [options]
 * @param {Document} [options.documentRef]
 * @returns {HTMLInputElement|null}
 */
export function ensurePrivateWifiFileInput({
  documentRef = globalThis.document,
} = {}) {
  if (!documentRef?.getElementById || !documentRef?.createElement) return null;
  const existing = documentRef.getElementById(PRIVATE_WIFI_FILE_INPUT_ID);
  if (existing) return existing;
  const input = documentRef.createElement('input');
  input.type = 'file';
  input.id = PRIVATE_WIFI_FILE_INPUT_ID;
  // .csv covers the pickers that honour it; the MIME list covers the ones
  // that only look at the type, and Android often reports text/plain.
  input.accept = '.csv,text/csv,text/plain';
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
      console.warn('[Data:private-wifi] file read failed:', error);
    }
  });
  documentRef.body.appendChild(input);
  return input;
}

/**
 * Open the picker, optionally pointing it at a specific handler.
 * @param {object} [options]
 * @param {Document} [options.documentRef]
 * @param {(file: File) => Promise<void>|void} [options.onFile]
 * @returns {HTMLInputElement|null} The input, for a caller that needs it.
 */
export function openPrivateWifiPicker({
  documentRef = globalThis.document,
  onFile,
} = {}) {
  const input = ensurePrivateWifiFileInput({ documentRef });
  if (!input) return null;
  if (onFile) bindPrivateWifiFileHandler(onFile);
  input.click();
  return input;
}
