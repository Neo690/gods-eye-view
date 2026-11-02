/**
 * The face boxes, drawn — and blurred — over the frame they were read from.
 *
 * A face count in a row says how many people the detector saw; it does not
 * say where, and an operator about to share a screen cannot tell which
 * pixels to crop. This module puts the detector's own boxes back on the
 * picture the detector looked at, blurred, so the audience sees people
 * without seeing them.
 *
 * The geometry is the plate reader's (`../alprReader/overlay.js`): the panel
 * shows the frame through `object-fit: contain`, so mapping one box is one
 * scale and one offset — the same `containFrame` arithmetic, imported, and
 * the frame's `width`/`height` and each face's `box` arrive in the same
 * pixels from `/api/face/analyze`.
 *
 * The drawing is decoration: it is `aria-hidden`, carries no label of its
 * own, and blurs rather than labels — a name on a face is an identity claim
 * this layer does not make. The row first says the count out loud.
 * @module layers/facePrivacy/overlay
 */
import { containFrame } from '../alprReader/overlay.js';

/** Id of the blur layer inside the CCTV frame. */
export const FACE_OVERLAY_ID = 'cctv-face-overlay';

/** Class of one blurred detector box. */
export const FACE_BLUR_CLASS = 'cctv-face-blur';

/** A box needs this much room before shrinking annoys more than it helps. */
const MIN_BOX_PX = 4;

/**
 * One rectangle per face, positioned inside the viewport.
 *
 * A face the server answered without a box (or with a degenerate one) is
 * skipped: it is still in the count, there is just nothing to blur.
 *
 * @param {{frame?:object, faces?:Array<object>}} answer A face analysis answer.
 * @param {{width:number, height:number}} viewport The displayed frame's box.
 * @returns {Array<{left:number, top:number, width:number, height:number}>}
 *   Rectangles in viewport pixels, best first.
 */
export function faceRects(answer, viewport) {
  const fit = containFrame(answer?.frame, viewport);
  if (!fit) return [];
  const rects = [];
  for (const face of answer.faces || []) {
    const box = usableBox(face?.box);
    if (!box) continue;
    rects.push({
      left: fit.left + box.x1 * fit.scale,
      top: fit.top + box.y1 * fit.scale,
      width: (box.x2 - box.x1) * fit.scale,
      height: (box.y2 - box.y1) * fit.scale,
    });
  }
  return rects;
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

/** CSS pixels, to one decimal: sub-pixel blur boundaries read as bands. */
const px = (value) => `${Math.round(value * 10) / 10}px`;

/**
 * Mount the blur boxes over the CCTV frame, and keep them there.
 *
 * Lazily mounted like the plate overlay, so a build without the CCTV panel
 * (a test, an embedded panel) still constructs the layer: a missing host is
 * a no-op rather than a throw.
 *
 * @param {object} [options]
 * @param {Document} [options.documentRef]
 * @param {typeof globalThis.ResizeObserver} [options.ResizeObserverImpl]
 * @returns {{show:Function, clear:Function, destroy:Function}}
 */
export function createFaceOverlay({
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
    overlay.id = FACE_OVERLAY_ID;
    overlay.className = 'cctv-face-overlay';
    // Decoration, not an answer: the row carries the count for a reader,
    // and blurring must never become a second name for a first person.
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

  /** Put the blur of the current answer on screen, remeasuring as it goes. */
  function render() {
    if (destroyed || !answer) return;
    const host = wrap();
    const box = mount(host);
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
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
    // around this layer, and measuring from the border box would shift every
    // blur by that much (6 px of frame at a 1920 px still).
    const origin = measure(box)?.rect ?? wrapRect.rect;
    const viewport = { width: mediaRect.width, height: mediaRect.height };
    const offsetLeft = mediaRect.rect.left - origin.left;
    const offsetTop = mediaRect.rect.top - origin.top;
    for (const rect of faceRects(answer, viewport)) {
      const span = documentRef.createElement('span');
      span.className = FACE_BLUR_CLASS;
      span.style.position = 'absolute';
      span.style.left = px(offsetLeft + rect.left);
      span.style.top = px(offsetTop + rect.top);
      span.style.width = px(Math.max(rect.width, MIN_BOX_PX));
      span.style.height = px(Math.max(rect.height, MIN_BOX_PX));
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
     * Blur one answer's faces.
     *
     * @param {{cameraId?:string, frame?:object, faces?:Array<object>}} next
     */
    show(next) {
      if (destroyed) return;
      answer = next && Array.isArray(next.faces) ? next : null;
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
