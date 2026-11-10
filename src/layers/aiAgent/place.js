// Where the alert is, for ASK mode: the country under its point and the
// coordinates themselves, both computed on the device.
//
//   - the country comes from the bundled Natural Earth admin-0 pack, the same
//     offline lookup "outline France" uses. No geocoder, key or network is
//     involved, so an answer still works with every provider switched off,
//   - the pack is decoded only when ASK mode is switched on (`warm`), not at
//     app start. Until it is ready an answer still carries the coordinates and
//     simply omits the country instead of delaying the spoken reply,
//   - country names are written in the operator's language through
//     Intl.DisplayNames, with the pack's English name as the fallback (an old
//     WebView or a territory ICU cannot name),
//   - three decimals is roughly 100 m, enough to place an alert on the globe
//     without turning a spoken sentence into a string of digits.
// @module layers/aiAgent/place

import { loadCountryLocator } from '../../data/adminBoundaries.js';
import { formatNumber, getLocale, t } from '../../i18n/index.js';

const REGION_NAMES = new Map();

/** Intl.DisplayNames for one locale, or null where the platform has none. */
function regionNames(locale) {
  if (REGION_NAMES.has(locale)) return REGION_NAMES.get(locale);
  let names = null;
  try {
    if (typeof Intl?.DisplayNames === 'function') {
      names = new Intl.DisplayNames([locale], { type: 'region' });
    }
  } catch {
    names = null; // no ICU region data: the pack's English name still works
  }
  REGION_NAMES.set(locale, names);
  return names;
}

/** The country's name in the operator's language, falling back to the pack. */
function countryLabel(hit, locale) {
  const code = String(hit?.iso2 || '')
    .trim()
    .toUpperCase();
  if (/^[A-Z]{2}$/.test(code)) {
    try {
      const name = regionNames(locale)?.of(code);
      if (name && name !== code) return name;
    } catch {
      // A code ICU will not name (a sovereign base, a disputed area).
    }
  }
  return String(hit?.name || '').trim();
}

/**
 * `48,857° N, 2,352° E` in the active locale. Cardinal letters are the
 * catalogs' own N/S/E/W, so French says O for west and Russian says С/Ю/В/З.
 * @param {number} lat
 * @param {number} lon
 * @returns {string}
 */
export function formatAlertCoordinates(lat, lon) {
  const options = { minimumFractionDigits: 3, maximumFractionDigits: 3 };
  const degrees = (value) => formatNumber(Math.abs(value), options);
  const north = lat >= 0 ? t('N') : t('S');
  const east = lon >= 0 ? t('E') : t('W');
  return `${degrees(lat)}° ${north}, ${degrees(lon)}° ${east}`;
}

/**
 * The place line an ASK answer appends to an alert.
 *
 * @param {object} [options]
 * @param {() => Promise<Function>} [options.loadLocator] country lookup seam.
 * @param {() => string} [options.locale] locale seam (defaults to the UI one).
 * @returns {{ready: boolean, warm: Function, describe: Function}}
 */
export function createAlertPlaces({
  loadLocator = loadCountryLocator,
  locale = getLocale,
} = {}) {
  let locator = null;
  let pending = null;

  return {
    get ready() {
      return locator !== null;
    },

    /** Decode the country pack once; false when it cannot be loaded. */
    warm() {
      if (locator) return Promise.resolve(true);
      if (!pending) {
        pending = Promise.resolve()
          .then(() => loadLocator())
          .then((found) => {
            locator = typeof found === 'function' ? found : null;
            return locator !== null;
          })
          .catch(() => {
            // A missing pack costs the country, never the answer; a later
            // warm (next time ASK mode is switched on) tries again.
            pending = null;
            return false;
          });
      }
      return pending;
    },

    /**
     * One alert's place, or '' when the alert has no usable position.
     * @param {{latDeg?: number, lonDeg?: number}} alert
     * @returns {string} `Country · 48,857° N, 2,352° E`, or coordinates alone.
     */
    describe(alert) {
      const latDeg = Number(alert?.latDeg);
      const lonDeg = Number(alert?.lonDeg);
      if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return '';
      if (Math.abs(latDeg) > 90 || Math.abs(lonDeg) > 180) return '';
      const coordinates = formatAlertCoordinates(latDeg, lonDeg);
      let country = '';
      if (locator) {
        try {
          country = countryLabel(locator(latDeg, lonDeg), locale());
        } catch {
          country = ''; // a broken pack loses the country, not the position
        }
      }
      return country ? `${country} · ${coordinates}` : coordinates;
    },
  };
}
