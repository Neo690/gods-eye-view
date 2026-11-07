/**
 * Sources and ceilings for the camera-advisory join.
 *
 * Two public, keyless sources are read: CISA's CSAF distribution of ICS
 * advisories and NVD's CVE API. Neither is a device interface — the join reads
 * published metadata only, and nothing in this feature opens a connection to a
 * catalogued camera.
 */

/** CISA OT advisories, TLP:WHITE, as a ROLIE feed (titles, dates, links). */
export const CISA_OT_FEED_URL =
  'https://raw.githubusercontent.com/cisagov/CSAF/develop/csaf_files/OT/white/cisa-csaf-ot-feed-tlp-white.json';
/** Where a reader sees one advisory as a page. */
export const CISA_ADVISORY_PAGE =
  'https://www.cisa.gov/news-events/ics-advisories/';
/** NVD CVE API 2.0, keyless. */
export const NVD_CVE_API = 'https://services.nvd.nist.gov/rest/json/cves/2.0';
/** Where a reader sees one CVE as a page. */
export const NVD_CVE_PAGE = 'https://nvd.nist.gov/vuln/detail/';

/** The feed is ~4.4 MB; allow generous headroom without accepting a stream. */
export const CISA_FEED_MAX_BYTES = 8 * 1024 * 1024;
/** One advisory document, bounded. */
export const CISA_DOC_MAX_BYTES = 2 * 1024 * 1024;
/** One NVD answer (2,000 CVEs with CPEs can be ~1.5 MB). */
export const NVD_MAX_BYTES = 4 * 1024 * 1024;

/** Documents fetched per refresh. Title filtering keeps this small. */
export const MAX_CISA_ADVISORIES = 8;
/**
 * NVD brand queries per refresh. Keyless NVD allows 5 requests per 30 s, so
 * four brands keep a refresh inside one window; a fleet with more identified
 * brands reports the rest as not queried rather than spending the budget on a
 * queue that would outlive the layer's own timeout.
 */
export const MAX_NVD_BRANDS = 4;
/** One upstream call's deadline. */
export const SOURCE_TIMEOUT_MS = 20_000;
/** How long one computed answer is served before it is rebuilt. */
export const DEFAULT_CACHE_MS = 6 * 60 * 60_000;
/** Highest ranked matches kept per camera, so one noisy CVE list cannot drown
 * the advisory that matters. */
export const MAX_MATCHES_PER_CAMERA = 6;
/** Cameras drawn at once; the rest are counted, not dropped silently. */
export const MAX_FINDINGS = 600;

/** Severity bands, worst first. Colour is the globe/legend token. */
export const SEVERITY_BANDS = Object.freeze([
  Object.freeze({ id: 'critical', min: 9, color: '#ff3b5c' }),
  Object.freeze({ id: 'high', min: 7, color: '#ff8a3d' }),
  Object.freeze({ id: 'medium', min: 4, color: '#ffd166' }),
  Object.freeze({ id: 'low', min: 0.1, color: '#7fd8ff' }),
  Object.freeze({ id: 'unscored', min: 0, color: '#8a94a6' }),
]);

export const SEVERITY_RANK = Object.freeze({
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  unscored: 1,
});

/**
 * Camera brands this join can name in NVD's CPE vocabulary. Catalogue
 * manufacturers are matched by alias, and only a brand listed here is queried
 * — an unknown brand is reported as unqueried rather than guessed at.
 */
export const CAMERA_BRANDS = Object.freeze([
  Object.freeze({
    id: 'axis',
    aliases: Object.freeze(['axis', 'axis communications']),
    cpeVendors: Object.freeze(['axis']),
  }),
  Object.freeze({
    id: 'bosch',
    aliases: Object.freeze(['bosch', 'bosch security systems']),
    cpeVendors: Object.freeze(['bosch', 'bosch_security_systems']),
  }),
  Object.freeze({
    id: 'hanwha',
    aliases: Object.freeze(['hanwha', 'hanwha techwin', 'samsung techwin']),
    cpeVendors: Object.freeze(['hanwha', 'hanwha_techwin', 'samsung']),
  }),
  Object.freeze({
    id: 'hikvision',
    aliases: Object.freeze(['hikvision']),
    cpeVendors: Object.freeze(['hikvision']),
  }),
  Object.freeze({
    id: 'dahua',
    aliases: Object.freeze(['dahua', 'dahua technology']),
    cpeVendors: Object.freeze(['dahua']),
  }),
  Object.freeze({
    id: 'vivotek',
    aliases: Object.freeze(['vivotek']),
    cpeVendors: Object.freeze(['vivotek']),
  }),
  Object.freeze({
    id: 'uniview',
    aliases: Object.freeze(['uniview', 'unv']),
    cpeVendors: Object.freeze(['uniview', 'uniview_technologies']),
  }),
  Object.freeze({
    id: 'avigilon',
    aliases: Object.freeze(['avigilon']),
    cpeVendors: Object.freeze(['avigilon']),
  }),
  Object.freeze({
    id: 'pelco',
    aliases: Object.freeze(['pelco']),
    cpeVendors: Object.freeze(['pelco']),
  }),
  Object.freeze({
    id: 'mobotix',
    aliases: Object.freeze(['mobotix']),
    cpeVendors: Object.freeze(['mobotix']),
  }),
  Object.freeze({
    id: 'geovision',
    aliases: Object.freeze(['geovision', 'geo vision']),
    cpeVendors: Object.freeze(['geovision']),
  }),
  Object.freeze({
    id: 'cohu',
    aliases: Object.freeze(['cohu']),
    cpeVendors: Object.freeze(['cohu']),
  }),
  Object.freeze({
    id: 'arecont',
    aliases: Object.freeze(['arecont', 'arecont vision']),
    cpeVendors: Object.freeze(['arecont_vision']),
  }),
  Object.freeze({
    id: 'march-networks',
    aliases: Object.freeze(['march networks']),
    cpeVendors: Object.freeze(['march_networks']),
  }),
  Object.freeze({
    id: 'sony',
    aliases: Object.freeze(['sony']),
    cpeVendors: Object.freeze(['sony']),
  }),
  Object.freeze({
    id: 'panasonic',
    aliases: Object.freeze(['panasonic', 'panasonic i-pro']),
    cpeVendors: Object.freeze(['panasonic']),
  }),
]);
