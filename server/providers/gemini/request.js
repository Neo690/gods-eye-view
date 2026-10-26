import { readRequestBody } from '../common/request.js';
import { forwardedProtocol } from '../common/same-site.js';
import { admitSameSiteRequest } from '../../../src/localRequestGate.mjs';
import {
  isAllowedHost,
  resolveAllowedHosts,
} from '../../../build/allowedHosts.js';

/**
 * Hostnames this instance is deliberately published on (`GEV_ALLOWED_HOSTS`,
 * the same list Vite's Host allowlist uses). On one of them the platform's
 * relay header is the normal path, not a sign of a foreign caller.
 * @returns {string[]}
 */
function publishedHosts(configuredAllowedHosts) {
  return String(configuredAllowedHosts ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Use the app's Host and request policies on the credential-spending route.
 *
 * The shared gate decides: a foreign or opaque `Origin`, a `Sec-Fetch-Site`
 * other than `same-origin`/`none`, or relay headers on a host this instance is
 * not published on are all refused. Two shapes are admitted. A same-origin app
 * request, whose `Origin` must equal the authority the request arrived on —
 * read from `X-Forwarded-Proto` when the instance is served behind a relay,
 * since that is where TLS ends. And a request for a published host carrying no
 * `Origin` and no `Sec-Fetch-Site`: that is the Android shell, which replays
 * `/api/*` from Java and sends neither header, so refusing it would leave the
 * phone's voice permanently dark on a hosted instance. The minted credential
 * itself stays constrained by this module's caller either way.
 */
export function isGeminiRequestOriginAllowed(
  req,
  configuredHost = '',
  configuredAllowedHosts,
) {
  const host = req.headers?.host;
  if (typeof host !== 'string' || !host || /[\s/?#@\\]/.test(host))
    return false;
  if (
    !admitSameSiteRequest({
      hostHeader: host,
      protocol: forwardedProtocol(req),
      origin: req.headers?.origin,
      secFetchSite: req.headers?.['sec-fetch-site'],
      proxyHeaders: req.headers || {},
      publishedHosts: publishedHosts(configuredAllowedHosts),
    }).ok
  )
    return false;
  const boundHost = String(configuredHost || '')
    .trim()
    .toLowerCase();
  return isAllowedHost(host, resolveAllowedHosts(configuredAllowedHosts), [
    boundHost,
  ]);
}

/** Admit only the existing input gesture; callers cannot supply model/setup. */
export async function readGeminiTokenRequest(req, signal, maxBytes = 1024) {
  const declared = Number(req.headers?.['content-length']);
  const fail = (code) =>
    Object.assign(new Error('Invalid token request'), { code });
  const body = await readRequestBody(
    req,
    maxBytes,
    Number.isFinite(declared) && declared > maxBytes
      ? AbortSignal.abort(fail('BODY_TOO_LARGE'))
      : signal,
  );
  if (!body.trim()) return 'open-mic';
  if (
    !/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || '')
  )
    throw fail('BAD_CONTENT_TYPE');
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw fail('BAD_BODY');
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
    throw fail('BAD_BODY');
  const keys = Object.keys(parsed);
  if (!keys.length) return 'open-mic';
  if (
    keys.length === 1 &&
    keys[0] === 'inputMode' &&
    parsed.inputMode === 'push-to-talk'
  )
    return 'push-to-talk';
  throw fail('BAD_BODY');
}
