import { readCappedResponseText } from './common/http.js';

/**
 * Server-side Copernicus EMS Rapid Mapping activations proxy. The dashboard
 * activations API is public and keyless but sends no CORS headers, so the
 * browser cannot read it directly — the app's own GET route answers the first
 * page (newest first) through a 15 s bounded, 4 MiB-capped server-side fetch.
 *
 * Successful answers are cached for ten minutes so the read stays well off the
 * upstream's load pattern; an upstream failure is answered (never cached) as
 * `ok:false` with a short, text-free error code and the client treats it as an
 * empty complement rather than an authoritative empty disaster picture.
 *
 * Route: GET /api/copernicus-ems
 * Upstream: GET https://mapping.emergency.copernicus.eu/activations/api/activations/?limit=200
 */

import {
  COPERNICUS_EMS_LIMIT,
  COPERNICUS_EMS_UPSTREAM_URL,
} from '../../src/layers/disasters/source.js';

export const COPERNICUS_EMS_ROUTE = '/api/copernicus-ems';
export const COPERNICUS_EMS_TIMEOUT_MS = 15_000;
export const COPERNICUS_EMS_MAX_BYTES = 4 * 1024 * 1024;
export const COPERNICUS_EMS_CACHE_MS = 10 * 60 * 1000;

export function copernicusEmsFailure(
  errorCode,
  { generatedAt = Date.now() } = {},
) {
  return {
    ok: false,
    error: errorCode, // 'upstream' | 'body-too-large' | 'unparseable'
    activations: [],
    generatedAt,
  };
}

export function createCopernicusEmsHandler({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = COPERNICUS_EMS_TIMEOUT_MS,
  maxBytes = COPERNICUS_EMS_MAX_BYTES,
  cacheMs = COPERNICUS_EMS_CACHE_MS,
  limit = COPERNICUS_EMS_LIMIT,
  logger = console,
} = {}) {
  const upstreamUrl = `${COPERNICUS_EMS_UPSTREAM_URL}?limit=${limit}`;
  const cache = { payload: null, bestBefore: 0, promise: null };

  const readUpstream = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const upstream = await fetchImpl(upstreamUrl, {
        signal: controller.signal,
      });
      if (!upstream.ok)
        return copernicusEmsFailure(`upstream ${upstream.status}`);
      const { tooLarge, text } = await readCappedResponseText(
        upstream,
        maxBytes,
      );
      if (tooLarge) return copernicusEmsFailure('body-too-large');
      let document;
      try {
        document = JSON.parse(text);
      } catch {
        return copernicusEmsFailure('unparseable');
      }
      if (
        !document ||
        typeof document !== 'object' ||
        !Array.isArray(document.results)
      )
        return copernicusEmsFailure('unparseable');
      return {
        ok: true,
        error: null,
        activations: document.results.slice(0, limit),
        generatedAt: Date.now(),
      };
    } catch (error) {
      logger.warn?.(
        `[copernicus-ems] upstream read failed: ${error?.name ?? 'Error'}`,
      );
      return copernicusEmsFailure('upstream');
    } finally {
      clearTimeout(timer);
    }
  };

  const cached = async () => {
    const now = Date.now();
    if (cache.payload && cache.bestBefore > now) return cache.payload;
    if (cache.promise) return cache.promise;
    cache.promise = (async () => {
      const payload = await readUpstream();
      if (payload.ok) {
        cache.payload = payload;
        cache.bestBefore = Date.now() + cacheMs;
      }
      return payload;
    })();
    try {
      return await cache.promise;
    } finally {
      cache.promise = null;
    }
  };

  return {
    async handle(request, response) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.statusCode = 405;
        response.setHeader('Allow', 'GET, HEAD');
        response.end();
        return;
      }
      let payload;
      try {
        payload = await cached();
      } catch {
        payload = copernicusEmsFailure('upstream');
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.setHeader('cache-control', 'no-store');
      if (request.method === 'GET') response.end(JSON.stringify(payload));
      else response.end();
    },
  };
}

export function copernicusEmsProxy({ logger = console } = {}) {
  const { handle } = createCopernicusEmsHandler({ logger });
  return {
    name: 'copernicus-ems-proxy',
    configureServer(server) {
      server.middlewares.use(
        COPERNICUS_EMS_ROUTE,
        (request, response, next) => {
          if (request.url !== '/' && request.url !== '') return next();
          void handle(request, response);
        },
      );
    },
    configurePreviewServer(server) {
      server.middlewares.use(
        COPERNICUS_EMS_ROUTE,
        (request, response, next) => {
          if (request.url !== '/' && request.url !== '') return next();
          void handle(request, response);
        },
      );
    },
  };
}
