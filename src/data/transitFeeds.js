import { greatCircleKm } from '../geoDistance.js';

/**
 * @module transitFeeds
 * @description Registry of keyless, openly licensed GTFS-Realtime
 * VehiclePositions feeds the Transit layer can show.
 *
 * Every entry here is a URL the SERVER fetches — the browser only ever asks
 * `/api/transit/vehicles/<id>` for a registered id (see SECURITY.md: proxies
 * never fetch client-supplied URLs). Adding a feed means adding a row here,
 * a DATA_SOURCES.md row with its license, and a credit in dataCredits.js.
 *
 * Admission rules for a feed:
 *  - No key, token, or registration required (identify-yourself headers are
 *    fine — Entur asks for `ET-Client-Name`, OVapi for a User-Agent).
 *  - An open license that permits display with attribution.
 *  - Real coordinates in VehiclePosition.position — NYCT subway, for example,
 *    publishes stop-relative positions only and is deliberately absent.
 *
 * `defaultEnabled` is separate from being registered. A feed ships switched ON
 * only when its operator's own published terms were READ and plainly cover this
 * use. A registered feed with `defaultEnabled: false` is never polled and never
 * offered to the browser; it is here so the decision is visible and reversible
 * in one line. `terms` records the passage that decision rests on, so the next
 * reader does not have to take the licence string on faith.
 *
 * Pure data + pure helpers: imported by the browser layer, the Vite proxy, and
 * node:test. No Cesium, no Node built-ins.
 */

/** Transit modes the layer colors. `routeMode` hints refine a feed's default. */
export const TRANSIT_MODES = Object.freeze([
  'bus',
  'tram',
  'subway',
  'rail',
  'ferry',
  'unknown',
]);

/** Per-mode icon used in labels and the selection card. */
export const TRANSIT_MODE_ICON = Object.freeze({
  bus: '🚌',
  tram: '🚊',
  subway: '🚇',
  rail: '🚆',
  ferry: '⛴️',
  unknown: '🚏',
});

/**
 * MBTA route ids are human-readable and mode-typed: rapid-transit lines carry
 * colour names, commuter rail is prefixed `CR-`, ferries `Boat-`, buses are
 * numeric (or `SL`/`CT` express families).
 * @param {string|null} routeId
 * @returns {string}
 */
function mbtaRouteMode(routeId) {
  if (!routeId) return 'unknown';
  if (/^(Red|Orange|Blue)\b/.test(routeId)) return 'subway';
  if (/^(Green|Mattapan)/.test(routeId)) return 'tram';
  if (/^CR-/.test(routeId)) return 'rail';
  if (/^Boat-/.test(routeId)) return 'ferry';
  if (/^Shuttle/i.test(routeId)) return 'bus';
  return 'bus';
}

/**
 * Entur (Norway) route ids are `<codespace>:Line:<local-id>`; the codespace
 * tells the operator, not the mode, but a few are single-mode operators.
 * @param {string|null} routeId
 * @returns {string}
 */
function enturRouteMode(routeId) {
  if (!routeId) return 'unknown';
  const codespace = routeId.split(':')[0];
  if (
    codespace === 'VYG' ||
    codespace === 'GJB' ||
    codespace === 'SJN' ||
    codespace === 'FLT' ||
    codespace === 'GOA' ||
    codespace === 'NSB' ||
    codespace === 'VYT'
  )
    return 'rail';
  if (codespace === 'FLB') return 'rail';
  return 'bus';
}

/**
 * HSL route ids start with a four-digit code whose first digit is the mode
 * family in HSL's numbering: 1xxx/2xxx… are trams (1001–1010) for 4-digit ids
 * beginning with `10`, metro routes are `31M…`, ferries `1019`.
 * @param {string|null} routeId
 * @returns {string}
 */
function hslRouteMode(routeId) {
  if (!routeId) return 'unknown';
  if (/^31M/.test(routeId)) return 'subway';
  if (/^10(0[1-9]|10|15)/.test(routeId)) return 'tram';
  if (/^1019/.test(routeId)) return 'ferry';
  if (/^300[0-9A-Z]/.test(routeId)) return 'rail';
  return 'bus';
}

/**
 * Metro Transit (Minneapolis–St Paul): light rail is the Blue/Green line
 * (route ids 901/902), Northstar commuter rail is 888.
 * @param {string|null} routeId
 * @returns {string}
 */
function metroTransitRouteMode(routeId) {
  if (!routeId) return 'unknown';
  if (routeId === '901' || routeId === '902') return 'tram';
  if (routeId === '888') return 'rail';
  return 'bus';
}

/**
 * TTC BusTime is the SURFACE feed: buses and streetcars, never the subway.
 * Streetcar routes are the 500-series, plus the four Blue Night routes that
 * run on streetcar trackage (301 Queen, 304 King, 306 Carlton, 310 Spadina);
 * the rest of the 300-series is night buses.
 * @param {string|null} routeId
 * @returns {string}
 */
function ttcRouteMode(routeId) {
  if (!routeId) return 'unknown';
  if (/^5\d\d$/.test(routeId)) return 'tram';
  if (/^(301|304|306|310)$/.test(routeId)) return 'tram';
  return 'bus';
}

/**
 * The fleet number settles TTC's mode before the route does: buses replace
 * streetcars on 5xx routes during track work, and streetcars running out of
 * service report no route at all. Flexity streetcars are numbered 4400–4699;
 * every other TTC number is a bus.
 * @param {string|null} vehicleId GTFS-RT vehicle id (the fleet number).
 * @returns {string}
 */
function ttcVehicleMode(vehicleId) {
  if (!/^\d{4}$/.test(String(vehicleId ?? ''))) return 'unknown';
  const fleet = Number(vehicleId);
  return fleet >= 4400 && fleet < 4700 ? 'tram' : 'bus';
}

/**
 * Guelph Transit's realtime feed publishes the internal database key of a
 * route (`2991`), not the number on the front of the bus (`1`). Without this
 * table the detection label reads "Route 2991", which is not what anyone at
 * the stop calls it. Route ids and short names are from the City of Guelph's
 * own published GTFS `routes.txt` (see DATA_SOURCES.md); an id missing here
 * falls through unchanged, so a route added later degrades to its raw id
 * rather than disappearing.
 */
const GUELPH_ROUTE_NAMES = Object.freeze({
  2991: '1',
  2992: '10',
  2993: '11',
  2994: '12',
  2995: '13',
  2996: '14',
  2997: '15',
  2998: '16',
  2999: '17',
  3000: '18',
  3001: '19',
  3002: '2',
  3003: '20',
  3004: '3',
  3005: '4',
  3006: '5',
  3007: '50 U',
  3008: '52 U',
  3009: '56 U',
  3010: '58 U',
  3011: '6',
  3012: '7',
  3013: '8',
  3014: '9',
  3015: '98',
  3016: '99',
  3017: '99Lite',
  3018: 'BREW',
  3019: 'EdiCol',
  3023: 'IroHarv',
  3030: 'Sun LN',
  3032: 'WHanSco',
  3039: 'ZehCha',
});

/**
 * Guelph route id to the number a rider would say.
 * @param {string|null} routeId
 * @returns {string|null}
 */
function guelphRouteLabel(routeId) {
  return GUELPH_ROUTE_NAMES[routeId] || routeId;
}

/**
 * Hamilton publishes an internal key for every route: not one of HSR's 80 route
 * ids equals the number on the bus, so an untranslated feed reads as
 * "Route 5783" city-wide. Two generations of id are live at once — `5688` and
 * `5780` are both the 2 BARTON — and both are listed, because both arrive.
 *
 * Numbers are unpadded to match the rest of the registry (`routes.txt` says
 * `02`; a rider says 2). The seasonal and event shuttles publish a name rather
 * than a number — `TC230`, `PEACH`, `ROCKTON` — and those are already what a
 * rider would say, so they survive as published. Ids and names are from the
 * City's own published GTFS `routes.txt`, under the same terms as the feed.
 */
const HAMILTON_ROUTE_NAMES = Object.freeze({
  5687: '1',
  5688: '2',
  5689: '3',
  5690: '4',
  5691: '5',
  5692: '6',
  5693: '7',
  5694: '8',
  5695: '9',
  5696: '10',
  5697: '11',
  5698: '12',
  5699: '16',
  5700: '18',
  5701: '20',
  5702: '21',
  5703: '22',
  5704: '23',
  5705: '24',
  5706: '25',
  5707: '26',
  5708: '27',
  5709: '33',
  5710: '34',
  5711: '35',
  5712: '41',
  5713: '42',
  5714: '43',
  5715: '44',
  5716: '51',
  5717: '52',
  5718: '55',
  5719: '56',
  5720: '99',
  5731: 'X-IND',
  5780: '2',
  5781: '3',
  5782: '4',
  5783: '5',
  5784: '6',
  5785: '7',
  5786: '8',
  5787: '9',
  5789: '11',
  5790: '12',
  5791: '16',
  5792: '18',
  5793: '20',
  5794: '21',
  5795: '22',
  5796: '23',
  5797: '24',
  5798: '25',
  5799: '26',
  5800: '27',
  5801: '33',
  5802: '34',
  5803: '35',
  5805: '42',
  5806: '43',
  5807: '44',
  5808: '51',
  5809: '52',
  5811: '56',
  5812: '99',
  5820: 'TC230',
  5823: 'X IND',
  5824: 'TC-700',
  5825: 'TC-300',
  5826: 'CAN',
  5827: 'PEACH',
  5828: '1',
  5829: '10',
  5830: '41',
  5831: '55',
  5832: 'TC300',
  5833: 'TC700',
  5834: 'TC730',
  5835: 'ANCFAIR',
  5836: 'ROCKTON',
});

/**
 * Hamilton route id to the number a rider would say.
 * @param {string|null} routeId
 * @returns {string|null}
 */
function hamiltonRouteLabel(routeId) {
  return HAMILTON_ROUTE_NAMES[routeId] || routeId;
}

/**
 * YRT publishes Viva bus rapid transit by route id (`601`), while every rider,
 * station sign and map calls it "Viva Blue". Plain local routes are already the
 * number on the bus and are left alone, unpadded: `105` reads better than the
 * `005` of `routes.txt`.
 *
 * Branches are the exception. YRT suffixes a two-digit branch onto the base
 * route — the scheme Viva's own `60102` follows — so a branch id reaches a
 * rider as "8301" unless it is translated. Names and colours are from York
 * Region's own published GTFS `routes.txt`; Viva Green (604) and Pink (606)
 * are not in current service and so are absent here too.
 *
 * Only branches observed live AND published in `routes.txt` are listed. `9101`
 * runs but is unpublished, so it is deliberately missing: the pattern suggests
 * "91A", and suggesting is not knowing.
 */
const YRT_ROUTE_NAMES = Object.freeze({
  601: 'Viva Blue',
  60102: 'Viva Blue B',
  603: 'Viva Purple',
  60301: 'Viva Purple A',
  605: 'Viva Orange',
  607: 'Viva Yellow',
  8301: '83A',
  9002: '90B',
  10702: '107B',
});

/**
 * YRT route id to the name a rider would say.
 * @param {string|null} routeId
 * @returns {string|null}
 */
function yrtRouteLabel(routeId) {
  return YRT_ROUTE_NAMES[routeId] || routeId;
}

/**
 * Burlington publishes the internal key of a route, and the keys are a trap:
 * `351` is route 1 while `3510` is route 10, so trimming a `35` prefix gets
 * the wrong answer on half the network. The join is the only correct route.
 * Ids and numbers are from the City's own published GTFS `routes.txt`, which
 * sits in the same directory as the realtime feed under the same terms.
 */
const BURLINGTON_ROUTE_NAMES = Object.freeze({
  351: '1',
  352: '2',
  353: '3',
  354: '4',
  356: '6',
  3510: '10',
  3511: '11',
  3512: '12',
  3525: '25',
  3548: '48',
  3550: '50',
  3551: '51',
  3552: '52',
  3580: '80',
  3581: '81',
  3587: '87',
});

/**
 * Burlington route id to the number a rider would say.
 * @param {string|null} routeId
 * @returns {string|null}
 */
function burlingtonRouteLabel(routeId) {
  return BURLINGTON_ROUTE_NAMES[routeId] || routeId;
}

/**
 * The two licence codes transport.data.gouv.fr publishes for French realtime
 * datasets. Every French entry below ships on one of them, so each grant is
 * quoted once here and referenced by the row, instead of eighteen copies of
 * the same passage drifting apart.
 */
const FR_LOV2_LICENSE = 'Licence Ouverte 2.0';
const FR_LOV2_URL = 'https://www.data.gouv.fr/pages/legal/licences/etalab-2.0';
const FR_ODBL_LICENSE = 'Open Database License 1.0 (ODbL)';
const FR_ODBL_URL = 'https://opendatacommons.org/licenses/odbl/1-0/';

const FR_LOV2_TERMS = Object.freeze({
  quote:
    'Le « Concédant » concède au « Réutilisateur » un droit non exclusif et gratuit de libre « Réutilisation » de l’« Information » … à des fins commerciales ou non, dans le monde entier et pour une durée illimitée … Sous réserve de : mentionner la paternité de l’« Information » : sa source (a minima le nom du « Concédant ») et la date de la dernière mise à jour de l’« Information » réutilisée.',
  note: 'Licence Ouverte 2.0, the grant the catalogue records as `lov2`. Reuse, including commercial reuse, needs one thing: name the producer and the date the data was last updated. The credit names the network and the authority; the licence also forbids letting that credit suggest the producer endorses this app.',
});

const FR_ODBL_TERMS = Object.freeze({
  quote:
    'You are free: To share: To copy, distribute and use the database … As long as you: Attribute: You must attribute any public use of the database, or works produced from the database, in the manner specified in the ODbL … and keep intact any notices on the original database.',
  note: 'ODbL 1.0, the grant the catalogue records as `odc-odbl`. Its share-alike clause reaches a redistributed or adapted database, not the display of live vehicle positions this layer draws, which is a produced work citing the database; the attribution and the licence name travel with the credit as the licence asks.',
});

/**
 * Rail routes among the French feeds, keyed by the route id the realtime feed
 * publishes, with the mode, the line name and the line colour each operator's
 * own published GTFS `routes.txt` states for it (`route_type` 0 = tram, 1 =
 * metro, `route_short_name`, `route_color`, `route_text_color`). Read on
 * 2026-10-24 from the static GTFS of the same dataset, which is the same file
 * the operator ships with the realtime resource — not inferred from a line's
 * number, which is how Rouen's `T1`–`T5` would be misread as trams when they
 * are TEOR buses.
 *
 * `color` is the operator's own line colour, uppercased and prefixed with `#`,
 * or null where the feed publishes none (Le Havre leaves `route_color` empty):
 * the sprite then keeps the mode colour rather than inventing one. `ink` is the
 * operator's `route_text_color` for the two yellow lines whose label needs
 * black text to stay readable, and is derived from luminance elsewhere.
 *
 * Only what the feed can actually be matched on is listed:
 *  - Fil Bleu publishes no route id at all (every vehicle's is null) and no
 *    route in its trip ids, so Tours' tram A cannot be told apart: absent.
 *  - Le Met' types its Mettis bus lines `O1`/`O2` as ferry (4) upstream, which
 *    is a data error, not a ferry: absent rather than rendered as one.
 *  - Transvilles' live ids carry the GTFS route number, so `190` (T1) and `191`
 *    (T2) are trams while `192` is a bus branch (T2B) the operator itself types
 *    as bus: only the two tram ids are listed.
 *  - Brest's line C is a cable car (`route_type` 6) and has no mode in
 *    TRANSIT_MODES, so it is left at the feed default.
 *  - Rouen's one rail line is the branched tramway the operator markets as
 *    "Métro" and types 1; it renders as subway because that is what the feed
 *    says, while its TEOR corridors stay buses.
 * A vehicle on a route id listed here is resolved; every other id falls through
 * to the feed's `defaultMode`, so a new line appearing upstream is never given
 * a mode this table did not establish.
 */
const FRENCH_RAIL_ROUTES = Object.freeze({
  'star-rennes': Object.freeze({
    '7-1001': Object.freeze({ mode: 'subway', label: 'a', color: '#EE1D23' }),
    '7-1002': Object.freeze({ mode: 'subway', label: 'b', color: '#00893E' }),
  }),
  'divia-dijon': Object.freeze({
    '4-T1': Object.freeze({ mode: 'tram', label: 'T1', color: '#AB0672' }),
    '4-T2': Object.freeze({ mode: 'tram', label: 'T2', color: '#AB0672' }),
  }),
  'bibus-brest': Object.freeze({
    A: Object.freeze({ mode: 'tram', label: 'A', color: '#DE007E' }),
    B: Object.freeze({ mode: 'tram', label: 'B', color: '#004F9E' }),
  }),
  'setram-lemans': Object.freeze({
    T1: Object.freeze({ mode: 'tram', label: 'T1', color: '#E4151E' }),
    T2: Object.freeze({ mode: 'tram', label: 'T2', color: '#0D65AE' }),
  }),
  'lia-lehavre': Object.freeze({
    // Le Havre publishes no route_color for its trams: no invented colour.
    '8-A': Object.freeze({ mode: 'tram', label: 'A', color: null }),
    '8-B': Object.freeze({ mode: 'tram', label: 'B', color: null }),
  }),
  'irigo-angers': Object.freeze({
    A: Object.freeze({ mode: 'tram', label: 'A', color: '#E30613' }),
    B: Object.freeze({ mode: 'tram', label: 'B', color: '#00569D' }),
    C: Object.freeze({ mode: 'tram', label: 'C', color: '#379E32' }),
  }),
  'tam-montpellier': Object.freeze({
    1: Object.freeze({ mode: 'tram', label: '1', color: '#005CA9' }),
    2: Object.freeze({ mode: 'tram', label: '2', color: '#EF7D00' }),
    3: Object.freeze({
      mode: 'tram',
      label: '3',
      color: '#C8D400',
      ink: '#000000',
    }),
    4: Object.freeze({ mode: 'tram', label: '4', color: '#4B2A0E' }),
    5: Object.freeze({ mode: 'tram', label: '5', color: '#287431' }),
  }),
  'lignes-dazur-nice': Object.freeze({
    L1: Object.freeze({ mode: 'tram', label: 'L1', color: '#D20A11' }),
    L2: Object.freeze({ mode: 'tram', label: 'L2', color: '#1F488F' }),
    L3: Object.freeze({ mode: 'tram', label: 'L3', color: '#00853E' }),
    B: Object.freeze({
      mode: 'tram',
      label: 'B',
      color: '#FFDD00',
      ink: '#000000',
    }),
  }),
  'astuce-rouen': Object.freeze({
    'TCAR:90': Object.freeze({
      mode: 'subway',
      // i18n-ignore: the operator's own line name, shown as published
      label: 'Métro',
      color: '#123E8B',
    }),
  }),
  'transvilles-valenciennes': Object.freeze({
    'NAVINEO:Line::190:LOC': Object.freeze({
      mode: 'tram',
      label: 'T1',
      color: '#E62655',
    }),
    'NAVINEO:Line::191:LOC': Object.freeze({
      mode: 'tram',
      label: 'T2',
      color: '#E06143',
    }),
  }),
});

/** Flat `feedId\0routeId` → rail entry, so a lookup is one Map get. */
const FRENCH_RAIL_BY_ROUTE = new Map(
  Object.entries(FRENCH_RAIL_ROUTES).flatMap(([feedId, routes]) =>
    Object.entries(routes).map(([routeId, entry]) => [
      `${feedId}\0${routeId}`,
      entry,
    ]),
  ),
);

/**
 * The rail facts a French feed's route id establishes, or null.
 * @param {string} feedId
 * @param {string|null} routeId
 * @returns {{mode: string, label: string, color: string|null, ink?: string}|null}
 */
function frenchRailRoute(feedId, routeId) {
  if (!routeId) return null;
  return FRENCH_RAIL_BY_ROUTE.get(`${feedId}\0${routeId}`) ?? null;
}

/**
 * The rail mode a French feed's route id establishes, or null.
 * @param {string} feedId
 * @param {string|null} routeId
 * @returns {string|null}
 */
function frenchRouteMode(feedId, routeId) {
  return frenchRailRoute(feedId, routeId)?.mode ?? null;
}

/**
 * One French urban feed: the row without the licence boilerplate, which
 * `licence` fills from the pair above. `terms` is shared and frozen, so a row
 * cannot acquire a grant its dataset does not carry, and a typo in the code
 * fails loudly here rather than shipping under the wrong licence.
 * @param {{ id: string, name: string, operator: string, attribution: string,
 *   region: string, lat: number, lon: number, loadRadiusKm: number,
 *   url: string, licence: 'lov2'|'odc-odbl' }} row
 * @returns {Readonly<object>}
 */
function frenchFeed(row) {
  const odbl = row.licence === 'odc-odbl';
  if (!odbl && row.licence !== 'lov2') {
    throw new Error(`unknown licence code for ${row.id}: ${row.licence}`);
  }
  return Object.freeze({
    id: row.id,
    name: row.name,
    operator: row.operator,
    region: row.region,
    center: Object.freeze({ lat: row.lat, lon: row.lon }),
    loadRadiusKm: row.loadRadiusKm,
    url: row.url,
    license: odbl ? FR_ODBL_LICENSE : FR_LOV2_LICENSE,
    licenseUrl: odbl ? FR_ODBL_URL : FR_LOV2_URL,
    attribution: row.attribution,
    defaultEnabled: true,
    terms: odbl ? FR_ODBL_TERMS : FR_LOV2_TERMS,
    defaultMode: 'bus',
    // Only a feed with a rail route gets the hook: its absence keeps meaning
    // "this feed establishes no route mode in TRANSIT_MODES".
    ...(FRENCH_RAIL_ROUTES[row.id]
      ? { routeMode: (routeId) => frenchRouteMode(row.id, routeId) }
      : {}),
  });
}

/**
 * Registry of feeds. Order is presentation order in the stats/credit text.
 * `loadRadiusKm` is the distance from `center` inside which the feed is polled.
 * @type {ReadonlyArray<Readonly<{
 *   id: string, name: string, operator: string, region: string,
 *   center: {lat: number, lon: number}, loadRadiusKm: number,
 *   url: string, headers?: Record<string, string>,
 *   license: string, licenseUrl: string, attribution: string,
 *   defaultMode: string, routeMode?: (routeId: string|null) => string,
 * }>>}
 */
export const TRANSIT_FEED_REGISTRY = Object.freeze([
  Object.freeze({
    id: 'mbta',
    historyRetention: true,
    name: 'MBTA',
    operator: 'Massachusetts Bay Transportation Authority',
    region: 'Boston, MA',
    center: Object.freeze({ lat: 42.3601, lon: -71.0589 }),
    loadRadiusKm: 70,
    url: 'https://cdn.mbta.com/realtime/VehiclePositions.pb',
    license: 'MassDOT Developers License Agreement',
    licenseUrl:
      'https://cdn.mbta.com/sites/default/files/2023-08/mbta-massdot-develop-license-agreement.pdf',
    attribution: 'MBTA / MassDOT',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'MassDOT ... hereby grants You (Licensee) non-exclusive, limited, and revocable rights to use, reproduce, and redistribute the Data. ... Clearly acknowledge MassDOT as the provider of the Data.',
      note: 'Credit is text only: the agreement forbids using MBTA/MassDOT logos or trademarks with the data.',
    }),
    defaultMode: 'bus',
    routeMode: mbtaRouteMode,
  }),
  Object.freeze({
    id: 'capmetro-austin',
    name: 'CapMetro',
    operator: 'Capital Metropolitan Transportation Authority',
    region: 'Austin, TX',
    center: Object.freeze({ lat: 30.2672, lon: -97.7431 }),
    loadRadiusKm: 60,
    url: 'https://data.texas.gov/download/eiei-9rpf/application%2Foctet-stream',
    license: 'CapMetro Developer Tools license',
    licenseUrl: 'https://www.capmetro.org/developertools',
    attribution:
      'Capital Metropolitan Transportation Authority — data.texas.gov',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'Capital Metropolitan Transportation Authority (CMTA) hereby grants you (Licensee) non-exclusive, limited and revocable rights to use, reproduce, and redistribute CMTA Data.',
      note: 'CMTA trademarks may not be used in association with the data, so the credit is the operator name as text.',
    }),
    defaultMode: 'bus',
  }),
  Object.freeze({
    id: 'metrotransit-msp',
    name: 'Metro Transit',
    operator: 'Metro Transit (Metropolitan Council)',
    region: 'Minneapolis–St Paul, MN',
    center: Object.freeze({ lat: 44.9778, lon: -93.265 }),
    loadRadiusKm: 70,
    url: 'https://svc.metrotransit.org/mtgtfs/vehiclepositions.pb',
    license: 'Public Metro Transit vehicle position data',
    licenseUrl: 'https://svc.metrotransit.org/',
    attribution: 'Metro Transit — Metropolitan Council',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        "Metro Transit's GTFS-realtime feeds are refreshed every 5 seconds.",
      note: 'The realtime feed is published from a developer page carrying operational guidance and no licence text of its own. The public-domain statement below belongs to the Metropolitan Council metadata for the COMPANION SCHEDULE dataset, not to this feed: "None. This dataset is public domain under the Minnesota Government Data Practices Act". Credited as a courtesy, the way the other public agency feeds are.',
    }),
    defaultMode: 'bus',
    routeMode: metroTransitRouteMode,
  }),
  Object.freeze({
    id: 'hsl-helsinki',
    name: 'HSL',
    operator: 'Helsinki Region Transport (HSL)',
    region: 'Helsinki, Finland',
    center: Object.freeze({ lat: 60.1699, lon: 24.9384 }),
    loadRadiusKm: 70,
    url: 'https://realtime.hsl.fi/realtime/vehicle-positions/v2/hsl',
    license: 'CC BY 4.0',
    licenseUrl: 'https://www.hsl.fi/en/hsl/open-data',
    attribution: 'HSL (Helsinki Region Transport)',
    defaultEnabled: true,
    terms: Object.freeze({
      quote: null,
      note: 'The open-data page refuses automated readers (HTTP 403, bot protection), so this entry rests on the owner opening it and accepting it rather than on a passage quoted here. HSL publishes its open data under CC BY 4.0 and asks to be credited as the source; the feed needs no key.',
    }),
    defaultMode: 'bus',
    routeMode: hslRouteMode,
  }),
  Object.freeze({
    id: 'ovapi-nl',
    name: 'OVapi',
    operator: 'Stichting OpenGeo (NDOV data)',
    region: 'Netherlands',
    center: Object.freeze({ lat: 52.2, lon: 5.3 }),
    loadRadiusKm: 220,
    url: 'https://gtfs.ovapi.nl/nl/vehiclePositions.pb',
    license: 'Free to use per the OVapi README (best effort, no SLA)',
    licenseUrl: 'https://gtfs.ovapi.nl/README',
    attribution:
      'OVapi / Stichting OpenGeo — Dutch integrated real-time transit data',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'You are free to use this data, but there is no service level agreement (best-effort) nor are you allowed to say you represent or impersonate any of the transit agencies listed here.',
      note: 'The README asks consumers to identify themselves in the User-Agent, to send If-Modified-Since / If-None-Match when polling faster than once a minute, and to accept gzip. The proxy does all three.',
    }),
    defaultMode: 'bus',
  }),
  Object.freeze({
    id: 'entur-norway',
    name: 'Entur',
    operator: 'Entur AS (Norwegian national transit data)',
    region: 'Norway',
    // Circle chosen to hold Oslo, Bergen, Bodø and Tromsø while leaving
    // Helsinki (≈820 km) out — a national feed must not poll from next door.
    center: Object.freeze({ lat: 64.0, lon: 11.5 }),
    loadRadiusKm: 720,
    url: 'https://api.entur.io/realtime/v1/gtfs-rt/vehicle-positions',
    headers: Object.freeze({ 'ET-Client-Name': 'gods-eye-view-transit' }),
    license: 'Norwegian Licence for Open Government Data (NLOD)',
    licenseUrl: 'https://developer.entur.org/pages-intro-authentication',
    attribution: 'Entur — data under NLOD',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'This API is open under NLOD licence, however, it is required that all consumers identify themselves by using the header ET-Client-Name.',
      note: 'The header is mandatory — unidentified consumers may be rate-limited or blocked — and the proxy sends it on every request.',
    }),
    defaultMode: 'bus',
    routeMode: enturRouteMode,
  }),
  Object.freeze({
    id: 'translink-seq',
    name: 'TransLink',
    operator: 'TransLink (Queensland Government)',
    region: 'South East Queensland, Australia',
    center: Object.freeze({ lat: -27.4698, lon: 153.0251 }),
    loadRadiusKm: 150,
    url: 'https://gtfsrt.api.translink.com.au/api/realtime/seq/VehiclePositions',
    license: 'CC BY 4.0',
    licenseUrl: 'https://translink.com.au/about-translink/open-data',
    attribution: 'TransLink — Queensland Government (CC BY 4.0)',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'Our data is licensed under a Creative Commons Attribution 4.0 International License. ... You must not represent that the State in any way endorses your Application.',
      note: 'No key, no stated rate limit, no caching rule. Logos and network imagery need separate approval, so the credit is text only.',
    }),
    defaultMode: 'bus',
  }),
  Object.freeze({
    id: 'ttc-toronto',
    name: 'TTC',
    operator: 'Toronto Transit Commission',
    region: 'Toronto, ON',
    center: Object.freeze({ lat: 43.6532, lon: -79.3832 }),
    loadRadiusKm: 45,
    url: 'https://bustime.ttc.ca/gtfsrt/vehicles',
    license: 'Open Government Licence \u2013 Toronto',
    licenseUrl: 'https://open.toronto.ca/open-data-licence/',
    attribution:
      'Toronto Transit Commission \u2014 City of Toronto Open Data (Open Government Licence \u2013 Toronto)',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'The Information Provider grants you a worldwide, royalty-free, perpetual, non-exclusive licence to use the Information, including for commercial purposes ... Acknowledge the source of the Information by including any attribution statement specified by the Information Provider.',
      note: 'The City publishes this endpoint from the TTC BusTime NVAS catalogue entry, whose own licence field reads \"License not specified\"; the quote above is the portal-wide Open Government Licence \u2013 Toronto the City applies to its open data, so the credit carries the licence name the way the Metro Transit entry carries its public-domain note. BusTime is the surface system: buses and streetcars report real positions, the subway reports none, so Lines 1/2/4 are simply absent rather than inferred. The endpoint sends no ETag or Last-Modified, so conditional requests fall through to the proxy snapshot TTL.',
    }),
    defaultMode: 'bus',
    // Toronto rides streetcars. The vehicles are the shared `tram` mode and
    // share its silhouette and speed limits; only the word a reader sees
    // changes, because "tram" is not what anyone at Queen and Spadina says.
    modeWords: Object.freeze({
      tram: Object.freeze({ word: 'Streetcar', abbr: 'STREETCAR' }),
    }),
    routeMode: ttcRouteMode,
    vehicleMode: ttcVehicleMode,
  }),
  Object.freeze({
    id: 'miway-mississauga',
    name: 'MiWay',
    operator: 'MiWay (City of Mississauga)',
    region: 'Mississauga, ON',
    center: Object.freeze({ lat: 43.589, lon: -79.6441 }),
    loadRadiusKm: 30,
    url: 'https://www.miapp.ca/GTFS_RT/Vehicle/VehiclePositions.pb',
    license: 'City of Mississauga Open Data Terms of Use',
    licenseUrl:
      'http://www5.mississauga.ca/research_catalogue/CityofMississauga_TermsofUse.pdf',
    attribution: 'MiWay \u2014 City of Mississauga Open Data',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'The City of Mississauga (the City) now grants you a world-wide, royalty-free, non-exclusive, revocable licence to use, modify, and distribute the Datasets in all current and future media and formats for any lawful purpose.',
      note: 'Two conditions shape how this ships. The licence is REVOCABLE, and it asks that anyone who provides access to the data pass on the Terms of Use URL \u2014 so `licenseUrl` points at the terms themselves rather than at a catalogue page, and the attribution popover carries the link. Credit is optional here ("you are not required to credit the City"), and is given anyway as a courtesy, the way the other municipal feeds are.',
    }),
    defaultMode: 'bus',
  }),
  Object.freeze({
    id: 'hsr-hamilton',
    name: 'Hamilton HSR',
    operator: 'Hamilton Street Railway (City of Hamilton)',
    region: 'Hamilton, ON',
    center: Object.freeze({ lat: 43.2557, lon: -79.8711 }),
    loadRadiusKm: 30,
    url: 'https://opendata.hamilton.ca/GTFS-RT/GTFS_VehiclePositions.pb',
    license: 'City of Hamilton Open Data Licence',
    licenseUrl:
      'https://www.hamilton.ca/city-initiatives/strategies-actions/open-data-licence-terms-and-conditions',
    attribution:
      'Contains public sector Data made available under the City of Hamilton\u2019s Open Data Licence',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'The City of Hamilton grants you a worldwide, royalty-free, perpetual, non-exclusive licence to use the Data, including for commercial purposes ... you must acknowledge the source of the Data by including the following attribution statement: \u201cContains public sector Data made available under the City of Hamilton\u2019s Open Data Licence\u201d.',
      note: 'The attribution wording is prescribed by the licence, so it is used verbatim as the credit rather than paraphrased to an operator name. Names, crests, logos and marks are excluded from the grant, so the credit stays text.',
    }),
    defaultMode: 'bus',
    routeLabel: hamiltonRouteLabel,
  }),
  Object.freeze({
    id: 'durham-region',
    name: 'Durham Region Transit',
    operator: 'Durham Region Transit (Regional Municipality of Durham)',
    region: 'Durham Region, ON',
    center: Object.freeze({ lat: 43.9496, lon: -78.9365 }),
    loadRadiusKm: 45,
    url: 'https://drtonline.durhamregiontransit.com/gtfsrealtime/VehiclePositions',
    license: 'Region of Durham Open Data Licence v.1.0',
    licenseUrl: 'https://www.durham.ca/en/regional-government/open-data.aspx',
    attribution:
      "Contains public sector information made available under The Regional Municipality of Durham's Open Data Licence",
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'Durham Region grants you a worldwide, royalty-free, perpetual, non-exclusive licence to use the information ... You are free to: Copy, publish, distribute and transmit the information ... Use the information commercially.',
      note: 'The licence link the open-data catalogue publishes for this feed (OpenDataLicenceAgreement.pdf) is dead after a site relaunch; `licenseUrl` points at the live Open Data page carrying the same licence v.1.0 text, which is where the quote above was read. Credit is optional and the suggested statement is used verbatim.',
    }),
    defaultMode: 'bus',
  }),
  Object.freeze({
    id: 'guelph-transit',
    name: 'Guelph Transit',
    operator: 'Guelph Transit (City of Guelph)',
    region: 'Guelph, ON',
    center: Object.freeze({ lat: 43.5325, lon: -80.2482 }),
    loadRadiusKm: 15,
    url: 'https://glphprdtmgtfs.glphtrpcloud.com/tmgtfsrealtimewebservice/vehicle/vehiclepositions.pb',
    license: 'Open Government Licence \u2013 City of Guelph (v2.0)',
    licenseUrl: 'https://explore.guelph.ca/pages/open-data-license',
    attribution:
      'Contains information licensed under the Open Government Licence \u2013 City of Guelph',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'The Information Provider grants you a worldwide, royalty-free, perpetual, non-exclusive licence to use the Information including for commercial purposes subject to the terms below. ... Acknowledge the source of the Information by including any attribution statement specified by the Information Provider(s) and, where possible, provide a link to this licence.',
      note: 'The endpoint sits on a vendor host, so provenance matters: the City publishes this exact URL on its own open-data developer page, https://explore.guelph.ca/pages/transit-gtfs-data, under an open-data initiative heading (that page is JavaScript-rendered; its readable source is the ArcGIS item JSON behind it). The licence is a verbatim OGL-Canada 2.0 derivative and the attribution wording above is its prescribed fallback, so it is used as written. The transit datasets carry a BLANK licence field in the portal catalogue; the Terms of Use supply it by default ("Except where otherwise noted this is the Open Government Licence"), the same shape of gap the TTC entry records. The Terms also publish a traffic limit \u2014 no concurrent requests, at most 5 per second \u2014 which one poll every 15 s satisfies many times over. Crests and logos are excluded from the grant, so the credit stays text.',
    }),
    defaultMode: 'bus',
    routeLabel: guelphRouteLabel,
  }),
  Object.freeze({
    id: 'kingston-transit',
    name: 'Kingston Transit',
    operator: 'Kingston Transit (The Corporation of the City of Kingston)',
    region: 'Kingston, ON',
    center: Object.freeze({ lat: 44.24, lon: -76.57 }),
    loadRadiusKm: 20,
    url: 'https://api.cityofkingston.ca/gtfs-realtime/vehicleupdates.pb',
    license: 'City of Kingston Open Data Licence 1.0',
    licenseUrl:
      'https://www.cityofkingston.ca/media/wtpgpkb0/gis_license_opendata.pdf',
    attribution:
      'Contains information licensed under the Open Data Licence \u2013 City of Kingston',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'The Information Provider, the City of Kingston, grants you a worldwide, royalty-free, perpetual, non-exclusive licence to use the information provided for any purpose, including for commercial purposes, subject to the terms below. ... Acknowledge the source of the information by including any attribution statement specified by the City of Kingston and, where possible, provide a link to this licence.',
      note: 'The City catalogues this exact URL as an open-data dataset, so provenance is direct rather than inferred. `licenseUrl` is the canonical location of the licence PDF; the address the catalogue prints is a legacy path that currently redirects there, and pinning the redirect target is what survives the next site relaunch \u2014 the Durham entry records what happens when it does not. Names, crests and logos are excluded from the grant, so the credit stays text. Roughly one entity in ten carries no usable position (the position field absent, occasionally a momentary 0,0 GPS dropout); both are discarded before rendering.',
    }),
    defaultMode: 'bus',
  }),
  Object.freeze({
    id: 'barrie-transit',
    name: 'Barrie Transit',
    operator: 'Barrie Transit (City of Barrie)',
    region: 'Barrie, ON',
    center: Object.freeze({ lat: 44.371, lon: -79.6733 }),
    loadRadiusKm: 10,
    url: 'https://www.myridebarrie.ca/gtfs/GTFS_VehiclePositions.pb',
    license: 'Barrie Transit Data licence',
    licenseUrl:
      'https://www.barrie.ca/services-payments/transportation-parking/barrie-transit/barrie-gtfs',
    attribution:
      'Realtime vehicle data \u00a9 City of Barrie, used under the Barrie Transit Data licence',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'Barrie Transit hereby grants you a non-exclusive, limited and revocable rights to use, reproduce, and redistribute Barrie Transit Data (scheduled and real-time data) subject to the following terms: Barrie Transit trademarks and copyrighted materials, including any confusingly similar variants, may not be used in association with Data. ... Barrie Transit maintains title, ownership, rights and interest in and to Data.',
      note: 'The City offers this licence for acceptance behind a click-through checkbox, and the licence body also makes use itself acceptance: \u201cBy using Barrie Transit Data, you agree to be bound by these terms.\u201d This deployment\u2019s owner took that clause as sufficient on 2026-09-16 and switched the feed on; nothing gates the endpoint, which needs no key, token or cookie. Two oddities worth knowing: the licence requires NO attribution at all (the credit above is a courtesy), and its trademark clause is broad enough that the credit names the City rather than Barrie Transit. The grant is expressly REVOCABLE and unversioned, so the quote above is the text as read on 2026-09-16.',
    }),
    defaultMode: 'bus',
  }),
  Object.freeze({
    id: 'yrt-york',
    name: 'YRT/Viva',
    operator:
      'York Region Transit (YRT/Viva), The Regional Municipality of York',
    region: 'York Region, ON',
    center: Object.freeze({ lat: 44.025, lon: -79.436 }),
    loadRadiusKm: 38,
    url: 'https://rtu.york.ca/gtfsrealtime/VehiclePositions',
    license: 'YRT Open Data Licence v2.0 (UK OGL-derived)',
    licenseUrl:
      'https://www.yrt.ca/en/about-us/open-data-licence-agreement.aspx',
    attribution:
      "Contains public transit Information made available under YRT's Open Data Licence",
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'YRT grants You a worldwide, royalty-free, perpetual, non-exclusive licence to Use the Information subject to the conditions below ... Use the Information commercially ... Provide credit to YRT when using Information under this licence but are not required to. ... Please note: You must agree with and accept the above stated License Agreement in order to download YRT GTFS or real-time GTFS data.',
      note: 'The operator asks that its licence be accepted through a form (forms.yrt.ca/YRT-GTFS-Data, which collects a name, company, phone and email and issues no credential), while the licence body says acceptance is by use: \u201cYour Use of Information indicates Your acceptance of the terms and conditions below.\u201d This deployment\u2019s owner took that clause as sufficient on 2026-09-16 and switched the feed on. Nothing gates the endpoint. The credit above is the licence\u2019s own wording and must be reproduced as given; attribution is optional here, and given anyway. Logos, trademarks and crests are carved out, so the credit stays text. Two data notes: no vehicle carries a bearing, so heading comes from observed movement; and one stuck unit reported a position ten hours old, which the layer shows as a stale report rather than hides.',
    }),
    defaultMode: 'bus',
    routeLabel: yrtRouteLabel,
  }),
  Object.freeze({
    id: 'burlington-transit',
    name: 'Burlington Transit',
    operator: 'Burlington Transit (City of Burlington)',
    region: 'Burlington, ON',
    center: Object.freeze({ lat: 43.3342, lon: -79.8089 }),
    loadRadiusKm: 12,
    url: 'https://opendata.burlington.ca/gtfs-rt/GTFS_VehiclePositions.pb',
    license: 'City of Burlington Open Data Terms of Use',
    licenseUrl:
      'https://opendata.burlington.ca/opendata-terms-of-use/City%20of%20Burlington%20-%20Open%20Data%20Terms%20of%20Use.pdf',
    attribution:
      'Transit data \u00a9 City of Burlington (Burlington Transit), used under the City of Burlington Open Data Terms of Use',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'The Corporation of the City of Burlington (the City) now grants you a worldwide, royalty-free, non-exclusive, revocable licence to use, reproduce, modify, and distribute the datasets in all current and future media and formats for any lawful purpose. ... If you distribute or provide access to these datasets to any other person ... you agree to include a copy of, or this Uniform Resource Locator (URL) for, these Terms of Use.',
      note: 'Same 2011-era municipal template as Mississauga, and the same two consequences: the grant is REVOCABLE, and the terms have to travel with the data, so `licenseUrl` is the Terms document itself rather than a catalogue page and the attribution popover carries the link. Credit is optional here and given anyway. Crests, logos and marks are excluded and the terms forbid implying any association, so the credit stays plain text. The catalogue record for this data leads with a licence link that 404s; the URL above is the live one. Plain http:// has no listener at all \u2014 not a redirect, a hang \u2014 so the https:// URL is mandatory rather than preferred. The feed updates once a minute and answers conditional requests with an ETag.',
    }),
    defaultMode: 'bus',
    routeLabel: burlingtonRouteLabel,
  }),
  // French urban networks, catalogued on transport.data.gouv.fr. Nine are read
  // through the national portal's own proxy (`proxy.transport.data.gouv.fr`),
  // which is the URL the catalogue publishes for the resource; the other nine
  // carry the producer's endpoint, because that is what the catalogue lists and
  // no hop is involved (every URL below answers 200 directly, checked
  // 2026-10-24, and each returned positions with real coordinates). Two
  // catalogued networks are deliberately absent: Nîmes (Tango) and Troyes
  // (TCAT) publish only over plain http, which the https rule above excludes.
  frenchFeed({
    id: 'star-rennes',
    name: 'STAR',
    operator: 'STAR (Rennes Métropole)',
    attribution: 'STAR — Rennes Métropole',
    region: 'Rennes, FR',
    lat: 48.1173,
    lon: -1.6778,
    loadRadiusKm: 45,
    url: 'https://proxy.transport.data.gouv.fr/resource/star-rennes-integration-gtfs-rt-vehicle-position',
    licence: 'odc-odbl',
  }),
  frenchFeed({
    id: 'divia-dijon',
    name: 'DiviaMobilités',
    operator: 'DiviaMobilités (Dijon Métropole)',
    attribution: 'DiviaMobilités — Dijon Métropole',
    region: 'Dijon, FR',
    lat: 47.322,
    lon: 5.0415,
    loadRadiusKm: 40,
    url: 'https://proxy.transport.data.gouv.fr/resource/divia-dijon-gtfs-rt-vehicle-position',
    licence: 'lov2',
  }),
  frenchFeed({
    id: 'lemet-metz',
    name: "Le Met'",
    operator: "Le Met' (Eurométropole de Metz)",
    attribution: "Le Met' — Eurométropole de Metz",
    region: 'Metz, FR',
    lat: 49.1193,
    lon: 6.1757,
    loadRadiusKm: 40,
    url: 'https://proxy.transport.data.gouv.fr/resource/lemet-metz-gtfs-rt-vehicle-position',
    licence: 'lov2',
  }),
  frenchFeed({
    id: 'citea-valence',
    name: 'Citéa',
    operator: 'Citéa (Valence Romans Mobilités)',
    attribution: 'Citéa — Valence Romans Mobilités',
    region: 'Valence, FR',
    lat: 44.9334,
    lon: 4.8924,
    loadRadiusKm: 35,
    url: 'https://proxy.transport.data.gouv.fr/resource/citea-valence-gtfs-rt-vehicle-position',
    licence: 'lov2',
  }),
  frenchFeed({
    id: 'bibus-brest',
    name: 'Bibus',
    operator: 'Bibus (Brest métropole)',
    attribution: 'Bibus — Brest métropole',
    region: 'Brest, FR',
    lat: 48.3904,
    lon: -4.4861,
    loadRadiusKm: 35,
    url: 'https://proxy.transport.data.gouv.fr/resource/bibus-brest-gtfs-rt-vehicle-position',
    licence: 'lov2',
  }),
  frenchFeed({
    id: 'setram-lemans',
    name: 'SETRAM',
    operator: 'SETRAM (Le Mans Métropole)',
    attribution: 'SETRAM — Le Mans Métropole',
    region: 'Le Mans, FR',
    lat: 48.0061,
    lon: 0.1996,
    loadRadiusKm: 40,
    url: 'https://proxy.transport.data.gouv.fr/resource/setram-lemans-gtfs-rt-vehicle-position',
    licence: 'lov2',
  }),
  frenchFeed({
    id: 'aleop-pays-de-la-loire',
    name: 'Aléop',
    operator: 'Aléop (Région des Pays de la Loire)',
    attribution: 'Aléop — Région des Pays de la Loire',
    region: 'Pays de la Loire, FR',
    // The regional coach network, and the only thing here between Angers and
    // the Vendée coast: Nantes, Saint-Nazaire, La Roche-sur-Yon and Laval have
    // no urban feed in this registry. The circle holds Le Mans at 118 km and
    // stops before Alençon (145 km, Normandy); it also reaches Rennes at 91 km,
    // which is a polling gate, not a claim that Rennes is covered.
    lat: 47.4,
    lon: -1.1,
    loadRadiusKm: 140,
    url: 'https://proxy.transport.data.gouv.fr/resource/aleop-pdl-gtfs-rt-vehicle-position',
    licence: 'lov2',
  }),
  frenchFeed({
    id: 'ametis-amiens',
    name: 'Ametis',
    operator: 'Ametis (Amiens Métropole)',
    attribution: 'Ametis — Amiens Métropole',
    region: 'Amiens, FR',
    lat: 49.8941,
    lon: 2.2958,
    loadRadiusKm: 40,
    url: 'https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-vehicle-position',
    licence: 'lov2',
  }),
  frenchFeed({
    id: 'kiceo-vannes',
    name: 'Kicéo',
    operator: 'Kicéo (Golfe du Morbihan — Vannes Agglomération)',
    attribution: 'Kicéo — Golfe du Morbihan Vannes Agglomération',
    region: 'Vannes, FR',
    lat: 47.6587,
    lon: -2.7603,
    loadRadiusKm: 35,
    url: 'https://proxy.transport.data.gouv.fr/resource/kiceo-vannes-gtfs-rt-vehicle-position',
    licence: 'lov2',
  }),
  frenchFeed({
    id: 'palmbus-cannes',
    name: 'Palmbus',
    operator: 'Palmbus (Cannes Lérins)',
    attribution: 'Palmbus — Cannes Lérins',
    region: 'Cannes, FR',
    lat: 43.5528,
    lon: 7.0174,
    loadRadiusKm: 30,
    url: 'https://proxy.transport.data.gouv.fr/resource/palmbus-cannes-gtfs-rt-vehicle-position',
    licence: 'lov2',
  }),
  frenchFeed({
    id: 'lignes-dazur-nice',
    name: "Lignes d'Azur",
    operator: "Lignes d'Azur (Métropole Nice Côte d'Azur)",
    attribution: "Lignes d'Azur — Métropole Nice Côte d'Azur",
    region: 'Nice, FR',
    lat: 43.7102,
    lon: 7.262,
    loadRadiusKm: 45,
    url: 'https://ara-api.enroute.mobi/rla/gtfs/vehicle-positions',
    licence: 'lov2',
  }),
  frenchFeed({
    id: 'tam-montpellier',
    name: 'TaM',
    operator: 'TaM (Montpellier Méditerranée Métropole)',
    attribution: 'TaM — Montpellier Méditerranée Métropole',
    region: 'Montpellier, FR',
    lat: 43.6108,
    lon: 3.8767,
    loadRadiusKm: 40,
    url: 'https://gtfsproxy.e-tam.fr/COMMON/VehiclePosition.pb',
    licence: 'odc-odbl',
  }),
  frenchFeed({
    id: 'astuce-rouen',
    name: 'Astuce',
    operator: 'Astuce (Métropole Rouen Normandie)',
    attribution: 'Astuce — Métropole Rouen Normandie',
    region: 'Rouen, FR',
    lat: 49.4431,
    lon: 1.0993,
    loadRadiusKm: 45,
    url: 'https://api.mrn.cityway.fr/dataflow/vehicle-tc-tr/download?provider=TCAR&dataFormat=gtfs-rt',
    licence: 'lov2',
  }),
  frenchFeed({
    id: 'transvilles-valenciennes',
    name: 'Transvilles',
    operator: 'Transvilles (Valenciennes Métropole)',
    attribution: 'Transvilles — Valenciennes Métropole',
    region: 'Valenciennes, FR',
    lat: 50.3571,
    lon: 3.5183,
    loadRadiusKm: 35,
    url: 'https://ara-api.enroute.mobi/transvilles/gtfs',
    licence: 'lov2',
  }),
  frenchFeed({
    id: 'irigo-angers',
    name: 'Irigo',
    operator: 'Irigo (Angers Loire Métropole)',
    attribution: 'Irigo — Angers Loire Métropole',
    region: 'Angers, FR',
    lat: 47.4784,
    lon: -0.5632,
    loadRadiusKm: 40,
    url: 'https://ara-api.enroute.mobi/irigo/gtfs/vehicle-positions',
    licence: 'odc-odbl',
  }),
  frenchFeed({
    id: 'filbleu-tours',
    name: 'Fil Bleu',
    operator: 'Fil Bleu (Tours Métropole Val de Loire)',
    attribution: 'Fil Bleu — Tours Métropole Val de Loire',
    region: 'Tours, FR',
    lat: 47.3941,
    lon: 0.6848,
    loadRadiusKm: 40,
    url: 'https://data.filbleu.fr/ws-tr/gtfs-rt/opendata/vehicle-positions',
    licence: 'lov2',
  }),
  frenchFeed({
    id: 'lia-lehavre',
    name: 'LiA',
    operator: 'LiA (Le Havre Seine Métropole)',
    attribution: 'LiA — Le Havre Seine Métropole',
    region: 'Le Havre, FR',
    lat: 49.4944,
    lon: 0.1079,
    loadRadiusKm: 35,
    url: 'https://opendata.transports-lia.fr/gtfs-rt/VehiclePosition.pb',
    licence: 'odc-odbl',
  }),
  frenchFeed({
    id: 'tadao-lens-bethune',
    name: 'TADAO',
    operator: 'TADAO (Syndicat Mixte des Transports Artois-Gohelle)',
    attribution: 'TADAO — Syndicat Mixte des Transports Artois-Gohelle',
    region: 'Lens–Béthune, FR',
    lat: 50.4292,
    lon: 2.8318,
    loadRadiusKm: 45,
    url: 'https://ara-api.enroute.mobi/tadao_production/gtfs',
    licence: 'odc-odbl',
  }),
  frenchFeed({
    id: 'cap-cotentin',
    name: 'Cap Cotentin',
    operator: 'Cap Cotentin (Le Cotentin)',
    attribution: 'Cap Cotentin — Le Cotentin',
    region: 'Cherbourg-en-Cotentin, FR',
    lat: 49.6337,
    lon: -1.6221,
    loadRadiusKm: 35,
    url: 'https://app.pysae.com/api/v2/groups/transdev-cotentin/gtfs-rt',
    licence: 'lov2',
  }),
]);

/**
 * The feeds this build actually polls. A registered feed that is not here is
 * inert everywhere: it resolves to no route, is never offered to the browser,
 * and never appears in a coverage check.
 */
export const TRANSIT_ENABLED_FEEDS = Object.freeze(
  TRANSIT_FEED_REGISTRY.filter((feed) => feed.defaultEnabled === true),
);

const FEED_BY_ID = new Map(
  TRANSIT_ENABLED_FEEDS.map((feed) => [feed.id, feed]),
);
const ANY_FEED_BY_ID = new Map(
  TRANSIT_FEED_REGISTRY.map((feed) => [feed.id, feed]),
);

/** Feed ids are path segments: lowercase letters, digits, hyphens only. */
export const TRANSIT_FEED_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * Look up a POLLABLE feed by id. Unknown ids, malformed ids, and feeds that are
 * registered but switched off all return null — this is the only door from a
 * request path to an upstream URL, so a feed the owner has not cleared must not
 * be reachable through it.
 * @param {string} id
 * @returns {object|null}
 */
export function getTransitFeed(id) {
  if (typeof id !== 'string' || !TRANSIT_FEED_ID_PATTERN.test(id)) return null;
  return FEED_BY_ID.get(id) || null;
}

/**
 * Look up any registered feed, enabled or not. For credits and documentation
 * only — never for resolving a request into an upstream fetch.
 * @param {string} id
 * @returns {object|null}
 */
export function getRegisteredTransitFeed(id) {
  if (typeof id !== 'string' || !TRANSIT_FEED_ID_PATTERN.test(id)) return null;
  return ANY_FEED_BY_ID.get(id) || null;
}

/**
 * Great-circle distance in km. Retained for compatibility with existing
 * transit consumers; new shared spatial code should use `greatCircleKm`.
 * @param {number} aLat
 * @param {number} aLon
 * @param {number} bLat
 * @param {number} bLon
 * @returns {number}
 */
export function haversineKm(aLat, aLon, bLat, bLon) {
  return greatCircleKm({ lat: aLat, lon: aLon }, { lat: bLat, lon: bLon });
}

/**
 * Feeds whose coverage circle contains the point, nearest first.
 * @param {number} lat
 * @param {number} lon
 * @param {number} [slackKm=0] Extra radius (hysteresis) so a feed at the edge
 *   of coverage does not flap on small camera moves.
 * @returns {object[]}
 */
export function transitFeedsInRange(lat, lon, slackKm = 0) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  return TRANSIT_ENABLED_FEEDS.map((feed) => ({
    feed,
    km: haversineKm(lat, lon, feed.center.lat, feed.center.lon),
  }))
    .filter(({ feed, km }) => km <= feed.loadRadiusKm + Math.max(0, slackKm))
    .sort((a, b) => a.km - b.km)
    .map(({ feed }) => feed);
}

/**
 * The feed's own hint for a vehicle: its fleet number when the feed maps
 * those (`vehicleMode`), else its route (`routeMode`). Null when neither knows.
 * @param {object} feed Registry entry.
 * @param {string|null} routeId
 * @param {string|null} vehicleId
 * @returns {string|null}
 */
function hintedMode(feed, routeId, vehicleId) {
  const byVehicle =
    typeof feed?.vehicleMode === 'function'
      ? feed.vehicleMode(vehicleId)
      : null;
  if (byVehicle && byVehicle !== 'unknown') return byVehicle;
  return typeof feed?.routeMode === 'function' ? feed.routeMode(routeId) : null;
}

/**
 * Mode for a vehicle: the feed's fleet or route hint when it has one, else
 * its default.
 * @param {object} feed Registry entry.
 * @param {string|null} routeId GTFS route_id from the vehicle's trip.
 * @param {string|null} [vehicleId] GTFS-RT vehicle id.
 * @returns {string} One of TRANSIT_MODES.
 */
export function transitModeFor(feed, routeId, vehicleId = null) {
  const hinted = hintedMode(feed, routeId, vehicleId);
  const mode =
    hinted && hinted !== 'unknown' ? hinted : feed?.defaultMode || 'unknown';
  return TRANSIT_MODES.includes(mode) ? mode : 'unknown';
}

/**
 * Whether the mode came from the route id rather than the feed's default. A
 * default is a guess about a fleet — TransLink's is "bus" while it publishes
 * rail in the same feed — so a consumer judging physical plausibility must
 * not hold a defaulted vehicle to a bus's limits.
 * @param {object} feed Registry entry.
 * @param {string|null} routeId
 * @param {string|null} [vehicleId]
 * @returns {boolean}
 */
export function transitModeResolved(feed, routeId, vehicleId = null) {
  const hinted = hintedMode(feed, routeId, vehicleId);
  return (
    Boolean(hinted) && hinted !== 'unknown' && TRANSIT_MODES.includes(hinted)
  );
}

/**
 * The route as a rider would say it. Most feeds publish that already, so this
 * is identity for them; a feed that publishes internal keys supplies its own
 * `routeLabel`. Never invents a label: an id the feed does not know survives
 * unchanged, because a raw id a person can compare against the bus is more
 * use than a blank.
 * @param {object|null} feed Registry entry.
 * @param {string|null} routeId
 * @returns {string|null}
 */
export function transitRouteLabel(feed, routeId) {
  if (!routeId) return routeId;
  // A published rail line name beats the raw id: `4-T1` is the file's key,
  // "T1" is what is written on the tram.
  const rail = transitRouteStyle(feed, routeId);
  if (rail?.label) return rail.label;
  if (typeof feed?.routeLabel !== 'function') return routeId;
  const named = feed.routeLabel(routeId);
  return typeof named === 'string' && named ? named : routeId;
}

/**
 * The rail style a vehicle's route establishes: its mode, the line name and
 * the operator's own line colour. Null for every bus route, and for a feed
 * whose GTFS publishes no rail route at all.
 *
 * The colour is the operator's (`route_color` in its `routes.txt`), never a
 * palette of ours: two trams on the same line share it, and two lines that
 * cross do not. A feed that publishes no colour yields null and the sprite
 * keeps the mode colour.
 * @param {object|string|null} feed Registry entry or its id.
 * @param {string|null} routeId
 * @returns {{mode: string, label: string, color: string|null, ink: string|null}|null}
 */
export function transitRouteStyle(feed, routeId) {
  const feedId = typeof feed === 'string' ? feed : feed?.id;
  const rail = frenchRailRoute(feedId, routeId);
  if (!rail) return null;
  return {
    mode: rail.mode,
    label: rail.label,
    color: rail.color ?? null,
    ink: rail.ink ?? null,
  };
}

/**
 * Public catalog shape served by `/api/transit/feeds` — everything the browser
 * needs to gate polling and credit the source, and nothing it could misuse.
 * @returns {object[]}
 */
export function publicTransitCatalog() {
  return TRANSIT_ENABLED_FEEDS.map((feed) => ({
    id: feed.id,
    name: feed.name,
    operator: feed.operator,
    region: feed.region,
    center: { ...feed.center },
    loadRadiusKm: feed.loadRadiusKm,
    license: feed.license,
    licenseUrl: feed.licenseUrl,
    attribution: feed.attribution,
    historyRetention: feed.historyRetention === true,
  }));
}
