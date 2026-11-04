// Sentinel patrol geometry and inspection ranking.
//
// The spider walks the globe: its body is a point on the ellipsoid that moves
// along a great circle toward one inspection target at a time, turning toward
// the new bearing at a bounded rate so the walk reads as a creature rather
// than a teleport. All public coordinates are degrees; the trigonometry works
// in radians and converts at the boundary, so a caller never has to remember
// which unit it holds.
//
// The ranking is deterministic — severity first, then feed health, freshness,
// distance and how recently the spider already looked at that layer. Nothing
// here calls a model, reads a clock of its own or touches the DOM: the layer
// passes `now` and the visited book in, so a test can pin the whole decision.
// @module layers/aiAgent/patrol

/** Surface speed while walking, as an angle: ~0.09 rad ≈ 570 km per second. */
export const CRUISE_RAD_PER_S = 0.09;

/** How fast the body swings onto a new bearing (radians per second). */
export const TURN_RAD_PER_S = 1.6;

/** Close enough to call it arrived (~0.012 rad ≈ 76 km of arc). */
export const ARRIVE_RAD = 0.012;

/** The spider sits still on a finished inspection before walking on. */
export const SCAN_MS = 4500;

/** A pause between inspections, so the globe is not in constant motion. */
export const REST_MS = 5000;

/** A layer event this recent still pulls the spider. */
export const FRESH_EVENT_MS = 5 * 60 * 1000;

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/** Degrees → radians. */
export const toRadians = (degrees) => Number(degrees) * DEG;

/** Radians → degrees. */
export const toDegrees = (radians) => Number(radians) / DEG;

/** Fold any angle into [0, 2π). */
export function normalizeHeading(radians) {
  const value = Number(radians);
  if (!Number.isFinite(value)) return 0;
  return ((value % TAU) + TAU) % TAU;
}

/** The smallest signed rotation that takes `from` onto `to`, in (−π, π]. */
export function shortestTurn(from, to) {
  let delta = normalizeHeading(to) - normalizeHeading(from);
  if (delta > Math.PI) delta -= TAU;
  if (delta <= -Math.PI) delta += TAU;
  return delta;
}

/** Central angle between two points, in radians (0 … π). */
export function angularDistance(from, to) {
  const lat1 = toRadians(from?.latDeg);
  const lat2 = toRadians(to?.latDeg);
  const dLon = toRadians(Number(to?.lonDeg) - Number(from?.lonDeg));
  if (![lat1, lat2, dLon].every(Number.isFinite)) return Number.NaN;
  const sinLat = Math.sin((lat2 - lat1) / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from `from` to `to`, in radians clockwise from north. */
export function bearingBetween(from, to) {
  const lat1 = toRadians(from?.latDeg);
  const lat2 = toRadians(to?.latDeg);
  const dLon = toRadians(Number(to?.lonDeg) - Number(from?.lonDeg));
  if (![lat1, lat2, dLon].every(Number.isFinite)) return 0;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return normalizeHeading(Math.atan2(y, x));
}

/** The point `angle` radians along `bearing` from `from`, in degrees. */
export function destinationPoint(from, bearing, angle) {
  const lat1 = toRadians(from?.latDeg);
  const lon1 = toRadians(from?.lonDeg);
  const distance = Math.max(0, Number(angle) || 0);
  if (![lat1, lon1, distance].every(Number.isFinite)) return null;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(distance) +
      Math.cos(lat1) * Math.sin(distance) * Math.cos(bearing),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(distance) * Math.cos(lat1),
      Math.cos(distance) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { latDeg: toDegrees(lat2), lonDeg: wrapLongitude(toDegrees(lon2)) };
}

/** Longitude folded into [−180, 180), so a walk across the dateline is sane. */
export function wrapLongitude(degrees) {
  const value = Number(degrees);
  if (!Number.isFinite(value)) return 0;
  return ((((value + 180) % 360) + 360) % 360) - 180;
}

/** Keep a number inside a range. */
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * One walking step.
 *
 * The body turns toward the target at no more than `turn` radians this step,
 * then walks `speed × dt` radians along the bearing it now faces — so a turn
 * traces an arc instead of a corner. A step that would reach or pass the
 * target lands exactly on it, which is what keeps the walk from orbiting.
 *
 * @param {{latDeg:number, lonDeg:number, headingRad:number}} state where the
 *   spider stands and which way it faces (radians clockwise from north).
 * @param {{latDeg:number, lonDeg:number}} target the point to walk to.
 * @param {number} dtSec seconds elapsed since the previous step.
 * @param {{speed?:number, turn?:number, arrive?:number}} [limits]
 * @returns {{latDeg:number, lonDeg:number, headingRad:number,
 *   travelledRad:number, arrived:boolean}}
 */
export function stepPatrol(state, target, dtSec, limits = {}) {
  const speed = Number.isFinite(limits.speed) ? limits.speed : CRUISE_RAD_PER_S;
  const turn = Number.isFinite(limits.turn) ? limits.turn : TURN_RAD_PER_S;
  const arrive = Number.isFinite(limits.arrive) ? limits.arrive : ARRIVE_RAD;
  const here = {
    latDeg: Number(state?.latDeg) || 0,
    lonDeg: Number(state?.lonDeg) || 0,
  };
  const headingRad = normalizeHeading(state?.headingRad);
  const dt = Number.isFinite(dtSec) ? clamp(dtSec, 0, 60) : 0;
  const distance = angularDistance(here, target);
  if (!Number.isFinite(distance)) {
    return {
      ...here,
      headingRad,
      travelledRad: 0,
      arrived: false,
    };
  }
  const step = speed * dt;
  if (distance <= arrive || distance <= step) {
    return {
      latDeg: Number(target.latDeg),
      lonDeg: Number(target.lonDeg),
      headingRad,
      travelledRad: distance,
      arrived: true,
    };
  }
  const desired = bearingBetween(here, target);
  const facing = normalizeHeading(
    headingRad +
      clamp(shortestTurn(headingRad, desired), -turn * dt, turn * dt),
  );
  const next = destinationPoint(here, facing, step);
  return {
    latDeg: next ? next.latDeg : here.latDeg,
    lonDeg: next ? next.lonDeg : here.lonDeg,
    headingRad: facing,
    travelledRad: step,
    arrived: false,
  };
}

/** Weight of a layer's worst fresh event in the ranking. */
export const SEVERITY_SCORE = Object.freeze({
  emergency: 900,
  warn: 300,
  info: 0,
});

/** A layer whose feed is failing is always worth a look. */
export const ERROR_BONUS = 200;

/** A just-changed layer beats a stale one. */
export const FRESH_BONUS_MAX = 150;

/** The nearest candidate beats the far one, all else equal. */
export const NEAR_BONUS_MAX = 120;

/** A layer the spider has not inspected recently is preferred. */
export const UNVISITED_BONUS = 80;

/** Re-picking the layer under the spider's feet is only a last resort. */
export const REPEAT_PENALTY = 240;

/**
 * Rank inspection targets: the most significant layer first.
 *
 * Deterministic by construction — no randomness, and ties break on the layer
 * id — so the walk is reproducible from the same inputs. A candidate without
 * a usable position is dropped: there is nowhere to walk to.
 *
 * @param {Array<{layerId:string, label?:string, latDeg:number, lonDeg:number,
 *   count?:number, severity?:string, error?:boolean, eventAt?:number}>} candidates
 * @param {{from?:{latDeg:number, lonDeg:number}, now?:number,
 *   visitedAt?:Record<string, number>, current?:string}} [context]
 * @returns {Array<object>} the candidates, best first, each with a `score`.
 */
export function rankInspectionTargets(candidates, context = {}) {
  const from = context.from ?? null;
  const now = Number.isFinite(context.now) ? context.now : Date.now();
  const visitedAt = context.visitedAt ?? {};
  const current = context.current ?? null;
  const ranked = [];
  for (const candidate of candidates ?? []) {
    // `Number(null)` is 0, which would plant a positionless layer on the
    // equator, so an absent coordinate is rejected before the cast.
    const rawLat = candidate?.latDeg;
    const rawLon = candidate?.lonDeg;
    if (rawLat == null || rawLon == null || rawLat === '' || rawLon === '')
      continue;
    const latDeg = Number(rawLat);
    const lonDeg = Number(rawLon);
    if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) continue;
    const layerId = String(candidate.layerId ?? '');
    if (!layerId) continue;
    let score = SEVERITY_SCORE[candidate?.severity] ?? SEVERITY_SCORE.info;
    if (candidate?.error) score += ERROR_BONUS;
    const eventAt = Number(candidate?.eventAt);
    if (Number.isFinite(eventAt) && now - eventAt < FRESH_EVENT_MS) {
      const freshness = 1 - clamp((now - eventAt) / FRESH_EVENT_MS, 0, 1);
      score += FRESH_BONUS_MAX * freshness;
    }
    if (from) {
      const distance = angularDistance(from, { latDeg, lonDeg });
      if (Number.isFinite(distance))
        score += NEAR_BONUS_MAX * (1 - clamp(distance / Math.PI, 0, 1));
    }
    const seenAt = Number(visitedAt[layerId]);
    if (!Number.isFinite(seenAt) || now - seenAt > 2 * FRESH_EVENT_MS) {
      score += UNVISITED_BONUS;
    }
    if (current && current === layerId) score -= REPEAT_PENALTY;
    ranked.push({ ...candidate, layerId, latDeg, lonDeg, score });
  }
  ranked.sort(
    (a, b) => b.score - a.score || a.layerId.localeCompare(b.layerId),
  );
  return ranked;
}
