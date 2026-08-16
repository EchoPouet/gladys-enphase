// -----------------------------------------------------------------------------
// Integration configuration.
//
// The configuration is filled in by the user in Gladys, from the `config_schema`
// declared in `gladys-assistant-integration.json`. The SDK fetches it for you
// (`gladys.getConfig()`) and notifies you of every change through
// `gladys.onConfigUpdated()`.
//
// This module only provides defaults and normalizes the received object, so the
// rest of the code never has to deal with `undefined`.
// -----------------------------------------------------------------------------

// Bounds declared in the manifest for the refresh interval, in seconds.
export const POLL_FREQUENCY_LIMITS = { min: 15, max: 600 };

import { isIP } from 'node:net';

// The gateway firmware D8+ requires an HTTPS local connection with a JWT Bearer
// token. The token is stored encrypted by Gladys (config_schema `secret`).
export const DEFAULT_CONFIG = {
  gateway_ip: '',
  access_token: '',
  poll_frequency: 60, // seconds, how often the gateway is polled
  include_inverters: true, // publish one device per micro-inverter
  // Optional SHA-256 fingerprint of the gateway certificate. When set, the
  // client (src/enphase.js) only trusts a certificate that matches it.
  pinned_cert_fingerprint: '',
};

/**
 * Merge the user config with the defaults and force the types: values coming
 * back from a form arrive as strings.
 *
 * The gateway IP is validated as a private IPv4/IPv6 literal: anything else
 * (a public address, a hostname, ports, paths) would make the integration send
 * the JWT bearer token to an arbitrary host on the network, so it is blanked
 * and the integration refuses to connect until a safe value is provided.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const rawIp = String(raw.gateway_ip ?? DEFAULT_CONFIG.gateway_ip).trim();

  return {
    ...DEFAULT_CONFIG,
    ...raw,
    gateway_ip: isValidGatewayIp(rawIp) ? rawIp : '',
    access_token: String(raw.access_token ?? DEFAULT_CONFIG.access_token).trim(),
    pinned_cert_fingerprint: String(
      raw.pinned_cert_fingerprint ?? DEFAULT_CONFIG.pinned_cert_fingerprint,
    ).trim(),
    poll_frequency: clampPollFrequency(raw.poll_frequency),
    include_inverters: raw.include_inverters !== false && raw.include_inverters !== 'false',
  };
}

/**
 * Whether `value` is a private IPv4 or a link-local / unique-local IPv6
 * literal. Restricting the gateway target to the private LAN keeps the token
 * from ever being sent to a public address, and stops the mDNS discovery from
 * being pointed at an impostor host.
 * @param {string} value
 */
export function isValidGatewayIp(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (isIP(value) === 4) return isPrivateIPv4(value);
  if (isIP(value) === 6) return isPrivateIPv6(value);
  return false;
}

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map((part) => Number(part));
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 127) return true; // 127.0.0.0/8 loopback
  return false;
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true; // loopback
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique-local
  return /^fe[89ab]/.test(lower); // fe80::/10 link-local
}

/** Keep the polling interval inside the bounds declared in the manifest. */
function clampPollFrequency(value) {
  const seconds = Number(value ?? DEFAULT_CONFIG.poll_frequency);
  if (!Number.isFinite(seconds)) {
    return DEFAULT_CONFIG.poll_frequency;
  }
  return Math.min(
    Math.max(Math.round(seconds), POLL_FREQUENCY_LIMITS.min),
    POLL_FREQUENCY_LIMITS.max,
  );
}

/**
 * Whether the integration can reach the gateway at all: an IP address and a
 * token are both required.
 * @param {ReturnType<typeof normalizeConfig>} config
 */
export function isConfigured(config) {
  return config.gateway_ip.length > 0 && config.access_token.length > 0;
}

/**
 * Pick the usable gateway addresses out of the list a gateway advertises over
 * mDNS. Only PRIVATE addresses are candidates — a public address (e.g. a global
 * IPv6) must never become the target, or the integration would send the JWT
 * token to it. IPv4 is preferred over IPv6: the gateway local API is most
 * reliable over IPv4, and its IPv6 addresses are often global (public) or
 * link-local (unroutable from the container). Duplicates are removed.
 * @param {Array<string|undefined|null>} addresses
 * @returns {string[]} private candidates, IPv4 first
 */
export function selectPrivateAddresses(addresses = []) {
  const seen = new Set();
  const candidates = [];
  for (const raw of addresses) {
    const address = String(raw ?? '').trim();
    if (!address || seen.has(address)) continue;
    seen.add(address);
    if (isValidGatewayIp(address)) candidates.push(address);
  }
  candidates.sort((a, b) => {
    const aIsV4 = isIP(a) === 4;
    const bIsV4 = isIP(b) === 4;
    if (aIsV4 && !bIsV4) return -1;
    if (!aIsV4 && bIsV4) return 1;
    return 0;
  });
  return candidates;
}
