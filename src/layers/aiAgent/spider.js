// The Sentinel orb: a glowing dot that travels the globe.
//
// Two pieces live here, and only the second touches Cesium:
//   - the sprite, drawn procedurally into four glow frames so the pulse needs
//     no image asset and no build step; the halo is a pure function, so a
//     test can pin the pulse without a canvas,
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

/** One pulse cycle in this many sprites. */
export const SPIDER_SPRITE_FRAMES = 4;

/** Sprite box, in pixels; the billboard draws it smaller than this, so the
 *  extra texture buys definition instead of on-globe size. */
export const SPIDER_SPRITE_SIZE = 96;

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

/** The orb's own colour, independent of the severity ring under it. */
const GLOW_CSS = '#3ee6ff';

/** Pulse intensity: 1 is the shipped calm breathing. Below flattens the orb
 *  toward a steady ember, above makes it breathe wider and brighter. The
 *  exported value is clamped into [0, 2] wherever it is used.
 *  @type {number} */
export const PULSE_INTENSITY = 1.3;

const INTENSITY = Math.min(2, Math.max(0, PULSE_INTENSITY));

/** Widest halo, in px: its 1.2 hem factor still fits 46 px (half a 96-px
 *  sprite minus a 2-px margin), so no intensity setting ever clips. */
const MAX_HALO_RADIUS = 38;

/**
 * One pulse frame: halo sizing and brightness, nucleus plus highlight.
 *
 * The pulse is a pure cosine eased through the cycle, read directly by the
 * drawing pass and pinned by a test, so the glow stays gentle: the halo
 * reaches it widest exactly when it is brightest, then settles. No part of
 * the frame leaves the 96-px canvas at the widest stroke, whatever the
 * `PULSE_INTENSITY` dial is turned to.
 *
 * @param {number} frame frame index within the cycle.
 * @param {number} total frames in the cycle.
 * @returns {{haloRadius:number, haloAlpha:number, coreRadius:number, highlightOffset:number}} pixel geometry.
 */
export function orbPulseGeometry(frame, total) {
  const frames = Math.max(1, Math.trunc(total) || 1);
  const phase = (Math.max(0, frame) % frames) / frames;
  const wave = 0.5 - 0.5 * Math.cos(phase * TAU); // 0 calm → 1 peak
  return {
    haloRadius: Math.min(20 + wave * 18 * INTENSITY, MAX_HALO_RADIUS),
    haloAlpha: Math.min(0.9, 0.18 + wave * 0.32 * INTENSITY),
    coreRadius: 6 + wave * 2, // 6 … 8
    highlightOffset: -1.2, // fixed off-centre highlight, never re-centred
  };
}

/** Draw one orb frame into a 2D context, tinted by the orb's colour. */
function drawFrame(ctx, frame, total) {
  const rgb = toRgbTriplet(GLOW_CSS);
  if (!rgb) return;
  const tint = (alpha) => `rgba(${rgb.join(', ')}, ${alpha})`;
  const size = SPIDER_SPRITE_SIZE;
  const centre = size / 2;
  const pulse = orbPulseGeometry(frame, total);
  const sx = pulse.haloRadius / (pulse.coreRadius * 2.4);
  const sy = pulse.haloRadius / (pulse.coreRadius * 3.1);

  // Hem of light: the wide, faint halo first, clamped to the sprite box so
  // the widest stroke never climbs past the canvas edge.
  const hemRadius = Math.min(pulse.haloRadius * 1.2, centre - 2);
  const hem = ctx.createRadialGradient(centre, centre, 0, centre, centre, hemRadius);
  hem.addColorStop(0, tint(pulse.haloAlpha));
  hem.addColorStop(0.55, tint(pulse.haloAlpha * 0.4));
  hem.addColorStop(1, tint(0));
  ctx.fillStyle = hem;
  ctx.beginPath();
  ctx.arc(centre, centre, hemRadius, 0, TAU);
  ctx.fill();

  // Tight glow hugging the nucleus.
  const tight = ctx.createRadialGradient(centre, centre, 0, centre, centre, pulse.haloRadius);
  tight.addColorStop(0, tint(Math.min(1, pulse.haloAlpha * 1.8)));
  tight.addColorStop(0.7, tint(pulse.haloAlpha));
  tight.addColorStop(1, tint(0));
  ctx.fillStyle = tight;
  ctx.beginPath();
  ctx.arc(centre, centre, pulse.haloRadius, 0, TAU);
  ctx.fill();

  // Nucleus: a soft white core with a tinted rim.
  const core = ctx.createRadialGradient(centre + pulse.highlightOffset * sx, centre + pulse.highlightOffset * sy, 0, centre, centre, pulse.coreRadius);
  core.addColorStop(0, 'rgba(255, 255, 255, 0.98)');
  core.addColorStop(0.7, tint(0.92));
  core.addColorStop(1, tint(0.75));
  ctx.strokeStyle = tint(0.25 + pulse.haloAlpha * 0.5);
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.arc(centre, centre, pulse.coreRadius, 0, TAU);
  ctx.fillStyle = core;
  ctx.fill();
  ctx.stroke();
}

/** Parse one hex CSS colour into an `[r, g, b]` triplet, or null. */
function toRgbTriplet(css) {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(css ?? '').trim());
  if (!match) return null;
  return [1, 2, 3].map((i) => Number.parseInt(match[i], 16));
}

/**
 * Render the pulse cycle to PNG data URLs.
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

/** Outward normal at a point: the orb's own "up". */
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
 * The orb's body on the globe.
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
    console.warn('[aiAgent] orb datasource refused:', error);
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
        width: 34,
        height: 34,
        // Rotation is kept: a round orb does not show it, but the walking
        // state stays truthful below the sprite for anything that reads it.
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
    console.warn('[aiAgent] orb body failed:', error);
    try {
      container.remove?.(dataSource, true);
    } catch {
      // A scene being torn down cannot take another removal.
    }
    entity = null;
  }
  if (!entity) return null;

  // One scanning pulse, only while the orb is reading a layer.
  let ring = null;
  if (Cesium.ColorMaterialProperty) {
    const radius = new CallbackProperty(
      () => Math.max(20_000, Number(state.ringRadiusM) || 0),
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
// The inspection note, drawn by the world-overlay host through the injected
// adapter (src/app/layers/overlayHost.js), never a Cesium label.
// ---------------------------------------------------------------------------

/** World-overlay source reserved for the orb's inspection note. */
export const SPIDER_NOTE_SOURCE = 'gev-sentinel-spider-note';

/** Stable entry identity inside that source. */
export const SPIDER_NOTE_ID = 'sentinel-note';

/** Every entry of the note source at once, when the layer is torn down. */
export function destroySpiderNoteOverlay(host = null) {
  if (!host) return;
  try {
    host.clearSource?.(SPIDER_NOTE_SOURCE);
  } catch {
    // The overlay host may already be gone with the page.
  }
}

/**
 * Keep exactly one world-overlay entry carrying what the orb is
 * inspecting. Called whenever the layer writes the note (arrival, moving on,
 * disable); an empty note removes the entry instead of drawing an empty
 * caption. The position is a getter so the caption follows the travelling
 * body without an upsert per frame, and it degrades like every other surface
 * in this layer: a missing host draws nothing and never throws.
 *
 * @param {object} [options]
 * @param {object} [options.state] the layer's orb state (`note`, `severity`,
 *   `latDeg`, `lonDeg`). Read-only here.
 * @param {object} [options.host] the world-overlay adapter handed in by the
 *   application (no import across the package boundary).
 * @param {object} [options.cesium] Cesium module (test seam).
 */
export function syncSpiderNoteOverlay({
  state = {},
  host = null,
  cesium = undefined,
} = {}) {
  const Cesium = cesium ?? CesiumModule;
  const note = String(state?.note ?? '').trim();
  if (!host) return;
  try {
    if (!note) {
      host.removeEntry?.(SPIDER_NOTE_SOURCE, SPIDER_NOTE_ID);
      return;
    }
    const fromDegrees = Cesium?.Cartesian3?.fromDegrees;
    host.upsertEntry?.(SPIDER_NOTE_SOURCE, {
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

export { GLOW_CSS };
