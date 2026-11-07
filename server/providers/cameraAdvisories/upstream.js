/**
 * Reading the two public advisory sources.
 *
 * Everything here is metadata: a feed of advisory titles, one document per
 * relevant advisory, and NVD's CVE records. The module refuses any host other
 * than the two advisory services, which is what keeps the feature's promise
 * that it never connects to a camera or to an operator's own equipment.
 */

import { readResponseJsonCapped } from '../common/http.js';
import {
  CISA_ADVISORY_PAGE,
  CISA_DOC_MAX_BYTES,
  CISA_FEED_MAX_BYTES,
  CISA_OT_FEED_URL,
  NVD_CVE_API,
  NVD_CVE_PAGE,
  NVD_MAX_BYTES,
  SOURCE_TIMEOUT_MS,
} from './constants.js';
import {
  advisoryTitle,
  brandFor,
  cpeProduct,
  normalizeWords,
  severityBand,
} from './matching.js';

/** The only hosts this feature reads. */
export const ADVISORY_HOSTS = Object.freeze([
  'raw.githubusercontent.com',
  'services.nvd.nist.gov',
]);

/** Whether a URL is one of the two advisory services. */
export function isAdvisoryUrl(value) {
  try {
    return ADVISORY_HOSTS.includes(new URL(String(value)).hostname);
  } catch {
    return false;
  }
}

/**
 * Read one JSON document, bounded and with redirects refused.
 *
 * @param {string} url
 * @param {object} options
 * @param {Function} options.fetchImpl
 * @param {number} options.maxBytes
 * @returns {Promise<object>} parsed body
 */
export async function readAdvisoryJson(url, { fetchImpl, maxBytes }) {
  if (!isAdvisoryUrl(url)) throw new Error('advisory_host_refused');
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'gods-eye-view-camera-advisories/1.0',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
  });
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      /* no-op */
    }
    throw Object.assign(new Error(`advisory_http_${response.status}`), {
      status: response.status,
    });
  }
  return readResponseJsonCapped(
    response,
    maxBytes,
    AbortSignal.timeout(SOURCE_TIMEOUT_MS),
  );
}

/** Every product name in a CSAF product tree, deduplicated. */
export function csafProducts(productTree) {
  const names = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const branch of Array.isArray(node.branches) ? node.branches : []) {
      if (typeof branch?.name === 'string' && branch.name.trim()) {
        names.add(branch.name.replace(/\s+/g, ' ').trim());
      }
      if (branch?.product?.name) {
        names.add(String(branch.product.name).replace(/\s+/g, ' ').trim());
      }
      walk(branch);
    }
    for (const product of Array.isArray(node.full_product_names)
      ? node.full_product_names
      : []) {
      if (product?.name) {
        names.add(String(product.name).replace(/\s+/g, ' ').trim());
      }
    }
  };
  walk(productTree);
  return [...names].filter(Boolean);
}

/** Highest CVSS 3.x score a CSAF vulnerability carries, or null. */
function csafScore(vulnerability) {
  let best = null;
  for (const score of Array.isArray(vulnerability?.scores)
    ? vulnerability.scores
    : []) {
    const base = score?.cvss_v3?.baseScore;
    if (Number.isFinite(base)) best = Math.max(best ?? 0, base);
  }
  return best;
}

/** A CSAF document and its feed entry → one advisory record, or null. */
export function parseCisaAdvisory(document, entry = null) {
  if (!document || typeof document !== 'object') return null;
  const id = String(document?.document?.tracking?.id ?? entry?.id ?? '').trim();
  const title = String(document?.document?.title ?? entry?.title ?? '').trim();
  if (!id || !title) return null;
  const products = csafProducts(document?.product_tree);
  const cves = [];
  let score = null;
  for (const vulnerability of Array.isArray(document?.vulnerabilities)
    ? document.vulnerabilities
    : []) {
    const cve = String(vulnerability?.cve ?? '').trim();
    if (cve && !cves.includes(cve)) cves.push(cve);
    const value = csafScore(vulnerability);
    if (Number.isFinite(value)) score = Math.max(score ?? 0, value);
  }
  const brands = [
    ...new Set(
      [title, ...products].map((text) => brandFor(text)).filter(Boolean),
    ),
  ];
  return {
    source: 'cisa',
    id,
    title,
    url: `${CISA_ADVISORY_PAGE}${id.toLowerCase()}`,
    published:
      document?.document?.tracking?.initial_release_date ??
      entry?.published ??
      null,
    updated:
      document?.document?.tracking?.current_release_date ??
      entry?.updated ??
      null,
    score,
    severity: severityBand(score),
    cves,
    products,
    brands,
  };
}

/**
 * Feed entries whose title names one of the fleet's brands, newest first.
 *
 * Advisory titles begin with the vendor's name, so this filter decides which
 * documents are worth fetching at all; a title that names no fleet brand
 * cannot produce a finding and costs no request.
 *
 * @param {object} feed parsed ROLIE feed
 * @param {Set<string>} fleetBrands canonical brand ids
 * @param {number} cap
 * @returns {Array<object>} feed entries
 */
export function cisaEntriesForBrands(feed, fleetBrands, cap) {
  const entries = Array.isArray(feed?.feed?.entry) ? feed.feed.entry : [];
  return entries
    .filter((entry) => {
      const brand = brandFor(entry?.title);
      return brand ? fleetBrands.has(brand) : false;
    })
    .sort(
      (a, b) =>
        Date.parse(b?.updated ?? b?.published ?? 0) -
        Date.parse(a?.updated ?? a?.published ?? 0),
    )
    .slice(0, Math.max(0, cap));
}

/** The self link of a feed entry, when it is on the advisory host. */
export function cisaEntryUrl(entry) {
  const href = entry?.link?.find?.((link) => link?.rel === 'self')?.href;
  return isAdvisoryUrl(href) ? String(href) : null;
}

/**
 * Fetch the CSAF feed and up to `cap` relevant advisory documents.
 *
 * @param {object} options
 * @param {Set<string>} options.fleetBrands
 * @param {Function} options.fetchImpl
 * @param {number} options.cap
 * @param {Function} [options.warn]
 * @returns {Promise<{records:Array<object>, fetched:number, brandOnly:number, error:string|null}>}
 */
export async function loadCisaAdvisories({
  fleetBrands,
  fetchImpl,
  cap,
  warn = () => {},
}) {
  if (!fleetBrands?.size) return { records: [], fetched: 0, error: null };
  try {
    const feed = await readAdvisoryJson(CISA_OT_FEED_URL, {
      fetchImpl,
      maxBytes: CISA_FEED_MAX_BYTES,
    });
    const entries = cisaEntriesForBrands(feed, fleetBrands, cap);
    const records = [];
    let fetched = 0;
    for (const entry of entries) {
      const url = cisaEntryUrl(entry);
      if (!url) continue;
      try {
        const document = await readAdvisoryJson(url, {
          fetchImpl,
          maxBytes: CISA_DOC_MAX_BYTES,
        });
        fetched += 1;
        const record = parseCisaAdvisory(document, entry);
        if (record) records.push(record);
      } catch (error) {
        warn(
          '[camera-advisories] CISA document failed:',
          error?.message || error,
        );
      }
    }
    return { records, fetched, error: null };
  } catch (error) {
    warn('[camera-advisories] CISA feed failed:', error?.message || error);
    return { records: [], fetched: 0, error: 'cisa_unavailable' };
  }
}

/** One NVD CVE → one advisory record, or null. */
export function parseNvdCve(cve) {
  if (!cve || typeof cve !== 'object') return null;
  const id = String(cve.id ?? '').trim();
  if (!/^CVE-\d{4}-\d+$/i.test(id)) return null;
  const description =
    (Array.isArray(cve.descriptions) ? cve.descriptions : []).find(
      (entry) => entry?.lang === 'en',
    )?.value ?? '';
  const products = [];
  const vendors = new Set();
  for (const configuration of Array.isArray(cve.configurations)
    ? cve.configurations
    : []) {
    for (const node of Array.isArray(configuration?.nodes)
      ? configuration.nodes
      : []) {
      for (const match of Array.isArray(node?.cpeMatch) ? node.cpeMatch : []) {
        const product = cpeProduct(match?.criteria);
        if (!product) continue;
        vendors.add(product.vendor);
        const label = product.product.replace(/_/g, ' ');
        if (!products.includes(label)) products.push(label);
      }
    }
  }
  if (!products.length) return null;
  const metric =
    cve.metrics?.cvssMetricV31?.[0] ??
    cve.metrics?.cvssMetricV30?.[0] ??
    cve.metrics?.cvssMetricV40?.[0] ??
    cve.metrics?.cvssMetricV2?.[0] ??
    null;
  const score = Number.isFinite(metric?.cvssData?.baseScore)
    ? metric.cvssData.baseScore
    : null;
  const named = metric?.cvssData?.baseSeverity ?? metric?.baseSeverity ?? '';
  const brands = [
    ...new Set([...vendors].map((vendor) => brandFor(vendor)).filter(Boolean)),
  ];
  return {
    source: 'nvd',
    id: id.toUpperCase(),
    title: advisoryTitle(description, id),
    url: `${NVD_CVE_PAGE}${id.toUpperCase()}`,
    published: cve.published ?? null,
    updated: cve.lastModified ?? null,
    score,
    severity: severityBand(score, named),
    cves: [id.toUpperCase()],
    products,
    brands,
  };
}

/**
 * Query NVD once per brand, capped.
 *
 * CPE prefix matching is used instead of a description keyword: the vendor is
 * a structured field, so a CVE about an unrelated product that merely mentions
 * the brand is not returned. The first CPE vendor alias is used for each
 * brand, keeping the whole refresh inside the keyless request budget.
 *
 * @param {object} options
 * @param {Array<object>} options.brands canonical brand records
 * @param {Function} options.fetchImpl
 * @param {number} options.cap
 * @param {Function} [options.warn]
 */
export async function loadNvdAdvisories({
  brands,
  fetchImpl,
  cap,
  warn = () => {},
}) {
  const selected = (Array.isArray(brands) ? brands : []).slice(
    0,
    Math.max(0, cap),
  );
  const records = [];
  const notQueried = [];
  let error = null;
  const settled = await Promise.allSettled(
    selected.map(async (brand) => {
      const vendor = brand.cpeVendors?.[0];
      if (!vendor) return { records: [], total: 0 };
      const url = new URL(NVD_CVE_API);
      url.searchParams.set('virtualMatchString', `cpe:2.3:o:${vendor}`);
      url.searchParams.set('resultsPerPage', '2000');
      const body = await readAdvisoryJson(url, {
        fetchImpl,
        maxBytes: NVD_MAX_BYTES,
      });
      const page = Array.isArray(body?.vulnerabilities)
        ? body.vulnerabilities
        : [];
      return {
        records: page.map((entry) => parseNvdCve(entry?.cve)).filter(Boolean),
        total: Number(body?.totalResults) || page.length,
      };
    }),
  );
  for (const [index, result] of settled.entries()) {
    if (result.status === 'fulfilled') {
      records.push(...result.value.records);
      continue;
    }
    error = error ?? 'nvd_unavailable';
    warn(
      '[camera-advisories] NVD query failed:',
      result.reason?.message || result.reason,
    );
    notQueried.push(selected[index]?.id);
  }
  return { records, error, notQueried };
}

/** Whether a word appears as a whole token in a normalized string. */
export function mentionsWord(text, word) {
  const normalized = normalizeWords(text);
  const target = normalizeWords(word);
  return Boolean(target) && ` ${normalized} `.includes(` ${target} `);
}
