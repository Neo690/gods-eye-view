/**
 * Israeli companies' documented transport activity, at home and abroad.
 *
 * Every record is one site a company is reported to have worked at, with the
 * public page that says so. The list is a curated snapshot, not a claim of
 * completeness: several awards disclose only a region ("a major seaport in
 * Asia"), and those are left out rather than placed on a guess — a record
 * without a coordinate would have to be invented.
 *
 * The scope widened in two directions. Sectors now cover rail and public
 * transport, drawn inside Israel where the work is: a search of company and
 * trade publications found no verified railway, metro or light-rail contract
 * abroad by an Israeli firm, so the rail records are the Tel Aviv Red Line and
 * the transit records are the operators' foreign networks, each marked with the
 * site the source names.
 *
 * @module layers/israeliTransport/data
 */

/**
 * @typedef {object} TransportActivity
 * @property {string} id Stable id, unique across the dataset.
 * @property {string} company The company credited on the source page.
 * @property {string} sector port|rail|airport|road|bridge|shipping|transit|logistics
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
  rail: '#F687B3',
  airport: '#F6AD55',
  road: '#63B3ED',
  bridge: '#9F7AEA',
  shipping: '#4FD1C5',
  transit: '#F6E05E',
  logistics: '#68D391',
});

/** The order the layer panel and the legend list sectors in. */
export const SECTORS = Object.freeze([
  'port',
  'rail',
  'airport',
  'road',
  'bridge',
  'shipping',
  'transit',
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

    // ── Rail: the contracts found are inside Israel ──────────────────────
    // No overseas rail, metro or light-rail award by an Israeli company could
    // be verified, and an invented one would be worse than an empty sector.
    {
      id: 'solel-boneh-redline',
      company: 'Shikun & Binui / Solel Boneh',
      sector: 'rail',
      country: 'Israel',
      place: 'Tel Aviv Red Line',
      lat: 32.0853,
      lon: 34.7818,
      project: 'Light-rail tunnels and six underground stations',
      role: 'Civil works in a JV led by China Railway Tunnel Group (51 %)',
      period: 'Awarded 2015',
      status: 'completed',
      summary:
        "The group's infrastructure arm built the western segment of Tel Aviv's first light-rail line as the junior partner of a Chinese-Israeli venture.",
      source: {
        url: 'https://www.crecg.com/zgztywz/core_business/overseas_business/2025021110100947257/index.html',
      },
    },
    {
      id: 'shikun-binui-redline',
      company: 'Shikun & Binui',
      sector: 'rail',
      country: 'Israel',
      place: 'Tel Aviv Red Line',
      lat: 32.0778,
      lon: 34.7808,
      project: 'Tunnels and six underground stations',
      role: 'Reported USD 750 m contract for the underground works',
      period: 'Six-year programme',
      status: 'completed',
      summary:
        'Trade press reported the group winning the underground package of the Red Line, the project that put Israeli contractors on a light-rail bill of quantities.',
      source: {
        url: 'https://www.railway-technology.com/news/newsshikun-binui-wins-750m-tel-aviv-light-rail-project-4587852/',
      },
    },

    // ── Maritime: lines, yards, ports and the technology on top ──────────
    {
      id: 'mano-cruises-haifa',
      company: 'Mano Maritime',
      sector: 'shipping',
      country: 'Israel',
      place: 'Haifa (cruise base)',
      lat: 32.8191,
      lon: 34.9983,
      project: 'Eastern Mediterranean cruise programme',
      role: 'Homeport cruises to Cyprus, Greece, Italy, Malta and Bulgaria',
      period: '2025 season',
      status: 'operating',
      summary:
        'The Israeli operator sails its own ship out of Haifa, which makes the port a homeport rather than a call on somebody else\u2019s itinerary.',
      source: {
        url: 'https://www.cruisemapper.com/news/14724-mano-cruises-launches-2025-eastern-mediterranean-season',
      },
    },
    {
      id: 'gold-star-line-haifa',
      company: 'Gold Star Line',
      sector: 'shipping',
      country: 'Israel',
      place: 'Haifa (operator base)',
      lat: 32.815,
      lon: 34.995,
      project: 'Asia–Middle East container service (GCX)',
      role: 'Weekly China–Middle East rotation via Colombo and Jebel Ali',
      period: 'Reported 2018',
      status: 'global',
      summary:
        'The line runs its published rotation with six ships of about 6,500 TEU and keeps its commercial base in Haifa, in the ZIM group.',
      source: {
        url: 'https://www.seatrade-maritime.com/containers/gold-star-line-to-expand-into-india-middle-east-africa-with-more-services-planned',
      },
    },
    {
      id: 'israel-shipyards-haifa',
      company: 'Israel Shipyards',
      sector: 'shipping',
      country: 'Israel',
      place: 'Haifa Bay shipyard',
      lat: 32.8246,
      lon: 35.0736,
      project: 'Naval and patrol vessel construction',
      role: 'SHALDAG and OPV builder; exports to Greece, Romania, Cyprus',
      period: '2022–2024',
      status: 'operating',
      summary:
        'The yard on the Kishon is the country\u2019s naval shipbuilder, and its export order book is the reason its hulls are seen in other navies\u2019 ports.',
      source: {
        url: 'https://www.israel-shipyards.com/recent-deliveries.asp',
      },
    },
    {
      id: 'israel-shipyards-cavite',
      company: 'Israel Shipyards',
      sector: 'shipping',
      country: 'Philippines',
      place: 'Cavite naval shipyard',
      lat: 14.4793,
      lon: 120.8961,
      project: 'Shipyard renewal and technology transfer',
      role: 'SHALDAG Mk V deliveries; first docking April 2024',
      period: '2022–2024',
      status: 'operating',
      summary:
        'The Philippine Navy\u2019s yard is the clearest case of the company exporting not only hulls but the ability to build and dock them.',
      source: {
        url: 'https://www.israel-shipyards.com/news.asp',
      },
    },
    {
      id: 'haifa-port-adani-gadot',
      company: 'Haifa Port Company',
      sector: 'port',
      country: 'Israel',
      place: 'Port of Haifa',
      lat: 32.8236,
      lon: 35.0008,
      project: 'Privatised container and general-cargo port',
      role: 'Adani 70 % and Gadot 30 %, concession running to 2054',
      period: '2022 · to 2054',
      status: 'operating',
      summary:
        'The tender of 2022 put an Indian-Israeli consortium in charge of the country\u2019s busiest port for three decades, with the Israeli partner on the board.',
      source: {
        url: 'https://www.adaniports.com/newsroom/media-releases/adani-and-gadot-win-tender-to-privatise-israels-haifa-port',
      },
    },
    {
      id: 'captains-eye-ashdod',
      company: "Captain's Eye",
      sector: 'port',
      country: 'Israel',
      place: 'Port of Ashdod',
      lat: 31.8145,
      lon: 34.642,
      project: 'Camera-based AI event monitoring',
      role: 'Pilot at the port, plus a strategic partnership with XT Shipping',
      period: '2022',
      status: 'announced',
      summary:
        'The pilot watches the port through cameras that already exist and raises safety and security events; Ashdod is where it was tried, not a signed fleet-wide contract.',
      source: {
        url: 'https://www.calcalistech.com/ctechnews/article/rkdxrrdq9',
      },
    },
    {
      id: 'orca-ai-seaspan',
      company: 'Orca AI',
      sector: 'shipping',
      country: 'Israel',
      place: 'Tel Aviv (operator base)',
      lat: 32.0853,
      lon: 34.7818,
      project: 'AI watchkeeper across a container fleet',
      role: 'Expanded to Seaspan\u2019s fleet after trials on selected ships',
      period: '2023–2025',
      status: 'global',
      summary:
        'A fleet-wide installation is the hardest thing for a maritime start-up to sell, and Seaspan is the named customer behind this one.',
      source: {
        url: 'https://www.orca-ai.io/resource/seaspan-expands-ai-adoption-with-100-more-ships-equipped-with-orca-ai-for-enhanced-safety-and-efficiency/',
      },
    },
    {
      id: 'windward-shell',
      company: 'Windward',
      sector: 'shipping',
      country: 'Israel',
      place: 'Tel Aviv (operator base)',
      lat: 32.0778,
      lon: 34.7818,
      project: 'Maritime trade-compliance analytics',
      role: 'Integrated into Shell Trading and Shipping compliance',
      period: '2021',
      status: 'global',
      summary:
        'A named oil-major customer, and governments beyond it, though the public pages name no port: the layer places the company at its base for that reason.',
      source: {
        url: 'https://www.prnewswire.com/il/news-releases/windward-to-enhance-shell-s-trade-compliance-processes-814445306.html',
      },
    },

    // ── Aviation: airlines, MRO and airport works ────────────────────────
    {
      id: 'cal-cargo-liege',
      company: 'CAL Cargo Airlines',
      sector: 'airport',
      country: 'Belgium',
      place: 'Li\u00e8ge (European hub)',
      lat: 50.6374,
      lon: 5.4432,
      project: 'All-cargo services between Belgium, Israel and North America',
      role: 'Renamed Challenge Airlines IL in 2022; 747 and 767 freighters',
      period: 'AOC since 1999 · renamed 2022',
      status: 'operating',
      summary:
        'The carrier routes its freight through Li\u00e8ge, which puts an Israeli airline\u2019s operating base on a Belgian apron.',
      source: {
        url: 'https://www.challenge-group.com/expert/challenge-airlines-il/',
      },
    },
    {
      id: 'iai-bedek-atsg',
      company: 'IAI Bedek Aviation Group',
      sector: 'airport',
      country: 'Israel',
      place: 'Ben Gurion (Bedek)',
      lat: 32.0114,
      lon: 34.8867,
      project: 'PW4000 engine maintenance for a US lessor',
      role: 'Engine MRO for Cargo Aircraft Management (ATSG)',
      period: '2024',
      status: 'operating',
      summary:
        'The work happens in Israel and the customer is American: an MRO contract read from the customer\u2019s side is a US site, not an Israeli one.',
      source: {
        url: 'https://avitrader.com/2024/01/18/iai-to-maintain-pw4000-engines-for-atsg/',
      },
    },
    {
      id: 'electra-gilston-jfk',
      company: 'Electra Group / Gilston',
      sector: 'airport',
      country: 'United States',
      place: 'JFK Terminal 1, New York',
      lat: 40.6413,
      lon: -73.7781,
      project: 'Terminal lighting system',
      role: 'About 30,000 fixtures and electrical systems, via AECOM',
      period: '2024 · completion planned 2026',
      status: 'under-construction',
      summary:
        'An electrical contractor\u2019s job rather than a headline project, and the first documented Israeli presence inside a New York terminal fit-out.',
      source: {
        url: 'https://www.ifi.today/news/2856-Electra-Group-Secures-Lucrative-Contract-for-JFK-A/',
      },
    },
    {
      id: 'sbusa-pittsburgh-airport',
      company: 'S&B USA (Shikun & Binui)',
      sector: 'airport',
      country: 'United States',
      place: 'Pittsburgh International Airport',
      lat: 40.4915,
      lon: -80.2329,
      project: 'Roads, bridges and a dual-level terminal bridge',
      role: 'Terminal roads and bridges; terminal bridge finished in 2023',
      period: '2022–2025',
      status: 'under-construction',
      summary:
        'The group\u2019s US arm is the contractor on the airport\u2019s landside works, which is airport construction without an aircraft in it.',
      source: {
        url: 'https://www.shikunusa.com/projects/airport',
      },
    },

    // ── Transit: operators and the software behind them ─────────────────
    {
      id: 'egged-mobilis-poland',
      company: 'Egged Group',
      sector: 'transit',
      country: 'Poland',
      place: 'Warsaw, Kraków and Wrocław',
      lat: 52.2297,
      lon: 21.0122,
      project: 'Municipal bus operations',
      role: 'Subsidiary Mobilis runs city buses in three Polish cities',
      period: 'Since 2006',
      status: 'operating',
      summary:
        'The oldest foreign concession of the group, and the one that turned a national bus cooperative into an operator with tenders abroad.',
      source: {
        url: 'https://www.egged.co.il/en/egged-group/egged-europe',
      },
    },
    {
      id: 'egged-ebs-netherlands',
      company: 'Egged Group',
      sector: 'transit',
      country: 'Netherlands',
      place: 'Waterland and Haaglanden',
      lat: 52.3676,
      lon: 4.9041,
      project: 'Regional bus concessions',
      role: 'About 720 buses, mostly electric; Zeeland tender won 2025',
      period: 'Since 2011',
      status: 'operating',
      summary:
        'Electric fleets are the point here: the Dutch concessions the group holds are largely zero-emission operations.',
      source: {
        url: 'https://www.egged.co.il/en/egged-group/egged-europe',
      },
    },
    {
      id: 'egged-toks-lithuania',
      company: 'Egged Group',
      sector: 'transit',
      country: 'Lithuania',
      place: 'Vilnius and Klaip\u0117da',
      lat: 54.6872,
      lon: 25.2797,
      project: 'City, intercity and international bus routes',
      role: 'Agreement to acquire 51 % of the operator TOKS',
      period: '2025',
      status: 'announced',
      summary:
        'An acquisition agreement, not yet a concession: the record stays announced until the purchase is reported complete.',
      source: {
        url: 'https://www.egged.co.il/en/egged-group/egged-europe',
      },
    },
    {
      id: 'dan-tst-lisbon',
      company: 'Dan Group',
      sector: 'transit',
      country: 'Portugal',
      place: 'Lisbon',
      lat: 38.7223,
      lon: -9.1393,
      project: 'Urban bus operations',
      role: 'Acquired Transportes Sul do Tejo from Arriva, with its staff',
      period: 'Completed December 2022',
      status: 'operating',
      summary:
        'A completed purchase, and the most concrete step by an Israeli operator into a western European bus market.',
      source: {
        url: 'https://news.arriva.co.uk/news/arriva-group-concludes-the-sale-of-its-portuguese-business-to-dan-group',
      },
    },
    {
      id: 'afifi-busway-aveiro',
      company: 'Afifi Group',
      sector: 'transit',
      country: 'Portugal',
      place: 'Aveiro region',
      lat: 40.6405,
      lon: -8.6538,
      project: 'Regional bus concession',
      role: 'Operations began with 100 buses, five electric, 125 drivers',
      period: 'From 1 August 2023',
      status: 'operating',
      summary:
        'A second Israeli operator on Portuguese roads, this one through the Afifi group\u2019s Busway.',
      source: {
        url: 'https://www.portugalresident.com/israeli-company-to-run-buses-in-and-around-aveiro/',
      },
    },
    {
      id: 'optibus-brasilia',
      company: 'Optibus',
      sector: 'transit',
      country: 'Brazil',
      place: 'Bras\u00edlia',
      lat: -15.7939,
      lon: -47.8828,
      project: 'Timetable and schedule planning',
      role: 'Operator Urbi plans schedules here; first published Dec 2020',
      period: '2020',
      status: 'operating',
      summary:
        'Transit software rather than vehicles, and a named operator whose schedules are produced with it.',
      source: {
        url: 'https://optibus.com/case/how-urbi-used-optibus-to-build-better-timetables-and-schedules-in-half-the-time/',
      },
    },
    {
      id: 'optibus-mexico-metrobus',
      company: 'Optibus',
      sector: 'transit',
      country: 'Mexico',
      place: 'Mexico City Metrob\u00fas',
      lat: 19.4326,
      lon: -99.1332,
      project: 'Driver-fatigue and distraction monitoring',
      role: 'The MagicEye system is reported on 792 Metrob\u00fas buses',
      period: 'Reported 2025',
      status: 'operating',
      summary:
        'The same platform that plans the timetable also watches the driver, on a bus rapid-transit network of hundreds of vehicles.',
      source: {
        url: 'https://optibus.com/case/metrobus-magiceye-control/',
      },
    },
    {
      id: 'hopon-leipzig',
      company: 'HopOn',
      sector: 'transit',
      country: 'Germany',
      place: 'Leipzig',
      lat: 51.3397,
      lon: 12.3731,
      project: 'LeipzigMOVE mobility platform',
      role: 'Planning, booking and payment for public and shared transport',
      period: 'Released June 2020',
      status: 'operating',
      summary:
        'A city-backed mobility account with an Israeli supplier behind it, which is how transit software usually enters a market.',
      source: {
        url: 'https://hopon.co/leipzig-move/',
      },
    },

    // ── Road: the technology that manages the network ────────────────────
    {
      id: 'notraffic-baltimore',
      company: 'NoTraffic',
      sector: 'road',
      country: 'United States',
      place: 'Baltimore, Maryland',
      lat: 39.2904,
      lon: -76.6122,
      project: 'AI intersection management',
      role: 'Five intersections, then Maryland DOT approval state-wide',
      period: '2024',
      status: 'operating',
      summary:
        'A pilot that became a state-level approval, which is the adoption path for traffic-signal software in the United States.',
      source: {
        url: 'https://www.notraffic.com/news-media/maryland-department-of-transportation-greenlights-notraffic/',
      },
    },
    {
      id: 'mobileye-oslo',
      company: 'Mobileye',
      sector: 'road',
      country: 'Norway',
      place: 'Grorud Valley, Oslo',
      lat: 59.9139,
      lon: 10.7522,
      project: 'Shared autonomous ride-pooling pilot',
      role: 'Six vehicles on Mobileye Drive, linked to transit hubs',
      period: '2023',
      status: 'operating',
      summary:
        'A pilot with the city\u2019s transit authority rather than a private robotaxi: the vehicles feed the public network instead of replacing it.',
      source: {
        url: 'https://www.mobileye.com/blog/from-neighborhoods-to-networks-how-grorud-valleys-maas-enriched-public-transit/',
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
