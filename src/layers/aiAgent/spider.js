// The Sentinel spider: a small robot that walks on the globe.
//
// Two pieces live here, and only the second touches Cesium:
//   - the sprite, drawn procedurally into four gait frames so the walk needs
//     no image asset and no build step; the leg pose is a pure function, so a
//     test can pin the gait without a canvas,
//   - the body view: one billboard riding the surface and a scan ring under
//     it. Every property is a CallbackProperty over the layer's own state
//     object, so a frame costs a few reads instead of rebuilding entities.
//     The note naming what is inspected is NOT an entity label graphic —
//     Cesium labels are forbidden (src/noCesiumLabels.test.mjs); it rides the
//     world-overlay host instead via syncSpiderNoteOverlay.
// The view is headless-safe: a viewer without a dataSources container simply
// draws nothing, exactly like the rest of the layer's Cesium surface.
// @module layers/aiAgent/spider

import * as CesiumModule from 'cesium';
import {
  clearOverlaySource,
  removeOverlayEntry,
  upsertOverlayEntry,
} from '../../overlays/worldOverlay.js';

/** One gait cycle in this many sprites. */
export const SPIDER_SPRITE_FRAMES = 4;

/** Sprite box, in pixels; the billboard draws it smaller. */
export const SPIDER_SPRITE_SIZE = 64;

/** Metres above the surface: clear of the ground, still reads as standing on it. */
export const SPIDER_HEIGHT_M = 8_000;

/** Datasource name inside the viewer. */
export const SPIDER_DATA_SOURCE = 'gev-sentinel-spider';

/** Scan-ring colour per severity, matching the rest of the Sentinel chrome. */
const SEVERITY_CSS = Object.freeze({
  info: '#3ee6ff',
  warn: '#ff9a2e',
  emergency: '#ff5030',
});

const TAU = Math.PI * 2;

/**
 * The leg angles of one gait frame.
 *
 * Four legs a side; the two groups alternate, which is what makes a spider
 * read as walking rather than skating. `swing` is the phase of this leg within
 * the cycle (−1 … 1), so a caller drawing the sprite only has to lift the leg
 * while it swings forward and plant it while it pushes back.
 *
 * @param {number} frame frame index within the cycle.
 * @param {number} total frames in the cycle.
 * @param {number} legIndex 0 … 7.
 * @returns {{hip:number, knee:number, foot:number, swing:number}} radians,
 *   relative to the body's forward axis.
 */
export function spiderLegPose(frame, total, legIndex) {
  const frames = Math.max(1, Math.trunc(total) || 1);
  const index = Math.max(0, Math.trunc(legIndex) || 0);
  const paired = index % 2;
  const phase = (Math.max(0, frame) || 0) / frames + paired * 0.5;
  const swing = Math.sin(TAU * phase);
  // Four legs a side fan from just ahead of the shoulders to behind the flank.
  const base = -0.62 + Math.floor(index / 2) * 0.42;
  const side = index % 2 === 0 ? 1 : -1;
  const hip = base + swing * 0.22;
  return {
    hip: side * hip,
    knee: side * (hip + 0.55 + swing * 0.16),
    foot: side * (hip + 1.05 + swing * 0.34),
    swing,
  };
}

/** Draw one robot-spider frame into a 2D context. */
function drawFrame(ctx, frame, total) {
  const size = SPIDER_SPRITE_SIZE;
  const centre = size / 2;
  ctx.clearRect(0, 0, size, size);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Legs first: two segments each, so the joint reads at billboard size.
  for (let leg = 0; leg < 8; leg++) {
    const pose = spiderLegPose(frame, total, leg);
    const hipX = centre + Math.sin(pose.hip) * 6;
    const hipY = centre - Math.cos(pose.hip) * 7;
    const kneeX = centre + Math.sin(pose.knee) * 15;
    const kneeY = centre - Math.cos(pose.knee) * 16;
    const footX = centre + Math.sin(pose.foot) * 25;
    const footY = centre - Math.cos(pose.foot) * 25;
    ctx.strokeStyle = 'rgba(120, 226, 255, 0.92)';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(hipX, hipY);
    ctx.lineTo(kneeX, kneeY);
    ctx.lineTo(footX, footY);
    ctx.stroke();
    // A joint pip keeps the silhouette robotic rather than organic.
    ctx.fillStyle = 'rgba(8, 22, 34, 0.95)';
    ctx.beginPath();
    ctx.arc(kneeX, kneeY, 1.5, 0, TAU);
    ctx.fill();
  }

  // Abdomen behind, cephalothorax in front: the body faces up (−Y).
  ctx.fillStyle = 'rgba(12, 26, 40, 0.96)';
  ctx.strokeStyle = 'rgba(140, 232, 255, 0.9)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.ellipse(centre, centre + 6, 9.5, 11, 0, 0, TAU);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(centre, centre - 8, 7, 7.5, 0, 0, TAU);
  ctx.fill();
  ctx.stroke();

  // Sensor eye: the one part that says "robot" at a glance.
  const blink = (frame + 1) % total === 0 ? 0.45 : 1;
  ctx.fillStyle = `rgba(255, 96, 72, ${blink})`;
  ctx.beginPath();
  ctx.arc(centre, centre - 11, 1.9, 0, TAU);
  ctx.fill();
}

/**
 * Render the gait cycle to PNG data URLs.
 *
 * A document without a 2D canvas (a node test, a headless build) yields an
 * empty list rather than throwing: the layer then runs the watch cycle with
 * no body drawn, which is the same degradation a viewerless run gets.
 *
 * @param {{doc?: Document, frames?: number}} [options]
 * @returns {string[]} one data URL per frame, empty when it cannot draw.
 */
export function spiderSpriteFrames({
  doc = globalThis.document,
  frames = SPIDER_SPRITE_FRAMES,
} = {}) {
  if (!doc?.createElement) return [];
  const total = Math.max(1, Math.trunc(frames) || SPIDER_SPRITE_FRAMES);
  let canvas;
  try {
    canvas = doc.createElement('canvas');
    canvas.width = SPIDER_SPRITE_SIZE;
    canvas.height = SPIDER_SPRITE_SIZE;
  } catch {
    return [];
  }
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return [];
  const urls = [];
  for (let frame = 0; frame < total; frame++) {
    try {
      drawFrame(ctx, frame, total);
      const url = canvas.toDataURL?.('image/png');
      if (typeof url === 'string' && url) urls.push(url);
    } catch {
      return urls;
    }
  }
  return urls;
}

/** Outward normal at a point: the spider's own "up". */
function surfaceUp(Cesium, state) {
  const fromDegrees = Cesium.Cartesian3?.fromDegrees;
  if (typeof fromDegrees !== 'function') return undefined;
  const position = fromDegrees(state.lonDeg, state.latDeg, 0);
  const normal = Cesium.Cartesian3?.normalize?.(
    position,
    new Cesium.Cartesian3(),
  );
  return normal || undefined;
}

/**
 * The spider's body on the globe.
 *
 * @param {object} options
 * @param {object} options.viewer a Cesium viewer (or a double).
 * @param {object} options.state the layer's live state: `latDeg`, `lonDeg`,
 *   `headingRad`, `frame`, `visible`, `scanning`, `ringRadiusM`, `note`,
 *   `severity`. The view reads it every frame and never writes to it.
 * @param {string[]} [options.frames] sprite data URLs, from spiderSpriteFrames.
 * @param {object} [options.cesium] Cesium module (test seam).
 * @returns {{destroy:Function, entity:object}|null} null when the scene cannot
 *   host it — never a throw.
 */
export function createSpiderBody({
  viewer = undefined,
  state = {},
  frames = [],
  cesium = undefined,
} = {}) {
  const Cesium = cesium ?? CesiumModule;
  const container = viewer?.dataSources;
  if (!Cesium || !container || typeof container.add !== 'function') return null;
  const CallbackProperty = Cesium.CallbackProperty;
  const CustomDataSource = Cesium.CustomDataSource;
  const fromDegrees = Cesium.Cartesian3?.fromDegrees;
  const toColor = Cesium.Color?.fromCssColorString;
  if (
    typeof CallbackProperty !== 'function' ||
    typeof CustomDataSource !== 'function' ||
    typeof fromDegrees !== 'function' ||
    typeof toColor !== 'function'
  )
    return null;

  const colourFor = (severity) =>
    toColor(SEVERITY_CSS[severity] || SEVERITY_CSS.info);

  const dataSource = new CustomDataSource(SPIDER_DATA_SOURCE);
  try {
    const added = container.add(dataSource);
    if (typeof added?.catch === 'function') added.catch(() => {});
  } catch (error) {
    console.warn('[aiAgent] spider datasource refused:', error);
    return null;
  }

  const grounded = () =>
    fromDegrees(Number(state.lonDeg) || 0, Number(state.latDeg) || 0, 0);

  // The body rides a little above the surface so the globe's depth buffer
  // never eats it; the scan ring stays flat on the ground.
  const bodyPosition = new CallbackProperty(
    () =>
      fromDegrees(
        Number(state.lonDeg) || 0,
        Number(state.latDeg) || 0,
        SPIDER_HEIGHT_M,
      ),
    false,
  );
  const up = new CallbackProperty(() => surfaceUp(Cesium, state), false);
  const heading = new CallbackProperty(
    () => Number(state.headingRad) || 0,
    false,
  );
  const frame = new CallbackProperty(
    () => frames[state.frame % frames.length] ?? frames[0],
    false,
  );
  const visible = new CallbackProperty(() => state.visible === true, false);

  let entity = null;
  try {
    entity = dataSource.entities.add({
      position: bodyPosition,
      billboard: {
        image: frame,
        width: 46,
        height: 46,
        rotation: heading,
        ...(up ? { alignedAxis: up } : {}),
        disableDepthTestDistance: 0,
        ...(Cesium.NearFarScalar
          ? {
              scaleByDistance: new Cesium.NearFarScalar(2e5, 2.1, 5e7, 0.7),
            }
          : {}),
      },
    });
  } catch (error) {
    console.warn('[aiAgent] spider body failed:', error);
    try {
      container.remove?.(dataSource, true);
    } catch {
      // A scene being torn down cannot take another removal.
    }
    entity = null;
  }
  if (!entity) return null;

  // One scanning pulse, only while the spider is reading a layer.
  let ring = null;
  if (Cesium.ColorMaterialProperty) {
    const radius = new CallbackProperty(
      () => Math.max(40_000, Number(state.ringRadiusM) || 0),
      false,
    );
    try {
      ring = dataSource.entities.add({
        position: new CallbackProperty(() => grounded(), false),
        show: new CallbackProperty(() => state.scanning === true, false),
        ellipse: {
          semiMajorAxis: radius,
          semiMinorAxis: radius,
          material: new Cesium.ColorMaterialProperty(
            new CallbackProperty(
              () => colourFor(state.severity).withAlpha(0.32),
              false,
            ),
          ),
        },
      });
    } catch (error) {
      console.warn('[aiAgent] scan ring failed:', error);
      ring = null;
    }
  }

  return {
    entity,
    ring,
    destroy() {
      try {
        const removed = container.remove?.(dataSource, true);
        if (typeof removed?.catch === 'function') removed.catch(() => {});
      } catch {
        // The scene may already be gone with the page.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The inspection note, drawn by the world-overlay host, never a Cesium label.
// ---------------------------------------------------------------------------

/** World-overlay source reserved for the spider's inspection note. */
export const SPIDER_NOTE_SOURCE = 'gev-sentinel-spider-note';

/** Stable entry identity inside that source. */
export const SPIDER_NOTE_ID = 'sentinel-note';

/** Every entry of the note source at once, when the layer is torn down. */
export function destroySpiderNoteOverlay() {
  try {
    clearOverlaySource(SPIDER_NOTE_SOURCE);
  } catch {
    // The overlay host may already be gone with the page.
  }
}

/**
 * Keep exactly one world-overlay entry carrying what the spider is
 * inspecting. Called whenever the layer writes the note (arrival, moving on,
 * disable); an empty note removes the entry instead of drawing an empty
 * caption. The position is a getter so the caption follows the walking body
 * without an upsert per frame, and it degrades like every other surface in
 * this layer: a missing host draws nothing and never throws.
 *
 * @param {object} [options]
 * @param {object} [options.state] the layer's spider state (`note`, `severity`,
 *   `latDeg`, `lonDeg`). Read-only here.
 * @param {object} [options.cesium] Cesium module (test seam).
 */
export function syncSpiderNoteOverlay({ state = {}, cesium = undefined } = {}) {
  const Cesium = cesium ?? CesiumModule;
  const note = String(state?.note ?? '').trim();
  try {
    if (!note) {
      removeOverlayEntry(SPIDER_NOTE_SOURCE, SPIDER_NOTE_ID);
      return;
    }
    const fromDegrees = Cesium?.Cartesian3?.fromDegrees;
    upsertOverlayEntry(SPIDER_NOTE_SOURCE, {
      id: SPIDER_NOTE_ID,
      position: () =>
        typeof fromDegrees === 'function'
          ? fromDegrees(
              Number(state.lonDeg) || 0,
              Number(state.latDeg) || 0,
              SPIDER_HEIGHT_M,
            )
          : undefined,
      title: note,
      accent: SEVERITY_CSS[state?.severity] ?? SEVERITY_CSS.info,
    });
  } catch {
    // A host being torn down cannot take an entry; the card still reports it.
  }
}
