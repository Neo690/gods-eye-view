/**
 * A scrollbar a phone can actually see.
 *
 * The rail sheets scroll their content, and the stylesheet has drawn a thin
 * cyan bar for that list for a long time. It is invisible on Android: Chrome
 * there uses overlay scrollbars and does not honour `::-webkit-scrollbar`, so
 * the bar only exists while a finger is already dragging — which is exactly
 * when it is not needed. Data layers, whose list is two screens tall, looked
 * like a panel that simply stopped halfway down.
 *
 * This draws the bar as DOM instead: a track and a thumb beside the sheet's
 * scroller, sized from `scrollHeight / clientHeight` and moved with
 * `scrollTop`. It stays visible while the sheet is open and the content
 * overflows, disappears when everything fits, and the thumb can be dragged to
 * scroll without touching the list itself.
 *
 * Only phones get it: above the breakpoint the native scrollbar is real and
 * already styled by the stylesheet.
 */

/** The one breakpoint the sheets — and this bar — exist at. */
export const PANEL_SCROLL_MEDIA = '(max-width: 720px)';

/** The sheets that become a full-height panel on a phone. */
export const PANEL_SCROLL_SHEET_SELECTOR =
  '#left-panel-stack > .panel-collapsible, #right-context-rail > .panel-collapsible';

/** The scrolling body inside a sheet, in the order they are tried. */
export const PANEL_SCROLL_BODY_SELECTOR =
  '[data-rail-scroller], .data-toggle-list, .pp-panel-body';

/** Shortest thumb: a bar that shrinks to a dot stops being grabbable. */
const MIN_THUMB_PX = 26;

/** Less overflow than this is not worth a bar beside the content. */
const MIN_OVERFLOW_PX = 8;

/**
 * @param {object} [input]
 * @param {Document} [input.document]
 * @param {() => boolean} [input.isMobile]
 * @returns {{entries: object[], sync: () => void, destroy: () => void}|null}
 */
export function createPanelScrollIndicators({
  document: doc = globalThis.document,
  isMobile = () =>
    !!doc?.defaultView?.matchMedia?.(PANEL_SCROLL_MEDIA)?.matches,
} = {}) {
  const sheets = [];
  for (const selector of PANEL_SCROLL_SHEET_SELECTOR.split(','))
    for (const sheet of doc?.querySelectorAll?.(selector.trim()) ?? [])
      if (sheet && !sheets.includes(sheet)) sheets.push(sheet);
  if (!sheets.length) return null;

  const entries = [];
  const observers = [];
  const unlisten = [];
  let drag = null;

  const bind = (sheet) => {
    if (entries.some((entry) => entry.sheet === sheet)) return null;
    const body = sheet.querySelector?.(PANEL_SCROLL_BODY_SELECTOR);
    if (!body) return null;
    const bar = doc.createElement?.('div');
    if (!bar) return null;
    bar.className = 'gev-scroll-indicator';
    bar.hidden = true;
    bar.setAttribute?.('aria-hidden', 'true');
    const thumb = doc.createElement('div');
    thumb.className = 'gev-scroll-thumb';
    bar.append(thumb);
    sheet.append(bar);
    const entry = { sheet, body, bar, thumb };
    entries.push(entry);

    const onScroll = () => update(entry);
    body.addEventListener?.('scroll', onScroll, { passive: true });
    unlisten.push(() => body.removeEventListener?.('scroll', onScroll));
    const MutationObserver = doc.defaultView?.MutationObserver;
    if (MutationObserver) {
      // Rows arrive asynchronously, and the sheet opens and closes by class.
      const observer = new MutationObserver(() => update(entry));
      observer.observe(body, { childList: true, subtree: true });
      observer.observe(sheet, { attributes: true, attributeFilter: ['class'] });
      observers.push(observer);
    }
    const ResizeObserver = doc.defaultView?.ResizeObserver;
    if (ResizeObserver) {
      const observer = new ResizeObserver(() => update(entry));
      observer.observe?.(body);
      observers.push(observer);
    }
    return entry;
  };

  /** Place the thumb where the list is, or take the bar away when it fits. */
  const update = (entry) => {
    const { sheet, body, bar, thumb } = entry;
    const hidden =
      !isMobile() ||
      sheet.classList?.contains?.('collapsed') ||
      !(body.scrollHeight > body.clientHeight + MIN_OVERFLOW_PX);
    bar.hidden = !!hidden;
    if (hidden) return;
    // The bar belongs to the scroller, not to the sheet: it starts under the
    // header and stops at the sheet's own padding, so the thumb lines up with
    // the rows it is describing.
    const sheetBox = sheet.getBoundingClientRect?.();
    const bodyBox = body.getBoundingClientRect?.();
    if (sheetBox && bodyBox) {
      bar.style?.setProperty?.(
        'top',
        `${Math.max(0, Math.round(bodyBox.top - sheetBox.top))}px`,
      );
      bar.style?.setProperty?.(
        'bottom',
        `${Math.max(0, Math.round(sheetBox.bottom - bodyBox.bottom))}px`,
      );
    }
    const trackHeight = bar.clientHeight || sheet.clientHeight || 0;
    if (!trackHeight) return;
    const ratio = body.clientHeight / body.scrollHeight;
    const thumbHeight = Math.max(MIN_THUMB_PX, Math.round(trackHeight * ratio));
    const range = body.scrollHeight - body.clientHeight;
    const progress = range > 0 ? body.scrollTop / range : 0;
    const top = Math.round(progress * (trackHeight - thumbHeight));
    thumb.style?.setProperty?.('height', `${thumbHeight}px`);
    thumb.style?.setProperty?.('top', `${top}px`);
  };

  const updateAll = () => {
    for (const entry of entries) update(entry);
  };

  /** Re-read the scroller under the finger and scroll the list to match. */
  const scrollToPoint = (event) => {
    if (!drag) return;
    const box = drag.bar.getBoundingClientRect?.();
    if (!box?.height) return;
    const thumbHeight = drag.thumb.getBoundingClientRect?.()?.height || 0;
    const usable = Math.max(1, box.height - thumbHeight);
    const offset = (event.clientY ?? 0) - box.top - drag.grabOffset;
    const progress = Math.min(1, Math.max(0, offset / usable));
    const range = drag.body.scrollHeight - drag.body.clientHeight;
    drag.body.scrollTop = progress * range;
    update(drag);
  };

  const onThumbDown = (event) => {
    const entry = entries.find(
      (candidate) => candidate.thumb === event.currentTarget,
    );
    if (!entry) return;
    const box = entry.bar.getBoundingClientRect?.();
    const thumbBox = entry.thumb.getBoundingClientRect?.();
    if (!box?.height) return;
    event.preventDefault?.();
    drag = {
      ...entry,
      grabOffset: Math.max(
        0,
        (event.clientY ?? 0) - (thumbBox?.top ?? box.top),
      ),
    };
    entry.bar.dataset.dragging = 'true';
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onThumbMove = (event) => {
    if (!drag) return;
    event.preventDefault?.();
    scrollToPoint(event);
  };

  const endDrag = () => {
    if (!drag) return;
    delete drag.bar.dataset.dragging;
    drag = null;
  };

  for (const sheet of sheets) bind(sheet);

  // A sheet whose inner markup arrives later (or that is portalled in) still
  // gets a bar: the rails are watched for children, not just the first boot.
  const MutationObserver = doc.defaultView?.MutationObserver;
  for (const railId of ['left-panel-stack', 'right-context-rail']) {
    const rail = doc.getElementById?.(railId);
    if (!rail || !MutationObserver) continue;
    const observer = new MutationObserver(() => {
      for (const sheet of rail.children ?? []) {
        const entry = bind(sheet);
        if (entry) update(entry);
      }
      updateAll();
    });
    observer.observe(rail, { childList: true });
    observers.push(observer);
  }

  for (const entry of entries) {
    entry.thumb.addEventListener?.('pointerdown', onThumbDown);
    const onClick = () => update(entry);
    entry.sheet.addEventListener?.('click', onClick);
    unlisten.push(() => entry.sheet.removeEventListener?.('click', onClick));
  }
  doc.addEventListener?.('pointermove', onThumbMove, { passive: false });
  doc.addEventListener?.('pointerup', endDrag);
  doc.addEventListener?.('pointercancel', endDrag);
  const onResize = () => updateAll();
  doc.defaultView?.addEventListener?.('resize', onResize);
  const media = doc.defaultView?.matchMedia?.(PANEL_SCROLL_MEDIA);
  media?.addEventListener?.('change', onResize);

  updateAll();

  return {
    entries,
    sync: updateAll,
    destroy() {
      for (const observer of observers) observer.disconnect?.();
      observers.length = 0;
      for (const off of unlisten.splice(0)) off();
      for (const entry of entries) {
        entry.thumb.removeEventListener?.('pointerdown', onThumbDown);
        entry.bar.remove?.();
      }
      entries.length = 0;
      doc.removeEventListener?.('pointermove', onThumbMove, {
        passive: false,
      });
      doc.removeEventListener?.('pointerup', endDrag);
      doc.removeEventListener?.('pointercancel', endDrag);
      doc.defaultView?.removeEventListener?.('resize', onResize);
      media?.removeEventListener?.('change', onResize);
    },
  };
}
