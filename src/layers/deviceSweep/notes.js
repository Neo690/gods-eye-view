import { t } from '../../i18n/index.js';
import { createSweepDialog, labelledField, styleSweepField } from './dialog.js';
import { DEVICE_SWEEP_NOTE_MAX, deviceSweepKey } from './store.js';

/**
 * The note dialog: pick one device from the imported inventory and write down
 * what only the operator knows — "the camera above the door", "my own plug".
 *
 * A note is filed under the device's key (its MAC, else its address), so it
 * follows that device across imports, and it stays in this browser with the
 * scan it belongs to. The text is bounded and escaped on the way in and shown
 * with `textContent`, so a pasted value can never become markup.
 *
 * @param {object} [options]
 * @param {Array<object>} [options.devices] Imported devices.
 * @param {Object<string, string>} [options.notes] Notes by device key.
 * @param {(key: string, text: string) => void} [options.onSubmit]
 * @param {Document} [options.documentRef] Test seam.
 * @returns {HTMLDialogElement|null} null with no devices or no document.
 */
export function openNoteDialog({
  devices = [],
  notes = {},
  onSubmit,
  documentRef = globalThis.document,
} = {}) {
  const list = Array.isArray(devices) ? devices : [];
  if (!list.length) return null;
  const dialog = createSweepDialog({
    title: t('Note on a device'),
    documentRef,
  });
  if (!dialog) return null;
  const doc = dialog.element.ownerDocument ?? documentRef;

  const select = styleSweepField(doc.createElement('select'));
  for (const device of list) {
    const option = doc.createElement('option');
    option.value = deviceSweepKey(device);
    // The address is what the operator can act on; the maker or host name
    // tells them which device it is.
    option.textContent =
      [device.ip || device.mac, device.vendor || device.hostname]
        .filter(Boolean)
        .join(' · ') || option.value;
    select.append(option);
  }

  const textarea = styleSweepField(doc.createElement('textarea'));
  textarea.rows = 3;
  textarea.maxLength = DEVICE_SWEEP_NOTE_MAX;
  textarea.value = notes[select.value] ?? '';

  dialog.body.append(
    labelledField(doc, t('Device'), select),
    labelledField(doc, t('Note'), textarea),
  );
  dialog.button(t('SAVE NOTE'), { type: 'submit' });

  select.addEventListener('change', () => {
    textarea.value = notes[select.value] ?? '';
  });

  dialog.form.addEventListener('submit', (event) => {
    event.preventDefault?.();
    const key = select.value;
    const text = textarea.value;
    dialog.close();
    onSubmit?.(key, text);
  });

  textarea.focus?.();
  textarea.select?.();
  return dialog.element;
}
