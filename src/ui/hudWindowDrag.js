/**
 * Finger-draggable HUD windows.
 *
 * The three readouts on the map — classification, MGRS, telemetry — are placed
 * by the layout: one at the top, two in a centred column above the credits. On
 * a phone that is a good default and a bad constant: the classification window
 * covers exactly the part of the imagery an operator wants to look at, and the
 * telemetry column sits over the street names they are reading. Each window
 * can be moved by finger and stays where it was put, across reloads and
 * locale switches.
 *
 * The offset is a translation, not a new layout position: the windows keep
 * their anchors, their stacking order and their halo, and a `transform` is the
 * only thing that moves. That also means a stored offset can be clamped back
 * inside the viewport at any time — after a rotation, a keyboard opening, or a
 * URL bar collapsing — without the layout having to know about it.
 *
 * Only phones move them (the same breakpoint as the mobile shell): a desktop
 * keeps its corner anchors, and a stored offset is simply not applied there.
 */

/** Versioned storage key: a layout change can retire it wholesale. */
export const HUD_WINDOW_DRAG_STORAGE_KEY = 'gev.hud-window-offsets.v1';

/** The breakpoint the offsets apply at; above it the windows keep their corners. */
export const HUD_WINDOW_DRAG_MEDIA = '(max-width: 720px)';

/** One entry per movable window, in the order they are reported. */
export const HUD_WINDOW_DRAG_SPECS = Object.freeze([
  Object.freeze({ id: 'top-left', selector: '.hud-top-left' }),
  Object.freeze({ id: 'bottom-left', selector: '.hud-bottom-left' }),
  Object.freeze({ id: 'bottom-right', selector: '.hud-bottom-right' }),
]);

/** A press has to travel this far before it counts as a drag, not a tap. */
const DRAG_THRESHOLD_PX = 4;

/** A window is never allowed to end flush against the screen edge. */
const EDGE_MARGIN_PX = 4;

/** Two taps inside this window (and this far apart) put a window back. */
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_SLOP_PX = 24;

/**
 * Make the HUD windows draggable on a phone and remember where they were left.
 *
 * @param {object} [input]
 * @param {Document} [input.document]
 * @param {{getItem: Function, setItem: Function}|null} [input.storage]
 *   Durable storage; localStorage by default, and a failure to read or write
 *   only costs the memory of the position.
 * @param {() => boolean} [input.isMobile] Whether the offsets apply right now.
 * @param {() => {width: number, height: number}} [input.viewport]
 * @returns {{sync: () => void, reset: () => void, destroy: () => void, windows: object[], element: HTMLElement}|null}
 */
export function createHudWindowDrag({
  document: doc = globalThis.document,
  storage = readDefaultStorage(),
  isMobile = () =>
    !!doc?.defaultView?.matchMedia?.(HUD_WINDOW_DRAG_MEDIA)?.matches,
  viewport = () => ({
    width: doc?.defaultView?.innerWidth ?? 0,
    height: doc?.defaultView?.innerHeight ?? 0,
  }),
} = {}) {
  const hud = doc?.getElementById?.('intel-hud');
  if (!hud || typeof hud.querySelector !== 'function') return null;

  const windows = [];
  for (const spec of HUD_WINDOW_DRAG_SPECS) {
    const el = hud.querySelector(spec.selector);
    if (el) windows.push({ id: spec.id, el, x: 0, y: 0 });
  }
  if (!windows.length) return null;
  const byElement = new Map(windows.map((entry) => [entry.el, entry]));

  const offsets = readOffsets(storage);
  let active = null;
  let dragging = false;
  let startPoint = null;
  let startOffset = null;
  let baseRect = null;
  let lastTap = null;

  /** Write one window's translate; the CSS owns the actual transform. */
  const apply = (entry) => {
    const style = entry.el.style;
    if (!style?.setProperty) return;
    style.setProperty('--hud-window-dx', `${entry.x}px`);
    style.setProperty('--hud-window-dy', `${entry.y}px`);
    entry.el.dataset.hudMoved = entry.x || entry.y ? 'true' : 'false';
  };

  /** Keep a translation inside the viewport, given the window's own box. */
  const clampTo = (box, x, y) => {
    const { width, height } = viewport();
    const minX = EDGE_MARGIN_PX - box.left;
    const maxX = width - EDGE_MARGIN_PX - box.width - box.left;
    const minY = EDGE_MARGIN_PX - box.top;
    const maxY = height - EDGE_MARGIN_PX - box.height - box.top;
    const inside = (value, min, max) =>
      min > max ? min : Math.min(Math.max(value, min), max);
    return { x: inside(x, minX, maxX), y: inside(y, minY, maxY) };
  };

  /**
   * The window's box with its translation undone. A window is moved only by
   * its own offset, so the measured box minus that offset is where the layout
   * put it — the reference a clamp has to work against.
   */
  const restingBox = (entry) => {
    const rect = entry.el.getBoundingClientRect?.();
    if (!rect?.width || !rect?.height) return null;
    return {
      left: rect.left - entry.x,
      top: rect.top - entry.y,
      width: rect.width,
      height: rect.height,
    };
  };

  /** Restore every stored offset, clamped to the viewport we are on now. */
  const sync = () => {
    const mobile = !!isMobile();
    let clampedAny = false;
    for (const entry of windows) {
      if (!mobile) {
        entry.x = 0;
        entry.y = 0;
        entry.el.style?.setProperty?.('--hud-window-dx', '0px');
        entry.el.style?.setProperty?.('--hud-window-dy', '0px');
        entry.el.dataset.hudMoved = 'false';
        continue;
      }
      // Measured before the new value is written: the box reflects the offset
      // that is on screen now, which is the only one it can be un-done with.
      const box = restingBox(entry);
      const stored = offsets[entry.id];
      const wanted = {
        x: Number.isFinite(stored?.x) ? stored.x : 0,
        y: Number.isFinite(stored?.y) ? stored.y : 0,
      };
      const target = box ? clampTo(box, wanted.x, wanted.y) : wanted;
      if (target.x !== wanted.x || target.y !== wanted.y) {
        offsets[entry.id] = { x: target.x, y: target.y };
        clampedAny = true;
      }
      entry.x = target.x;
      entry.y = target.y;
      apply(entry);
    }
    if (clampedAny) writeOffsets(storage, offsets);
  };

  /** Put one window back on its layout spot, and forget the offset. */
  const resetWindow = (entry) => {
    entry.x = 0;
    entry.y = 0;
    delete offsets[entry.id];
    writeOffsets(storage, offsets);
    apply(entry);
  };

  const reset = () => {
    for (const entry of windows) resetWindow(entry);
  };

  const onPointerDown = (event) => {
    if (!isMobile()) return;
    if (active) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const entry = byElement.get(event.currentTarget);
    if (!entry) return;
    const box = restingBox(entry);
    if (!box) return;
    active = entry;
    dragging = false;
    baseRect = box;
    startPoint = { x: event.clientX, y: event.clientY };
    startOffset = { x: entry.x, y: entry.y };
  };

  const onPointerMove = (event) => {
    if (!active) return;
    const dx = event.clientX - startPoint.x;
    const dy = event.clientY - startPoint.y;
    if (!dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      active.el.dataset.hudDragging = 'true';
    }
    // The gesture belongs to the window now: no text selection, no panning.
    event.preventDefault?.();
    const clamped = clampTo(baseRect, startOffset.x + dx, startOffset.y + dy);
    active.x = clamped.x;
    active.y = clamped.y;
    apply(active);
  };

  const endDrag = (event) => {
    if (!active) return;
    const entry = active;
    const wasDragging = dragging;
    delete entry.el.dataset.hudDragging;
    active = null;
    dragging = false;
    if (wasDragging) {
      if (entry.x || entry.y) offsets[entry.id] = { x: entry.x, y: entry.y };
      else delete offsets[entry.id];
      writeOffsets(storage, offsets);
      return;
    }
    // A tap that did not move: two of them in the same spot put the window
    // back where the layout wanted it, which is the only way out of a corner
    // someone dragged it into by accident.
    const point = { x: event?.clientX ?? 0, y: event?.clientY ?? 0 };
    const previous = lastTap;
    lastTap = { ...point, at: Date.now(), id: entry.id };
    if (
      previous &&
      previous.id === entry.id &&
      lastTap.at - previous.at <= DOUBLE_TAP_MS &&
      Math.hypot(point.x - previous.x, point.y - previous.y) <=
        DOUBLE_TAP_SLOP_PX
    ) {
      lastTap = null;
      resetWindow(entry);
    }
  };

  const onPointerCancel = () => {
    if (!active) return;
    delete active.el.dataset.hudDragging;
    active = null;
    dragging = false;
  };

  for (const entry of windows) {
    entry.el.addEventListener?.('pointerdown', onPointerDown);
  }
  doc.addEventListener?.('pointermove', onPointerMove, { passive: false });
  doc.addEventListener?.('pointerup', endDrag);
  doc.addEventListener?.('pointercancel', onPointerCancel);

  // A rotation or a URL bar collapsing changes the viewport under a stored
  // offset; the windows are pulled back in rather than left half off-screen.
  const onResize = () => sync();
  doc.defaultView?.addEventListener?.('resize', onResize);
  const media = doc.defaultView?.matchMedia?.(HUD_WINDOW_DRAG_MEDIA);
  media?.addEventListener?.('change', onResize);

  sync();

  return {
    element: hud,
    windows,
    sync,
    reset,
    destroy() {
      for (const entry of windows) {
        entry.el.removeEventListener?.('pointerdown', onPointerDown);
        delete entry.el.dataset.hudDragging;
      }
      doc.removeEventListener?.('pointermove', onPointerMove, {
        passive: false,
      });
      doc.removeEventListener?.('pointerup', endDrag);
      doc.removeEventListener?.('pointercancel', onPointerCancel);
      doc.defaultView?.removeEventListener?.('resize', onResize);
      media?.removeEventListener?.('change', onResize);
      windows.length = 0;
    },
  };
}

/**
 * localStorage without trusting it: Safari's private mode throws on write, and
 * a position is not worth breaking a boot over.
 */
function readDefaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** @returns {Record<string, {x: number, y: number}>} */
function readOffsets(storage) {
  try {
    const raw = storage?.getItem?.(HUD_WINDOW_DRAG_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    const offsets = {};
    for (const spec of HUD_WINDOW_DRAG_SPECS) {
      const value = parsed[spec.id];
      if (!value || typeof value !== 'object') continue;
      const x = Number(value.x);
      const y = Number(value.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      offsets[spec.id] = { x, y };
    }
    return offsets;
  } catch {
    return {};
  }
}

function writeOffsets(storage, offsets) {
  try {
    storage?.setItem?.(HUD_WINDOW_DRAG_STORAGE_KEY, JSON.stringify(offsets));
  } catch {
    /* a full or blocked storage keeps the offsets in memory only */
  }
}
