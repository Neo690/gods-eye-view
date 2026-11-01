/**
 * The app's update channel.
 *
 * CI publishes three rolling releases on this repository — `apk-latest`
 * (Android), `ios-latest` (iOS) and `desktop-latest` (Windows) — and each one
 * carries the newest artefact of its platform. Every build the console bundles
 * also carries, baked in by `build/vite.js`, the moment the bundle was built
 * (`GEV_BUILD_TIME`) and the short commit it was built from
 * (`GEV_BUILD_SHA`). A bundle older than a platform's newest published
 * release therefore has an update it can take.
 *
 * Pure: the parser takes a decoded GitHub releases payload and returns plain
 * facts; the network fetch and the DOM wiring live in the functions below and
 * in `wireUpdatePanel` respectively, so the fiche logic stays testable without
 * a document.
 * @module updates/updateChannel
 */
import { msg } from '../i18n/marker.js';

/** The one repository every channel reads from. */
export const REPO = 'Neo690/gods-eye-view';

/** Rolling release tag per platform, and the artefact that proves it shipped. */
export const CHANNELS = [
  {
    id: 'android',
    label: msg('Android'),
    tag: 'apk-latest',
    assetMatch: 'gods-eye-view.apk',
    install:
      'The browser downloads the APK; open it from the notification to install. Settings and presets survive an in-place install.',
  },
  {
    id: 'ios',
    label: msg('iOS'),
    tag: 'ios-latest',
    // The armor does not exist until signing is configured in CI, so the
    // artefact is a probe, not a requirement: the release page itself is the
    // thing to open.
    assetMatch: 'gods-eye-view.ipa',
    install:
      'An ad-hoc .ipa installs through Finder, Sideloadly or AltStore; the WebView storage (provider keys) survives a re-sign.',
  },
  {
    id: 'windows',
    label: msg('Windows'),
    tag: 'desktop-latest',
    assetMatch: 'setup',
    assetMatchExtension: '.exe',
    install:
      'Run the offered Setup .exe. Keys and window state survive an uninstall.',
  },
];

export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=20`;

/** The shell platform this console runs on, from its user agent. */
export function shellPlatform(userAgent = String(navigator?.userAgent || '')) {
  if (/Android/.test(userAgent)) return 'android';
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'ios';
  return 'windows';
}

/** First date among the candidate stamps, or 0 when none parses. */
function firstStamp(values) {
  for (const value of values) {
    const parsed = Date.parse(String(value || ''));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

/**
 * Reduce a GitHub releases payload to per-channel facts.
 *
 * A rolling release has no semver — each publication replaces the one before
 * it. Its channels are republished in place (`upload --clobber` + `gh release
 * edit`), so `release.published_at` stays frozen at the channel's first-ever
 * upload and can never measure a later replacement; the honest comparison is
 * the published artefact's own timestamp, which an upload refreshes, against
 * the moment this bundle was built. A channel whose newest artefact predates
 * the bundle is a channel the bundle is up to date with; one that is newer is
 * an update; one that is missing (iOS without signing) is reported as
 * unavailable.
 *
 * @param {Array} releases decoded api.github.com releases payload
 * @param {{ buildTime: string, buildSha: string }} current this bundle's stamps
 * @returns {{ buildTime: string, buildSha: string, channels: Array }}
 */
export function resolveUpdateInfo(
  releases,
  current = { buildTime: '', buildSha: '' },
) {
  const byTag = new Map(
    (Array.isArray(releases) ? releases : []).map((r) => [
      String(r?.tag_name || ''),
      r,
    ]),
  );
  const buildMs = Date.parse(current.buildTime) || 0;
  return {
    buildTime: current.buildTime,
    buildSha: current.buildSha,
    channels: CHANNELS.map((channel) => {
      const release = byTag.get(channel.tag);
      if (!release) {
        return { ...channel, ok: false, available: false, publishedAt: null };
      }
      const tag = String(release.tag_name || '');
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const artefact = assets.find((a) => {
        const name = String(a?.name || '').toLowerCase();
        return (
          name.includes(channel.assetMatch) &&
          (!channel.assetMatchExtension ||
            name.endsWith(channel.assetMatchExtension))
        );
      });
      // The channel's published moment is when its artefact last shipped:
      // an in-place republication refreshes the asset's `updated_at` while
      // leaving `release.published_at` at the first-ever upload. Assets
      // without stamps (hand-uploaded, or a payload shape that omits them)
      // fall back to the release page's own stamps, newest candidate first.
      const publishedMs = firstStamp(
        artefact
          ? [
              artefact.updated_at,
              artefact.created_at,
              release.published_at,
              release.updated_at,
            ]
          : [release.published_at, release.updated_at],
      );
      return {
        ...channel,
        ok: true,
        artefactName: artefact ? String(artefact.name) : null,
        openUrl: artefact
          ? String(artefact.browser_download_url)
          : `https://github.com/${REPO}/releases/${tag}`,
        publishedAt: publishedMs ? new Date(publishedMs).toISOString() : '',
        available: buildMs > 0 && publishedMs > 0 && publishedMs > buildMs,
      };
    }),
  };
}

/**
 * Fetch the releases payload. Anonymous api.github.com reads are rate-limited
 * per IP (60/h), so callers should treat this as a user-driven command, not a
 * poll loop.
 * @template T fetch / PromiseLike, injectable for tests
 * @param {{ fetch?: T }} dependencies
 * @returns {Promise<Array>} decoded releases, [] on failure
 */
export async function fetchReleases({ fetch: fetchImpl } = {}) {
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) return [];
  try {
    const response = await doFetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return Array.isArray(payload) ? payload : [];
  } catch {
    return [];
  }
}

/**
 * One-shot check: fetch, resolve, and report. Cached for five minutes so a
 * panel can be leaned on (or a reviewer can click it twice) without burning
 * the anonymous quota.
 */
const CACHE_MS = 5 * 60 * 1000;
let cache = null;

export async function checkForUpdate({ fetch: fetchImpl } = {}) {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.info;
  const releases = await fetchReleases({ fetch: fetchImpl });
  const info = resolveUpdateInfo(releases, currentBundleStamps());
  cache = { at: now, info };
  return info;
}

/** Bake in the build stamps for the resolving calls above. */
export function currentBundleStamps() {
  const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
  return {
    buildTime: String(env.GEV_BUILD_TIME || ''),
    buildSha: String(env.GEV_BUILD_SHA || ''),
  };
}
