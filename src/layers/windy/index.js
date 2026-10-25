// src/layers/windy/index.js
import * as Cesium from 'cesium';
import { t, msg } from '../../i18n/index.js';

const WINDY_ID = 'windy-weather';

function compassDir(deg) {
  if (deg === null || deg === undefined) return '—';
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  return dirs[Math.round(deg / 45) % 8];
}

function updateHudTelemetry(weatherData) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('hud-windy');
  if (!el) return;
  if (!weatherData) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }
  const tempStr =
    weatherData.tempC !== null && weatherData.tempC !== undefined
      ? `${weatherData.tempC > 0 ? '+' : ''}${weatherData.tempC}°C`
      : null;
  const windStr =
    weatherData.windKmh !== null && weatherData.windKmh !== undefined
      ? `${weatherData.windKmh} km/h ${compassDir(weatherData.windDeg)}`
      : null;
  const pressStr =
    weatherData.pressureHpa !== null && weatherData.pressureHpa !== undefined
      ? `${weatherData.pressureHpa} hPa`
      : null;
  const parts = [tempStr, windStr, pressStr].filter(Boolean);
  el.textContent = parts.length ? `🌡 ${parts.join(' · ')}` : '';
  el.style.display = parts.length ? '' : 'none';
}

export function createWindyWeatherLayer({
  feed,
  id = WINDY_ID,
  getCameraCenter = null,
  onWeatherUpdate = null,
} = {}) {
  if (!feed || typeof feed.getSnapshot !== 'function')
    throw new TypeError('Windy layer requires a snapshot source');

  let listener = null;
  let viewerRef = null;
  let enabled = false;
  let loading = false;
  let error = null;
  let data = null;
  let request = null;
  let timer = null;
  let lastLat = null,
    lastLon = null;
  const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

  const notify = () => listener?.();

  function getCenterCoords() {
    if (typeof getCameraCenter === 'function') {
      const c = getCameraCenter();
      if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon)) return c;
    }
    if (!viewerRef?.camera) return null;
    try {
      const canvas = viewerRef.scene?.canvas;
      if (canvas && typeof Cesium.Cartesian2 === 'function') {
        const windowPosition = new Cesium.Cartesian2(
          canvas.clientWidth / 2,
          canvas.clientHeight / 2,
        );
        const ray = viewerRef.camera.getPickRay(windowPosition);
        if (ray && viewerRef.scene?.globe) {
          const targetCartesian = viewerRef.scene.globe.pick(ray, viewerRef.scene);
          if (targetCartesian) {
            const carto = Cesium.Cartographic.fromCartesian(targetCartesian);
            return {
              lat: (carto.latitude * 180) / Math.PI,
              lon: (carto.longitude * 180) / Math.PI,
            };
          }
        }
      }
    } catch {}
    const carto = viewerRef.camera.positionCartographic;
    if (carto) {
      return {
        lat: (carto.latitude * 180) / Math.PI,
        lon: (carto.longitude * 180) / Math.PI,
      };
    }
    return null;
  }

  async function fetchData(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (request) {
      request.abort();
      request = null;
    }
    const controller = new AbortController();
    request = controller;
    loading = true;
    error = null;
    notify();
    try {
      const result = await feed.getSnapshot({
        lat,
        lon,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      data = result;
      lastLat = lat;
      lastLon = lon;
      error = null;
      updateHudTelemetry(data);
      onWeatherUpdate?.(data);
    } catch (err) {
      if (controller.signal.aborted) return;
      error = err.message || 'Windy error';
      data = null;
    } finally {
      if (!controller.signal.aborted) {
        loading = false;
        request = null;
        notify();
      }
    }
  }

  function scheduleRefresh() {
    clearTimeout(timer);
    if (!enabled) return;
    timer = setTimeout(() => {
      if (!enabled) return;
      const center = getCenterCoords();
      if (center) fetchData(center.lat, center.lon);
      scheduleRefresh();
    }, REFRESH_INTERVAL_MS);
  }

  const layer = {
    id,
    name: 'Local weather (Windy)',
    icon: '🌡',
    source: 'Windy.com · GFS',
    updateInterval: 300_000,

    init(nextViewer) {
      if (nextViewer) viewerRef = nextViewer;
    },

    enable() {
      if (enabled) return;
      enabled = true;
      const center = getCenterCoords();
      if (center) fetchData(center.lat, center.lon);
      scheduleRefresh();
      notify();
    },

    disable() {
      if (!enabled) return;
      enabled = false;
      clearTimeout(timer);
      timer = null;
      request?.abort();
      request = null;
      loading = false;
      updateHudTelemetry(null);
      onWeatherUpdate?.(null);
      notify();
    },

    async update(viewer, { signal } = {}) {
      if (viewer) viewerRef = viewer;
      if (!enabled) return false;
      const center = getCenterCoords();
      if (center && (lastLat === null || lastLon === null)) {
        await fetchData(center.lat, center.lon);
      }
      return true;
    },

    /** Called by the app when the camera moves significantly. */
    onCameraMove(lat, lon) {
      if (!enabled) return;
      fetchData(lat, lon);
      scheduleRefresh();
    },

    attach(viewer) {
      if (viewer) viewerRef = viewer;
    },
    detach() {
      viewerRef = null;
    },
    applyParams() {},

    getRowControls() {
      const tempStr =
        data?.tempC !== null && data?.tempC !== undefined
          ? `${data.tempC > 0 ? '+' : ''}${data.tempC}°C`
          : '—';
      const windStr =
        data?.windKmh !== null && data?.windKmh !== undefined
          ? `${data.windKmh} km/h ${compassDir(data?.windDeg)}`
          : '—';
      const gustStr =
        data?.gustKmh !== null &&
        data?.gustKmh !== undefined &&
        data.gustKmh > (data.windKmh || 0)
          ? ` (rafale ${data.gustKmh} km/h)`
          : '';
      const pressStr =
        data?.pressureHpa !== null && data?.pressureHpa !== undefined
          ? `${data.pressureHpa} hPa`
          : '—';
      const humStr =
        data?.humidity !== null && data?.humidity !== undefined
          ? `${data.humidity}%`
          : '—';

      const status = loading
        ? t('Loading…')
        : error
          ? t('Unavailable')
          : data
            ? `${tempStr} · ${windStr}${gustStr}`
            : t('Enable to load');

      const controls = {
        id,
        name: t('Local weather (Windy)'),
        icon: '🌡',
        enabled,
        loading,
        summary: {
          status,
          chips: [],
          lines: data
            ? [
                { id: 'temp', text: `🌡 Température: ${tempStr}` },
                { id: 'wind', text: `💨 Vent: ${windStr}${gustStr}` },
                { id: 'pressure', text: `⬇ Pression: ${pressStr}` },
                { id: 'humidity', text: `💧 Humidité: ${humStr}` },
              ]
            : [],
          actions: [],
          settings: [],
          info: data
            ? `Météo locale (Windy · GFS)\nTempérature: ${tempStr}\nVent: ${windStr}${gustStr}\nPression: ${pressStr}\nHumidité: ${humStr}\nSource: Windy.com · GFS`
            : error || t('No data'),
          infoTitle: t(
            'GFS point forecast for the map centre. Refreshed automatically every 5 minutes or when the camera moves more than 5 km. Source: Windy.com / NOAA GFS.',
          ),
          legend: [],
          legendCategorical: false,
        },
        chips: [],
        list: { ariaLabel: t('Local weather forecast'), items: [] },
      };
      return controls;
    },

    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },

    getStats() {
      return {
        count: data ? 1 : 0,
        lastUpdate: data?.fetchedAt || null,
        loading,
        error,
        stale: false,
        source: 'Windy.com · GFS',
      };
    },

    getDiagnostics() {
      return {
        enabled,
        loading,
        error,
        hasData: !!data,
        lastLat,
        lastLon,
        timerActive: timer !== null,
      };
    },

    /** Returns current weather data for HUD display, or null. */
    getWeatherData() {
      return enabled ? data : null;
    },

    destroy() {
      layer.disable();
      listener = null;
      viewerRef = null;
    },
  };
  return layer;
}
