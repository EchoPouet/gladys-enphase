// -----------------------------------------------------------------------------
// Device type: ENPHASE CT METER.
//
// One device per current transformer (CT) meter, reporting its active power,
// delivered/received energy, voltage, current and frequency. The data comes
// from `/ivp/meters` (configuration) and `/ivp/meters/readings` (live values).
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { fetchMeters, round3 } from '../enphase.js';

export const DEVICE_TYPE = 'enphase-ct-meter';

const logger = createLogger({ name: DEVICE_TYPE });

// The per-meter readings, kept between polls.
const state = {
  meters: [],
};

/** Feature keys. */
export const FEATURE = {
  POWER: 'power',
  ENERGY_DELIVERED: 'energy-delivered',
  ENERGY_RECEIVED: 'energy-received',
  VOLTAGE: 'voltage',
  CURRENT: 'current',
};

/** Multi-language labels of the features. */
const FEATURE_NAMES = {
  [FEATURE.POWER]: { en: 'Active power', fr: 'Puissance active' },
  [FEATURE.ENERGY_DELIVERED]: { en: 'Energy delivered', fr: 'Énergie délivrée' },
  [FEATURE.ENERGY_RECEIVED]: { en: 'Energy received', fr: 'Énergie reçue' },
  [FEATURE.VOLTAGE]: { en: 'Voltage', fr: 'Tension' },
  [FEATURE.CURRENT]: { en: 'Current', fr: 'Courant' },
};

/** External id of the device of one meter. */
export function deviceExternalId(gladys, eid) {
  return gladys.externalIds(DEVICE_TYPE, eid).device;
}

/** The external ids currently published by this blueprint. */
export function publishedDeviceIds(gladys) {
  return state.meters.map((meter) => deviceExternalId(gladys, meter.eid));
}

/** Build the discovery payload of ONE meter. */
export function buildDevice(gladys, meter) {
  const ids = gladys.externalIds(DEVICE_TYPE, meter.eid);
  return {
    name: `CT Meter ${meter.eid}`,
    external_id: ids.device,
    params: [
      { name: 'EID', value: meter.eid },
      { name: 'MEASUREMENT_TYPE', value: meter.measurementType },
    ],
    features: [
      {
        name: FEATURE_NAMES[FEATURE.POWER].en,
        external_id: ids.feature(FEATURE.POWER),
        category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
        type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
        unit: DEVICE_FEATURE_UNITS.KILOWATT,
        min: -80,
        max: 80,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: FEATURE_NAMES[FEATURE.ENERGY_DELIVERED].en,
        external_id: ids.feature(FEATURE.ENERGY_DELIVERED),
        category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
        type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.INDEX,
        unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: FEATURE_NAMES[FEATURE.ENERGY_RECEIVED].en,
        external_id: ids.feature(FEATURE.ENERGY_RECEIVED),
        category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
        type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.INDEX,
        unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: FEATURE_NAMES[FEATURE.VOLTAGE].en,
        external_id: ids.feature(FEATURE.VOLTAGE),
        category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
        type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.VOLTAGE,
        unit: DEVICE_FEATURE_UNITS.VOLT,
        min: 0,
        max: 500,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: FEATURE_NAMES[FEATURE.CURRENT].en,
        external_id: ids.feature(FEATURE.CURRENT),
        category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
        type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.CURRENT,
        unit: DEVICE_FEATURE_UNITS.AMPERE,
        min: 0,
        max: 200,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
    ],
  };
}

/** Build the `publishStates` batch of ONE meter. */
export function buildStates(gladys, meter) {
  const ids = gladys.externalIds(DEVICE_TYPE, meter.eid);
  return [
    {
      device_feature_external_id: ids.feature(FEATURE.POWER),
      state: round3(meter.activePowerW / 1000), // W -> kW
    },
    {
      device_feature_external_id: ids.feature(FEATURE.ENERGY_DELIVERED),
      state: round3(meter.energyDeliveredWh / 1000), // Wh -> kWh
    },
    {
      device_feature_external_id: ids.feature(FEATURE.ENERGY_RECEIVED),
      state: round3(meter.energyReceivedWh / 1000), // Wh -> kWh
    },
    {
      device_feature_external_id: ids.feature(FEATURE.VOLTAGE),
      state: round3(meter.voltage),
    },
    {
      device_feature_external_id: ids.feature(FEATURE.CURRENT),
      state: round3(meter.current),
    },
  ];
}

export const ctMeterDevice = {
  key: DEVICE_TYPE,

  /** The device belongs to this blueprint when its id carries the type. */
  owns(device) {
    return device.external_id.includes(`:${DEVICE_TYPE}:`);
  },

  /** Build the discovery payloads — performs the live reads. */
  async buildDevices(gladys, config) {
    let meters;
    try {
      meters = await fetchMeters(config.gateway_ip, config.access_token);
    } catch (err) {
      // Meters are optional: no CT installed.
      logger.debug('Meters unavailable', err);
      return [];
    }

    state.meters = meters;
    logger.info(`Discovered ${meters.length} CT meter(s)`);
    return meters.map((meter) => buildDevice(gladys, meter));
  },

  /** Refresh every meter at once, from the in-memory list. */
  async onPoll(gladys, config) {
    const meters = await fetchMeters(config.gateway_ip, config.access_token).catch(() => []);
    state.meters = meters;
    for (const meter of meters) {
      await gladys.publishStates(buildStates(gladys, meter));
    }
  },
};
