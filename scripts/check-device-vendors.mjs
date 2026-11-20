// Re-check the device sweep's MAC shortlist against the IEEE registries.
//
//   node scripts/check-device-vendors.mjs
//
// The shortlist in src/layers/deviceSweep/scan.js exists to name a camera
// maker with certainty, and a wrong attribution is worse than none. Every
// entry claims an MA-L block that the IEEE assigns to the maker of an
// appliance, so this script reads the live registries and reports:
//
//   - a prefix that is no longer an MA-L assignment (or never was one), and
//     whether it survives only as part of a longer MA-M/MA-S block;
//   - a prefix whose registered company does not read as the maker the
//     shortlist names.
//
// It exits 1 on any mismatch, so it can be run as a gate when the shortlist is
// edited. It is deliberately NOT part of CI: it needs the public registries,
// and a network hiccup must not turn into a red pipeline that reviewers learn
// to ignore.
//
// After a successful run, update the "read YYYY-MM-DD" note above the table in
// scan.js, which is what tells a later reader how fresh the check is.

import { DEVICE_VENDOR_PREFIXES } from '../src/layers/deviceSweep/scan.js';

const REGISTRIES = [
  ['MA-L', 'https://standards-oui.ieee.org/oui/oui.csv', 6],
  ['MA-M', 'https://standards-oui.ieee.org/oui28/mam.csv', 7],
  ['MA-S', 'https://standards-oui.ieee.org/oui36/oui36.csv', 9],
];

/** How each retained maker's registered company should read. */
const VENDOR_WORDS = {
  Hikvision: /hikvision/i,
  Dahua: /dahua/i,
  Axis: /axis communications/i,
  'Raspberry Pi': /raspberry pi/i,
};

/**
 * Registry rows as assignment → company. The organisation column may be
 * quoted and may contain commas, so only the first three fields are read.
 * @param {string} text
 * @param {number} length Hex digits this registry assigns.
 */
export function parseRegistry(text, length) {
  const rows = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^([^,]*),([^,]*),(?:"((?:[^"]|"")*)"|([^,]*))/.exec(line);
    if (!match) continue;
    const assignment = match[2].trim().toUpperCase();
    if (assignment.length !== length || !/^[0-9A-F]+$/.test(assignment))
      continue;
    rows.set(
      assignment,
      (match[3] ?? match[4] ?? '').replace(/""/g, '"').trim(),
    );
  }
  return rows;
}

const failures = [];
const registries = new Map();

for (const [name, url, length] of REGISTRIES) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    failures.push(`${name}: could not be read (${error?.message ?? error})`);
    continue;
  }
  if (!response.ok) {
    failures.push(`${name}: HTTP ${response.status}`);
    continue;
  }
  const rows = parseRegistry(await response.text(), length);
  registries.set(name, rows);
  console.log(`${name}: ${rows.size} assignments read`);
}

if (registries.size) {
  const maL = registries.get('MA-L') ?? new Map();
  for (const [prefix, vendor] of Object.entries(DEVICE_VENDOR_PREFIXES)) {
    const assignment = prefix.toUpperCase();
    const company = maL.get(assignment);
    if (!company) {
      const longer = ['MA-M', 'MA-S'].find(
        (name) =>
          rowsHave(name) &&
          [...registries.get(name).keys()].some((entry) =>
            entry.startsWith(assignment),
          ),
      );
      failures.push(
        `${prefix}: not an MA-L block${longer ? ` (only part of a ${longer} assignment)` : ''}`,
      );
      continue;
    }
    const words = VENDOR_WORDS[vendor];
    if (!words) {
      failures.push(`${prefix}: no expected company for "${vendor}"`);
      continue;
    }
    if (!words.test(company))
      failures.push(
        `${prefix}: MA-L names "${company}", the shortlist says ${vendor}`,
      );
  }
}

function rowsHave(name) {
  return (registries.get(name)?.size ?? 0) > 0;
}

if (failures.length) {
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(
    `\n${failures.length} prefix(es) to review against the IEEE registries.`,
  );
} else {
  console.log(
    `\nAll ${Object.keys(DEVICE_VENDOR_PREFIXES).length} prefixes match the IEEE MA-L registry.`,
  );
  console.log('Update the "read YYYY-MM-DD" note in scan.js.');
}

process.exitCode = failures.length ? 1 : 0;
