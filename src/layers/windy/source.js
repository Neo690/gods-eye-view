// src/layers/windy/source.js
import { getApiKey } from '../../data/storedApiKeys.js';

const FALLBACK_WINDY_KEY = '3Z8AiagNSo2KgCDX3qZcwqRKqLpQcv9I';
const WINDY_FORECAST_URL = 'https://api.windy.com/api/point-forecast/v2';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MOVE_THRESHOLD_KM = 5;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function createWindySource({
  apiKey = getApiKey('WINDY_API_KEY', FALLBACK_WINDY_KEY),
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 15_000,
} = {}) {
  let cache = null; // { lat, lon, data, fetchedAt }

  return {
    async getSnapshot({ lat, lon, signal } = {}) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon))
        throw new Error('Windy: invalid coordinates');

      // Return cached result if position hasn't moved much and cache is fresh
      if (cache) {
        const agems = Date.now() - cache.fetchedAt;
        const dist = haversineKm(lat, lon, cache.lat, cache.lon);
        if (agems < CACHE_TTL_MS && dist < MOVE_THRESHOLD_KM) {
          return { ...cache.data, cached: true };
        }
      }

      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('Windy request timed out')),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl(WINDY_FORECAST_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lat,
            lon,
            model: 'gfs',
            parameters: ['temp', 'wind', 'windGust', 'pressure', 'rh'],
            levels: ['surface'],
            key: apiKey,
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Windy HTTP ${response.status}`);
        const json = await response.json();

        const ts = json.ts || [];
        const temps = json['temp-surface'] || [];
        const us = json['wind_u-surface'] || [];
        const vs = json['wind_v-surface'] || [];
        const gusts = json['gust-surface'] || [];
        const pressures = json['pressure-surface'] || [];
        const rhs = json['rh-surface'] || [];

        // Find the index of the nearest timestamp to now
        const now = Date.now();
        let idx = 0;
        let minDiff = Infinity;
        for (let i = 0; i < ts.length; i++) {
          const diff = Math.abs(ts[i] - now);
          if (diff < minDiff) { minDiff = diff; idx = i; }
        }

        const tempC = temps[idx] !== undefined ? temps[idx] - 273.15 : null;
        const windMs = us[idx] !== undefined && vs[idx] !== undefined
          ? Math.hypot(us[idx], vs[idx])
          : null;
        const windKmh = windMs !== null ? windMs * 3.6 : null;
        const gustMs = gusts[idx] !== undefined ? gusts[idx] : null;
        const gustKmh = gustMs !== null ? gustMs * 3.6 : null;
        const pressureHpa = pressures[idx] !== undefined ? pressures[idx] / 100 : null;
        const humidity = rhs[idx] !== undefined ? rhs[idx] : null;

        // Wind direction in degrees (meteorological: direction FROM)
        const u = us[idx] || 0;
        const v = vs[idx] || 0;
        const windDeg = u === 0 && v === 0 ? null : (Math.atan2(u, v) * 180 / Math.PI + 360) % 360;

        const data = {
          lat,
          lon,
          tempC: tempC !== null ? Math.round(tempC * 10) / 10 : null,
          windKmh: windKmh !== null ? Math.round(windKmh) : null,
          windDeg: windDeg !== null ? Math.round(windDeg) : null,
          gustKmh: gustKmh !== null ? Math.round(gustKmh) : null,
          pressureHpa: pressureHpa !== null ? Math.round(pressureHpa) : null,
          humidity: humidity !== null ? Math.round(humidity) : null,
          model: 'GFS',
          fetchedAt: Date.now(),
        };

        cache = { lat, lon, data, fetchedAt: Date.now() };
        return data;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
    clearCache() { cache = null; },
  };
}
