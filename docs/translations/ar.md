# Arabic (`ar`)

Modern Standard Arabic. The interface is right-to-left: `<html dir="rtl">` is set
from `RTL_LOCALES` in `src/i18n/locale.js`.

## Plural forms

`Intl.PluralRules('ar')` yields `zero`, `one`, `two`, `few`, `many` and `other`,
so every `tn()` entry carries six keys. The forms follow the number in the
message:

- `one` and `zero` for 1 and 0,
- `two` for 2 (dual),
- `few` for 3–10,
- `many` for 11–99,
- `other` for 100 and above.

All six always keep the same `{placeholder}` as the English, even where the
natural sentence would drop the count.

## Numerals

Western Arabic numerals (1, 2, 3) are used everywhere, as in the source, so
readouts match the globe data and the monospace HUD.

## Glossary

| English                            | Arabic                             |
| ---------------------------------- | ---------------------------------- |
| Live flights                       | رحلات مباشرة                       |
| Military flights                   | رحلات عسكرية                       |
| Vessels                            | سفن                                |
| Satellites                         | أقمار صناعية                       |
| Active fires                       | حرائق نشطة                         |
| Earthquakes                        | زلازل                              |
| Cyclones                           | أعاصير / تحذيرات الأعاصير          |
| Mapped installations               | منشآت مرسومة                       |
| Data layers                        | طبقات البيانات                     |
| Cockpit                            | قمرة القيادة                       |
| HUD                                | HUD                                |
| Feed                               | تغذية                              |
| Snapshot                           | لقطة                               |
| Track / heading / bearing / course | مسار / اتجاه / سمت / مسار          |
| Route (navigation)                 | مسار                               |
| Scene / shot                       | مشهد / لقطة                        |
| Provider Settings                  | Provider Settings (jamais traduit) |
| Key (API)                          | مفتاح                              |

## Units and directions

- Units stay Latin: `km/h`, `km`, `m`, `قدم` (ft), `kt`, `hPa`, `dB`, `MW`,
  `MiB`, with a space between number and unit.
- Direction fragments used inside a sentence start lowercase-less Arabic without
  a leading preposition: `يساراً`, `يميناً قليلاً`, `مستقيماً`, `دوراناً كاملاً`.
- Compass abbreviations: `ش`, `ش ق`, `ق`, `ج ق`, `ج`, `ج غ`, `غ`, `ش غ` and the
  16-point variants `ش ش ق`, `ق ش ق`, …

## Style

- Product, provider and data names stay in Latin script: Google Maps, Cesium ion,
  ChatGPT, NASA FIRMS, USGS, OpenSky, ADS-B, AIS, CCTV, TomTom, OpenStreetMap,
  Mapillary, Panoramax, GOES, VIIRS, Sentinel-2, Landsat, DENSE, FOV, STARLINK.
- Keyboard keys stay Latin and unaltered: `Enter`, `Esc`, `Space`, `Tab`,
  `Shift`, `Backspace`.
- Punctuation follows Arabic: `،` for the comma, `؛` for the semicolon, `؟` for
  the question mark, and `«»` for quotes. Separators `·`, `—`, `→`, `↗`, `…`
  are kept.
- Sentences are kept short: the mobile panels are narrow and Arabic words are
  longer than their English counterparts.
- Bidi: a Latin run inside Arabic text is separated by a space so the browser
  orders it correctly; never add control characters to the catalog.
