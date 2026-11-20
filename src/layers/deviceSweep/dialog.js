import { t } from '../../i18n/index.js';

/**
 * The small modal the sweep's own dialogs share: the place and a device note.
 *
 * A plain `<dialog>` with a form: Enter submits through the form, Escape
 * cancels through the dialog's own `cancel` event, and neither needs key
 * handling of our own. Every string is set with `textContent`, so a value the
 * operator typed can never become markup. One dialog is open at a time — a
 * second open closes the first rather than stacking two forms over the globe.
 *
 * Nothing here reaches the network: the dialog only hands its values back to
 * the layer, which writes them to this browser's storage.
 */

const PALETTE = Object.freeze({
  background: '#08141e',
  field: '#10242e',
  text: '#e3faff',
  border: '#397080',
  warning: '#ffb347',
});

/** Close the dialog still open from an earlier click, if any. */
let closeOpen = null;

/**
 * Style a text field, select or textarea the way the dialog's own surface is
 * drawn; returned so a caller can use it as an expression.
 * @param {HTMLElement} node
 * @returns {HTMLElement}
 */
export function styleSweepField(node) {
  Object.assign(node.style, {
    display: 'block',
    boxSizing: 'border-box',
    width: '100%',
    padding: '7px',
    margin: '6px 0 4px',
    color: PALETTE.text,
    background: PALETTE.field,
    border: `1px solid ${PALETTE.border}`,
    font: 'inherit',
  });
  return node;
}

/**
 * A labelled field, the shape both dialogs use: the label wraps the control,
 * so clicking the text focuses it and no id is needed.
 *
 * @param {Document} doc
 * @param {string} label
 * @param {HTMLElement} node
 * @returns {HTMLLabelElement}
 */
export function labelledField(doc, label, node) {
  const field = doc.createElement('label');
  field.textContent = label;
  Object.assign(field.style, { display: 'block' });
  field.append(node);
  return field;
}

/**
 * @param {object} options
 * @param {string} options.title Shown as the heading and the accessible name.
 * @param {Document} [options.documentRef] Test seam.
 * @returns {{element: HTMLDialogElement, form: HTMLFormElement,
 *   body: HTMLElement, footer: HTMLElement, status: HTMLElement,
 *   button: (label: string, options?: {type?: string}) => HTMLButtonElement,
 *   close: () => void}|null} null where there is no document (tests, SSR).
 */
export function createSweepDialog({
  title,
  documentRef = globalThis.document,
} = {}) {
  const doc = documentRef;
  if (!doc?.createElement || !doc.body) return null;
  closeOpen?.();

  const element = doc.createElement('dialog');
  element.className = 'device-sweep-dialog';
  element.setAttribute('aria-label', title);
  Object.assign(element.style, {
    background: PALETTE.background,
    color: PALETTE.text,
    border: `1px solid ${PALETTE.border}`,
    borderRadius: '6px',
    padding: '18px',
    width: 'min(380px, calc(100vw - 32px))',
    boxSizing: 'border-box',
    position: 'fixed',
    inset: '0',
    margin: 'auto',
    font: '14px/1.5 sans-serif',
  });

  const heading = doc.createElement('h2');
  heading.textContent = title;
  Object.assign(heading.style, { margin: '0 0 12px', fontSize: '15px' });

  const form = doc.createElement('form');
  form.noValidate = true;
  const body = doc.createElement('div');
  const status = doc.createElement('p');
  status.setAttribute('role', 'status');
  Object.assign(status.style, {
    margin: '8px 0',
    minHeight: '1.4em',
    color: PALETTE.warning,
  });
  const footer = doc.createElement('div');
  Object.assign(footer.style, {
    display: 'flex',
    gap: '8px',
    justifyContent: 'flex-end',
  });
  form.append(body, status, footer);
  element.append(heading, form);

  function close() {
    if (closeOpen === close) closeOpen = null;
    element.removeEventListener('cancel', cancelDialog);
    element.close?.();
    element.remove();
  }
  closeOpen = close;

  function cancelDialog(event) {
    event.preventDefault?.();
    close();
  }

  function button(label, { type = 'button' } = {}) {
    const node = doc.createElement('button');
    node.type = type;
    node.textContent = label;
    Object.assign(node.style, {
      background: PALETTE.field,
      color: PALETTE.text,
      border: `1px solid ${PALETTE.border}`,
      borderRadius: '3px',
      padding: '7px 11px',
      cursor: 'pointer',
      font: 'inherit',
    });
    footer.append(node);
    return node;
  }

  // Cancel is the dialog's own, wired once here: a dialog whose cancel button
  // does nothing is a form the operator can only leave with Escape.
  button(t('Cancel')).addEventListener('click', close);

  element.addEventListener('cancel', cancelDialog);
  doc.body.append(element);
  element.showModal?.();
  return { element, form, body, footer, status, button, close };
}
