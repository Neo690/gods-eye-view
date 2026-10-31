/**
 * The plate boxes, drawn over the frame they were read from.
 *
 * A plate string in a row says what the reader saw; it does not say where, and
 * an operator looking at a junction full of cars cannot tell which one was
 * read. This module puts the detector's own boxes back on the picture the
 * detector looked at, so the answer can be checked by eye against the frame.
 *
 * The server already answers with what is needed: `frame` is the size of the
 * image it decoded and each plate's `box` is in that image's pixels. The panel
 * shows that same still through `object-fit: contain`, so mapping a box is one
 * scale and one offset — no image is re-fetched and no plate is looked at twice.
 *
 * The drawing is decoration: it is `aria-hidden`, carries no tooltip, and adds
 * no text of its own. The row above it already says the plates out loud, so a
 * screen reader reads the answer once rather than twice.
 *
 * A box stays until the next read, another camera or the layer going off — it
 * is not re-measured against the picture, because the panel refreshes a still
 * every few seconds and a plate's car moves with it. The row's own "same
 * frame" age is what says how old the answer is; the boxes say where it was.
 * @module layers/alprReader/overlay
 */

/** Id of the box layer inside the CCTV frame. */
export const PLATE_OVERLAY_ID = 'cctv-plate-overlay';

/** Class of one detector box. */
export const PLATE_BOX_CLASS = 'cctv-plate-box';

/** Class of the plate text drawn with its box. */
export const PLATE_LABEL_CLASS = 'cctv-plate-box-label';

/** A label needs this much room above its box before it can sit outside it. */
const LABEL_ROOM_PX = 11;

/**
 * Where an image of `frame` size lands inside a `viewport` that contains it.
 *
 * This is `object-fit: contain` as arithmetic: the whole frame is shown, scaled
 * by the tighter of the two axes, and the spare room is split evenly. It
 * returns null rather than a guess when either size is unusable, because a box
 * drawn from a made-up viewport is worse than no box.
 *
 * @param {{width:number, height:number}} frame Decoded frame size, in pixels.
 * @param {{width:number, height:number}} viewport Box the frame is drawn in,
 *   in CSS pixels.
 * @returns {{scale:number, left:number, top:number, width:number,
 *   height:number}|null} The frame's rect inside the viewport.
 */
export function containFrame(frame, viewport) {
  const frameWidth = Number(frame?.width);
  const frameHeight = Number(frame?.height);
  const viewWidth = Number(viewport?.width);
  const viewHeight = Number(viewport?.height);
  if (!(frameWidth > 0) || !(frameHeight > 0)) return null;
  if (!(viewWidth > 0) || !(viewHeight > 0)) return null;
  const scale = Math.min(viewWidth / frameWidth, viewHeight / frameHeight);
  const width = frameWidth * scale;
  const height = frameHeight * scale;
  return {
    scale,
    left: (viewWidth - width) / 2,
    top: (viewHeight - height) / 2,
    width,
    height,
  };
}

/** A detector box with a usable area, in frame pixels. */
function usableBox(box) {
  const x1 = Number(box?.x1);
  const y1 = Number(box?.y1);
  const x2 = Number(box?.x2);
  const y2 = Number(box?.y2);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  if (x2 - x1 < 1 || y2 - y1 < 1) return null;
  return { x1, y1, x2, y2 };
}

/**
 * One rectangle per plate, positioned inside the viewport.
 *
 * A plate the server answered without a box (or with a degenerate one) is
 * skipped: its text is still in the row, there is just nothing to point at.
 *
 * @param {{frame?:object, plates?:Array<object>}} answer A plate reader answer.
 * @param {{width:number, height:number}} viewport The displayed frame's box.
 * @returns {Array<{text:string, left:number, top:number, width:number,
 *   height:number, outside:boolean}>} Rectangles in viewport pixels, best
 *   first, `outside` set when there is no room to label above the box.
 */
export function plateRects(answer, viewport) {
  const fit = containFrame(answer?.frame, viewport);
  if (!fit) return [];
  const rects = [];
  for (const plate of answer.plates || []) {
    const box = usableBox(plate?.box);
    if (!box) continue;
    const left = fit.left + box.x1 * fit.scale;
    const top = fit.top + box.y1 * fit.scale;
    const width = (box.x2 - box.x1) * fit.scale;
    const height = (box.y2 - box.y1) * fit.scale;
    rects.push({
      text: typeof plate.text === 'string' ? plate.text.trim() : '',
      left,
      top,
      width,
      height,
      outside: top >= LABEL_ROOM_PX,
    });
  }
  return rects;
}

/** CSS pixels, to one decimal: sub-pixel text is noise on a 300 px panel. */
const px = (value) => `${Math.round(value * 10) / 10}px`;

/**
 * Mount the plate boxes over the CCTV frame, and keep them there.
 *
 * The overlay is created with the layer and mounted lazily: the CCTV panel is
 * in the page from the start, but a build without it (an embedded panel, a
 * test) must still construct the layer, so a missing host is a no-op rather
 * than a throw. Sizes are measured, never assumed: the frame is `contain`ed in
 * a box whose height follows the image, and a phone turns that box on its side.
 *
 * @param {object} [options]
 * @param {Document} [options.documentRef]
 * @param {typeof globalThis.ResizeObserver} [options.ResizeObserverImpl]
 * @returns {{show:Function, clear:Function, destroy:Function}}
 */
export function createPlateOverlay({
  documentRef = globalThis.document,
  ResizeObserverImpl = globalThis.ResizeObserver,
} = {}) {
  if (!documentRef?.createElement || !documentRef?.getElementById)
    return { show() {}, clear() {}, destroy() {} };

  let answer = null;
  let overlay = null;
  let attachedTo = null;
  let media = null;
  let observer = null;
  let destroyed = false;

  const wrap = () => documentRef.getElementById('cctv-frame-wrap');

  /** The picture on show: the live canvas when it is up, else the still. */
  const mediaFor = () => {
    const canvas = documentRef.getElementById('cctv-video');
    if (canvas && !canvas.hidden) return canvas;
    return documentRef.getElementById('cctv-frame') || canvas || null;
  };

  const measure = (element) => {
    const rect = element?.getBoundingClientRect?.();
    if (!rect) return null;
    return { rect, width: rect.width, height: rect.height };
  };

  const detach = () => {
    observer?.disconnect?.();
    observer = null;
    media?.removeEventListener?.('load', render);
    media = null;
    overlay?.remove?.();
    overlay = null;
    attachedTo = null;
  };

  const mount = (host) => {
    if (!host) return null;
    if (overlay && attachedTo === host) return overlay;
    detach();
    overlay = documentRef.createElement('div');
    overlay.id = PLATE_OVERLAY_ID;
    overlay.className = 'cctv-plate-overlay';
    // Decoration, not an answer: the row carries the plates for a reader.
    overlay.setAttribute('aria-hidden', 'true');
    host.append(overlay);
    attachedTo = host;
    if (typeof ResizeObserverImpl === 'function') {
      observer = new ResizeObserverImpl(() => render());
      observer.observe?.(host);
    }
    media = mediaFor();
    media?.addEventListener?.('load', render);
    return overlay;
  };

  /** Put the boxes of the current answer on screen, remeasuring as it goes. */
  function render() {
    if (destroyed || !answer) return;
    const host = wrap();
    const box = mount(host);
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    // The picture can change under a mounted overlay (a new camera, a live
    // feed): watch whatever is displayed now.
    const current = mediaFor();
    if (current && current !== media) {
      media?.removeEventListener?.('load', render);
      media = current;
      media.addEventListener?.('load', render);
    }
    const wrapRect = measure(host);
    const mediaRect = measure(current);
    if (!wrapRect || !mediaRect) return;
    // The overlay's own origin, not the wrap's: the wrap draws a 1 px border
    // around this layer, and measuring from the border box would push every
    // box that far off the picture (6 px of frame at a 1920 px still).
    const origin = measure(box)?.rect ?? wrapRect.rect;
    const viewport = { width: mediaRect.width, height: mediaRect.height };
    const offsetLeft = mediaRect.rect.left - origin.left;
    const offsetTop = mediaRect.rect.top - origin.top;
    for (const rect of plateRects(answer, viewport)) {
      const span = documentRef.createElement('span');
      span.className = PLATE_BOX_CLASS;
      span.style.position = 'absolute';
      span.style.left = px(offsetLeft + rect.left);
      span.style.top = px(offsetTop + rect.top);
      span.style.width = px(Math.max(rect.width, 2));
      span.style.height = px(Math.max(rect.height, 2));
      if (rect.text) {
        const label = documentRef.createElement('span');
        label.className = PLATE_LABEL_CLASS;
        label.textContent = rect.text;
        // Above the box by default; inside it when the plate is against the
        // top of the frame, where a label outside would be clipped away.
        label.style.top = rect.outside ? '-1px' : '1px';
        label.style.transform = rect.outside ? 'translateY(-100%)' : 'none';
        span.append(label);
      }
      box.append(span);
    }
  }

  /** Drop the answer and everything drawn from it. */
  function clear() {
    answer = null;
    detach();
  }

  return {
    /**
     * Draw one answer's boxes.
     *
     * @param {{cameraId?:string, frame?:object, plates?:Array<object>}} next
     */
    show(next) {
      if (destroyed) return;
      answer = next && Array.isArray(next.plates) ? next : null;
      if (!answer) {
        clear();
        return;
      }
      render();
    },

    clear,

    destroy() {
      destroyed = true;
      clear();
    },
  };
}
