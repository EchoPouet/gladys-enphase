// -----------------------------------------------------------------------------
// Local Enphase IQ Gateway client (firmware D8+).
//
// All requests go to the gateway's local HTTPS API, authenticated with the JWT
// Bearer token generated in the gateway web UI (System > Local Access). The
// gateway uses a self-signed certificate, so `rejectUnauthorized` is disabled
// — this is what every local Enphase client does (homebridge-enphase-envoy,
// pyenphase...).
//
// Endpoints used:
//   GET /auth/check_jwt                   -> token validity
//   GET /production.json?details=1        -> live power + today/7d/lifetime Wh
//   GET /api/v1/production                -> optional fallback (today/7d/lifetime Wh)
//   GET /api/v1/production/inverters      -> per-inverter report (serial, W)
//   GET /api/v1/site_info                 -> gateway identity (serial, name)
//   GET /info.xml                         -> gateway serial (fallback, all firmwares)
//
// Errors are raised as `EnphaseError` with a `status` (0 = network/timeout)
// and a `code`, so the integration can tell "token invalid" (401/403) apart
// from "gateway unreachable" and react accordingly.
// -----------------------------------------------------------------------------

import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';

/**
 * Error raised when the gateway is unreachable, refuses the token, or answers
 * something unreadable. `status 0` means the request never completed (network
 * error or timeout).
 */
export class EnphaseError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'EnphaseError';
    this.status = status; // HTTP status, or 0 for network/timeout failures
    this.code = code;
  }
}

/** Timeout for every gateway request, in milliseconds. */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * One TLS connection reused across requests. Opening a fresh TCP+TLS handshake
 * per request is slow and pushes a busy Envoy past the timeout. `maxSockets` is
 * deliberately low: the gateway only accepts a few simultaneous local
 * connections — saturating it causes the very timeouts this avoids.
 */
const agent = new HttpsAgent({ keepAlive: true, maxSockets: 2 });

/**
 * The request implementation, injectable for tests. Uses the native `request`
 * by default; tests replace it with an in-memory stand-in.
 */
let requestImpl = httpsRequest;

/** Replace the request implementation (tests only). */
export function setRequestImpl(fn) {
  requestImpl = fn;
}

/** Restore the native request implementation (tests only). */
export function resetRequestImpl() {
  requestImpl = httpsRequest;
}

/**
 * Maximum size of a single gateway response body, in bytes. Guards the
 * container memory against an oversized (or malicious) endpoint.
 */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MiB

/**
 * Optional SHA-256 fingerprint of the gateway's certificate (the value shown
 * by `openssl x509 -noout -fingerprint -sha256`, e.g. `AB:CD:12:34:…`). When
 * set, every response is only trusted if it comes from that exact certificate,
 * so a process impersonating the gateway on the LAN cannot be mistaken for it
 * even though the TLS chain is not validated. Empty = no pinning (the gateway
 * certificate is self-signed and unknown to the integration by default).
 */
let pinnedCertFingerprint = '';

/** Set (or clear with '') the expected gateway certificate fingerprint. */
export function setPinnedCertFingerprint(fingerprint) {
  pinnedCertFingerprint = String(fingerprint ?? '')
    .trim()
    .toUpperCase();
}

/** Clear the pinned fingerprint (tests). */
export function resetPinnedCertFingerprint() {
  pinnedCertFingerprint = '';
}

/**
 * Perform a raw GET against the gateway and return the response body as text.
 * @param {string} ip gateway IP address
 * @param {string} path absolute URL path (may include a query string)
 * @param {object} options
 * @param {string} options.token JWT Bearer token
 * @param {number} [options.timeoutMs] request timeout
 * @returns {Promise<string>} raw response body
 */
function rawRequest(ip, path, { token, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const url = new URL(`https://${ip}${path}`);
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline = null;
    // Resolve/reject exactly once (a request can fail on several paths at
    // once — socket 'error', body 'data' over the size cap, absolute timeout).
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      fn(value);
    };

    let req;
    req = requestImpl(
      {
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          Accept: '*/*',
          Authorization: `Bearer ${token}`,
        },
        // The gateway presents a self-signed certificate: this is expected and
        // tolerated. When `pinnedCertFingerprint` is set, that certificate is
        // still verified against the pinned SHA-256 fingerprint below, so an
        // impostor can no longer act as the gateway even though the TLS chain
        // is not validated.
        rejectUnauthorized: false,
        timeout: timeoutMs,
        agent,
      },
      (res) => {
        // Optional certificate pinning: only trust a host that presents the
        // exact certificate whose fingerprint was configured.
        if (pinnedCertFingerprint) {
          const peer = res.socket?.getPeerCertificate?.();
          const fingerprint = peer?.fingerprint256 ?? '';
          if (fingerprint.toUpperCase() !== pinnedCertFingerprint) {
            finish(
              reject,
              new EnphaseError(
                0,
                'CERT_PIN_MISMATCH',
                'Gateway certificate fingerprint does not match the configured pin',
              ),
            );
            req?.destroy?.();
            return;
          }
        }

        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            finish(
              reject,
              new EnphaseError(
                0,
                'RESPONSE_TOO_LARGE',
                `Gateway response to ${path} exceeded ${MAX_RESPONSE_BYTES} bytes`,
              ),
            );
            req?.destroy?.();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const error = new EnphaseError(
              res.statusCode,
              res.statusCode === 401 || res.statusCode === 403 ? 'AUTH' : 'HTTP_ERROR',
              `Gateway answered HTTP ${res.statusCode} on ${path}`,
            );
            finish(reject, error);
            return;
          }
          finish(resolve, raw);
        });
      },
    );

    // Absolute deadline for the whole request. The socket 'timeout' only fires
    // when the connection is idle, so a server that keeps dribbling bytes could
    // otherwise leave this promise pending forever.
    deadline = setTimeout(() => {
      req?.destroy?.(
        new EnphaseError(0, 'TIMEOUT', `Gateway request to ${path} timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    if (typeof deadline.unref === 'function') deadline.unref();

    req.on('error', (err) => {
      if (err instanceof EnphaseError) {
        finish(reject, err);
        return;
      }
      finish(
        reject,
        new EnphaseError(
          0,
          'UNREACHABLE',
          `Cannot reach gateway at ${ip} (${err.code ?? err.message})`,
        ),
      );
    });
    req.end();
  });
}

/**
 * Perform a JSON GET against the gateway.
 * @param {string} ip gateway IP address
 * @param {string} path absolute URL path (may include a query string)
 * @param {object} options
 * @param {string} options.token JWT Bearer token
 * @param {number} [options.timeoutMs] request timeout
 * @returns {Promise<unknown>} parsed JSON body
 */
async function getJson(ip, path, options) {
  const raw = await rawRequest(ip, path, options);
  try {
    return JSON.parse(raw);
  } catch {
    throw new EnphaseError(200, 'INVALID_RESPONSE', `Gateway returned invalid JSON on ${path}`);
  }
}

/**
 * Perform a text GET against the gateway (for XML endpoints).
 * @param {string} ip gateway IP address
 * @param {string} path absolute URL path (may include a query string)
 * @param {object} options
 * @param {string} options.token JWT Bearer token
 * @param {number} [options.timeoutMs] request timeout
 * @returns {Promise<string>} raw response body
 */
function getText(ip, path, options) {
  return rawRequest(ip, path, options);
}

/**
 * Check that the token is accepted by the gateway.
 *
 * Only the HTTP status matters: a 2xx means the token works, 401/403 means it
 * is refused. The body is ignored because some firmwares answer plain text
 * (`"valid token"`) while others answer JSON — parsing it would wrongly fail
 * on the former. When `/auth/check_jwt` does not exist (404), we fall back to
 * `/production.json`, which is always present and also requires the token.
 * @param {string} ip
 * @param {string} token
 * @returns {Promise<boolean>} true when the token is valid
 */
export async function checkJwt(ip, token) {
  try {
    await rawRequest(ip, '/auth/check_jwt', { token });
    return true;
  } catch (err) {
    // Fall back only when the endpoint is missing (404); auth/network errors
    // must still surface.
    if (!(err instanceof EnphaseError) || err.status !== 404) {
      throw err;
    }
    await getJson(ip, '/production.json', { token });
    return true;
  }
}

/**
 * Read the gateway identity.
 *
 * Tries `/api/v1/site_info` first (JSON, newer firmwares), then falls back to
 * `/info.xml` (XML, available on every firmware) when the former is missing.
 * @returns {Promise<{ serial: string, name: string }>}
 */
export async function fetchSystem(ip, token) {
  try {
    const body = await getJson(ip, '/api/v1/site_info', { token });
    const serial = String(body?.inventory?.serial_number ?? body?.serial_number ?? '');
    const name = String(body?.name ?? body?.site_name ?? 'Enphase gateway').trim();
    return { serial, name };
  } catch (err) {
    // Only fall back when the endpoint does not exist (404); other errors
    // (auth, network) must still surface.
    if (!(err instanceof EnphaseError) || err.status !== 404) {
      throw err;
    }
    const xml = await getText(ip, '/info.xml', { token });
    const match = /<sn>([^<]+)<\/sn>/.exec(xml);
    const serial = match ? match[1].trim() : '';
    return { serial, name: 'Enphase gateway' };
  }
}

/**
 * Read the live production + lifetime energy of the gateway, plus consumption
 * and battery when the gateway reports them.
 *
 * @returns {Promise<{
 *   wattsNow: number, whToday: number|null, whSevenDays: number|null,
 *   whLifetime: number|null, consumptionWatts: number|null,
 *   consumptionTodayWh: number|null, batterySoc: number|null,
 *   batteryChargeWatts: number|null, batteryDischargeWatts: number|null,
 *   batteryEnergyRemainingWh: number|null
 * }>}
 */
export async function fetchProduction(ip, token) {
  const productionJson = await getJson(ip, '/production.json?details=1', { token });

  // /api/v1/production is optional: some firmwares do not serve it. Its values
  // are only used as a fallback when /production.json lacks them.
  let apiV1 = {};
  try {
    apiV1 = await getJson(ip, '/api/v1/production', { token });
  } catch (err) {
    if (!(err instanceof EnphaseError) || err.status !== 404) {
      throw err;
    }
  }

  // production.json layout (see pyenphase models/system_production.py):
  //   production: [{ type: 'eim', activeCount, wNow, whLifetime, whToday, whLastSevenDays },
  //                { type: 'inverters', activeCount, wNow, whLifetime, whToday, whLastSevenDays }]
  //   consumption: [{ type: 'eim', measurementType, wNow, whToday, whLastSevenDays, whLifetime }]
  //   storage: [{ type: 'acb', activeCount, wNow, whNow, percentFull, state }]
  const production = productionJson?.production ?? [];
  const eim = production.find((entry) => entry.type === 'eim');
  const inverters = production.find((entry) => entry.type === 'inverters');
  const consumption = (productionJson?.consumption ?? []).find((entry) => entry.type === 'eim');
  const storage = (productionJson?.storage ?? []).find((entry) => entry.type === 'acb');

  // api/v1/production layout: { wattHoursToday, wattHoursSevenDays,
  //   wattHoursLifetime, wattsNow }
  const live = apiV1 ?? {};

  const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  // pyenphase: the production meter (eim) is authoritative when active;
  // otherwise fall back to the inverters entry.
  const nowSource = eim && num(eim.activeCount) > 0 ? eim : inverters;

  const batteryChargeWatts =
    storage && num(storage.wNow) !== null ? Math.max(0, num(storage.wNow)) : null;
  const batteryDischargeWatts =
    storage && num(storage.wNow) !== null ? Math.max(0, -num(storage.wNow)) : null;

  return {
    wattsNow: num(nowSource?.wNow ?? live.wattsNow) ?? 0,
    whToday: num(eim?.whToday ?? inverters?.whToday ?? live.wattHoursToday),
    whSevenDays: num(eim?.whLastSevenDays ?? inverters?.whLastSevenDays ?? live.wattHoursSevenDays),
    whLifetime: num(nowSource?.whLifetime ?? live.wattHoursLifetime),
    consumptionWatts: num(consumption?.wNow),
    consumptionTodayWh: num(consumption?.whToday),
    batterySoc: num(storage?.percentFull),
    batteryChargeWatts,
    batteryDischargeWatts,
    batteryEnergyRemainingWh: num(storage?.whNow),
  };
}

/**
 * Read the per-inverter report.
 * @returns {Promise<Array<{ serialNumber: string, lastReportWatts: number,
 *   maxReportWatts: number, lastReportDate: number }>>}
 */
export async function fetchInverters(ip, token) {
  const body = await getJson(ip, '/api/v1/production/inverters', { token });
  if (!Array.isArray(body)) {
    throw new EnphaseError(
      200,
      'INVALID_RESPONSE',
      'Gateway returned an unexpected inverters payload',
    );
  }
  return (
    body
      // devType 1 = micro-inverter; devType 11 = ACB battery. Keep only the
      // micro-inverters here (batteries are reported by the system device).
      .filter((entry) => Number(entry?.devType ?? 1) === 1)
      .map((entry) => ({
        serialNumber: String(entry?.serialNumber ?? entry?.serial ?? ''),
        lastReportWatts: Number(entry?.lastReportWatts ?? 0),
        maxReportWatts: Number(entry?.maxReportWatts ?? 0),
        lastReportDate: Number(entry?.lastReportDate ?? 0),
      }))
      .filter((entry) => entry.serialNumber.length > 0)
  );
}

/**
 * Read the Ensemble inventory (Enpower + Encharge devices).
 *
 * `/ivp/ensemble/inventory` returns a list of groups, each with a `type`
 * (`ENPOWER`, `ENCHARGE`, ...) and a `devices` array. Only present on
 * installations with an IQ System Controller / IQ Battery.
 *
 * @returns {Promise<{ encharge: Array<object>, enpower: Array<object> }>}
 */
export async function fetchEnsemble(ip, token) {
  const inventory = await getJson(ip, '/ivp/ensemble/inventory', { token });
  const list = Array.isArray(inventory) ? inventory : [];

  const encharge = [];
  const enpower = [];

  for (const group of list) {
    const devices = Array.isArray(group?.devices) ? group.devices : [];
    if (group?.type === 'ENCHARGE') {
      for (const device of devices) {
        encharge.push({
          serialNumber: String(device?.serial_num ?? ''),
          percentFull: Number(device?.percentFull ?? 0),
          temperature: Number(device?.temperature ?? 0),
          capacityWh: Number(device?.encharge_capacity ?? 0),
          communicating: Boolean(device?.communicating),
        });
      }
    }
    if (group?.type === 'ENPOWER') {
      for (const device of devices) {
        enpower.push({
          serialNumber: String(device?.serial_num ?? ''),
          gridMode: String(device?.Enpwr_grid_mode ?? ''),
          // Enpower reports temperature in Fahrenheit.
          temperatureF: Number(device?.temperature ?? 0),
          communicating: Boolean(device?.communicating),
          mainsAdminState: String(device?.mains_admin_state ?? ''),
        });
      }
    }
  }

  return { encharge, enpower };
}

/**
 * Read the per-Encharge power report.
 *
 * `/ivp/ensemble/power` returns `{ "devices:": [...] }` (note the trailing
 * colon in the key). `real_power_mw` is in MILLIWATTS.
 *
 * @returns {Promise<Map<string, { realPowerW: number, soc: number }>>}
 */
export async function fetchEnchargePower(ip, token) {
  const body = await getJson(ip, '/ivp/ensemble/power', { token });
  const devices = Array.isArray(body?.['devices:']) ? body['devices:'] : [];

  const map = new Map();
  for (const device of devices) {
    const serial = String(device?.serial_num ?? '');
    if (!serial) continue;
    map.set(serial, {
      realPowerW: Number(device?.real_power_mw ?? 0) / 1000,
      soc: Number(device?.soc ?? 0),
    });
  }
  return map;
}

/**
 * Read the CT meters (configuration + live readings).
 *
 * `/ivp/meters` gives the meter configuration (eid, measurementType, state);
 * `/ivp/meters/readings` gives the live values keyed by the same eid.
 *
 * @returns {Promise<Array<{
 *   eid: string, measurementType: string, activePowerW: number,
 *   energyDeliveredWh: number, energyReceivedWh: number, voltage: number,
 *   current: number, frequency: number
 * }>>}
 */
export async function fetchMeters(ip, token) {
  const status = await getJson(ip, '/ivp/meters', { token });
  const readings = await getJson(ip, '/ivp/meters/readings', { token });

  const statusList = Array.isArray(status) ? status : [];
  const readingsList = Array.isArray(readings) ? readings : [];

  // Match readings to their configuration by eid (the two lists can differ in
  // size and order on some firmwares).
  const statusByEid = new Map(statusList.map((entry) => [String(entry?.eid ?? ''), entry]));

  const meters = [];
  for (const reading of readingsList) {
    const eid = String(reading?.eid ?? '');
    const config = statusByEid.get(eid);
    if (!config) continue;
    meters.push({
      eid,
      measurementType: String(config?.measurementType ?? ''),
      activePowerW: Number(reading?.activePower ?? 0),
      energyDeliveredWh: Number(reading?.actEnergyDlvd ?? 0),
      energyReceivedWh: Number(reading?.actEnergyRcvd ?? 0),
      voltage: Number(reading?.voltage ?? 0),
      current: Number(reading?.current ?? 0),
      frequency: Number(reading?.freq ?? 0),
    });
  }
  return meters;
}

/**
 * Whether a value is a meaningful number (guards against `null` for missing
 * optional measurements like consumption without a meter).
 */
export function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Round a number to at most 3 decimal places (e.g. 3.456789 -> 3.457).
 * Used before publishing so Gladys never stores long floating-point noise.
 */
export function round3(value) {
  return Math.round(value * 1000) / 1000;
}
