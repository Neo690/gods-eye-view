const set = (node, key, value) => {
  if (node[key] !== value) node[key] = value;
};
const attribute = (node, key, value) => {
  if (node.getAttribute(key) !== value) node.setAttribute(key, value);
};
/** Reconcile ordered layer/card lists without replacing focused items. */
export function syncRowList(container, list) {
  const document = container?.ownerDocument ?? globalThis.document;
  if (!container) return;
  const items = list?.items || [];
  set(container, 'hidden', items.length === 0);
  attribute(container, 'aria-label', list?.ariaLabel || '');
  // A switch list (one network per transit feed) is not a numbered sequence:
  // the class drops the step counter and draws the track and knob.
  const switches = items.some((item) => typeof item.checked === 'boolean');
  if (container.classList) container.classList.toggle('switches', switches);

  const stale = new Map();
  for (const node of [...container.children]) {
    if (node.dataset?.listItemId) stale.set(node.dataset.listItemId, node);
  }
  let index = 0;
  let activeButton = null;
  for (const item of items) {
    let entry = stale.get(item.id);
    stale.delete(item.id);
    let button;
    if (!entry) {
      entry = document.createElement('li');
      entry.dataset.listItemId = item.id;
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'data-row-list-item';
      button.dataset.listItemId = item.id;
      const lead = document.createElement('span');
      lead.className = 'data-row-list-lead';
      const text = document.createElement('span');
      text.className = 'data-row-list-text';
      button.append(lead, text);
      entry.appendChild(button);
    } else {
      button = entry.querySelector('.data-row-list-item');
    }
    // Keep DOM order in step with descriptor order without rebuilding.
    const anchor = container.children[index++] || null;
    if (entry !== anchor) container.insertBefore(entry, anchor);
    if (!button) continue;
    const lead = button.querySelector('.data-row-list-lead');
    const text = button.querySelector('.data-row-list-text');
    const leadText = String(item.lead ?? '');
    const bodyText = String(item.text ?? '');
    if (lead && lead.textContent !== leadText) lead.textContent = leadText;
    if (text && text.textContent !== bodyText) text.textContent = bodyText;
    set(button, 'disabled', Boolean(item.disabled));
    // A boolean `checked` turns the row into a switch: `role="switch"` with
    // `aria-checked` is what a screen reader announces as on/off, where
    // `aria-pressed` on a plain button would announce a toggle button.
    const isSwitch = typeof item.checked === 'boolean';
    set(
      button,
      'className',
      `data-row-list-item${isSwitch ? ' switch' : ''}${item.disabled ? ' note' : ''}${item.active ? ' active' : ''}${item.current ? ' current' : ''}`,
    );
    attribute(button, 'aria-current', item.current ? 'step' : 'false');
    attribute(button, 'aria-pressed', item.active ? 'true' : 'false');
    if (isSwitch) {
      attribute(button, 'role', 'switch');
      attribute(button, 'aria-checked', item.checked ? 'true' : 'false');
      set(button.dataset, 'checked', item.checked ? 'true' : 'false');
    } else {
      button.removeAttribute?.('role');
      button.removeAttribute?.('aria-checked');
      delete button.dataset?.checked;
    }
    let track = button.querySelector('.data-row-list-switch');
    if (isSwitch && !track) {
      track = document.createElement('span');
      track.className = 'data-row-list-switch';
      track.setAttribute('aria-hidden', 'true');
      button.appendChild(track);
    } else if (!isSwitch && track) track.remove();
    set(button, 'title', item.title || bodyText);
    if (item.current) activeButton = button;
  }
  for (const node of stale.values()) node.remove();
  // Follow the flight, but never steal a scroll the reader is making
  // themselves: only when the step actually changed.
  if (
    activeButton &&
    container.dataset.currentId !== activeButton.dataset.listItemId
  ) {
    container.dataset.currentId = activeButton.dataset.listItemId;
    activeButton.scrollIntoView?.({ block: 'nearest' });
  } else if (!activeButton) {
    delete container.dataset.currentId;
  }
}
