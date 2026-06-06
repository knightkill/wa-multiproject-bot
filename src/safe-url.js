import { lookup } from 'node:dns/promises';
import net from 'node:net';

export class UnsafeUrlError extends Error {
  constructor(detail) {
    super(detail);
    this.name = 'UnsafeUrlError';
  }
}

const MAX_REDIRECTS = 3;

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function isPrivateIpv4(ip) {
  const value = ipv4ToInt(ip);
  const inRange = (base, bits) => (value >>> (32 - bits)) === (ipv4ToInt(base) >>> (32 - bits));
  return (
    inRange('0.0.0.0', 8) ||
    inRange('10.0.0.0', 8) ||
    inRange('100.64.0.0', 10) ||
    inRange('127.0.0.0', 8) ||
    inRange('169.254.0.0', 16) || // link-local + cloud metadata (169.254.169.254)
    inRange('172.16.0.0', 12) ||
    inRange('192.0.0.0', 24) ||
    inRange('192.168.0.0', 16) ||
    inRange('198.18.0.0', 15) ||
    inRange('224.0.0.0', 4) ||
    inRange('240.0.0.0', 4)
  );
}

// Expand any valid IPv6 textual form to its 8 hextets. Handles `::`
// compression and a trailing dotted-quad (e.g. ::ffff:127.0.0.1), which is
// what makes mapped-address checks reliable regardless of how new URL()
// normalised the host (it rewrites dotted v4-mapped forms to hex).
function expandIpv6(addr) {
  let text = addr.toLowerCase().split('%')[0];
  const dotted = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const octets = dotted[1].split('.').map(Number);
    const hex = `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
    text = text.slice(0, dotted.index) + hex;
  }
  const [head, tail] = text.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail === undefined ? null : tail ? tail.split(':') : [];
  let hextets;
  if (tailParts === null) {
    hextets = headParts;
  } else {
    const fill = 8 - headParts.length - tailParts.length;
    if (fill < 0) return null;
    hextets = [...headParts, ...Array(fill).fill('0'), ...tailParts];
  }
  if (hextets.length !== 8) return null;
  return hextets.map((part) => parseInt(part || '0', 16));
}

function isPrivateIpv6(ip) {
  const hextets = expandIpv6(ip);
  if (!hextets || hextets.some((value) => Number.isNaN(value))) return true;
  if (hextets.every((value) => value === 0)) return true; // ::
  // IPv4-mapped (::ffff:0:0/96) and deprecated IPv4-compatible (::/96):
  // the embedded v4 is the real destination, so validate it as v4.
  const highIsZero = hextets.slice(0, 5).every((value) => value === 0);
  if (highIsZero && (hextets[5] === 0xffff || hextets[5] === 0)) {
    const embedded = `${hextets[6] >> 8}.${hextets[6] & 0xff}.${hextets[7] >> 8}.${hextets[7] & 0xff}`;
    return isPrivateIpv4(embedded);
  }
  const first = hextets[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA (incl. Fly 6PN fdaa::/16)
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

function isPrivateAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateIpv4(ip);
  if (kind === 6) return isPrivateIpv6(ip);
  return true;
}

// Throws unless `rawUrl` is http(s) and its host resolves only to public
// addresses. Returns the parsed URL on success.
export async function assertPublicHttpUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError('invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError(`unsupported protocol ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new UnsafeUrlError('url resolves to a private address');
    return url;
  }
  let records;
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw new UnsafeUrlError(`cannot resolve host ${host}`);
  }
  if (!records.length || records.some((record) => isPrivateAddress(record.address))) {
    throw new UnsafeUrlError('url resolves to a private address');
  }
  return url;
}

// SSRF-safe fetch: validates the URL, then follows redirects MANUALLY,
// re-validating each hop's Location. A plain fetch() follows 3xx itself, so
// a public URL could redirect to an internal target after the initial check
// passed — re-validating every hop closes that.
export async function safeFetch(rawUrl, options = {}) {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHttpUrl(current);
    const response = await fetch(current, { ...options, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      current = new URL(response.headers.get('location'), current).href;
      continue;
    }
    return response;
  }
  throw new UnsafeUrlError('too many redirects');
}
