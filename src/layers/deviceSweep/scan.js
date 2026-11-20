/**
 * Read an inventory of the operator's own network into the devices on it.
 *
 * The globe can draw a public camera because its provider publishes a
 * position for it. A device on the operator's own Wi-Fi publishes nothing, so
 * this layer starts from the one artefact the operator already has: the scan
 * they ran. Nothing here touches the network or the DOM — the file is read by
 * the caller, and the result never leaves this browser.
 *
 * Five shapes are accepted, because asking the operator to re-run a scan in a
 * different format is asking them to remember a flag: nmap's XML report
 * (`-oX`), its normal report (no flag) and its greppable one (`-oG`), plus the
 * two inventories a desktop already has without installing anything — the ARP
 * table (`arp -a` on Linux, macOS and Windows, `/proc/net/arp`) and a router's
 * DHCP lease list. Only hosts a scan saw up are kept, and only ports it saw
 * open; the table and lease shapes carry no ports at all, so their verdicts
 * rest on the MAC and the host name alone.
 *
 * A table has to look like one. Its rows are an address and a MAC, so more than
 * one such row is required: a file that happens to quote a single address and
 * MAC is about something else, and reading it as an inventory would invent a
 * device the operator never scanned for.
 *
 * What a device *is* stays a guess, and the verdict says so: a MAC prefix, an
 * open RTSP port and a hostname are evidence, not proof. A lamp can serve an
 * admin page; a camera can answer on nothing but 443. The reasons are returned
 * with the verdict so the row can show its work instead of asking for trust.
 */

/** Most devices one import may keep. A home network is a few dozen. */
export const SCAN_MAX_DEVICES = 256;

/**
 * Prefixes the IEEE registry assigns to the maker of the device itself, and to
 * a maker whose products are cameras, recorders or boards.
 *
 * Every entry was checked against the IEEE MA-L registry (`oui.csv`, read
 * 2026-11-20): that company owns the block. Nothing more is inferred, and it
 * is why the table is short. In a tool built to find cameras a wrong maker is
 * worse than no maker — it turns a guess into a printed fact and sends the
 * operator looking for the wrong product — so an unverified prefix is left out
 * rather than hedged:
 *
 * - Espressif and Tuya blocks are registered, but to the maker of the radio
 *   module: the same ESP32 or Tuya chip sits in a lamp, a plug and a camera
 *   alike, so the prefix says nothing about the appliance.
 * - Blocks this module once carried without a source (`AC:E6:B8`, `08:3A:F8`)
 *   are in no IEEE registry at all — neither MA-L, MA-M nor MA-S.
 *
 * nmap's own `vendor` attribute (from its shipped OUI table) is still read
 * first for every host and wins when present; that answer has a provenance of
 * its own and is passed through as scanned.
 */
export const DEVICE_VENDOR_PREFIXES = Object.freeze({
  // Hangzhou Hikvision Digital Technology Co., Ltd.
  '4419b6': 'Hikvision',
  bcad28: 'Hikvision',
  c056e3: 'Hikvision',
  '4cbd8f': 'Hikvision',
  '1868cb': 'Hikvision',
  '2857be': 'Hikvision',
  a41437: 'Hikvision',
  // Zhejiang Dahua Technology Co., Ltd.
  '3cef8c': 'Dahua',
  '4c11bf': 'Dahua',
  e0508b: 'Dahua',
  '9002a9': 'Dahua',
  // Axis Communications AB
  '00408c': 'Axis',
  accc8e: 'Axis',
  b8a44f: 'Axis',
  // Raspberry Pi Foundation / Raspberry Pi Trading Ltd
  b827eb: 'Raspberry Pi',
  dca632: 'Raspberry Pi',
  e45f01: 'Raspberry Pi',
  d83add: 'Raspberry Pi',
});

/**
 * Vendors whose boards are sensors and switches, never a laptop. These names
 * arrive from the scan's own OUI table, never from the shortlist above.
 */
const SENSOR_VENDORS = new Set([
  'Espressif',
  'Tuya',
  'Raspberry Pi',
  'Sonoff',
  'Shelly',
]);

/** A vendor name that reads as a camera even from nmap's own OUI table. */
const CAMERA_VENDOR_WORDS =
  /hikvision|dahua|axis|foscam|reolink|amcrest|uniview|vivotek|mobotix|hanwha|wisenet|annke|lorex|zmodo|wansview|arlo|wyze|blink|eufy|avertx|swann/i;

/** A host name the operator or the device gave itself: `ipcam-2`, `NVR-01`. */
const CAMERA_HOSTNAME =
  /(^|[-_.])(cam|ipcam|ipc|nvr|dvr|rtsp|webcam|camera)([-_.\d]|$)/i;

/** RTSP and its alternate port: a live video stream, in one port. */
const STREAM_PORTS = new Map([
  [554, 'rtsp'],
  [8554, 'rtsp-alt'],
]);

/** Recorder services that answer on their own vendor port. */
const RECORDER_PORTS = new Set([37777, 34567]);

/** Streaming a recorder relays, weaker than RTSP but still video-shaped. */
const RELAY_PORTS = new Set([1935]);

/** Web admin pages. Weak alone: a printer has one too. */
const ADMIN_PORTS = new Set([80, 81, 88, 8000, 8080, 8081, 8888]);

function attribute(tag, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(String(tag));
  return match ? match[1].trim() : '';
}

/** `B4:A3:82:11:22:33` → `b4a382`, the prefix an OUI is written in. */
function macPrefix(mac) {
  const hex = String(mac ?? '')
    .replace(/[^0-9a-f]/gi, '')
    .toLowerCase();
  return hex.length >= 6 ? hex.slice(0, 6) : '';
}

/**
 * The maker a MAC address is registered to, when this module can vouch for it.
 *
 * An empty string is the honest answer for a prefix that is unknown, belongs to
 * a chip maker, or was never registered; callers must show no vendor at all
 * rather than a candidate.
 *
 * @param {string} mac
 * @returns {string}
 */
export function vendorForMac(mac) {
  return DEVICE_VENDOR_PREFIXES[macPrefix(mac)] ?? '';
}

function normalisePorts(ports) {
  const seen = new Set();
  const out = [];
  for (const port of Array.isArray(ports) ? ports : []) {
    const number = Number(port?.port);
    if (!Number.isInteger(number) || number < 1 || number > 65535) continue;
    const protocol = String(port?.protocol ?? 'tcp').toLowerCase();
    const key = `${number}/${protocol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ port: number, protocol });
  }
  return out.sort((a, b) => a.port - b.port);
}

/**
 * Score one device from the evidence the scan carries.
 *
 * The weights are deliberately coarse: one RTSP port is worth more than an
 * admin page, a camera maker's MAC is worth more than a hostname. A device
 * with nothing to say about itself is `unknown` rather than assumed safe.
 *
 * @param {{mac?:string, vendor?:string, hostname?:string, ports?:Array<object>}} device
 * @returns {{verdict:'camera'|'iot'|'network'|'unknown', score:number,
 *   reasons:Array<{code:string, detail:string}>}}
 */
export function classifyDevice(device) {
  const reasons = [];
  const ports = normalisePorts(device?.ports);
  const declaredVendor = String(device?.vendor ?? '').trim();
  const vendor = declaredVendor || vendorForMac(device?.mac);
  const hostname = String(device?.hostname ?? '').trim();
  let score = 0;
  let adminSeen = false;

  for (const port of ports) {
    if (STREAM_PORTS.has(port.port)) {
      score += 5;
      reasons.push({
        code: 'rtsp',
        detail: `${port.port}/${port.protocol}`,
      });
      continue;
    }
    if (RECORDER_PORTS.has(port.port)) {
      score += 5;
      reasons.push({
        code: 'recorder',
        detail: String(port.port),
      });
      continue;
    }
    if (RELAY_PORTS.has(port.port)) {
      score += 2;
      reasons.push({
        code: 'stream',
        detail: `${port.port}/${port.protocol}`,
      });
      continue;
    }
    if (ADMIN_PORTS.has(port.port) && !adminSeen) {
      adminSeen = true;
      score += 1;
      reasons.push({
        code: 'admin',
        detail: `${port.port}/${port.protocol}`,
      });
    }
  }

  if (vendor && CAMERA_VENDOR_WORDS.test(vendor)) {
    score += 4;
    reasons.push({ code: 'vendor', detail: vendor });
  } else if (vendor && SENSOR_VENDORS.has(vendor)) {
    score += 2;
    reasons.push({ code: 'sensor', detail: vendor });
  }

  if (hostname && CAMERA_HOSTNAME.test(hostname)) {
    score += 3;
    reasons.push({ code: 'hostname', detail: hostname });
  }

  const verdict =
    score >= 4
      ? 'camera'
      : score >= 2
        ? 'iot'
        : score >= 1 || ports.length || vendor
          ? 'network'
          : 'unknown';

  return { verdict, score, reasons };
}

/** One host, with its ports and its verdict, or null when it cannot be placed. */
function makeDevice({ ip, mac = '', vendor = '', hostname = '', ports = [] }) {
  const address = String(ip ?? '').trim();
  if (!address) return null;
  const normalisedMac = String(mac ?? '')
    .trim()
    .toUpperCase();
  const device = {
    ip: address,
    mac: normalisedMac,
    // nmap's OUI answer wins; our shortlist only fills a gap it left.
    vendor: String(vendor ?? '').trim() || vendorForMac(normalisedMac),
    hostname: String(hostname ?? '').trim(),
    ports: normalisePorts(ports),
  };
  return Object.assign(device, classifyDevice(device));
}

function xmlDevices(text) {
  const devices = [];
  for (const match of text.matchAll(/<host\b[\s\S]*?<\/host>/gi)) {
    const block = match[0];
    const status = /<status\b[^>]*>/.exec(block);
    if (status && attribute(status[0], 'state') === 'down') continue;
    let ip = '';
    let mac = '';
    let vendor = '';
    for (const address of block.matchAll(/<address\b[^>]*>/gi)) {
      const kind = attribute(address[0], 'addrtype');
      if (kind === 'ipv4' || kind === 'ipv6')
        ip = attribute(address[0], 'addr');
      if (kind === 'mac') {
        mac = attribute(address[0], 'addr');
        vendor = attribute(address[0], 'vendor');
      }
    }
    const hostnameMatch = /<hostname\b[^>]*>/.exec(block);
    const ports = [];
    for (const port of block.matchAll(/<port\b[^>]*>[\s\S]*?<\/port>/gi)) {
      const tag = port[0];
      const state = /<state\b[^>]*>/.exec(tag);
      if (state && attribute(state[0], 'state') !== 'open') continue;
      ports.push({
        port: attribute(tag, 'portid'),
        protocol: attribute(tag, 'protocol'),
      });
    }
    devices.push({
      ip,
      mac,
      vendor,
      hostname: hostnameMatch ? attribute(hostnameMatch[0], 'name') : '',
      ports,
    });
  }
  return devices;
}

function normalDevices(text) {
  const devices = [];
  const blocks = text.split(/^(?=Nmap scan report for )/m);
  for (const block of blocks) {
    const report = /^Nmap scan report for (.+)$/m.exec(block);
    if (!report) continue;
    // "host.lan (192.168.1.5)" or just "192.168.1.5".
    const named = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(report[1].trim());
    const ip = named ? named[2].trim() : report[1].trim();
    const hostname = named ? named[1].trim() : '';
    const macMatch =
      /^MAC Address:\s*([0-9A-Fa-f:.-]{17})(?:\s*\(([^)]*)\))?/m.exec(block);
    const ports = [];
    for (const port of block.matchAll(/^(\d{1,5})\/(tcp|udp)\s+open\s/gim)) {
      ports.push({ port: port[1], protocol: port[2] });
    }
    devices.push({
      ip,
      mac: macMatch?.[1] ?? '',
      vendor: macMatch?.[2] ?? '',
      hostname,
      ports,
    });
  }
  return devices;
}

function greppableDevices(text) {
  const devices = [];
  for (const line of text.split(/\r?\n/)) {
    const host = /^Host:\s+(\S+)(?:\s+\(([^)]*)\))?/.exec(line.trim());
    if (!host) continue;
    const ports = [];
    const section = /Ports:\s*(.+)$/.exec(line);
    if (section) {
      // "554/open/tcp//rtsp//Hikvision/, 80/open/tcp//http//"
      for (const entry of section[1].split(',')) {
        const fields = entry.trim().split('/');
        if (fields.length < 3) continue;
        if (fields[1].trim().toLowerCase() !== 'open') continue;
        ports.push({ port: fields[0], protocol: fields[2] });
      }
    }
    devices.push({
      ip: host[1],
      hostname: host[2] ?? '',
      mac: '',
      vendor: '',
      ports,
    });
  }
  return devices;
}

/** `0:11:22:33:44:55`, `00-11-22-33-44-55` → `00:11:22:33:44:55`. */
function normaliseMac(mac) {
  const groups = String(mac ?? '')
    .trim()
    .split(/[:-]/);
  if (groups.length !== 6) return '';
  if (!groups.every((group) => /^[0-9a-f]{1,2}$/i.test(group))) return '';
  return groups
    .map((group) => group.padStart(2, '0'))
    .join(':')
    .toUpperCase();
}

/** `? (192.168.1.1) at 00:11:22:33:44:55 [ether] on eth0` — Linux and macOS. */
const ARP_AT_LINE =
  /^(.*?)\s*\((\d{1,3}(?:\.\d{1,3}){3})\)\s+at\s+([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})\b/i;

/** The `/proc/net/arp` column header, which is how that file names itself. */
const ARP_PROC_COLUMNS = /^IP address\s+HW type\s+Flags\s+HW address\b/i;

/** An address and a MAC on one line: any router's lease export, or the
 * Windows ARP table, which is the same three columns. */
const IPV4_ANYWHERE = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;
const MAC_ANYWHERE = /\b([0-9a-f]{1,2}(?:[:-][0-9a-f]{1,2}){5})\b/i;

/**
 * Column words a lease export repeats; none of them is a host name.
 *
 * Routers localize the export, and the lease state sits in the column where a
 * name would: unaccented `Dynamique`, `Dynamisch`, `dinamica` or `statica` is a
 * plain ASCII word, so without these it would be read as the device's own
 * name. The accented and non-Latin spellings are the same vocabulary, kept
 * beside them; the host-name shape below admits ASCII only, so those never
 * reach this set — the state is already skipped by its shape.
 */
const LEASE_WORDS = new Set([
  'dhcp',
  'lease',
  'leases',
  'expires',
  'expiry',
  'permanent',
  'infinite',
  'reserved',
  'active',
  'inactive',
  'yes',
  'no',
  'dynamic',
  'static',
  // French
  'dynamique',
  'statique',
  // Spanish
  'dinámica',
  'estática',
  // German
  'dynamisch',
  'statisch',
  // Italian, and the unaccented Spanish and Portuguese forms with it
  'dinamico',
  'dinamica',
  'estatico',
  'statico',
  'statica',
  // Portuguese
  'dinâmico',
  'estático',
  // Russian
  'динамический',
  'статический',
  // Chinese
  '动态',
  '静态',
]);

function lines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * An ARP table, read the three ways it is written. An entry still marked
 * incomplete carries no MAC, so it is skipped: the address answered once and
 * then stopped, and there is nothing to attribute.
 */
function arpDevices(text) {
  const devices = [];
  for (const line of lines(text)) {
    if (line.startsWith('#')) continue;
    const columns = line.split(/\s+/);
    // /proc/net/arp: address, hw type, flags, mac, mask, device.
    if (columns.length === 6 && IPV4_ANYWHERE.test(columns[0])) {
      if (columns[2] === '0x0') continue;
      const mac = normaliseMac(columns[3]);
      if (mac) devices.push({ ip: columns[0], mac });
      continue;
    }
    const at = ARP_AT_LINE.exec(line);
    if (at) {
      const name = at[1].replace(/^[?!]\s*/, '').trim();
      const mac = normaliseMac(at[3]);
      if (mac) devices.push({ ip: at[2], mac, hostname: name });
    }
  }
  return devices;
}

/**
 * A router's lease list: one address and one MAC per line, with a host name
 * when the export carries one. Columns named after a lease state are not host
 * names, and anything without both an address and a MAC is not a lease.
 */
function leaseDevices(text) {
  const devices = [];
  for (const line of lines(text)) {
    if (line.startsWith('#')) continue;
    const address = IPV4_ANYWHERE.exec(line);
    const mac = MAC_ANYWHERE.exec(line);
    if (!address || !mac) continue;
    const ip = address[1];
    if (ip.startsWith('0.') || ip === '255.255.255.255') continue;
    const normalised = normaliseMac(mac[1]);
    if (!normalised) continue;
    let hostname = '';
    for (const token of line.split(/[\s,;|\t]+/)) {
      if (!token || token === ip || token === mac[1]) continue;
      if (!/^[A-Za-z][\w.-]{0,62}$/.test(token)) continue;
      if (LEASE_WORDS.has(token.toLowerCase())) continue;
      hostname = token;
      break;
    }
    devices.push({ ip, mac: normalised, hostname });
  }
  return devices;
}

const looksLikeArp = (body) =>
  lines(body).some((line) => ARP_AT_LINE.test(line));

/**
 * The format a file claims and the hosts it yields, or `[null, []]`.
 *
 * Each shape is tried in the order it can be told apart, because each names
 * itself: an nmap report says so, an ARP table has a line shape of its own, and
 * a lease list is what is left — the one shape that has to prove it is a list.
 * The Windows ARP table is the same three columns as a lease export, so it is
 * read there too, and a real one carries its interface line and several rows.
 */
function readInventory(text) {
  if (/<nmaprun\b/i.test(text)) return ['xml', xmlDevices(text)];
  if (/^Nmap scan report for /m.test(text))
    return ['normal', normalDevices(text)];
  if (/^Host:\s/m.test(text)) return ['greppable', greppableDevices(text)];
  if (ARP_PROC_COLUMNS.test(text.trim()) || looksLikeArp(text))
    return ['arp', arpDevices(text)];
  const leases = leaseDevices(text);
  return leases.length > 1 ? ['leases', leases] : [null, []];
}

/**
 * Parse one inventory file into classified devices.
 *
 * @param {string} text File contents.
 * @param {{limit?: number}} [options]
 * @returns {{
 *   format: 'xml'|'normal'|'greppable'|'arp'|'leases'|null,
 *   devices: Array<object>,
 *   truncated: boolean,
 * }}
 */
export function parseInventory(text, { limit = SCAN_MAX_DEVICES } = {}) {
  const body = String(text ?? '');
  const cap =
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : SCAN_MAX_DEVICES;
  const [format, raw] = readInventory(body);
  if (!format) return { format: null, devices: [], truncated: false };

  const byKey = new Map();
  let truncated = false;
  for (const host of raw) {
    const device = makeDevice(host);
    if (!device) continue;
    // The same host can appear twice in a merged report; the MAC is the
    // identity when there is one, the address otherwise.
    const key = device.mac || device.ip;
    const existing = byKey.get(key);
    if (existing) {
      // Keep the richer row: a ping sweep followed by a port scan merges into
      // one device that carries both the MAC and the ports.
      if (device.ports.length > existing.ports.length) byKey.set(key, device);
      continue;
    }
    if (byKey.size >= cap) {
      truncated = true;
      continue;
    }
    byKey.set(key, device);
  }

  return { format, devices: [...byKey.values()], truncated };
}

/**
 * The reader's earlier name, kept for callers that imported it while it only
 * understood nmap. Same function, same result.
 */
export const parseNmapScan = parseInventory;
