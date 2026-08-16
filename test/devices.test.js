// -----------------------------------------------------------------------------
// Unit tests for the device blueprints (discovery payloads + state mapping).
// The gateway HTTP client is mocked with an in-memory stand-in (see
// test/enphase.test.js for the mock contract).
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetRequestImpl, setRequestImpl } from '../src/enphase.js';
import { buildStates as buildSystemStates } from '../src/devices/systemDevice.js';
import {
  buildDevice as buildInverterDevice,
  buildStates as buildInverterStates,
  inverterDevice,
  statusMessage,
} from '../src/devices/inverterDevice.js';
import { buildDiscoveredDevices, findBlueprintByDevice } from '../src/devices/index.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const IP = '192.168.1.42';
const TOKEN = 'test-token';

/** Same in-memory HTTP mock as in test/enphase.test.js. */
function createMockRequest() {
  const seen = [];
  const routes = new Map();

  const mockRequest = (options, callback) => {
    seen.push(options);
    const route = routes.get(options.path) ?? { status: 404, body: null };
    const res = {
      statusCode: route.status,
      on: (event, handler) => {
        if (event === 'data' && route.body !== null) {
          handler(Buffer.from(JSON.stringify(route.body), 'utf8'));
        }
        if (event === 'end') {
          handler();
        }
        return res;
      },
    };
    callback(res);
    const req = { on: () => req, destroy: () => {}, end: () => {} };
    return req;
  };

  return {
    mockRequest,
    seen,
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
});

/** A fully configured config, as the user would fill it. */
function configuredConfig(overrides = {}) {
  return normalizeConfig({ gateway_ip: IP, access_token: TOKEN, ...overrides });
}

/** The typical gateway answers for a solar + consumption + battery install. */
function mockFullGateway() {
  mock.route('/api/v1/site_info', 200, {
    name: 'La Maison Solaire',
    inventory: { serial_number: '1234567890' },
  });
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
}

test('buildDiscoveredDevices publishes the system device and every inverter', async () => {
  mockFullGateway();
  const gladys = createFakeGladys();
  const config = configuredConfig();

  const devices = await buildDiscoveredDevices(gladys, config);

  // 1 system + 2 inverters.
  assert.equal(devices.length, 3);

  const system = devices.find((device) => device.external_id.includes(':enphase-system:'));
  assert.ok(system);
  assert.equal(system.external_id, 'ext:test-integration:enphase-system:1234567890');
  assert.equal(system.name, 'La Maison Solaire');
  // No poll_frequency: the core only accepts a fixed enum in milliseconds, so
  // the integration drives its own refresh timer (see index.js).
  assert.equal(system.poll_frequency, undefined);
  assert.ok(
    system.params.some((param) => param.name === 'GATEWAY_SERIAL' && param.value === '1234567890'),
  );
  // Production features: W now, today, 7 days, lifetime.
  assert.ok(system.features.some((f) => f.external_id.endsWith(':production-power')));
  assert.ok(system.features.some((f) => f.external_id.endsWith(':production-today')));
  assert.ok(system.features.some((f) => f.external_id.endsWith(':production-seven-days')));
  assert.ok(system.features.some((f) => f.external_id.endsWith(':production-lifetime')));
  // Consumption (meter present) + battery (battery present).
  assert.ok(system.features.some((f) => f.external_id.endsWith(':consumption-power')));
  assert.ok(system.features.some((f) => f.external_id.endsWith(':consumption-today')));
  assert.ok(system.features.some((f) => f.external_id.endsWith(':battery-level')));

  const inverters = devices.filter((device) => device.external_id.includes(':enphase-inverter:'));
  assert.equal(inverters.length, 2);
  assert.ok(
    inverters.every((device) => device.features.some((f) => f.external_id.endsWith(':power'))),
  );
  assert.ok(
    inverters.every((device) => device.features.some((f) => f.external_id.endsWith(':status'))),
  );
});

test('no consumption or battery features when the gateway lacks them', async () => {
  mock.route('/api/v1/site_info', 200, {
    name: 'Simple Solar',
    inventory: { serial_number: '9876543210' },
  });
  mock.route('/production.json', 200, {
    production: [
      { type: 'inverters', activeCount: 2, wNow: 2400, whToday: 8000, whLifetime: 3000000 },
    ],
  });
  mock.route('/api/v1/production', 200, { wattsNow: 2400 });
  mock.route('/api/v1/production/inverters', 200, []);

  const gladys = createFakeGladys();
  const config = configuredConfig();
  const devices = await buildDiscoveredDevices(gladys, config);

  const system = devices.find((device) => device.external_id.includes(':enphase-system:'));
  assert.ok(system);
  assert.ok(!system.features.some((f) => f.external_id.includes('consumption')));
  assert.ok(!system.features.some((f) => f.external_id.includes('battery')));
});

test('include_inverters false publishes only the system device', async () => {
  mockFullGateway();
  const gladys = createFakeGladys();
  const config = configuredConfig({ include_inverters: false });

  const devices = await buildDiscoveredDevices(gladys, config);
  assert.equal(devices.length, 1);
  assert.ok(devices[0].external_id.includes(':enphase-system:'));
});

test('systemDevice.buildStates maps the production reading', async () => {
  mockFullGateway();
  const gladys = createFakeGladys();
  const config = configuredConfig();

  // Fills the module state with a serial.
  await buildDiscoveredDevices(gladys, config);

  const states = buildSystemStates(gladys, {
    wattsNow: 3500,
    whToday: 12000,
    whSevenDays: 89000,
    whLifetime: 4560000,
    consumptionWatts: 700,
    consumptionTodayWh: 3500,
    batterySoc: 64,
    batteryChargeWatts: 0,
    batteryDischargeWatts: 120,
    batteryEnergyRemainingWh: 3000,
  });

  assert.equal(states.length, 10);
  assert.ok(
    states.some(
      (s) => s.device_feature_external_id.endsWith(':production-power') && s.state === 3.5,
    ),
  );
  assert.ok(
    states.some(
      (s) => s.device_feature_external_id.endsWith(':production-today') && s.state === 12,
    ),
  );
  assert.ok(
    states.some((s) => s.device_feature_external_id.endsWith(':battery-level') && s.state === 64),
  );
});

test('inverterDevice buildDevice and buildStates work from a report entry', () => {
  const gladys = createFakeGladys();
  const inverter = {
    serialNumber: '4300-123456',
    lastReportWatts: 180,
    maxReportWatts: 300,
    lastReportDate: 1699999999,
  };

  const device = buildInverterDevice(gladys, inverter);
  assert.equal(device.external_id, 'ext:test-integration:enphase-inverter:4300-123456');
  assert.equal(device.name, 'Micro-inverter 123456');
  assert.ok(device.params.some((param) => param.name === 'SERIAL_NUMBER'));

  const states = buildInverterStates(gladys, inverter);
  assert.equal(states.length, 2);
  assert.ok(
    states.some((s) => s.device_feature_external_id.endsWith(':power') && s.state === 0.18),
  );
  assert.ok(
    states.some(
      (s) => s.device_feature_external_id.endsWith(':status') && typeof s.text === 'string',
    ),
  );
});

test('inverterDevice.statusMessage reports the activity', () => {
  const now = 1700000000;
  const active = statusMessage({ lastReportWatts: 180, lastReportDate: now - 60 }, now);
  assert.equal(active.en, 'Active');

  const idle = statusMessage({ lastReportWatts: 0, lastReportDate: now - 60 }, now);
  assert.equal(idle.en, 'Active (0 W)');

  const offline = statusMessage({ lastReportWatts: 0, lastReportDate: now - 600 }, now);
  assert.equal(offline.en, 'Offline (10 min)');

  const never = statusMessage({ lastReportWatts: 0, lastReportDate: 0 }, now);
  assert.equal(never.en, 'Never reported');
});

test('inverterDevice.publishAllStates pushes power and status for every inverter', async () => {
  mockFullGateway();
  const gladys = createFakeGladys();
  const config = configuredConfig();

  // Discovery fills the module cache (system + inverters) from the gateway.
  await buildDiscoveredDevices(gladys, config);

  // This is what the refresh cycle calls in index.js to give the discovered
  // micro-inverters a value (previously never published).
  await inverterDevice.publishAllStates(gladys);

  // First inverter: 180 W -> 0.18 kW + a status text.
  assert.ok(
    gladys.published.some(
      (s) =>
        s.featureExternalId.endsWith(':enphase-inverter:4300-123456:power') && s.state === 0.18,
    ),
  );
  assert.ok(
    gladys.published.some(
      (s) =>
        s.featureExternalId.endsWith(':enphase-inverter:4300-123456:status') &&
        typeof s.text === 'string',
    ),
  );
  // Second inverter present too (reports 0 W, still a status text).
  assert.ok(
    gladys.published.some(
      (s) => s.featureExternalId.endsWith(':enphase-inverter:4300-654321:power') && s.state === 0,
    ),
  );
});

test('findBlueprintByDevice routes the system and inverter ids', async () => {
  mockFullGateway();
  const gladys = createFakeGladys();
  await buildDiscoveredDevices(gladys, configuredConfig());

  const system = findBlueprintByDevice({
    external_id: 'ext:test-integration:enphase-system:1234567890',
  });
  assert.equal(system.key, 'enphase-system');

  const inverter = findBlueprintByDevice({
    external_id: 'ext:test-integration:enphase-inverter:4300-123456',
  });
  assert.equal(inverter.key, 'enphase-inverter');

  assert.equal(findBlueprintByDevice({ external_id: 'other-device' }), undefined);
});
