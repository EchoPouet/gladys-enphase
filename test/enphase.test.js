// -----------------------------------------------------------------------------
// Unit tests for the local Enphase gateway client.
// A small in-memory HTTP stand-in replaces the native `request` so no real
// network call is made.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkJwt,
  EnphaseError,
  fetchEnchargePower,
  fetchEnsemble,
  fetchInverters,
  fetchMeters,
  fetchProduction,
  fetchSystem,
  MAX_RESPONSE_BYTES,
  resetPinnedCertFingerprint,
  resetRequestImpl,
  setPinnedCertFingerprint,
  setRequestImpl,
} from '../src/enphase.js';

const IP = '192.168.1.42';
const TOKEN = 'test-token';

/** In-memory request stand-in. Each registered route answers one response. */
function createMockRequest() {
  const seen = [];
  const routes = new Map();

  const mockRequest = (options, callback) => {
    seen.push(options);
    const route = routes.get(options.path) ?? { status: 404, body: null };
    const res = {
      statusCode: route.status,
      // A socket exposing a "certificate", so certificate-pinning tests work.
      socket: { getPeerCertificate: () => ({ fingerprint256: 'AA:AA:AA:00:00:00' }) },
      on: (event, handler) => {
        if (event === 'data') {
          // Write the body once. A string body is sent as-is (XML); an object
          // body is JSON-encoded.
          if (route.body !== null) {
            const payload =
              typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
            handler(Buffer.from(payload, 'utf8'));
            route._sent = true;
          }
        }
        if (event === 'end' && route.body !== null && !route._sent) {
          handler();
        }
        if (event === 'end') {
          handler();
        }
        return res;
      },
    };
    // Call the callback synchronously with the mock response.
    callback(res);
    const req = {
      on: () => {
        // No timeout/error events by default.
        return req;
      },
      destroy: () => {},
      end: () => {},
    };
    return req;
  };

  return {
    mockRequest,
    seen,
    routes,
    route(path, status, body) {
      routes.set(path, { status, body });
    },
  };
}

let mock;

beforeEach(() => {
  mock = createMockRequest();
  setRequestImpl(mock.mockRequest);
});

afterEach(() => {
  resetRequestImpl();
  resetPinnedCertFingerprint();
});

test('checkJwt resolves when the gateway answers 200', async () => {
  mock.route('/auth/check_jwt', 200, { message: 'valid token' });
  const ok = await checkJwt(IP, TOKEN);
  assert.equal(ok, true);
  assert.equal(mock.seen[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(mock.seen[0].rejectUnauthorized, false);
});

test('checkJwt rejects with AUTH on 401', async () => {
  mock.route('/auth/check_jwt', 401, {});
  await assert.rejects(checkJwt(IP, TOKEN), (err) => {
    assert.ok(err instanceof EnphaseError);
    assert.equal(err.status, 401);
    assert.equal(err.code, 'AUTH');
    return true;
  });
});

test('checkJwt accepts a plain-text answer (no JSON parsing)', async () => {
  mock.route('/auth/check_jwt', 200, 'valid token');
  const ok = await checkJwt(IP, TOKEN);
  assert.equal(ok, true);
});

test('checkJwt brackets an IPv6 literal in the request hostname', async () => {
  mock.route('/auth/check_jwt', 200, 'valid token');
  const ok = await checkJwt('fd12::1', TOKEN);
  assert.equal(ok, true);
  // The URL parser requires brackets around an IPv6 literal; without them the
  // request would throw ERR_INVALID_URL before ever reaching the gateway.
  assert.equal(mock.seen[0].hostname, '[fd12::1]');
});

test('checkJwt falls back to /production.json when /auth/check_jwt is 404', async () => {
  mock.route('/auth/check_jwt', 404, null);
  mock.route('/production.json', 200, { wattsNow: 3500 });
  const ok = await checkJwt(IP, TOKEN);
  assert.equal(ok, true);
  assert.equal(mock.seen[0].path, '/auth/check_jwt');
  assert.equal(mock.seen[1].path, '/production.json');
});

test('a pinned certificate that does not match rejects the request', async () => {
  // The mock socket reports 'AA:AA:AA:00:00:00'; configure a different pin.
  setPinnedCertFingerprint('BB:BB:BB:BB:00:00:00');
  mock.route('/auth/check_jwt', 200, { message: 'ok' });
  await assert.rejects(checkJwt(IP, TOKEN), (err) => {
    assert.ok(err instanceof EnphaseError);
    assert.equal(err.status, 0);
    assert.equal(err.code, 'CERT_PIN_MISMATCH');
    return true;
  });
});

test('a pinned certificate that matches is accepted', async () => {
  setPinnedCertFingerprint('aa:aa:aa:00:00:00'); // lower-case is normalised
  mock.route('/auth/check_jwt', 200, { message: 'valid token' });
  const ok = await checkJwt(IP, TOKEN);
  assert.equal(ok, true);
});

test('an oversized response is refused', async () => {
  const big = Buffer.alloc(MAX_RESPONSE_BYTES + 1).toString('utf8');
  mock.route('/auth/check_jwt', 200, big);
  await assert.rejects(checkJwt(IP, TOKEN), (err) => {
    assert.ok(err instanceof EnphaseError);
    assert.equal(err.code, 'RESPONSE_TOO_LARGE');
    return true;
  });
});

test('fetchSystem extracts the serial and the name', async () => {
  mock.route('/api/v1/site_info', 200, {
    name: 'Solar Roof',
    inventory: { serial_number: '1234567890' },
  });
  const system = await fetchSystem(IP, TOKEN);
  assert.deepEqual(system, { serial: '1234567890', name: 'Solar Roof' });
});

test('fetchSystem falls back to /info.xml when /api/v1/site_info is 404', async () => {
  mock.route('/api/v1/site_info', 404, null);
  mock.route('/info.xml', 200, '<envoy_info><device><sn>1234567890</sn></device></envoy_info>');
  const system = await fetchSystem(IP, TOKEN);
  assert.deepEqual(system, { serial: '1234567890', name: 'Enphase gateway' });
  // Both endpoints were hit, in order.
  assert.equal(mock.seen[0].path, '/api/v1/site_info');
  assert.equal(mock.seen[1].path, '/info.xml');
});

test('fetchSystem surfaces a non-404 error without falling back', async () => {
  mock.route('/api/v1/site_info', 401, null);
  await assert.rejects(fetchSystem(IP, TOKEN), (err) => {
    assert.ok(err instanceof EnphaseError);
    assert.equal(err.status, 401);
    assert.equal(err.code, 'AUTH');
    return true;
  });
  // No fallback request was made.
  assert.equal(mock.seen.length, 1);
});

test('fetchProduction reads /production.json without the heavy details flag', async () => {
  mock.route('/production.json', 200, {
    production: [
      { type: 'inverters', activeCount: 1, wNow: 1000, whToday: 5000, whLifetime: 100000 },
    ],
  });
  mock.route('/api/v1/production', 404, null);
  await fetchProduction(IP, TOKEN);
  assert.equal(mock.seen[0].path, '/production.json');
});

test('fetchProduction merges production.json and api/v1/production', async () => {
  mock.route('/production.json', 200, {
    production: [
      {
        type: 'eim',
        activeCount: 1,
        wNow: 3500,
        whToday: 12000,
        whLastSevenDays: 89000,
        whLifetime: 4560000,
      },
      {
        type: 'inverters',
        activeCount: 2,
        wNow: 3500,
        whToday: 12000,
        whLastSevenDays: 89000,
        whLifetime: 4560000,
      },
    ],
    consumption: [{ type: 'eim', wNow: 700, whToday: 3500 }],
    storage: [{ type: 'acb', activeCount: 1, wNow: -120, whNow: 3000, percentFull: 64 }],
  });
  mock.route('/api/v1/production', 200, {
    wattsNow: 3500,
    wattHoursToday: 12000,
    wattHoursSevenDays: 89000,
    wattHoursLifetime: 4560000,
  });

  const production = await fetchProduction(IP, TOKEN);
  assert.deepEqual(production, {
    wattsNow: 3500,
    whToday: 12000,
    whSevenDays: 89000,
    whLifetime: 4560000,
    consumptionWatts: 700,
    consumptionTodayWh: 3500,
    batterySoc: 64,
    batteryChargeWatts: 0, // wNow negative -> charging -> 0 charge, 120 discharge
    batteryDischargeWatts: 120,
    batteryEnergyRemainingWh: 3000,
  });
});

test('fetchProduction works when /api/v1/production is 404', async () => {
  mock.route('/production.json', 200, {
    production: [
      {
        type: 'eim',
        activeCount: 1,
        wNow: 3500,
        whToday: 12000,
        whLastSevenDays: 89000,
        whLifetime: 4560000,
      },
    ],
  });
  mock.route('/api/v1/production', 404, null);

  const production = await fetchProduction(IP, TOKEN);
  assert.equal(production.wattsNow, 3500);
  assert.equal(production.whToday, 12000);
  assert.equal(production.whSevenDays, 89000);
  assert.equal(production.whLifetime, 4560000);
});

test('fetchProduction reads whToday/whLastSevenDays from the eim entry', async () => {
  mock.route('/production.json', 200, {
    production: [
      {
        type: 'eim',
        activeCount: 1,
        wNow: 3500,
        whToday: 12000,
        whLastSevenDays: 89000,
        whLifetime: 4560000,
      },
      { type: 'inverters', activeCount: 2, wNow: 0, whToday: 0, whLastSevenDays: 0, whLifetime: 0 },
    ],
  });
  mock.route('/api/v1/production', 404, null);

  const production = await fetchProduction(IP, TOKEN);
  assert.equal(production.whToday, 12000);
  assert.equal(production.whSevenDays, 89000);
});

test('fetchProduction handles a gateway without meter or battery', async () => {
  mock.route('/production.json', 200, {
    production: [
      { type: 'inverters', activeCount: 2, wNow: 2400, whToday: 8000, whLifetime: 3000000 },
    ],
  });
  mock.route('/api/v1/production', 200, { wattsNow: 2400 });

  const production = await fetchProduction(IP, TOKEN);
  assert.equal(production.consumptionWatts, null);
  assert.equal(production.consumptionTodayWh, null);
  assert.equal(production.batterySoc, null);
  assert.equal(production.batteryChargeWatts, null);
  assert.equal(production.batteryDischargeWatts, null);
});

test('fetchInverters parses the per-inverter report', async () => {
  mock.route('/api/v1/production/inverters', 200, [
    {
      serialNumber: '4300-123456',
      devType: 1,
      lastReportWatts: 180,
      maxReportWatts: 300,
      lastReportDate: 1699999999,
    },
    {
      serialNumber: '4300-654321',
      devType: 1,
      lastReportWatts: 0,
      maxReportWatts: 300,
      lastReportDate: 1699999999,
    },
  ]);
  const inverters = await fetchInverters(IP, TOKEN);
  assert.equal(inverters.length, 2);
  assert.equal(inverters[0].serialNumber, '4300-123456');
  assert.equal(inverters[0].lastReportWatts, 180);
});

test('fetchInverters drops ACB batteries (devType 11)', async () => {
  mock.route('/api/v1/production/inverters', 200, [
    { serialNumber: '4300-123456', devType: 1, lastReportWatts: 180 },
    { serialNumber: '121917000087', devType: 11, lastReportWatts: 50 },
  ]);
  const inverters = await fetchInverters(IP, TOKEN);
  assert.equal(inverters.length, 1);
  assert.equal(inverters[0].serialNumber, '4300-123456');
});

test('fetchInverters drops entries without a serial', async () => {
  mock.route('/api/v1/production/inverters', 200, [{}]);
  const inverters = await fetchInverters(IP, TOKEN);
  assert.equal(inverters.length, 0);
});

test('fetchEnsemble parses ENCHARGE and ENPOWER groups', async () => {
  mock.route('/ivp/ensemble/inventory', 200, [
    {
      type: 'ENCHARGE',
      devices: [
        {
          serial_num: '202200001',
          percentFull: 64,
          temperature: 25,
          encharge_capacity: 3500,
          communicating: true,
        },
      ],
    },
    {
      type: 'ENPOWER',
      devices: [
        {
          serial_num: '202300002',
          Enpwr_grid_mode: 'multimode-ongrid',
          temperature: 77,
          communicating: true,
          mains_admin_state: 'closed',
        },
      ],
    },
  ]);

  const ensemble = await fetchEnsemble(IP, TOKEN);
  assert.equal(ensemble.encharge.length, 1);
  assert.equal(ensemble.encharge[0].serialNumber, '202200001');
  assert.equal(ensemble.encharge[0].percentFull, 64);
  assert.equal(ensemble.enpower.length, 1);
  assert.equal(ensemble.enpower[0].gridMode, 'multimode-ongrid');
  assert.equal(ensemble.enpower[0].temperatureF, 77);
});

test('fetchEnchargePower converts milliwatts to watts', async () => {
  mock.route('/ivp/ensemble/power', 200, {
    'devices:': [{ serial_num: '202200001', real_power_mw: 150000, soc: 64 }],
  });

  const powerMap = await fetchEnchargePower(IP, TOKEN);
  assert.equal(powerMap.get('202200001').realPowerW, 150);
  assert.equal(powerMap.get('202200001').soc, 64);
});

test('fetchMeters matches readings to config by eid', async () => {
  mock.route('/ivp/meters', 200, [
    { eid: '123456', measurementType: 'production', state: 'enabled' },
  ]);
  mock.route('/ivp/meters/readings', 200, [
    {
      eid: '123456',
      activePower: 3500,
      actEnergyDlvd: 12000,
      actEnergyRcvd: 0,
      voltage: 240,
      current: 14.5,
      freq: 50,
    },
  ]);

  const meters = await fetchMeters(IP, TOKEN);
  assert.equal(meters.length, 1);
  assert.equal(meters[0].eid, '123456');
  assert.equal(meters[0].measurementType, 'production');
  assert.equal(meters[0].activePowerW, 3500);
  assert.equal(meters[0].energyDeliveredWh, 12000);
});
