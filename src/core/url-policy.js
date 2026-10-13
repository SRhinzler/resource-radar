const dns = require('node:dns').promises;
const net = require('node:net');

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google.com',
  'instance-data.ec2.internal',
]);

function normalizeInput(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new Error('Enter a webpage URL first.');
  }

  return /^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`;
}

function parseHttpUrl(value) {
  const input = normalizeInput(value);
  let parsed;

  try {
    parsed = new URL(input);
  } catch {
    throw new Error('Enter a valid webpage URL.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only public HTTP and HTTPS URLs are supported.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('URLs with embedded credentials are not supported.');
  }

  if (!parsed.hostname) {
    throw new Error('The URL is missing a hostname.');
  }

  parsed.hash = '';
  return parsed;
}

function ipv4ToNumber(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }

  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function isPrivateIpv4(address) {
  const value = ipv4ToNumber(address);
  if (value === null) return false;

  const inRange = (start, end) => value >= start && value <= end;
  return (
    inRange(0x00000000, 0x00ffffff) || // this network / current host
    inRange(0x0a000000, 0x0affffff) || // 10.0.0.0/8
    inRange(0x64400000, 0x647fffff) || // 100.64.0.0/10
    inRange(0x7f000000, 0x7fffffff) || // loopback
    inRange(0xa9fe0000, 0xa9feffff) || // link-local
    inRange(0xac100000, 0xac1fffff) || // 172.16.0.0/12
    inRange(0xc0a80000, 0xc0a8ffff) || // 192.168.0.0/16
    inRange(0xc0000000, 0xc00000ff) || // IETF protocol assignments
    inRange(0xc0000200, 0xc00002ff) || // documentation
    inRange(0xc6336400, 0xc63364ff) || // documentation
    inRange(0xcb007100, 0xcb0071ff) || // documentation
    inRange(0xe0000000, 0xffffffff) // multicast and reserved
  );
}

function isPrivateIp(address) {
  const value = String(address).toLowerCase().replace(/^\[|\]$/g, '');

  if (net.isIPv4(value)) {
    return isPrivateIpv4(value);
  }

  if (!net.isIPv6(value)) {
    return true;
  }

  if (value === '::' || value === '::1' || value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length);
    return value === '::' || value === '::1' || isPrivateIpv4(mapped);
  }

  return (
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    value.startsWith('fe8') ||
    value.startsWith('fe9') ||
    value.startsWith('fea') ||
    value.startsWith('feb') ||
    value.startsWith('ff')
  );
}

async function resolvePublicHost(hostname, lookup = dns.lookup) {
  const normalized = String(hostname).toLowerCase().replace(/\.$/, '');

  if (BLOCKED_HOSTNAMES.has(normalized) || normalized.endsWith('.localhost') || normalized.endsWith('.local')) {
    throw new Error('Local and internal hosts are not allowed.');
  }

  if (net.isIP(normalized)) {
    if (isPrivateIp(normalized)) {
      throw new Error('Private and local network addresses are not allowed.');
    }
    return { address: normalized, family: net.isIP(normalized) };
  }

  let records;
  try {
    records = await lookup(normalized, { all: true, verbatim: true });
  } catch {
    throw new Error('The hostname could not be resolved.');
  }

  const addresses = Array.isArray(records) ? records : [records];
  const usable = addresses.filter((record) => record && record.address && !isPrivateIp(record.address));

  if (!usable.length || usable.length !== addresses.length) {
    throw new Error('The hostname resolves to a private or local network address.');
  }

  return { address: usable[0].address, family: usable[0].family || net.isIP(usable[0].address) };
}

async function assertPublicUrl(value, options = {}) {
  const url = parseHttpUrl(value);
  const resolved = await resolvePublicHost(url.hostname, options.lookup || dns.lookup);
  return { url, ...resolved };
}

module.exports = {
  assertPublicUrl,
  isPrivateIp,
  normalizeInput,
  parseHttpUrl,
  resolvePublicHost,
};
