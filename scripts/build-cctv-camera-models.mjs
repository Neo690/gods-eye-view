/**
 * Build the matching index for the CC0 ch-bas/cctv-camera-database dataset.
 *
 * One-time (rerun to refresh): one fetch of the dataset's `data/cameras.csv`
 * (brand + model + id are the only columns this index consumes) compressed
 * into a brand/model lookup the CCTV server joins against a catalog entry's
 * own hardware strings (`model`, `manufacturer`). Nothing else changes: no
 * camera feed, no stream, no catalog entry is touched by or generated from
 * this data — it only names hardware a feed already published.
 *
 * Output: `src/data/local_data/cctv_camera_models/cctv_camera_models.json`,
 * committed to the repo like the ground-heights sidecar, so the runtime
 * never contacts the database repo.
 *
 * Usage:
 *   node scripts/build-cctv-camera-models.mjs
 *
 * The dataset is CC0 (public domain dedication): free to copy and
 * redistribute with no restrictions, recorded as such in the output header
 * and in DATA_SOURCES.md. `--csv <path>` uses a local copy instead of the
 * fetch. Every model is transcribed upstream from manufacturer datasheets;
 * this script copies them verbatim and invents nothing.
 *
 * @module scripts/build-cctv-camera-models
 */

import fs from 'node:fs';
import path from 'node:path';

const CSV_URL =
  'https://raw.githubusercontent.com/ch-bas/cctv-camera-database/main/data/cameras.csv';
const REPO_URL = 'https://github.com/ch-bas/cctv-camera-database';
const OUT_DIR = 'src/data/local_data/cctv_camera_models';
const OUT_FILE = 'cctv_camera_models.json';

/** The smallest series token the `series` map accepts: enough digits to be a
 * real series number and long enough not to collide on every prefix. */
const SERIES_MIN_CHARS = 3;

/** Lowercase, collapse every non-alphanumeric run to one space, trim. */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Parse one CSV line honoring double-quoted fields ("1/3"" colour CMOS") and
 * escaped quotes inside them. Returns the raw fields; callers decide what
 * each column means.
 * @param {string} line
 * @returns {string[]}
 */
function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

/**
 * Lookup keys for one (brand, model) pair. Two keys are indexed: the model as
 * the dataset writes it (normalized), and, when the model text itself starts
 * with the brand name, the same text with that prefix removed ("2N IP Base"
 * also answers for "IP Base"). Duplicate keys across brands are kept as a
 * list and the runtime only confirms a match when the list names exactly one
 * hardware entry — an ambiguous key confirms nothing.
 *
 * @param {string} brand
 * @param {string} model
 * @returns {string[]}
 */
function entryKeys(brand, model) {
  const brandNorm = normalize(brand);
  const modelNorm = normalize(model);
  const keys = new Set([modelNorm]);
  if (brandNorm && modelNorm.startsWith(`${brandNorm} `)) {
    keys.add(modelNorm.slice(brandNorm.length + 1));
  }
  return [...keys];
}

async function main() {
  const csvPath = process.argv
    .slice(process.argv.indexOf('--csv') + 1)
    .find((arg) => arg && !arg.startsWith('-'));
  let csv;
  if (csvPath) {
    csv = fs.readFileSync(path.resolve(csvPath), 'utf8');
    console.log(`Reading local CSV ${csvPath}`);
  } else {
    const response = await fetch(CSV_URL);
    if (!response.ok) {
      throw new Error(`cameras.csv fetch failed: HTTP ${response.status}`);
    }
    csv = await response.text();
    console.log(`Fetched ${CSV_URL} (${(csv.length / 1e6).toFixed(1)} MB)`);
  }

  const lines = csv.split(/\r?\n/);
  const header = parseCsvLine(lines[0] || '').map((name) => name.trim());
  const brandCol = header.indexOf('brand');
  const modelCol = header.indexOf('model');
  const idCol = header.indexOf('id');
  if (brandCol < 0 || modelCol < 0 || idCol < 0) {
    throw new Error(`unexpected CSV header: ${header.join(', ')}`);
  }

  const brands = new Set();
  const lookup = new Map();
  /** First series token → entries whose model names a longer title after it
   * ("3950 iVIEW" → token "3950"), so a feed's bare "3950" can still find the
   * hardware while the full title stays exact-only. Tokens without a digit
   * ("pro", "mega") never enter the map. */
  const series = new Map();
  let cameras = 0;
  for (const line of lines.slice(1)) {
    if (!line?.trim()) continue;
    const fields = parseCsvLine(line);
    const brand = String(fields[brandCol] || '').trim();
    const model = String(fields[modelCol] || '').trim();
    const id = String(fields[idCol] || '').trim();
    if (!brand || !model || !id) continue;
    brands.add(brand);
    cameras++;
    const entry = { brand, model, id };
    for (const key of entryKeys(brand, model)) {
      if (!key) continue;
      const list = lookup.get(key);
      if (list) {
        if (!list.some((existing) => existing.id === id)) list.push(entry);
      } else {
        lookup.set(key, [entry]);
      }
    }
    const token = normalize(model).split(' ')[0];
    if (
      token.length >= SERIES_MIN_CHARS &&
      /\d/.test(token) &&
      normalize(model).includes(' ')
    ) {
      const tokenLookup = series.get(token);
      if (tokenLookup) {
        if (!tokenLookup.some((existing) => existing.id === id)) {
          tokenLookup.push(entry);
        }
      } else {
        series.set(token, [entry]);
      }
    }
  }

  const index = {
    schemaVersion: 1,
    source: 'ch-bas/cctv-camera-database',
    sourceUrl: REPO_URL,
    sourceFile: 'data/cameras.csv',
    license: 'CC0-1.0',
    generatedAt: new Date().toISOString(),
    cameraCount: cameras,
    brandCount: brands.size,
    // brand → [normalized model key|keys]; the runtime reads lookup only.
    brands: [...brands].sort(),
    brandNorm: brands.size ? [...brands].map((brand) => normalize(brand)) : [],
    lookup: Object.fromEntries([...lookup].sort(([a], [b]) => (a < b ? -1 : 1))),
    series: Object.fromEntries([...series].sort(([a], [b]) => (a < b ? -1 : 1))),
  };

  const outDir = path.resolve(OUT_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, OUT_FILE);
  fs.writeFileSync(outFile, `${JSON.stringify(index)}\n`);
  const mb = (fs.statSync(outFile).size / 1e6).toFixed(2);
  console.log(
    `Wrote ${outFile}: ${cameras} cameras, ${brands.size} brands, ${lookup.size} lookup keys (${mb} MB)`,
  );
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
