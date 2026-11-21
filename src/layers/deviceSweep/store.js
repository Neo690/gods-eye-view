/**
 * Where an imported inventory and the operator's own place live: this browser.
 *
 * A scan of someone's flat is a map of their private network, so it is kept
 * out of every shared surface by construction: there is no upload path in this
 * module, the layer is registered as local-only (never serialised into a share
 * link), and the payload here is read and written only through `localStorage`.
 * Importing again replaces the scan; clearing it keeps the place, because the
 * place is where the operator is, not part of the file.
 *
 * The stored form packs each device as one array rather than an object map —
 * key names would double the size for no benefit — and a write that would not
 * fit is refused with a reason instead of silently dropping half the file.
 *
 * What a re-import carries across instead of resetting: the FIRST time each
 * device was seen (so a later import can say what is new), the LAST time it
 * answered to a scan, and the operator's own note about it. All three are keyed
 * by the MAC, or by the address for a device whose MAC the inventory did not
 * give. A device the new file does not mention keeps its row with its old
 * `lastSeen` rather than vanishing — the layer greys it, because a camera that
 * stopped answering is exactly what the operator is looking for — and only
 * CLEAR empties the list.
 *
 * The maker is the one thing deliberately NOT carried: only a name the file
 * itself gave is written down, and the shortlist's answer is recomputed from the
 * MAC on every read. A shortlist is a judgement this project can correct, and a
 * frozen copy of it would keep printing a maker that has since been withdrawn.
 */
import {
  DEVICE_VENDOR_PREFIXES,
  SCAN_MAX_DEVICES,
  classifyDevice,
  vendorForMac,
} from './scan.js';

export const DEVICE_SWEEP_STORAGE_KEY = 'gev.device-sweep.v1';

/**
 * Version of the payload stored under that key. v2 added `lastSeen` to each
 * device row; a v1 row (six fields) still reads, dated by the import that
 * carried it. v3 added the maker rule: a row keeps only the name the FILE gave,
 * and the shortlist's answer is recomputed from the MAC on every read — so a
 * corrected shortlist corrects the scans already in the browser instead of
 * leaving a wrong maker printed forever. The key keeps its name: renaming it
 * would strand every scan already in a browser on an address nothing reads, and
 * the payload versions itself.
 */
export const DEVICE_SWEEP_FORMAT_VERSION = 3;

/**
 * The names the shortlist itself can produce. A v1/v2 row holding one of these
 * stored the shortlist's answer, not the file's, and a corrected list must be
 * able to take it back. A name nmap gave ("Hangzhou Hikvision Digital
 * Technology Co., Ltd.") is in none of them and stays as evidence.
 */
const SHORTLIST_NAMES = new Set(
  Object.values(DEVICE_VENDOR_PREFIXES).map((name) => name.toLowerCase()),
);

/** Ceiling for the stored string; localStorage itself is around 5 MB. */
export const DEVICE_SWEEP_MAX_BYTES = 512_000;

/** Longest note one device keeps, in characters. */
export const DEVICE_SWEEP_NOTE_MAX = 280;

/** A refusal with a machine reason the row can translate. */
export class DeviceSweepStoreError extends Error {
  /**
   * @param {'unavailable'|'too-large'|'write-failed'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'DeviceSweepStoreError';
    this.code = code;
  }
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // A browser with storage disabled throws on the property itself.
    return null;
  }
}

/**
 * The identity a device keeps across imports: its MAC when the inventory gave
 * one, its address otherwise. This is also the key a note is filed under.
 * @param {{mac?: string, ip?: string}} device
 * @returns {string}
 */
export function deviceSweepKey(device) {
  return String(device?.mac || device?.ip || '').trim();
}

/**
 * One device as stored:
 * [ip, mac, fileVendor, hostname, "port/protocol;…", firstSeen, lastSeen].
 *
 * The maker column holds only what the file claimed. Anything the shortlist
 * worked out is a function of the MAC, so writing it down would freeze an
 * answer that a corrected list should be free to change.
 */
function packDevice(device) {
  return [
    String(device.ip ?? ''),
    String(device.mac ?? ''),
    String(device.scannedVendor ?? ''),
    String(device.hostname ?? ''),
    (Array.isArray(device.ports) ? device.ports : [])
      .map((port) => `${port.port}/${port.protocol}`)
      .join(';'),
    Number.isFinite(device.firstSeen) ? device.firstSeen : 0,
    Number.isFinite(device.lastSeen) ? device.lastSeen : 0,
  ];
}

function unpackPorts(value) {
  return String(value ?? '')
    .split(';')
    .flatMap((entry) => {
      const [port, protocol] = entry.split('/');
      const number = Number(port);
      if (!Number.isInteger(number) || number < 1 || number > 65535) return [];
      return [{ port: number, protocol: protocol === 'udp' ? 'udp' : 'tcp' }];
    });
}

function unpackDevice(
  row,
  importedAt,
  { version = 1, vendorOf = vendorForMac } = {},
) {
  if (!Array.isArray(row) || row.length < 1) return null;
  const [ip, mac, vendor, hostname, ports, firstSeen, lastSeen] = row;
  const address = String(ip ?? '').trim();
  if (!address) return null;
  const storedVendor = String(vendor ?? '').trim();
  // A v1/v2 row kept whatever the maker read as when it was imported, which for
  // a device the shortlist knew was that list's own answer. Treat such a name as
  // derived and let the list speak again; from v3 the column is the file's word
  // by construction and is kept as it stands.
  const fileVendor =
    version >= 3 || !SHORTLIST_NAMES.has(storedVendor.toLowerCase())
      ? storedVendor
      : '';
  const device = {
    ip: address,
    mac: String(mac ?? ''),
    vendor: fileVendor || vendorOf(String(mac ?? '')),
    scannedVendor: fileVendor,
    hostname: String(hostname ?? ''),
    ports: unpackPorts(ports),
  };
  // The verdict is recomputed on every read, so improving the classifier
  // improves an existing import instead of freezing it.
  const seen = Number(firstSeen);
  const last = Number(lastSeen);
  return Object.assign(device, classifyDevice(device, { vendorOf }), {
    // An import written before this field existed is dated by its own import
    // time rather than losing the device.
    firstSeen: Number.isFinite(seen) && seen > 0 ? seen : importedAt,
    // A v1 row (six fields) has no `lastSeen`. Every device such a payload
    // holds was in the import it names, so that import is its last sighting —
    // not its first, and not "never seen", which would grey a whole scan the
    // first time a browser upgraded.
    lastSeen: Number.isFinite(last) && last > 0 ? last : importedAt,
  });
}

function readPlace(value) {
  const lat = Number(value?.lat);
  const lon = Number(value?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/** Stored notes, as a plain object of key → text. */
function readNotes(value) {
  const notes = {};
  if (!value || typeof value !== 'object') return notes;
  for (const [key, text] of Object.entries(value)) {
    const note = String(text ?? '').trim();
    if (key && note) notes[key] = note.slice(0, DEVICE_SWEEP_NOTE_MAX);
  }
  return notes;
}

/**
 * @param {object} [options]
 * @param {Storage|null} [options.storage] Injected for tests.
 * @param {() => number} [options.now]
 */
export function createDeviceSweepStore({
  storage = defaultStorage(),
  now = () => Date.now(),
  // The maker shortlist is a policy input, read on every read(). Injected so a
  // scan stored before a correction is testable against the corrected list.
  resolveVendor = vendorForMac,
} = {}) {
  /**
   * Write one whole payload, or refuse with a reason the row can translate.
   * Every mutation goes through here, so no path can save half a scan.
   */
  function persist({
    devices = [],
    place = null,
    importedAt = null,
    name = '',
    notes = {},
  }) {
    if (!storage)
      throw new DeviceSweepStoreError(
        'unavailable',
        'This browser cannot store an import',
      );
    const payload = {
      v: DEVICE_SWEEP_FORMAT_VERSION,
      at: Number.isFinite(importedAt) ? importedAt : now(),
      name: String(name ?? ''),
      place: readPlace(place),
      hosts: devices.slice(0, SCAN_MAX_DEVICES).map(packDevice),
      notes: readNotes(notes),
    };
    let serialised;
    try {
      serialised = JSON.stringify(payload);
    } catch {
      throw new DeviceSweepStoreError(
        'write-failed',
        'That scan could not be saved',
      );
    }
    const bytes = serialised.length;
    if (bytes > DEVICE_SWEEP_MAX_BYTES)
      throw new DeviceSweepStoreError(
        'too-large',
        'The scan is too large for this device',
      );
    try {
      storage.setItem(DEVICE_SWEEP_STORAGE_KEY, serialised);
    } catch (error) {
      // Quota exceeded arrives as a DOMException with no useful message;
      // name the remedy instead.
      throw new DeviceSweepStoreError(
        'write-failed',
        error?.name === 'QuotaExceededError'
          ? 'The scan is too large for this device'
          : 'That scan could not be saved',
      );
    }
    return { bytes, importedAt: payload.at };
  }

  /** Write the payload already read, with one part replaced. */
  function save(current, patch) {
    return persist({ ...current, ...patch });
  }

  /**
   * The whole stored payload, or an empty one. A half-written or hand-edited
   * value is not worth crashing a layer over: it reads as "no import" and the
   * next import replaces it.
   *
   * @returns {{devices: Array<object>, place: {lat:number, lon:number}|null,
   *   importedAt: number|null, name: string, notes: Object<string, string>}}
   */
  function read() {
    const empty = {
      devices: [],
      place: null,
      importedAt: null,
      name: '',
      notes: {},
    };
    if (!storage) return empty;
    let raw;
    try {
      raw = storage.getItem(DEVICE_SWEEP_STORAGE_KEY);
    } catch {
      return empty;
    }
    if (!raw) return empty;
    try {
      const payload = JSON.parse(raw);
      const importedAt = Number.isFinite(payload?.at) ? payload.at : null;
      const version = Number(payload?.v) || 1;
      const devices = (Array.isArray(payload?.hosts) ? payload.hosts : [])
        .map((row) =>
          unpackDevice(row, importedAt, { version, vendorOf: resolveVendor }),
        )
        .filter(Boolean);
      // A note filed under a device the store no longer holds is dead weight,
      // and would come back if a later device reused the key. A device missing
      // from the latest scan is still held, so its note still reads.
      const stored = readNotes(payload?.notes);
      const notes = {};
      for (const device of devices) {
        const key = deviceSweepKey(device);
        const note = stored[key];
        if (note) {
          notes[key] = note;
          device.note = note;
        } else device.note = '';
      }
      return {
        devices,
        place: readPlace(payload?.place),
        importedAt,
        name: String(payload?.name ?? ''),
        notes,
      };
    } catch {
      return empty;
    }
  }

  /**
   * Replace the stored scan. The place is kept (it is where the operator
   * stands, not a property of the file) and so is the first time each device
   * was seen, so a re-import can say what is new.
   *
   * Devices the new file does not mention are kept too, dated by the import
   * that last carried them: a device that stopped answering is evidence, and
   * dropping it would make the operator's network look tidier than it is. They
   * are appended after the scanned ones, so a file that fills the cap still
   * keeps every device it did see.
   *
   * @param {{devices: Array<object>, name?: string}} value
   * @returns {{bytes: number, importedAt: number, added: number}} `added`
   *   counts devices absent from the previous import.
   */
  function write({ devices = [], name = '' } = {}) {
    const current = read();
    const seen = new Map(
      current.devices.map((device) => [
        deviceSweepKey(device),
        device.firstSeen,
      ]),
    );
    const at = now();
    const kept = [];
    const scanned = new Set();
    let added = 0;
    for (const device of devices.slice(0, SCAN_MAX_DEVICES)) {
      const key = deviceSweepKey(device);
      if (scanned.has(key)) continue;
      scanned.add(key);
      const previous = seen.get(key);
      if (!seen.has(key)) added += 1;
      kept.push({
        ...device,
        firstSeen: Number.isFinite(previous) ? previous : at,
        lastSeen: at,
      });
    }
    for (const device of current.devices) {
      if (scanned.has(deviceSweepKey(device))) continue;
      kept.push({ ...device, lastSeen: device.lastSeen ?? at });
    }
    const { bytes } = save(current, { devices: kept, name, importedAt: at });
    return { bytes, importedAt: at, added };
  }

  /**
   * Record the place the scan is drawn at. Kept apart from the scan so a
   * location fix can arrive before or after the file.
   *
   * @param {{lat:number, lon:number}|null} place
   */
  function setPlace(place) {
    if (!storage) return null;
    const current = read();
    const next = readPlace(place);
    try {
      save(current, { place: next });
    } catch {
      // A broken store already reads as empty; the place is not worth a crash.
    }
    return next;
  }

  /**
   * Attach the operator's own note to one device, or remove it with an empty
   * one. The note never leaves this browser, like the scan it belongs to.
   *
   * @param {string} key A `deviceSweepKey`.
   * @param {string} text
   * @returns {Object<string, string>} The notes as they now read.
   */
  function setNote(key, text) {
    const current = read();
    const id = String(key ?? '');
    if (!storage || !id) return current.notes;
    const notes = { ...current.notes };
    const value = String(text ?? '')
      .trim()
      .slice(0, DEVICE_SWEEP_NOTE_MAX);
    if (value) notes[id] = value;
    else delete notes[id];
    try {
      save(current, { notes });
    } catch {
      return current.notes;
    }
    return notes;
  }

  /** Remove the scan and its notes; the place stays, it is not the file's. */
  function clear() {
    if (!storage) return;
    const current = read();
    if (!current.place) {
      try {
        storage.removeItem(DEVICE_SWEEP_STORAGE_KEY);
      } catch {
        // Nothing to do.
      }
      return;
    }
    try {
      save(current, { devices: [], notes: {} });
    } catch {
      // Nothing to do: a broken store already reads as empty.
    }
  }

  return { read, write, setPlace, setNote, clear };
}
