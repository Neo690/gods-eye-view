/**
 * Swipe a sheet away.
 *
 * On a phone an open rail window is a bottom sheet: fixed to the map, starting
 * under the action row, ending above the zoom cluster. It is dismissed by its
 * small collapse button and by Escape — neither of which a thumb reaches
 * comfortably, and neither of which is the gesture the sheet's shape promises.
 * Dragging the sheet down and letting go closes it, the way every bottom sheet
 * on the platform behaves.
 *
 * The gesture starts on the sheet's header, not on its body: the body scrolls
 * on its own, and a panel whose content cannot be scrolled because a finger is
 * dragging the panel is worse than no gesture at all. The header carries no
 * scroller, so it can own the vertical axis outright.
 *
 * The listener sits on the rails, not on the panels: Display is portalled
 * between the rail and the dock, and a panel bound once at boot would stop
 * answering the gesture the first time it moved. A sheet is therefore whatever
 * `.panel-collapsible` is a direct child of a rail at the moment of the touch —
 * which also excludes Context's nested Radio section.
 *
 * The drag is a `transform`, so the sheet follows the finger without the layout
 * reflowing around it, and letting go below the threshold simply settles back.
 */

/** The one breakpoint the sheets exist at; above it the rails keep their chips. */
export const PANEL_SWIPE_MEDIA = '(max-width: 720px)';

/** The two rails whose direct children become sheets on a phone. */
export const PANEL_SHEET_RAILS = Object.freeze([
  'left-panel-stack',
  'right-context-rail',
]);

/** Where a drag may start: the sheet's own header, never its scrolling body. */
export const PANEL_SHEET_HANDLE_SELECTOR = '.panel-header, .pp-header-row';

/** A press has to travel this far before it is a drag rather than a tap. */
const DRAG_THRESHOLD_PX = 6;

/** Shortest pull that dismisses, whatever the sheet's height. */
const MIN_DISMISS_PX = 72;

/** ...or this share of the sheet's height, whichever is larger. */
const DISMISS_FRACTION = 0.3;

/** A quick downward flick dismisses even when the pull was short. */
const FLICK_VELOCITY_PX_PER_MS = 0.55;
const FLICK_MIN_TRAVEL_PX = 24;

/** A click this soon after a drag belongs to the drag, not to the header. */
const CLICK_SUPPRESSION_MS = 350;

/**
 * @param {object} [input]
 * @param {Document} [input.document]
 * @param {(panelId: string, collapsed: boolean, options?: object) => void} input.setPanelCollapsed
 * @param {() => boolean} [input.isMobile]
 * @param {() => number} [input.now] Clock for the flick velocity.
 * @returns {{rails: HTMLElement[], destroy: () => void}|null}
 */
export function createPanelSwipeDismiss({
  document: doc = globalThis.document,
  setPanelCollapsed,
  isMobile = () => !!doc?.defaultView?.matchMedia?.(PANEL_SWIPE_MEDIA)?.matches,
  now = () => Date.now(),
} = {}) {
  if (typeof setPanelCollapsed !== 'function') return null;
  const rails = [];
  for (const id of PANEL_SHEET_RAILS) {
    const rail = doc?.getElementById?.(id);
    if (rail) rails.push(rail);
  }
  if (!rails.length) return null;

  let active = null;
  let dragging = false;
  let startY = 0;
  let startTime = 0;
  let travel = 0;
  let height = 0;
  let suppressClickUntil = 0;

  const setDraw = (el, px) => {
    el.style?.setProperty?.('--sheet-draw', `${px}px`);
  };

  /** Put the sheet back where the layout has it, with the CSS transition. */
  const settle = (el) => {
    delete el.dataset.sheetDragging;
    setDraw(el, 0);
  };

  /**
   * The sheet a touch belongs to, or null. Only a direct child of the rail is
   * a sheet, and only its own header is a handle.
   */
  const sheetFor = (event, rail) => {
    const sheet = event.target?.closest?.('.panel-collapsible');
    if (!sheet || sheet.parentElement !== rail) return null;
    if (sheet.classList.contains('collapsed')) return null;
    const handle = event.target.closest?.(PANEL_SHEET_HANDLE_SELECTOR);
    if (!handle) return null;
    return handle.closest?.('.panel-collapsible') === sheet ? sheet : null;
  };

  const onPointerDown = (event) => {
    if (active) return;
    if (!isMobile()) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const sheet = sheetFor(event, event.currentTarget);
    if (!sheet) return;
    const box = sheet.getBoundingClientRect?.();
    height = box?.height || 0;
    active = sheet;
    dragging = false;
    startY = event.clientY ?? 0;
    startTime = now();
    travel = 0;
  };

  const onPointerMove = (event) => {
    if (!active) return;
    const dy = (event.clientY ?? 0) - startY;
    if (!dragging) {
      // Down is the only direction that dismisses: upward stays whatever the
      // sheet's own content wants it to be.
      if (dy < DRAG_THRESHOLD_PX) return;
      dragging = true;
      active.dataset.sheetDragging = 'true';
    }
    event.preventDefault?.();
    travel = dy;
    setDraw(active, dy);
  };

  const finish = (event, { cancelled = false } = {}) => {
    if (!active) return;
    const sheet = active;
    const wasDragging = dragging;
    const dy = Math.max(
      0,
      event?.clientY != null ? event.clientY - startY : travel,
    );
    active = null;
    dragging = false;
    if (!wasDragging) return;
    const elapsed = Math.max(1, now() - startTime);
    const flick =
      dy >= FLICK_MIN_TRAVEL_PX && dy / elapsed >= FLICK_VELOCITY_PX_PER_MS;
    const pastThreshold =
      dy >= Math.max(MIN_DISMISS_PX, Math.round(height * DISMISS_FRACTION));
    settle(sheet);
    if (cancelled) return;
    suppressClickUntil = now() + CLICK_SUPPRESSION_MS;
    if (pastThreshold || flick)
      setPanelCollapsed(sheet.id, true, { explicit: true });
  };

  const onPointerUp = (event) => finish(event);
  const onPointerCancel = () => finish(null, { cancelled: true });

  /**
   * A drag that ends over the collapse button would otherwise be read as a
   * press on it: the sheet closes from the swipe and opens again from the
   * click. The press is the drag's, so it is swallowed once.
   */
  const onClickCapture = (event) => {
    if (now() > suppressClickUntil) return;
    suppressClickUntil = 0;
    event.preventDefault?.();
    event.stopPropagation?.();
  };

  for (const rail of rails) {
    rail.addEventListener?.('pointerdown', onPointerDown);
    rail.addEventListener?.('click', onClickCapture, true);
  }
  doc.addEventListener?.('pointermove', onPointerMove, { passive: false });
  doc.addEventListener?.('pointerup', onPointerUp);
  doc.addEventListener?.('pointercancel', onPointerCancel);

  return {
    rails,
    destroy() {
      for (const rail of rails) {
        rail.removeEventListener?.('pointerdown', onPointerDown);
        rail.removeEventListener?.('click', onClickCapture, true);
      }
      for (const rail of rails)
        for (const sheet of rail.children || []) {
          delete sheet.dataset?.sheetDragging;
          sheet.style?.setProperty?.('--sheet-draw', '0px');
        }
      doc.removeEventListener?.('pointermove', onPointerMove, {
        passive: false,
      });
      doc.removeEventListener?.('pointerup', onPointerUp);
      doc.removeEventListener?.('pointercancel', onPointerCancel);
      rails.length = 0;
    },
  };
}
