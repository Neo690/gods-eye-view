#!/usr/bin/env node
/**
 * Build the local radio-site extract the Radio Sites layer reads.
 *
 * ANFR publishes every radio installation above 5 W as monthly tables inside
 * one ZIP (`data.gouv.fr`, Licence Ouverte 2.0). That archive is 63 MB and
 * holds millions of rows — far too much to commit, and pointless to ship to
 * phones. This script reads the archive in memory, keeps one point per
 * physical support with the systems transmitting from it, and writes a
 * gzipped JSON extract under `data/anfr/` (git-ignored).
 *
 *   npm run towers:build                       newest monthly archive
 *   npm run towers:build -- --bbox=-5,42,9,52  one region only
 *   npm run towers:build -- --zip=C:\tmp\anfr.zip   already downloaded
 *   npm run towers:build -- --max=50000        cap the extract
 *
 * Two tables carry what the map shows: SUP_SUPPORT (one row per support, with
 * coordinates split into degrees/minutes/seconds) and SUP_EMETTEUR (one row per
 * transmitter, naming its system). The frequency table holds 4.8 M rows and
 * adds nothing a map can explain that "5G" or "FM" does not, so it is skipped.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, inflateRawSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATASET =
  'https://www.data.gouv.fr/api/1/datasets/donnees-sur-les-installations-radioelectriques-de-plus-de-5-watts-1/';
const OUT_DIR = path.join(ROOT, 'data', 'anfr');
const OUT_FILE = path.join(OUT_DIR, 'cell-towers.json.gz');
const LICENCE = 'Licence Ouverte 2.0 (ANFR)';

/**
 * Minimal ZIP reader: the archive uses deflate or stored entries, and a ZIP
 * library would be a dependency to audit for one build script. Only the
 * central directory is trusted; entries inflate one at a time.
 * @param {Buffer} buffer
 * @returns {{name:string, read: () => Buffer}[]}
 */
export function zipEntries(buffer) {
  const entries = [];
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66_000; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no central directory)');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('corrupt ZIP central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf8');
    entries.push({
      name,
      read: () => {
        if (buffer.readUInt32LE(localOffset) !== 0x04034b50)
          throw new Error(`corrupt ZIP entry: ${name}`);
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const data = buffer.subarray(start, start + compressedSize);
        return method === 0 ? Buffer.from(data) : inflateRawSync(data);
      },
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Split one CSV line, honouring quoted fields. */
export function csvLine(line) {
  const out = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        value += '"';
        i++;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ';' || char === ',') {
      out.push(value);
      value = '';
    } else value += char;
  }
  out.push(value);
  return out;
}

/** Iterate lines without splitting millions of strings at once. */
export function* tableLines(text) {
  let start = 0;
  for (;;) {
    const end = text.indexOf('\n', start);
    if (end < 0) {
      const last = text.slice(start).replace(/\r$/, '');
      if (last) yield last;
      return;
    }
    const line = text.slice(start, end).replace(/\r$/, '');
    if (line) yield line;
    start = end + 1;
  }
}

/**
 * ANFR publishes coordinates as degrees, minutes, seconds and a hemisphere
 * split across four columns, never as a decimal pair.
 * @param {string|number} degrees
 * @param {string|number} minutes
 * @param {string|number} seconds
 * @param {string} hemisphere N/S/E/W
 * @returns {number|null}
 */
export function dmsToDecimal(degrees, minutes, seconds, hemisphere) {
  const deg = Number(degrees);
  const min = Number(minutes || 0);
  const sec = Number(seconds || 0);
  if (!Number.isFinite(deg) || deg === 0) return null;
  if (!Number.isFinite(min) || !Number.isFinite(sec)) return null;
  if (deg < 0 || deg > 180) return null;
  const value = deg + min / 60 + sec / 3600;
  const side = String(hemisphere || '')
    .trim()
    .toUpperCase();
  if (side === 'S' || side === 'W') return -value;
  if (side !== 'N' && side !== 'E' && side !== '') return null;
  return value;
}

/** Find the support columns by name, never by position. */
export function supportColumns(header) {
  const index = (name) => header.indexOf(name);
  return {
    id: index('SUP_ID'),
    station: index('STA_NM_ANFR'),
    address: index('ADR'),
    dgLat: index('COR_NB_DG_LAT'),
    mnLat: index('COR_NB_MN_LAT'),
    scLat: index('COR_NB_SC_LAT'),
    nsLat: index('COR_CD_NS_LAT'),
    dgLon: index('COR_NB_DG_LON'),
    mnLon: index('COR_NB_MN_LON'),
    scLon: index('COR_NB_SC_LON'),
    ewLon: index('COR_CD_EW_LON'),
  };
}

/** Find the transmitter columns by name. */
export function transmitterColumns(header) {
  return {
    station: header.indexOf('STA_NM_ANFR'),
    system: header.indexOf('EMR_LB_SYSTEME'),
  };
}

/**
 * Build the site list from the two tables that carry what the layer shows.
 * @param {object} input
 * @param {string} input.supportsText
 * @param {string} [input.transmittersText]
 * @param {number[]|null} [input.bbox] west,south,east,north
 * @param {number} [input.max]
 */
export function buildSites({
  supportsText,
  transmittersText = '',
  bbox = null,
  max = Infinity,
}) {
  const supportLines = tableLines(supportsText);
  const header = csvLine(supportLines.next().value ?? '');
  const columns = supportColumns(header);
  if (columns.dgLat < 0 || columns.dgLon < 0)
    throw new Error(
      `SUP_SUPPORT has no DMS coordinate columns: ${header.join(';').slice(0, 200)}`,
    );
  const sites = new Map();
  const stationToSite = new Map();
  let supportsRead = 0;
  for (const line of supportLines) {
    const row = csvLine(line);
    const lat = dmsToDecimal(
      row[columns.dgLat],
      row[columns.mnLat],
      row[columns.scLat],
      row[columns.nsLat],
    );
    const lon = dmsToDecimal(
      row[columns.dgLon],
      row[columns.mnLon],
      row[columns.scLon],
      row[columns.ewLon],
    );
    if (lat === null || lon === null) continue;
    if (
      bbox &&
      (lon < bbox[0] || lat < bbox[1] || lon > bbox[2] || lat > bbox[3])
    )
      continue;
    supportsRead += 1;
    const id = String(row[columns.id] ?? '').trim();
    if (!id) continue;
    const station = String(row[columns.station] ?? '').trim();
    if (!sites.has(id)) {
      if (sites.size >= max) continue;
      sites.set(id, {
        id,
        lat: Number(lat.toFixed(5)),
        lon: Number(lon.toFixed(5)),
        bands: [],
        station,
        address: String(row[columns.address] ?? '').trim() || null,
      });
    }
    if (station) stationToSite.set(station, id);
  }

  if (transmittersText) {
    const transmitterLines = tableLines(transmittersText);
    const transmitterHeader = csvLine(transmitterLines.next().value ?? '');
    const transmitter = transmitterColumns(transmitterHeader);
    if (transmitter.station >= 0 && transmitter.system >= 0) {
      for (const line of transmitterLines) {
        const row = csvLine(line);
        const siteId = stationToSite.get(
          String(row[transmitter.station] ?? '').trim(),
        );
        if (!siteId) continue;
        const site = sites.get(siteId);
        const system = String(row[transmitter.system] ?? '').trim();
        if (!site || !system) continue;
        if (!site.bands.includes(system) && site.bands.length < 8)
          site.bands.push(system);
      }
    }
  }

  return { sites: [...sites.values()], supportsRead };
}

async function newestArchiveUrl(fetchImpl) {
  const response = await fetchImpl(DATASET);
  if (!response.ok) throw new Error(`data.gouv.fr answered ${response.status}`);
  const dataset = await response.json();
  const resources = (dataset.resources || []).filter(
    (resource) =>
      /zip/i.test(resource.format || '') &&
      /support/i.test(resource.title || '') &&
      /bande/i.test(resource.title || ''),
  );
  // Titles carry a French month, which does not sort; the modification date
  // says which archive is current.
  resources.sort((a, b) =>
    String(b.last_modified || '').localeCompare(String(a.last_modified || '')),
  );
  const newest = resources[0];
  if (!newest?.url) throw new Error('no "supports antennes" archive found');
  return { url: newest.url, title: newest.title };
}

/** Read the two tables this build needs out of the archive. */
export function readTables(buffer) {
  const entries = zipEntries(buffer);
  const find = (name) => entries.find((entry) => entry.name === name);
  const supports = find('SUP_SUPPORT.txt') || find('SUP_SUPPORT.csv');
  if (!supports) throw new Error('the archive holds no SUP_SUPPORT table');
  return {
    supportsText: supports.read().toString('utf8'),
    transmittersText:
      (find('SUP_EMETTEUR.txt') || find('SUP_EMETTEUR.csv') || '')
        ?.read?.()
        .toString('utf8') ?? '',
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (const argument of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argument);
    if (!match) {
      console.error(`Unknown argument: ${argument}`);
      return 2;
    }
    options[match[1]] = match[2] ?? true;
  }
  if (options.help) {
    console.log(
      'npm run towers:build [-- --zip=<file>] [--bbox=w,s,e,n] [--max=<n>]',
    );
    return 0;
  }

  let zipPath =
    typeof options.zip === 'string' ? path.resolve(options.zip) : null;
  if (zipPath && !existsSync(zipPath)) {
    console.error(`No such archive: ${zipPath}`);
    return 2;
  }
  if (!zipPath) {
    const { url, title } = await newestArchiveUrl(globalThis.fetch);
    console.log(`downloading ${title}`);
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`download answered ${response.status}`);
      return 1;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    zipPath = path.join(OUT_DIR, 'anfr-archive.zip');
    mkdirSync(OUT_DIR, { recursive: true });
    await writeFile(zipPath, buffer);
    console.log(
      `saved ${(buffer.length / 1048576).toFixed(1)} MB to ${zipPath}`,
    );
  }

  const bbox =
    typeof options.bbox === 'string'
      ? options.bbox.split(',').map(Number)
      : null;
  if (bbox && (bbox.length !== 4 || !bbox.every(Number.isFinite))) {
    console.error('--bbox needs west,south,east,north');
    return 2;
  }
  const max = Number(options.max) > 0 ? Number(options.max) : Infinity;

  const tables = readTables(await readFile(zipPath));
  const { sites, supportsRead } = buildSites({ ...tables, bbox, max });
  if (!sites.length) {
    console.error(
      'no support carried usable coordinates; the table layout may have changed',
    );
    return 1;
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'ANFR — installations radioélectriques de plus de 5 W',
    licence: LICENCE,
    count: sites.length,
    sites,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, gzipSync(JSON.stringify(payload)));
  const bytes = (await readFile(OUT_FILE)).length;
  const withSystems = sites.filter((site) => site.bands.length).length;
  console.log(
    `${sites.length} sites (${withSystems} with a named system, ${supportsRead} supports read) -> ${path.relative(ROOT, OUT_FILE)} (${(bytes / 1048576).toFixed(1)} MB gz)`,
  );
  console.log(
    'The Radio Sites layer reads this file on its next request; no restart needed.',
  );
  return 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  const code = await main();
  if (code !== 0) process.exitCode = code;
}
