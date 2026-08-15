// -----------------------------------------------------------------------------
// Device type: ENPHASE IQ BATTERY (Encharge).
//
// One device per IQ Battery, reporting its state of charge, temperature,
// capacity and real power. The list comes from `/ivp/ensemble/inventory`
// (type ENCHARGE) and the live power from `/ivp/ensemble/power`.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { fetchEnchargePower, fetchEnsemble, round3 } from '../enphase.js';

export const DEVICE_TYPE = 'enphase-encharge';

const logger = createLogger({ name: DEVICE_TYPE });

// The per-battery inventory, kept between polls.
const state = {
  batteries: [],
};

/** Feature keys. */
export const FEATURE = {
  LEVEL: 'level',
  TEMPERATURE: 'temperature',
  POWER: 'power',
  CAPACITY: 'capacity',
};

/** Multi-language labels of the features. */
const FEATURE_NAMES = {
  [FEATURE.LEVEL]: { en: 'Battery level', fr: 'Niveau de batterie' },
  [FEATURE.TEMPERATURE]: { en: 'Temperature', fr: 'Température' },
  [FEATURE.POWER]: { en: 'Power', fr: 'Puissance' },
  [FEATURE.CAPACITY]: { en: 'Capacity', fr: 'Capacité' },
};

/** External id of the device of one battery. */
export function deviceExternalId(gladys, serial) {
  return gladys.externalIds(DEVICE_TYPE, serial).device;
}

/** The external ids currently published by this blueprint. */
export function publishedDeviceIds(gladys) {
  return state.batteries.map((battery) => deviceExternalId(gladys, battery.serialNumber));
}

/** Build the discovery payload of ONE battery. */
export function buildDevice(gladys, battery) {
  const ids = gladys.externalIds(DEVICE_TYPE, battery.serialNumber);
  return {
    name: `IQ Battery ${battery.serialNumber.slice(-6)}`,
    external_id: ids.device,
    params: [
      { name: 'SERIAL_NUMBER', value: battery.serialNumber },
      { name: 'CAPACITY_WH', value: String(battery.capacityWh ?? 0) },
    ],
    features: [
      {
        name: FEATURE_NAMES[FEATURE.LEVEL].en,
        external_id: ids.feature(FEATURE.LEVEL),
        category: DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
        type: DEVICE_FEATURE_TYPES.BATTERY_STORAGE.BATTERY_LEVEL,
        unit: DEVICE_FEATURE_UNITS.PERCENT,
        min: 0,
        max: 100,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: FEATURE_NAMES[FEATURE.TEMPERATURE].en,
        external_id: ids.feature(FEATURE.TEMPERATURE),
        category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
        type: DEVICE_FEATURE_TYPES.TEMPERATURE_SENSOR.AVERAGE,
        unit: DEVICE_FEATURE_UNITS.CELSIUS,
        min: -40,
        max: 80,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: FEATURE_NAMES[FEATURE.POWER].en,
        external_id: ids.feature(FEATURE.POWER),
        category: DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
        type: DEVICE_FEATURE_TYPES.BATTERY_STORAGE.CHARGE_POWER,
        unit: DEVICE_FEATURE_UNITS.KILOWATT,
        min: -80,
        max: 80,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: FEATURE_NAMES[FEATURE.CAPACITY].en,
        external_id: ids.feature(FEATURE.CAPACITY),
        category: DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
        type: DEVICE_FEATURE_TYPES.BATTERY_STORAGE.BATTERY_ENERGY_REMAINING,
        unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
    ],
  };
}

/** Build the `publishStates` batch of ONE battery. */
export function buildStates(gladys, battery, power) {
  const ids = gladys.externalIds(DEVICE_TYPE, battery.serialNumber);
  const states = [
    {
      device_feature_external_id: ids.feature(FEATURE.LEVEL),
      state: battery.percentFull,
    },
    {
      device_feature_external_id: ids.feature(FEATURE.TEMPERATURE),
      state: battery.temperature,
    },
  ];

  if (power) {
    states.push({
      device_feature_external_id: ids.feature(FEATURE.POWER),
      state: round3(power.realPowerW / 1000), // W -> kW
    });
  }

  if (battery.capacityWh > 0) {
    states.push({
      device_feature_external_id: ids.feature(FEATURE.CAPACITY),
      state: round3(battery.capacityWh / 1000), // Wh -> kWh
    });
  }

  return states;
}

export const enchargeDevice = {
  key: DEVICE_TYPE,

  /** The device belongs to this blueprint when its id carries the type. */
  owns(device) {
    return device.external_id.includes(`:${DEVICE_TYPE}:`);
  },

  /** Build the discovery payloads — performs the live reads. */
  async buildDevices(gladys, config) {
    let ensemble;
    try {
      ensemble = await fetchEnsemble(config.gateway_ip, config.access_token);
    } catch (err) {
      // Ensemble is optional: no IQ Battery / System Controller installed.
      logger.debug('Ensemble inventory unavailable', err);
      return [];
    }

    state.batteries = ensemble.encharge;
    logger.info(`Discovered ${state.batteries.length} IQ battery(ies)`);
    return state.batteries.map((battery) => buildDevice(gladys, battery));
  },

  /** Refresh every battery at once, from the in-memory list. */
  async onPoll(gladys, config) {
    const powerMap = await fetchEnchargePower(config.gateway_ip, config.access_token).catch(
      () => new Map(),
    );
    for (const battery of state.batteries) {
      const power = powerMap.get(battery.serialNumber);

      await gladys.publishStates(buildStates(gladys, battery, power));
    }
  },
};
