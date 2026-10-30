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
      matches: ['Shikun & Binui', 'Shikun & Binui / SBI'],
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
      matches: ['Israel Aerospace Industries'],
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
      subsidiaries: [],
      source: {
        url: 'https://www.sec.gov/Archives/edgar/data/1654126/000117891325002994/zk2533624.htm',
      },
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
