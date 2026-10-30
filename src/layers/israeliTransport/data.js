/**
 * Israeli companies' documented transport activity outside Israel.
 *
 * Every record is one site a company is reported to have worked at, with the
 * public page that says so. The list is a curated snapshot, not a claim of
 * completeness: several awards disclose only a region ("a major African
 * seaport"), and those are left out rather than placed on a guess. No verified
 * overseas railway, metro or light-rail contract was found for an Israeli
 * company, so the layer carries none — an empty sector is the honest result,
 * not an omission to fill.
 *
 * @module layers/israeliTransport/data
 */

/**
 * @typedef {object} TransportActivity
 * @property {string} id Stable id, unique across the dataset.
 * @property {string} company The company credited on the source page.
 * @property {string} sector port|airport|road|bridge|shipping|logistics
 * @property {string} country Country of the site.
 * @property {string} place Site or project, as the source names it.
 * @property {number} lat Degrees.
 * @property {number} lon Degrees.
 * @property {string} project What was built or run there.
 * @property {string} role The company's documented part.
 * @property {string} period Years as the source gives them.
 * @property {string} status operating|completed|under-construction|announced|global
 * @property {string} summary One sentence of context.
 * @property {{url: string}} source The public page this came from.
 */

/** Sector accents: one hue per kind of work, so the globe reads at a glance. */
export const SECTOR_COLORS = Object.freeze({
  port: '#4FD1C5',
  airport: '#F6AD55',
  road: '#63B3ED',
  bridge: '#9F7AEA',
  shipping: '#4FD1C5',
  logistics: '#68D391',
});

/** The order the layer panel and the legend list sectors in. */
export const SECTORS = Object.freeze([
  'port',
  'airport',
  'road',
  'bridge',
  'shipping',
  'logistics',
]);

/** @type {ReadonlyArray<Readonly<TransportActivity>>} */
export const TRANSPORT_ACTIVITIES = Object.freeze(
  [
    {
      id: 'magal-tarragona',
      company: 'Magal Solutions',
      sector: 'port',
      country: 'Spain',
      place: 'Port of Tarragona',
      lat: 41.1,
      lon: 1.24,
      project: 'Port security management',
      role: 'Fortis4G command and control across the port control rooms; maintenance since 2024',
      period: '2014 · maintenance 2024',
      status: 'operating',
      summary:
        "Magal's integrated physical and cyber security platform runs the port's main control centre and its distributed rooms.",
      source: {
        url: 'https://www.magalsolutions.com/in-the-media/the-port-authority-of-tarragona-awards-magal-solutions-the-maintenance-of-its-security-systems/',
      },
    },
    {
      id: 'magal-huelva',
      company: 'Magal Security Systems',
      sector: 'port',
      country: 'Spain',
      place: 'Port of Huelva',
      lat: 37.25,
      lon: -6.94,
      project: 'Port perimeter security',
      role: 'Perimeter sensors and day/night cameras, extending systems already in place',
      period: '2019',
      status: 'announced',
      summary:
        'A contract reported in 2019 extended the port perimeter systems Magal had supplied in earlier years.',
      source: {
        url: 'https://www.calcalistech.com/ctech/articles/0,7340,L-3754231,00.html',
      },
    },
    {
      id: 'gadot-ghent',
      company: 'Gadot Group (Gadot Belgium)',
      sector: 'logistics',
      country: 'Belgium',
      place: 'Ghent, North Sea Port',
      lat: 51.09,
      lon: 3.79,
      project: 'Chemical tank terminal',
      role: 'Tank storage, blending, filling and multimodal transfer for seagoing vessels',
      period: 'ADPO bought 2010 · Gadot Ghent 2019',
      status: 'operating',
      summary:
        'Gadot runs a chemical terminal on the Ghent canal with direct deep-sea access, customs handling and transport coordination.',
      source: { url: 'https://www.gadot.be/' },
    },
    {
      id: 'iai-taxibot-frankfurt',
      company: 'Israel Aerospace Industries',
      sector: 'airport',
      country: 'Germany',
      place: 'Frankfurt Airport',
      lat: 50.0379,
      lon: 8.5622,
      project: 'TaxiBot tow tractor',
      role: 'Pilot-controlled hybrid-electric tractor moving aircraft with engines off, run by Lufthansa LEOS',
      period: '2015',
      status: 'operating',
      summary:
        'The first real-flight TaxiBot operation ran at Frankfurt after European approval, towing aircraft between gate and runway.',
      source: {
        url: 'https://www.airport-technology.com/news/newsfrankfurt-airport-deploys-fuel-saving-taxibot-for-taxiing-aircraft-4517031/',
      },
    },
    {
      id: 'iai-taxibot-delhi',
      company: 'Israel Aerospace Industries',
      sector: 'airport',
      country: 'India',
      place: 'Indira Gandhi International, Delhi',
      lat: 28.5562,
      lon: 77.1,
      project: 'TaxiBot tow tractor',
      role: 'Operated by KSU Aviation; commercial flights taxiing with the tractor since late 2018',
      period: '2018',
      status: 'operating',
      summary:
        'Delhi was the first Indian airport to put the IAI tractor into commercial service.',
      source: {
        url: 'https://avitrader.com/2018/11/01/start-of-smart-taxiing-in-india-ksu-initiates-operations-of-iais-taxibot-vehicles-in-indian-airports/',
      },
    },
    {
      id: 'iai-taxibot-bengaluru',
      company: 'Israel Aerospace Industries',
      sector: 'airport',
      country: 'India',
      place: 'Kempegowda International, Bengaluru',
      lat: 13.1986,
      lon: 77.7066,
      project: 'TaxiBot tow tractor',
      role: 'Airside towing operations with KSU Aviation, after trials at Delhi',
      period: '2022',
      status: 'operating',
      summary:
        'Bengaluru described itself as the second airport in the world to use the tractor in airside operations.',
      source: {
        url: 'https://www.tld-group.com/zh-hans/16581/',
      },
    },
    {
      id: 'sbi-kabaale',
      company: 'Shikun & Binui / SBI',
      sector: 'airport',
      country: 'Uganda',
      place: 'Kabaale, Hoima',
      lat: 1.42,
      lon: 31.18,
      project: 'Kabaale International Airport',
      role: 'Runway, taxiway, apron, cargo terminal and control tower through SBC (Uganda) with Colas UK',
      period: '2018 – 2023 · 96% in 2025',
      status: 'under-construction',
      summary:
        'The airport serves the Albertine oil region; the ministry reported it at 96% with commissioning targeted for 2025.',
      source: {
        url: 'http://www.sbi.co.ug/kabaale_airport_project_brief.htm',
      },
    },
    {
      id: 'ashtrom-montego-bay',
      company: 'Ashtrom International',
      sector: 'airport',
      country: 'Jamaica',
      place: 'Sangster International, Montego Bay',
      lat: 18.5037,
      lon: -77.9134,
      project: 'Airport runway and terminal works',
      role: 'Runway, taxiway, apron and terminal renovation for the Airports Authority, through a local subsidiary',
      period: 'Completed · undated',
      status: 'completed',
      summary:
        'Ashtrom lists the Sangster works, including a new terminal roof, as completed through its Jamaican subsidiary.',
      source: {
        url: 'https://www.ashtrominternational.com/en/projects/sangster-international-airport',
      },
    },
    {
      id: 'sbi-sh288',
      company: 'Shikun & Binui',
      sector: 'road',
      country: 'United States',
      place: 'SH 288 toll lanes, Houston',
      lat: 29.62,
      lon: -95.4,
      project: 'SH 288 toll lanes',
      role: 'Concession partner and design-build joint venture; four new toll lanes over 10.3 miles',
      period: 'Opened 2020 · concession ended 2024',
      status: 'completed',
      summary:
        'The Harris County toll lanes opened in November 2020 and reached final acceptance in 2022; the concession was terminated in 2024.',
      source: {
        url: 'https://www.fhwa.dot.gov/ipd/project_profiles/tx_sh288.aspx',
      },
    },
    {
      id: 'sbi-cundinamarca',
      company: 'Shikun & Binui / SBI',
      sector: 'road',
      country: 'Colombia',
      place: 'Perimetral Oriental de Cundinamarca',
      lat: 4.55,
      lon: -74.1,
      project: 'Cundinamarca 010 toll road',
      role: 'Built, rehabilitated and operated 154 km of toll road under a 25-year concession',
      period: '2015 – 2019 · segments ongoing',
      status: 'under-construction',
      summary:
        'The concession east of Bogotá has three segments operational and two still under rehabilitation.',
      source: {
        url: 'https://www.shikunusa.com/projects/cundinamarca-010-toll-road-project',
      },
    },
    {
      id: 'sbi-sagamu-benin',
      company: 'Shikun & Binui / SBI',
      sector: 'road',
      country: 'Nigeria',
      place: 'Sagamu–Benin highway',
      lat: 6.6,
      lon: 4.64,
      project: 'Sagamu–Benin highway',
      role: 'Paving and widening the highway, renewing drainage canals and conduits',
      period: '2012 · three-year contract',
      status: 'announced',
      summary:
        'The contract covers the Lagos–Benin corridor; the cited report gives the award and duration, not its completion.',
      source: {
        url: 'https://www.ynetnews.com/articles/0,7340,L-4288404,00.html',
      },
    },
    {
      id: 'sbi-east-west',
      company: 'SBI Infrastructure',
      sector: 'road',
      country: 'Nigeria',
      place: 'East West highway, Delta',
      lat: 4.95,
      lon: 6.1,
      project: 'East West highway',
      role: '99 km of highway including an 840 m bridge',
      period: 'Undated',
      status: 'under-construction',
      summary:
        "The company's own project page describes the highway as being built, without dates.",
      source: {
        url: 'https://shikunbinui.com/en/sbi-infrastructure/',
      },
    },
    {
      id: 'sbi-katosi',
      company: 'SBI Infrastructure',
      sector: 'road',
      country: 'Uganda',
      place: 'Katosi Road',
      lat: 0.13,
      lon: 32.78,
      project: 'Katosi Road upgrade',
      role: 'Upgrade of a 74 km road east of Kampala',
      period: 'Undated',
      status: 'under-construction',
      summary:
        "The route and length come from the company's project page, which gives no dates.",
      source: {
        url: 'https://shikunbinui.com/en/sbi-infrastructure/',
      },
    },
    {
      id: 'ashtrom-abuloma',
      company: 'Ashtrom International',
      sector: 'bridge',
      country: 'Nigeria',
      place: 'Abuloma–Woji, Port Harcourt',
      lat: 4.78,
      lon: 7.0,
      project: 'Abuloma–Woji bridge',
      role: 'Design-and-build 270 m bridge with 1,700 m of access ramps',
      period: 'Completed 2015',
      status: 'completed',
      summary:
        'The bridge links villages on opposite sides of the river at Port Harcourt.',
      source: {
        url: 'https://www.ashtrominternational.com/en/projects/abuloma-woji-bridge',
      },
    },
    {
      id: 'sbusa-beaver',
      company: 'S&B USA (Shikun & Binui)',
      sector: 'bridge',
      country: 'United States',
      place: 'Beaver River, Pennsylvania',
      lat: 40.7,
      lon: -80.32,
      project: 'Beaver River Bridge replacement',
      role: 'Two new bridges plus highway widening',
      period: '2023 – 2027',
      status: 'under-construction',
      summary:
        'The replacement is under construction in Beaver County, with Shikun & Binui staff providing technical assistance.',
      source: {
        url: 'https://www.shikunusa.com/projects/beaver',
      },
    },
    {
      id: 'sbusa-pennsylvania',
      company: 'S&B USA Concessions',
      sector: 'bridge',
      country: 'United States',
      place: 'PennDOT Major Bridges, Pennsylvania',
      lat: 40.27,
      lon: -76.88,
      project: 'PennDOT Major Bridges P3',
      role: 'Consortium partner; six bridges replaced under a public-private programme',
      period: '2022 close · 2023 – 2028',
      status: 'under-construction',
      summary:
        'One point marks a six-site programme, from the Susquehanna to the Lehigh, not a single bridge.',
      source: {
        url: 'https://www.shikunusa.com/blog/bpp-closes-on-pennsylvania-major-bridges-p3',
      },
    },
    {
      id: 'zim-haifa',
      company: 'ZIM Integrated Shipping Services',
      sector: 'shipping',
      country: 'Israel',
      place: 'Haifa (operator base)',
      lat: 32.82,
      lon: 34.99,
      project: 'Global container liner',
      role: 'Container services including Asia–US East Coast and Gulf with MSC, and a Cross-Atlantic service',
      period: 'Global network',
      status: 'global',
      summary:
        'The carrier sails worldwide; the point marks its base, not one terminal it owns.',
      source: {
        url: 'https://investors.zim.com/news/news-details/2024/ZIM-Announces-New-Operational-Cooperation-with-MSC-Covering-the-Strategic-Transpacific-Trade/default.aspx',
      },
    },
    {
      id: 'ray-shipping',
      company: 'Ray Shipping (Ray Car Carriers)',
      sector: 'shipping',
      country: 'Israel',
      place: 'Tel Aviv (operator base)',
      lat: 32.08,
      lon: 34.78,
      project: 'Pure car and truck carriers',
      role: '65 PCTCs operated at the November 2023 count',
      period: 'Global network',
      status: 'global',
      summary:
        "Lloyd's List reported the fleet and named Rami and Yael Ungar as beneficial owners.",
      source: {
        url: 'https://www.lloydslist.com/LL1147314/Houthis-hijack-Israeli-owned-car-carrier-Galaxy-Leader',
      },
    },
    {
      id: 'gadot-chemship',
      company: 'Gadot / Chemship',
      sector: 'shipping',
      country: 'Israel',
      place: 'Haifa Bay (operator base)',
      lat: 32.83,
      lon: 35.0,
      project: 'Chemical tankers',
      role: '15 stainless-steel chemical tankers plus four newbuildings, on European and US lanes',
      period: 'Global network',
      status: 'global',
      summary:
        'Chemship lists services between Northwest Europe, the Mediterranean and the US Atlantic and Gulf coasts.',
      source: { url: 'https://chemship.com/fleet/' },
    },
    {
      id: 'xt-shipping',
      company: 'XT Shipping',
      sector: 'shipping',
      country: 'Israel',
      place: 'Haifa (operator base)',
      lat: 32.815,
      lon: 34.995,
      project: 'Owned and managed fleet',
      role: 'Vessel ownership and ship management, with about 2,500 seafarers',
      period: 'Global network',
      status: 'global',
      summary:
        'The group lists Haifa and Tel Aviv as its bases and runs ship-management services worldwide.',
      source: {
        url: 'https://www.xtholdings.com/shipping/',
      },
    },
  ].map((record) => Object.freeze(record)),
);

/** Documents in how many countries the curated set places an activity. */
export function activityCountries(activities = TRANSPORT_ACTIVITIES) {
  return [...new Set(activities.map((activity) => activity.country))].sort();
}

/**
 * Activities of one sector, in dataset order.
 * @param {string} sector
 * @param {ReadonlyArray<TransportActivity>} [activities]
 * @returns {TransportActivity[]}
 */
export function activitiesInSector(sector, activities = TRANSPORT_ACTIVITIES) {
  return activities.filter((activity) => activity.sector === sector);
}
