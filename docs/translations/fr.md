# French (`fr`)

Source language is English; this file records the choices made for French.

## Plural forms

`Intl.PluralRules('fr')` yields `one`, `many` and `other`. `many` covers the
large round numbers (1e6, 2e6…); it is written like `other`. A `tn()` entry keeps
all three keys even when two read the same.

## Glossary

| English                            | French                                             |
| ---------------------------------- | -------------------------------------------------- |
| Live flights                       | Vols en direct                                     |
| Military flights                   | Vols militaires                                    |
| Vessels                            | Navires                                            |
| Satellites                         | Satellites                                         |
| Active fires                       | Feux actifs                                        |
| Earthquakes                        | Séismes                                            |
| Cyclones                           | Cyclones / avis cycloniques                        |
| Mapped installations               | Installations cartographiées                       |
| Data layers                        | Couches de données                                 |
| Cockpit                            | Cockpit                                            |
| Cockpit briefing                   | Briefing du cockpit                                |
| HUD                                | HUD                                                |
| Street level                       | Niveau rue / Street Level (couche)                 |
| Provider Settings                  | Provider Settings (nom du panneau, jamais traduit) |
| Feed                               | Flux                                               |
| Snapshot                           | Instantané                                         |
| Telemetry                          | Télémétrie                                         |
| Squawk                             | Squawk (code transpondeur)                         |
| Track / heading / bearing / course | Piste / cap / relèvement / route                   |
| Route (navigation)                 | Itinéraire                                         |
| Scene / shot                       | Scène / plan                                       |
| Annotation                         | Annotation                                         |
| Key (API)                          | Clé                                                |

## Units and numbers

- Units follow French convention: `km/h`, `km`, `m`, `ft`, `kt`, `hPa`, `dB`,
  `MW`, `MiB`. A space separates the number from the unit (`{value} m`).
- Decimal comma is left to `Intl` formatting in the app; catalogs only carry the
  unit and the surrounding words.
- Percentages read `{percent} %` with a non-breaking-free space, as in the
  source `50–99% contained` → `50–99 % maîtrisé`.
- Hundreds and thousands are not regrouped in the catalogs.

## Style

- Sentence case for sentences, UPPERCASE kept for labels, chips and HUD text.
- Second person plural (vous), never “tu”.
- French typography: a space before `:` `;` `!` `?`, `«  »` for quotes, `—` for
  dashes, `·` kept as is.
- Keyboard keys stay in their original form: `Enter`, `Esc`, `Backspace`, `Tab`,
  `Shift`, `Space`, `Escape`.
- Product, provider and data names stay as in English: Google Maps, Cesium ion,
  OpenAI, ChatGPT, NASA FIRMS, USGS, OpenSky, ADS-B, AIS, CCTV, HUD, TomTom,
  OpenStreetMap, Mapillary, Panorama, GOES, VIIRS, Sentinel-2, Landsat.
- Direction strings are fragments used inside a sentence (`Tournez {direction} sur
{road}`), so they start lowercase: `à gauche`, `légèrement à droite`, `tout
droit`.
