- Add an **Earthquakes (EMSC) layer** alongside the USGS one. The
  European-Mediterranean SeismicPortal FDSN event endpoint
  (`www.seismicportal.eu/fdsnws/event/1/query`, past 24 h, M2.5+, keyless,
  answer read browser-direct and validated whole before it can replace the
  display) is normalized to the same record shape the USGS feed uses
  (`normalizeEmscEarthquakeSnapshot`), and draws its events with the same
  depth-coloured, M5+-accented disc pipeline and overlay-host cohort as the
  USGS layer — an FDSN window with no events is an ordinary empty snapshot,
  not a failure. The layer registers everywhere the USGS one does (layer
  panel with its own state token, voice manifest under the name and the
  aliases `emsc`, `emsc quakes`, `european earthquakes`, the standalone and
  server-side source registries, data-usage credits), credits EMSC under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) in
  DATA_SOURCES.md and the in-app attribution, and ships the records, source
  and ownership test suites its USGS counterpart carries (yourname, #1333).
