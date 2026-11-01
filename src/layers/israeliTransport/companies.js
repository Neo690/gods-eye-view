/**
 * The companies behind the transport sites: who they are, where they sit, and
 * which of their names appear on a site record.
 *
 * A site record names the company as its source page does, so one group can
 * arrive under several spellings ("Shikun & Binui", "Shikun & Binui / SBI",
 * "SBI Infrastructure"). `matches` is what ties those spellings to one node,
 * and `parent` draws the ownership link the sources state.
 *
 * Headquarters coordinates are city or locality centres unless the source
 * published a street address; `precision` says which. Nothing here is inferred
 * from a project: a company with no published head office would carry no `hq`
 * and the map would draw its sites as one constellation with no hub.
 *
 * @module layers/israeliTransport/companies
 */

/**
 * @typedef {object} CompanyProfile
 * @property {string} key Stable id, unique across the registry.
 * @property {string} name The name the node shows.
 * @property {ReadonlyArray<string>} matches Spoken/written spellings used by site records.
 * @property {string|null} parent Key of the owning company, when the sources say so.
 * @property {{lat:number, lon:number, place:string, country:string, precision:'city'|'address'}} hq
 * @property {string} business One sentence on what the company does.
 * @property {ReadonlyArray<string>} subsidiaries Brands and subsidiaries named by the sources.
 * @property {{url:string}} source The public page the profile came from.
 */

/** @type {ReadonlyArray<Readonly<CompanyProfile>>} */
export const COMPANIES = Object.freeze(
  [
    {
      key: 'shikun-binui',
      name: 'Shikun & Binui',
      matches: [
        'Shikun & Binui',
        'Shikun & Binui / SBI',
        'Shikun & Binui / Solel Boneh',
      ],
      parent: null,
      hq: {
        lat: 31.9882,
        lon: 34.91266,
        place: 'Airport City',
        country: 'Israel',
        precision: 'city',
      },
      business:
        'Israeli group working in infrastructure, real estate, energy and concessions at home and abroad.',
      subsidiaries: [
        'SBI Infrastructure',
        'SBI AG',
        'S&B USA',
        'S&B USA Concessions',
        'S&B USA Construction (Fay)',
      ],
      source: { url: 'https://www.shikunbinui.com/en/subsidiaries/' },
    },
    {
      key: 'sbi-infrastructure',
      name: 'SBI Infrastructure',
      matches: ['SBI Infrastructure'],
      parent: 'shikun-binui',
      hq: {
        lat: 31.9882,
        lon: 34.91266,
        place: 'Airport City',
        country: 'Israel',
        precision: 'address',
      },
      business:
        "Shikun & Binui's international civil-engineering arm, building roads, bridges and ports abroad.",
      subsidiaries: ['SBI AG (Switzerland)'],
      source: { url: 'https://shikunbinui.com/en/sbi-infrastructure/' },
    },
    {
      key: 'sb-usa',
      name: 'S&B USA',
      matches: ['S&B USA (Shikun & Binui)', 'S&B USA Concessions'],
      parent: 'shikun-binui',
      hq: {
        lat: 40.440624,
        lon: -79.995888,
        place: 'Pittsburgh',
        country: 'United States',
        precision: 'address',
      },
      business:
        'U.S. arm of Shikun & Binui: P3 and design-build infrastructure, construction and maintenance.',
      subsidiaries: [
        'S&B USA Concessions',
        'S&B USA Construction',
        'Fay',
        'Fay Southeast',
      ],
      source: { url: 'https://www.shikunusa.com/our-story' },
    },
    {
      key: 'ashtrom-international',
      name: 'Ashtrom International',
      matches: ['Ashtrom International'],
      parent: null,
      hq: {
        lat: 32.08074,
        lon: 34.8338,
        place: 'Bnei Brak',
        country: 'Israel',
        precision: 'address',
      },
      business:
        'Overseas arm of Ashtrom: initiates, builds and operates construction, infrastructure and property projects.',
      subsidiaries: [],
      source: { url: 'https://www.ashtrominternational.com/en' },
    },
    {
      key: 'gadot-group',
      name: 'Gadot Group',
      matches: ['Gadot Group (Gadot Belgium)', 'Gadot / Chemship'],
      parent: null,
      hq: {
        lat: 32.33291,
        lon: 34.85992,
        place: 'Netanya',
        country: 'Israel',
        precision: 'city',
      },
      business:
        'Chemical-logistics group: tank storage, terminals, transport and chemical tanker shipping.',
      subsidiaries: [
        'Gadot Belgium (Ghent)',
        'Gadot Germany',
        'Chemship (Capelle aan den IJssel)',
      ],
      source: { url: 'https://gadot.com/' },
    },
    {
      key: 'iai',
      name: 'Israel Aerospace Industries',
      matches: ['Israel Aerospace Industries', 'IAI Bedek Aviation Group'],
      parent: null,
      hq: {
        lat: 31.9467,
        lon: 34.8903,
        place: 'Lod',
        country: 'Israel',
        precision: 'city',
      },
      business:
        'Aerospace and defence manufacturer: aircraft, UAVs, missiles, satellites and radar.',
      subsidiaries: [],
      source: {
        url: 'https://www.iafastro.org/membership/all-members/israel-aerospace-industries-ltd.html',
      },
    },
    {
      key: 'magal',
      name: 'Magal',
      matches: ['Magal Security Systems', 'Magal Solutions'],
      parent: null,
      hq: {
        lat: 32.03317,
        lon: 34.89091,
        place: 'Yehud',
        country: 'Israel',
        precision: 'address',
      },
      business:
        'Security and safety systems for critical sites: ports, borders, terminals and other infrastructure.',
      subsidiaries: ['Magal Solutions (current brand)'],
      source: { url: 'https://www.magalsolutions.com/about/' },
    },
    {
      key: 'ray-shipping',
      name: 'Ray Shipping',
      matches: ['Ray Shipping (Ray Car Carriers)'],
      parent: null,
      hq: {
        lat: 32.08088,
        lon: 34.78057,
        place: 'Tel Aviv',
        country: 'Israel',
        precision: 'city',
      },
      business:
        'Supplies and manages pure car and truck carrier tonnage through Ray Car Carriers.',
      subsidiaries: [
        'Ray Car Carriers (Douglas, Isle of Man)',
        'STAMCO Ship Management',
      ],
      source: { url: 'http://www.raycarcarriers.com/about-us.html' },
    },
    {
      key: 'xt-shipping',
      name: 'XT Shipping',
      matches: ['XT Shipping'],
      parent: null,
      hq: {
        lat: 32.794044,
        lon: 34.989571,
        place: 'Haifa',
        country: 'Israel',
        precision: 'city',
      },
      business:
        'Owns and manages vessels for international shipping; the shipping arm of XT Group.',
      subsidiaries: [],
      source: { url: 'https://www.xtholdings.com/shipping/' },
    },
    {
      key: 'zim',
      name: 'ZIM Integrated Shipping Services',
      matches: ['ZIM Integrated Shipping Services'],
      parent: null,
      hq: {
        lat: 32.794044,
        lon: 34.989571,
        place: 'Haifa',
        country: 'Israel',
        precision: 'address',
      },
      business:
        'Global container carrier operating its own fleet and liner network.',
      subsidiaries: ['Gold Star Line'],
      source: {
        url: 'https://www.sec.gov/Archives/edgar/data/1654126/000117891325002994/zk2533624.htm',
      },
    },

    // ── Maritime ─────────────────────────────────────────────────────────
    {
      key: 'gold-star-line',
      name: 'Gold Star Line',
      matches: ['Gold Star Line'],
      parent: 'zim',
      hq: {
        lat: 32.794044,
        lon: 34.989571,
        place: 'Haifa',
        country: 'Israel',
        precision: 'city',
      },
      business:
        'Container line running an Asia–Middle East rotation, commercially based in Haifa.',
      subsidiaries: [],
      source: {
        url: 'https://www.seatrade-maritime.com/containers/gold-star-line-to-expand-into-india-middle-east-africa-with-more-services-planned',
      },
    },
    {
      key: 'israel-shipyards',
      name: 'Israel Shipyards',
      matches: ['Israel Shipyards'],
      parent: null,
      hq: {
        lat: 32.8246,
        lon: 35.0736,
        place: 'Haifa Bay',
        country: 'Israel',
        precision: 'city',
      },
      business:
        'Naval and commercial shipyard building patrol craft and offshore patrol vessels for export.',
      subsidiaries: [],
      source: { url: 'https://www.israel-shipyards.com/recent-deliveries.asp' },
    },
    {
      key: 'mano-maritime',
      name: 'Mano Maritime',
      matches: ['Mano Maritime', 'Mano Cruises'],
      parent: null,
      hq: {
        lat: 32.8191,
        lon: 34.9983,
        place: 'Haifa',
        country: 'Israel',
        precision: 'city',
      },
      business:
        'Shipowner and cruise operator sailing its own vessel from Haifa across the eastern Mediterranean.',
      subsidiaries: ['Mano Cruises', 'Crown Iris'],
      source: {
        url: 'https://www.cruisemapper.com/news/14724-mano-cruises-launches-2025-eastern-mediterranean-season',
      },
    },
    {
      key: 'haifa-port',
      name: 'Haifa Port Company',
      matches: ['Haifa Port Company', 'Haifa Port'],
      parent: null,
      hq: {
        lat: 32.8236,
        lon: 35.0008,
        place: 'Haifa',
        country: 'Israel',
        precision: 'city',
      },
      business:
        'Operator of the port of Haifa, privatised in 2022 to an Adani (70 %) and Gadot (30 %) consortium.',
      subsidiaries: [],
      source: {
        url: 'https://www.adaniports.com/newsroom/media-releases/adani-and-gadot-win-tender-to-privatise-israels-haifa-port',
      },
    },
    {
      key: 'captains-eye',
      name: "Captain's Eye",
      matches: ["Captain's Eye"],
      parent: null,
      hq: {
        lat: 32.0853,
        lon: 34.7818,
        place: 'Tel Aviv',
        country: 'Israel',
        precision: 'city',
      },
      business:
        'Maritime AI that reads existing port and ship cameras for safety and security events.',
      subsidiaries: [],
      source: {
        url: 'https://www.calcalistech.com/ctechnews/article/rkdxrrdq9',
      },
    },
    {
      key: 'orca-ai',
      name: 'Orca AI',
      matches: ['Orca AI'],
      parent: null,
      hq: {
        lat: 32.0853,
        lon: 34.7818,
        place: 'Tel Aviv',
        country: 'Israel',
        precision: 'city',
      },
      business:
        'Navigation and watchkeeping AI installed on commercial fleets.',
      subsidiaries: [],
      source: {
        url: 'https://www.orca-ai.io/resource/seaspan-expands-ai-adoption-with-100-more-ships-equipped-with-orca-ai-for-enhanced-safety-and-efficiency/',
      },
    },
    {
      key: 'windward',
      name: 'Windward',
      matches: ['Windward'],
      parent: null,
      hq: {
        lat: 32.0778,
        lon: 34.7818,
        place: 'Tel Aviv',
        country: 'Israel',
        precision: 'city',
      },
      business:
        'Maritime risk and trade-compliance analytics used by carriers and governments.',
      subsidiaries: [],
      source: {
        url: 'https://www.prnewswire.com/il/news-releases/windward-to-enhance-shell-s-trade-compliance-processes-814445306.html',
      },
    },

    // ── Aviation and construction ────────────────────────────────────────
    {
      key: 'cal-cargo',
      name: 'CAL Cargo Airlines',
      matches: ['CAL Cargo Airlines', 'Challenge Airlines IL'],
      parent: null,
      hq: {
        lat: 32.0114,
        lon: 34.8867,
        place: 'Ben Gurion airport',
        country: 'Israel',
        precision: 'city',
      },
      business:
        'Israeli all-cargo carrier, renamed Challenge Airlines IL in 2022, based on a 747 and 767 freighter fleet.',
      subsidiaries: [],
      source: {
        url: 'https://www.challenge-group.com/expert/challenge-airlines-il/',
      },
    },
    {
      key: 'electra',
      name: 'Electra Group',
      matches: ['Electra Group', 'Electra'],
      parent: null,
      hq: {
        lat: 32.0684,
        lon: 34.8248,
        place: 'Ramat Gan',
        country: 'Israel',
        precision: 'city',
      },
      business:
        'Building-services and infrastructure contractor working across transport, energy and facilities.',
      subsidiaries: ['Gilston', 'Electra Afikim'],
      source: {
        url: 'https://www.ifi.today/news/2856-Electra-Group-Secures-Lucrative-Contract-for-JFK-A/',
      },
    },

    // ── Transit: operators and the software behind them ─────────────────
    {
      key: 'egged',
      name: 'Egged Group',
      matches: ['Egged Group', 'Egged'],
      parent: null,
      hq: {
        lat: 32.0853,
        lon: 34.7818,
        place: 'Tel Aviv',
        country: 'Israel',
        precision: 'city',
      },
      business:
        "Israel's largest bus operator, holding concessions in Poland, the Netherlands and Lithuania.",
      subsidiaries: [
        'Mobilis (Poland)',
        'EBS (Netherlands)',
        'TOKS (Lithuania)',
      ],
      source: { url: 'https://www.egged.co.il/en/egged-group/egged-europe' },
    },
    {
      key: 'dan',
      name: 'Dan Group',
      matches: ['Dan Group', 'Dan'],
      parent: null,
      hq: {
        lat: 32.0853,
        lon: 34.7818,
        place: 'Tel Aviv',
        country: 'Israel',
        precision: 'city',
      },
      business:
        'Public-transport operator running urban bus services in Israel and Lisbon.',
      subsidiaries: ['Transportes Sul do Tejo (Portugal)'],
      source: {
        url: 'https://news.arriva.co.uk/news/arriva-group-concludes-the-sale-of-its-portuguese-business-to-dan-group',
      },
    },
    {
      key: 'afifi',
      name: 'Afifi Group',
      matches: ['Afifi Group', 'Afifi'],
      parent: null,
      hq: {
        lat: 32.7021,
        lon: 35.2978,
        place: 'Nazareth',
        country: 'Israel',
        precision: 'city',
      },
      business:
        'Transport and logistics group whose Busway subsidiary holds a regional bus concession in Portugal.',
      subsidiaries: ['Busway (Portugal)'],
      source: {
        url: 'https://www.portugalresident.com/israeli-company-to-run-buses-in-and-around-aveiro/',
      },
    },
    {
      key: 'optibus',
      name: 'Optibus',
      matches: ['Optibus'],
      parent: null,
      hq: {
        lat: 32.0853,
        lon: 34.7818,
        place: 'Tel Aviv',
        country: 'Israel',
        precision: 'city',
      },
      business:
        'Planning, scheduling and operations software for public-transport operators and agencies.',
      subsidiaries: ['MagicEye'],
      source: { url: 'https://optibus.com/case/metrobus-magiceye-control/' },
    },
    {
      key: 'hopon',
      name: 'HopOn',
      matches: ['HopOn', 'TAF mobile'],
      parent: null,
      hq: {
        lat: 32.0853,
        lon: 34.7818,
        place: 'Tel Aviv',
        country: 'Israel',
        precision: 'city',
      },
      business:
        'Mobility-as-a-service and mobile ticketing platform, with TAF mobile as its German arm.',
      subsidiaries: ['TAF mobile'],
      source: { url: 'https://hopon.co/leipzig-move/' },
    },

    // ── Road technology ─────────────────────────────────────────────────
    {
      key: 'mobileye',
      name: 'Mobileye',
      matches: ['Mobileye'],
      parent: null,
      hq: {
        lat: 31.7683,
        lon: 35.2137,
        place: 'Jerusalem',
        country: 'Israel',
        precision: 'city',
      },
      business:
        'Driver-assistance and autonomous-driving systems supplied to carmakers and transit pilots.',
      subsidiaries: [],
      source: {
        url: 'https://www.mobileye.com/blog/from-neighborhoods-to-networks-how-grorud-valleys-maas-enriched-public-transit/',
      },
    },
    {
      key: 'notraffic',
      name: 'NoTraffic',
      matches: ['NoTraffic'],
      parent: null,
      hq: {
        lat: 32.0853,
        lon: 34.7818,
        place: 'Tel Aviv',
        country: 'Israel',
        precision: 'city',
      },
      business:
        'AI traffic-signal platform deployed at intersections and approved for statewide use.',
      subsidiaries: [],
      source: {
        url: 'https://www.notraffic.com/news-media/maryland-department-of-transportation-greenlights-notraffic/',
      },
    },

    // ── Defence and security technology ─────────────────────────────────
    // Nineteen more firms from the Israeli security and aerospace/aerospace ecosystem
    // ride the same registry: each sits at its published head office and is
    // linked into the layer's neural map, even before a document credits one
    // of its products at a named site abroad.
    {
      key: 'accubeat',
      name: 'AccuBeat',
      matches: ['AccuBeat'],
      parent: null,
      hq: {
        lat: 31.802,
        lon: 35.2101,
        place: 'Har Hotzvim, Jerusalem',
        country: 'Israel',
        precision: 'address',
      },
      business:
        'Rubidium atomic clocks, GPS/GNSS-disciplined timing systems and NTP/PTP time servers for defence, aerospace and telecom.',
      subsidiaries: [],
      source: { url: 'https://www.accubeat.com/contact-us' },
    },
    {
      key: 'ashot',
      name: 'Ashot Ashkelon Industries',
      matches: ['Ashot Ashkelon Industries', 'Ashot Ashkelon'],
      parent: null,
      hq: {
        lat: 31.671,
        lon: 34.5745,
        place: 'Industrial Zone, Ashkelon',
        country: 'Israel',
        precision: 'address',
      },
      business:
        'Elbit Systems group manufacturer of armament and munitions components, gun barrels, transmissions and suspension systems for land and aerospace platforms.',
      subsidiaries: [],
      source: { url: 'https://ashot.co.il/' },
    },
    {
      key: 'asio',
      name: 'ASIO Technologies',
      matches: ['ASIO Technologies', 'ASIO'],
      parent: null,
      hq: {
        lat: 32.1797,
        lon: 34.9073,
        place: 'Kfar Saba',
        country: 'Israel',
        precision: 'address',
      },
      business:
        'Tactical combat solutions for dismounted forces: GNSS-denied optical navigation, AR night vision, fire control and battle management for armoured vehicles.',
      subsidiaries: [],
      source: { url: 'https://asiotech.com/contact/' },
    },
    {
      key: 'cti-intl',
      name: 'CTI Intl-Solutions',
      matches: ['CTI Intl-Solutions', 'Computech International'],
      parent: null,
      hq: {
        lat: 32.088,
        lon: 34.8858,
        place: 'Petah Tikva',
        country: 'Israel',
        precision: 'address',
      },
      business:
        'Rugged mission-critical computing, ground-control stations, AI video analytics and C4I solutions for defence, homeland security and law enforcement.',
      subsidiaries: [],
      source: { url: 'https://cti-intl.co.il/' },
    },
    {
      key: 'dagan-optics',
      name: 'Dagan-Optics',
      matches: ['Dagan-Optics', 'Senso-Optics'],
      parent: null,
      hq: {
        lat: 32.9753,
        lon: 35.23,
        place: 'Bar-Lev Industrial Park',
        country: 'Israel',
        precision: 'address',
      },
      business:
        'Electro-optical systems: uncooled thermal imaging, visual/thermal-fusion sights and fire-control, including the SensoDrive periscope for Merkava tanks.',
      subsidiaries: [],
      source: {
        url: 'https://hls-cyber-2022.israel-expo.co.il/expo/exhibits/3244',
      },
    },
    {
      key: 'imco',
      name: 'IMCO Industries',
      matches: ['IMCO Industries', 'IMCO Group'],
      parent: null,
      hq: {
        lat: 32.7667,
        lon: 35.044,
        place: 'Nesher',
        country: 'Israel',
        precision: 'address',
      },
      business:
        'Mechanical, electromechanical and electronic systems — power and control, UAVs, electro-optics and situational awareness — for air, land and naval defence platforms.',
      subsidiaries: [],
      source: {
        url: 'https://www.aviation-defence-universe.com/imco-industries-held-a-special-two-day-demonstration-of-its-solutions-and-capabilities/',
      },
    },
    {
      key: 'infinidome',
      name: 'infiniDome',
      matches: ['infiniDome', 'GPSdome'],
      parent: null,
      hq: {
        lat: 32.483,
        lon: 34.927,
        place: 'Caesarea Industrial Park',
        country: 'Israel',
        precision: 'address',
      },
      business:
        'GPS/GNSS anti-jamming and navigation-resiliency systems (GPSdome, Aura, LightHouse) that keep UAVs, loitering munitions and ground platforms on course under jamming.',
      subsidiaries: [],
      source: { url: 'https://www.gpsdome.com/' },
    },
    {
      key: 'lowental-hybrid',
      name: 'Lowental Hybrid',
      matches: ['Lowental Hybrid'],
      parent: null,
      hq: {
        lat: 31.899,
        lon: 34.806,
        place: 'Rehovot',
        country: 'Israel',
        precision: 'address',
      },
      business:
        'Native Parallel Hybrid™ propulsion blending electric and combustion power for tactical UAVs and loitering munitions, with silent electric flight modes.',
      subsidiaries: [],
      source: { url: 'https://www.lowental-hybrid.com/website-privacy-policy' },
    },
    {
      key: 'magam',
      name: 'Magam Safety',
      matches: ['Magam Safety'],
      parent: null,
      hq: {
        lat: 32.712,
        lon: 35.315,
        place: 'I.Z. Ziporit, Nof HaGalil',
        country: 'Israel',
        precision: 'address',
      },
      business:
        "Israel's leading manufacturer of protective, rescue and survivability equipment — personal protection and tailored safety systems for military and civilian users.",
      subsidiaries: [],
      source: { url: 'https://magam-safety.com/contact/' },
    },
    {
      key: 'orbit-cs',
      name: 'Orbit Communication Systems',
      matches: ['Orbit Communication Systems', 'Orbit CS'],
      parent: null,
      hq: {
        lat: 32.288,
        lon: 34.862,
        place: 'Netanya',
        country: 'Israel',
        precision: 'address',
      },
      business:
        'Military and space communications: airborne, shipborne and mobile SATCOM terminals, tracking antennas and audio systems for defence and government customers.',
      subsidiaries: [],
      source: { url: 'https://orbit-cs.com/contact-us' },
    },
    {
      key: 'parazero',
      name: 'ParaZero Technologies',
      matches: ['ParaZero Technologies', 'ParaZero'],
      parent: null,
      hq: {
        lat: 32.175,
        lon: 34.907,
        place: 'Kfar Saba',
        country: 'Israel',
        precision: 'address',
      },
      business:
        'Autonomous parachute safety and recovery systems plus counter-UAS and precision airdrop (SafeAir, DefendAir, DropAir) for defence and commercial drone operators.',
      subsidiaries: [],
      source: {
        url: 'https://www.sec.gov/Archives/edgar/data/1916241/000121390024075083/ea0212120-posam2_parazero.htm',
      },
    },
    {
      key: 'paxis',
      name: 'Paxis',
      matches: ['Paxis', 'Paxis Ceramics'],
      parent: null,
      hq: {
        lat: 32.982,
        lon: 35.276,
        place: 'Migdal Tefen Industrial Park',
        country: 'Israel',
        precision: 'address',
      },
      business:
        'Boron-carbide and silicon-carbide ceramic solutions for high-end ballistic armour: body, vehicle, aircraft and marine protection for defence integrators.',
      subsidiaries: [],
      source: { url: 'https://www.paxisceramics.com/contact/' },
    },
    {
      key: 'redler',
      name: 'Redler Technologies',
      matches: ['Redler Technologies'],
      parent: null,
      hq: {
        lat: 32.1689,
        lon: 34.9256,
        place: 'Kfar Saba',
        country: 'Israel',
        precision: 'address',
      },
      business:
        'Rugged servo drive and motor controllers, smart power distribution units and solid-state circuit breakers for defence, aerospace, robotics and UAV platforms.',
      subsidiaries: [],
      source: { url: 'https://redlertechnologies.com/contact/' },
    },
    {
      key: 'sol-security',
      name: 'Sol Security Labs',
      matches: ['Sol Security Labs', 'Sola Security'],
      parent: null,
      hq: {
        lat: 32.0641,
        lon: 34.7717,
        place: 'Tel Aviv',
        country: 'Israel',
        precision: 'city',
      },
      business:
        'Cybersecurity startup offering a self-serve cloud and identity security platform that maps an organization\u2019s entire security environment for humans and AI agents.',
      subsidiaries: [],
      source: {
        url: 'https://www.northdata.com/Sol%20Security%20Labs%20Ltd%C2%B7,%20Tel%20Aviv%20-%20Yafo/ICA-516868254',
      },
    },
    {
      key: 'solarpaint',
      name: 'Solarpaint',
      matches: ['Solarpaint'],
      parent: null,
      hq: {
        lat: 32.6508,
        lon: 35.0982,
        place: 'Yokneam Illit',
        country: 'Israel',
        precision: 'address',
      },
      business:
        'Apollo Power\u2019s flexible solar-film unit supplying foldable and rollable panels and solar kits that let field units recharge batteries, comms gear and drones off-grid.',
      subsidiaries: [],
      source: { url: 'https://apollo-power.com/portable-solar/' },
    },
    {
      key: 'steadicopter',
      name: 'Steadicopter',
      matches: ['Steadicopter'],
      parent: null,
      hq: {
        lat: 32.6683,
        lon: 35.2517,
        place: 'Migdal HaEmek',
        country: 'Israel',
        precision: 'address',
      },
      business:
        'Black Eagle family of rotary-wing unmanned aerial systems — electric and hybrid RUAVs — for defence, homeland security and maritime missions.',
      subsidiaries: [],
      source: { url: 'https://steadicopter.com/contact/' },
    },
    {
      key: 'supergum',
      name: 'Supergum Industries',
      matches: ['Supergum Industries', 'Supergum'],
      parent: null,
      hq: {
        lat: 32.1005,
        lon: 34.8855,
        place: 'Petah Tikva',
        country: 'Israel',
        precision: 'address',
      },
      business:
        'CBRN respiratory protection: military and police gas masks and respirators (IM76, M15), filters, protective hoods and life-support systems.',
      subsidiaries: [],
      source: { url: 'https://supergum.com/contact/' },
    },
    {
      key: 'thermal-beacon',
      name: 'Thermal Beacon',
      matches: ['Thermal Beacon'],
      parent: null,
      hq: {
        lat: 31.6069,
        lon: 34.7728,
        place: 'Kiryat Gat',
        country: 'Israel',
        precision: 'address',
      },
      business:
        'Infrared and thermal beacons, markers and AI-enhanced thermal imaging payloads for combat identification, targeting and night operations.',
      subsidiaries: [],
      source: { url: 'https://www.thermalbeacon.com/contact/' },
    },
    {
      key: 'tracense',
      name: 'Tracense Systems',
      matches: ['Tracense Systems'],
      parent: null,
      hq: {
        lat: 32.2838,
        lon: 34.8647,
        place: 'Netanya',
        country: 'Israel',
        precision: 'address',
      },
      business:
        'Nanotechnology-based trace sensors for stand-off, non-contact detection of explosives and hazardous materials, integrated on drones and ground robots.',
      subsidiaries: [],
      source: { url: 'https://tracense.com/contact/' },
    },
  ].map((company) =>
    Object.freeze({
      ...company,
      matches: Object.freeze([...company.matches]),
      subsidiaries: Object.freeze([...company.subsidiaries]),
      hq: Object.freeze({ ...company.hq }),
      source: Object.freeze({ ...company.source }),
    }),
  ),
);

/** Company by key, for a caller that already resolved one. */
export const COMPANIES_BY_KEY = Object.freeze(
  Object.fromEntries(COMPANIES.map((company) => [company.key, company])),
);

/**
 * The node a site record belongs to.
 *
 * Matched on the record's own company string, so a spelling the registry does
 * not know still resolves to a node instead of vanishing from the map.
 * @param {string} companyName
 * @returns {CompanyProfile|null}
 */
export function companyFor(companyName) {
  const text = String(companyName ?? '').trim();
  if (!text) return null;
  const exact = COMPANIES.find((company) => company.matches.includes(text));
  if (exact) return exact;
  // A record that names the group first ("Gadot Group (…)", "S&B USA (…)")
  // still belongs to that group when the short form is all it kept.
  return (
    COMPANIES.find((company) =>
      company.matches.some(
        (match) => text.startsWith(`${match} `) || text.startsWith(`${match}(`),
      ),
    ) || null
  );
}
