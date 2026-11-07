import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  brandFor,
  brandRecord,
  buildFindings,
  cameraHardware,
  cpeProduct,
  matchPrecision,
  modelKeys,
  severityBand,
} from './cameraAdvisories/matching.js';
import {
  ADVISORY_HOSTS,
  cisaEntriesForBrands,
  isAdvisoryUrl,
  loadCisaAdvisories,
  loadNvdAdvisories,
  parseCisaAdvisory,
  parseNvdCve,
} from './cameraAdvisories/upstream.js';
import { CISA_OT_FEED_URL, NVD_CVE_API } from './cameraAdvisories/constants.js';
import {
  cameraAdvisoriesProxy,
  cameraAdvisoryPayload,
  catalogueBrands,
} from './cameraAdvisories.js';

const FEED = `${CISA_OT_FEED_URL}`;
const AXIS_DOC = `${CISA_OT_FEED_URL.replace(/cisa-csaf-ot-feed.*$/, '')}2026/icsa-26-001-01.json`;

const cameras = [
  {
    id: 'kc-1',
    name: 'I-90 at Elm',
    lat: 47.6,
    lon: -122.3,
    manufacturer: 'Axis',
    model: 'Q6135-LE',
  },
  {
    id: 'kc-2',
    name: '4th Ave',
    lat: 47.61,
    lon: -122.31,
    manufacturer: 'Bosch',
    model: 'AUTODOME IP 4000 HD',
  },
  {
    id: 'kc-3',
    name: 'Unnamed hardware',
    lat: 47.62,
    lon: -122.32,
    manufacturer: 'Axis',
  },
  {
    id: 'kc-4',
    name: 'Other',
    lat: 47.63,
    lon: -122.33,
    manufacturer: 'Acme',
    model: 'X100',
  },
];

const axisCve = {
  id: 'CVE-2024-0001',
  published: '2024-01-02T00:00:00.000Z',
  lastModified: '2024-02-02T00:00:00.000Z',
  descriptions: [
    {
      lang: 'en',
      value: 'Axis Q6135-LE firmware allows remote code execution.',
    },
  ],
  metrics: {
    cvssMetricV31: [{ cvssData: { baseScore: 9.8, baseSeverity: 'CRITICAL' } }],
  },
  configurations: [
    {
      nodes: [
        {
          cpeMatch: [
            { criteria: 'cpe:2.3:o:axis:q6135_le_firmware:*:*:*:*:*:*:*:*' },
          ],
        },
      ],
    },
  ],
};

const boschCve = {
  id: 'CVE-2024-0002',
  published: '2024-03-01T00:00:00.000Z',
  lastModified: '2024-03-02T00:00:00.000Z',
  descriptions: [
    { lang: 'en', value: 'AUTODOME IP 4000 HD uses weak credentials.' },
  ],
  metrics: {
    cvssMetricV31: [{ cvssData: { baseScore: 5.3, baseSeverity: 'MEDIUM' } }],
  },
  configurations: [
    {
      nodes: [
        {
          cpeMatch: [
            {
              criteria:
                'cpe:2.3:o:bosch:autodome_ip_4000_hd_firmware:*:*:*:*:*:*:*:*',
            },
          ],
        },
      ],
    },
  ],
};

const axisDoc = {
  document: {
    title: 'Axis Communications Camera Station',
    tracking: {
      id: 'ICSA-26-001-01',
      initial_release_date: '2026-01-01T00:00:00.000Z',
      current_release_date: '2026-01-05T00:00:00.000Z',
    },
  },
  product_tree: {
    branches: [
      {
        category: 'vendor',
        name: 'Axis Communications',
        branches: [
          { category: 'product_name', name: 'Camera Station' },
          { category: 'product_name', name: 'Device Manager' },
        ],
      },
    ],
  },
  vulnerabilities: [
    {
      cve: 'CVE-2025-5000',
      scores: [{ cvss_v3: { baseScore: 7.5 } }],
    },
  ],
};

const feed = {
  feed: {
    entry: [
      {
        id: 'ICSA-26-001-01',
        title: 'Axis Communications Camera Station',
        updated: '2026-01-05T00:00:00.000Z',
        link: [{ rel: 'self', href: AXIS_DOC }],
      },
      {
        id: 'ICSA-26-002-01',
        title: 'Siemens SIMATIC',
        updated: '2026-02-01T00:00:00.000Z',
        link: [
          { rel: 'self', href: 'https://raw.githubusercontent.com/x/y.json' },
        ],
      },
      {
        id: 'ICSA-24-001-01',
        title: 'Axis Communications A1001',
        updated: '2024-01-01T00:00:00.000Z',
        link: [{ rel: 'self', href: AXIS_DOC }],
      },
    ],
  },
};

/** A response with JSON and a live body so it can be cancelled/read. */
const json = (body) => new Response(JSON.stringify(body), { status: 200 });

test('brand aliases resolve to the NVD vocabulary and unknown brands do not', () => {
  assert.equal(brandFor('Axis'), 'axis');
  assert.equal(brandFor('Hanwha Techwin'), 'hanwha');
  assert.equal(brandFor('BOSCH Security Systems'), 'bosch');
  assert.equal(brandFor('Acme'), null);
  assert.equal(brandFor(''), null);
  assert.deepEqual(cameraHardware(cameras[0]), {
    brand: 'axis',
    model: 'Q6135-LE',
  });
  assert.equal(
    cameraHardware(cameras[2]),
    null,
    'a brand without a model is not a join key',
  );
  assert.equal(
    cameraHardware({ manufacturer: 'Acme', model: 'X100' }),
    null,
    'an unknown brand is not guessed at',
  );
});

test('model keys separate the whole model from its numbered series', () => {
  assert.deepEqual(modelKeys('DS-2CD2087G3-LI2UY', 'hikvision'), {
    modelKey: 'ds2cd2087g3li2uy',
    seriesKey: '2cd2087g3',
  });
  assert.deepEqual(modelKeys('Q6135-LE', 'axis'), {
    modelKey: 'q6135le',
    seriesKey: 'q6135',
  });
  // A brand prefix in the model string is not part of the model token.
  assert.equal(modelKeys('AXIS P3707-PE', 'axis').modelKey, 'p3707pe');
  // A model too short to be unambiguous keeps no series key.
  assert.equal(modelKeys('M10', 'axis').seriesKey, '');
  // A bare number is not a family name either: it would match any product
  // carrying that number.
  assert.equal(modelKeys('AUTODOME IP 4000 HD', 'bosch').seriesKey, '');
});

test('a CPE criterion becomes the product words the model is compared with', () => {
  assert.deepEqual(
    cpeProduct(
      'cpe:2.3:o:axis:m10_series_network_cameras_firmware:*:*:*:*:*:*:*:*',
    ),
    { vendor: 'axis', product: 'm10_series_network_cameras' },
  );
  assert.equal(cpeProduct('not-a-cpe'), null);
  assert.equal(cpeProduct('cpe:2.3:o:axis:*:*:*:*:*:*:*:*'), null);
});

test('severity bands follow the CVSS ranges and named labels', () => {
  assert.equal(severityBand(9.8), 'critical');
  assert.equal(severityBand(9), 'critical');
  assert.equal(severityBand(8.9), 'high');
  assert.equal(severityBand(7), 'high');
  assert.equal(severityBand(5.3), 'medium');
  assert.equal(severityBand(2.1), 'low');
  assert.equal(severityBand(0.1), 'low');
  assert.equal(severityBand(0), 'unscored');
  assert.equal(severityBand(null, 'HIGH'), 'high');
  assert.equal(severityBand(null, 'unknown'), 'unscored');
});

test('a model match outranks a series match, and a brand alone flags nothing', () => {
  const advisory = (id, products) => ({
    source: 'nvd',
    id,
    title: id,
    products,
    brands: ['axis'],
    score: 7,
    severity: 'high',
    cves: [id],
  });
  const hardware = { brand: 'axis', model: 'Q6135-LE' };
  const keys = modelKeys('Q6135-LE', 'axis');
  assert.equal(
    matchPrecision(advisory('a', ['Q6135 LE firmware']), hardware, keys),
    'model',
  );
  assert.equal(
    matchPrecision(advisory('b', ['Q6135 series firmware']), hardware, keys),
    'series',
  );
  assert.equal(
    matchPrecision(advisory('c', ['Camera Station']), hardware, keys),
    null,
  );

  const result = buildFindings({
    cameras: [cameras[0], cameras[2]],
    advisories: [advisory('CVE-1', ['Camera Station'])],
  });
  assert.equal(
    result.findings.length,
    0,
    'brand noise never becomes a finding',
  );
  assert.equal(result.stats.brandOnlyAdvisories, 1);
  assert.equal(result.stats.identified, 1);
});

test('findings are worst-first and one per camera', () => {
  const advisories = [
    {
      source: 'nvd',
      id: 'CVE-2024-0002',
      title: 'medium',
      products: ['AUTODOME IP 4000 HD firmware'],
      brands: ['bosch'],
      score: 5.3,
      severity: 'medium',
      cves: ['CVE-2024-0002'],
    },
    {
      source: 'nvd',
      id: 'CVE-2024-0001',
      title: 'critical',
      products: ['Q6135 LE firmware'],
      brands: ['axis'],
      score: 9.8,
      severity: 'critical',
      cves: ['CVE-2024-0001'],
    },
  ];
  const { findings, stats } = buildFindings({
    cameras,
    advisories,
    maxFindings: 1,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 'kc-1');
  assert.equal(findings[0].worstSeverity, 'critical');
  assert.equal(stats.flagged, 2);
  assert.equal(stats.truncated, true);
  assert.deepEqual(stats.bySeverity, {
    critical: 1,
    high: 0,
    medium: 1,
    low: 0,
    unscored: 0,
  });
  assert.equal(stats.brands[0].id, 'axis');
});

test('a CSAF advisory document yields products, CVEs, brands and its page', () => {
  const record = parseCisaAdvisory(axisDoc, { id: 'ICSA-26-001-01' });
  assert.equal(record.source, 'cisa');
  assert.equal(record.id, 'ICSA-26-001-01');
  assert.match(
    record.url,
    /cisa\.gov\/news-events\/ics-advisories\/icsa-26-001-01$/,
  );
  assert.deepEqual(record.products, [
    'Axis Communications',
    'Camera Station',
    'Device Manager',
  ]);
  assert.deepEqual(record.brands, ['axis']);
  assert.deepEqual(record.cves, ['CVE-2025-5000']);
  assert.equal(record.score, 7.5);
  assert.equal(record.severity, 'high');
  assert.equal(record.published, '2026-01-01T00:00:00.000Z');
});

test('an NVD CVE without CPE applicability cannot name a product', () => {
  assert.equal(parseNvdCve({ ...axisCve, configurations: [] }), null);
  const record = parseNvdCve(axisCve);
  assert.equal(record.id, 'CVE-2024-0001');
  assert.deepEqual(record.products, ['q6135 le']);
  assert.deepEqual(record.brands, ['axis']);
  assert.equal(record.score, 9.8);
  assert.equal(record.severity, 'critical');
  assert.match(record.url, /nvd\.nist\.gov\/vuln\/detail\/CVE-2024-0001$/);
});

test('the feed is filtered to fleet brands, newest first, then capped', () => {
  const entries = cisaEntriesForBrands(feed, new Set(['axis']), 5);
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ['ICSA-26-001-01', 'ICSA-24-001-01'],
  );
  assert.equal(cisaEntriesForBrands(feed, new Set(['axis']), 1).length, 1);
  assert.equal(cisaEntriesForBrands(feed, new Set(), 5).length, 0);
});

test('only the two advisory services are readable', () => {
  for (const host of ADVISORY_HOSTS) {
    assert.equal(isAdvisoryUrl(`https://${host}/anything`), true);
  }
  assert.equal(
    isAdvisoryUrl('https://cctv.travelmidwest.com/snapshots/x.jpg'),
    false,
  );
  assert.equal(isAdvisoryUrl('http://127.0.0.1/admin'), false);
  assert.equal(isAdvisoryUrl('not a url'), false);
});

test('the route joins the catalogue with both sources and never fetches a camera', async () => {
  const requested = [];
  const proxy = cameraAdvisoriesProxy({
    getCatalog: async () => cameras,
    fetchImpl: async (url) => {
      const href = String(url);
      requested.push(href);
      if (href === FEED) return json(feed);
      if (href === AXIS_DOC) return json(axisDoc);
      if (href.startsWith(NVD_CVE_API)) {
        const vendor = new URL(href).searchParams.get('virtualMatchString');
        if (vendor === 'cpe:2.3:o:axis') {
          return json({ totalResults: 1, vulnerabilities: [{ cve: axisCve }] });
        }
        if (vendor === 'cpe:2.3:o:bosch') {
          return json({
            totalResults: 1,
            vulnerabilities: [{ cve: boschCve }],
          });
        }
        return json({ totalResults: 0, vulnerabilities: [] });
      }
      throw new Error(`unexpected request ${href}`);
    },
    now: () => 1_000_000,
  });

  const res = await call(proxy);
  assert.equal(res.status, 200);
  const body = res.body;
  assert.equal(body.deviceContact, 'none');
  assert.equal(body.firmwareObserved, false);
  assert.equal(body.cameras.total, 4);
  assert.equal(body.cameras.identified, 2);
  assert.deepEqual(
    body.findings.map((finding) => finding.id),
    ['kc-1', 'kc-2'],
  );
  assert.equal(body.findings[0].matches[0].id, 'CVE-2024-0001');
  assert.equal(body.counts.critical, 1);
  assert.equal(body.counts.medium, 1);
  assert.equal(body.counts.brandOnlyAdvisories, 1);
  assert.equal(body.sources[0].ok, true);
  assert.equal(body.sources[1].ok, true);
  // Every outbound request was an advisory service; nothing a camera publishes
  // was opened, and the catalogue was read from memory.
  assert.ok(requested.length > 0);
  for (const href of requested) {
    assert.equal(
      isAdvisoryUrl(href),
      true,
      `${href} is not an advisory service`,
    );
  }
  assert.equal(
    requested.some((href) => /snapshot|frame|stream|cctv\/media/i.test(href)),
    false,
  );
});

test('the answer is cached, and a failed rebuild serves the previous one', async () => {
  let calls = 0;
  let catalogFails = false;
  let clock = 1_000_000;
  const proxy = cameraAdvisoriesProxy({
    getCatalog: async () => {
      if (catalogFails) throw new Error('catalogue unavailable');
      return cameras;
    },
    cacheMs: 1000,
    now: () => clock,
    fetchImpl: async (url) => {
      calls += 1;
      if (String(url) === FEED) return json({ feed: { entry: [] } });
      return json({ totalResults: 0, vulnerabilities: [] });
    },
  });
  const first = await call(proxy);
  assert.equal(first.status, 200);
  const callsAfterFirst = calls;
  const second = await call(proxy);
  assert.equal(second.body.ageMs, 0);
  assert.equal(
    calls,
    callsAfterFirst,
    'a cached answer costs no upstream read',
  );

  clock += 5000;
  catalogFails = true;
  const stale = await call(proxy);
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.counts.advisories, 0);
});

test('the route is a GET-only kill-switchable endpoint', async () => {
  const disabled = cameraAdvisoriesProxy({
    getCatalog: async () => cameras,
    enabled: false,
  });
  const refused = await call(disabled, { method: 'GET' });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error, 'camera_advisories_disabled');

  const proxy = cameraAdvisoriesProxy({
    getCatalog: async () => cameras,
    fetchImpl: async () => json({ feed: { entry: [] } }),
  });
  const post = await call(proxy, { method: 'POST' });
  assert.equal(post.status, 405);
  const foreign = await call(proxy, {
    method: 'GET',
    headers: { origin: 'https://evil.example', host: 'localhost:5173' },
  });
  assert.equal(foreign.status, 403);
});

test('the NVD brand budget is reported instead of silently spent', async () => {
  const many = [
    ...cameras,
    {
      id: 'b1',
      name: 'b1',
      lat: 1,
      lon: 1,
      manufacturer: 'Dahua',
      model: 'IPC-HFW1234',
    },
    {
      id: 'b2',
      name: 'b2',
      lat: 1,
      lon: 1,
      manufacturer: 'Vivotek',
      model: 'FD9380-H',
    },
    {
      id: 'b3',
      name: 'b3',
      lat: 1,
      lon: 1,
      manufacturer: 'Hikvision',
      model: 'DS-2CD2087G3',
    },
    {
      id: 'b4',
      name: 'b4',
      lat: 1,
      lon: 1,
      manufacturer: 'Hanwha',
      model: 'XNP-6400RW',
    },
  ];
  const queries = [];
  const proxy = cameraAdvisoriesProxy({
    getCatalog: async () => many,
    fetchImpl: async (url) => {
      if (String(url) === FEED) return json({ feed: { entry: [] } });
      queries.push(String(url));
      return json({ totalResults: 0, vulnerabilities: [] });
    },
  });
  const body = (await call(proxy)).body;
  assert.equal(queries.length, 4, 'one request per queried brand');
  assert.equal(body.cameras.brands.filter((brand) => brand.queried).length, 4);
  assert.equal(
    body.cameras.brands.filter((brand) => !brand.queried).length >= 1,
    true,
  );
});

test('the payload counts cameras the join could not identify', () => {
  const payload = cameraAdvisoryPayload({
    cameras,
    records: [],
    cisa: {},
    nvd: {},
  });
  assert.equal(payload.cameras.total, 4);
  assert.equal(payload.cameras.identified, 2);
  assert.deepEqual(
    payload.cameras.brands.map((brand) => brand.id),
    ['axis', 'bosch'],
  );
  assert.equal(payload.counts.flagged, 0);
  assert.deepEqual(catalogueBrands(cameras), [
    { brand: brandRecord('axis'), cameras: 1 },
    { brand: brandRecord('bosch'), cameras: 1 },
  ]);
});

/** Invoke the plugin handler and return its status and parsed body. */
async function call(proxy, { method = 'GET', headers = {} } = {}) {
  const res = {
    status: 0,
    headers: {},
    body: null,
    destroyed: false,
    writeHead(status, values = {}) {
      this.status = status;
      Object.assign(this.headers, values);
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(text) {
      this.body = text ? JSON.parse(text) : null;
      this.done?.();
    },
  };
  const done = new Promise((resolve) => {
    res.done = resolve;
  });
  proxy.handler({ method, url: '/', headers }, res);
  await Promise.race([
    done,
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  if (res.body === null) throw new Error('handler did not answer');
  return {
    status: res.status || res.statusCode || 0,
    body: res.body,
    headers: res.headers,
  };
}
