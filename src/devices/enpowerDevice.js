// -----------------------------------------------------------------------------
// Device type: ENPHASE IQ SYSTEM CONTROLLER (Enpower).
//
// One device, the System Controller, reporting its grid mode, temperature and
// admin state. The data comes from `/ivp/ensemble/inventory` (type ENPOWER).
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { fetchEnsemble } from '../enphase.js';

export const DEVICE_TYPE = 'enphase-enpower';

const logger = createLogger({ name: DEVICE_TYPE });

// The Enpower device, kept between polls.
const state = {
  enpower: null,
};

/** Feature keys. */
export const FEATURE = {
  GRID_MODE: 'grid-mode',
  TEMPERATURE: 'temperature',
  ADMIN_STATE: 'admin-state',
};

/** Multi-language labels of the features. */
const FEATURE_NAMES = {
  [FEATURE.GRID_MODE]: { en: 'Grid mode', fr: 'Mode réseau' },
  [FEATURE.TEMPERATURE]: { en: 'Temperature', fr: 'Température' },
  [FEATURE.ADMIN_STATE]: { en: 'Admin state', fr: 'État admin' },
};

/** External id of the Enpower device. */
export function deviceExternalId(gladys, serial) {
  return gladys.externalIds(DEVICE_TYPE, serial).device;
}

/** Convert Fahrenheit to Celsius. */
function fahrenheitToCelsius(f) {
  return Math.round(((f - 32) * 5) / 9);
}

/** Build the discovery payload of the Enpower device. */
export function buildDevice(gladys, enpower) {
  const ids = gladys.externalIds(DEVICE_TYPE, enpower.serialNumber);
  return {
    name: `IQ System Controller ${enpower.serialNumber.slice(-6)}`,
    external_id: ids.device,
    params: [{ name: 'SERIAL_NUMBER', value: enpower.serialNumber }],
    features: [
      {
        name: FEATURE_NAMES[FEATURE.GRID_MODE].en,
        external_id: ids.feature(FEATURE.GRID_MODE),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
        min: 0,
        max: 0,
        read_only: true,
        has_feedback: false,
        keep_history: false,
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
        name: FEATURE_NAMES[FEATURE.ADMIN_STATE].en,
        external_id: ids.feature(FEATURE.ADMIN_STATE),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
        min: 0,
        max: 0,
        read_only: true,
        has_feedback: false,
        keep_history: false,
      },
    ],
  };
}

/** Build the `publishStates` batch of the Enpower device. */
export function buildStates(gladys, enpower) {
  const ids = gladys.externalIds(DEVICE_TYPE, enpower.serialNumber);
  return [
    {
      device_feature_external_id: ids.feature(FEATURE.GRID_MODE),
      text: enpower.gridMode,
    },
    {
      device_feature_external_id: ids.feature(FEATURE.TEMPERATURE),
      state: fahrenheitToCelsius(enpower.temperatureF),
    },
    {
      device_feature_external_id: ids.feature(FEATURE.ADMIN_STATE),
      text: enpower.mainsAdminState,
    },
  ];
}

export const enpowerDevice = {
  key: DEVICE_TYPE,

  /** The device belongs to this blueprint when its id carries the type. */
  owns(device) {
    return device.external_id.includes(`:${DEVICE_TYPE}:`);
  },

  /** Build the discovery payload — performs the live read. */
  async buildDevices(gladys, config) {
    let ensemble;
    try {
      ensemble = await fetchEnsemble(config.gateway_ip, config.access_token);
    } catch (err) {
      // Ensemble is optional: no System Controller installed.
      logger.debug('Ensemble inventory unavailable', err);
      return [];
    }

    state.enpower = ensemble.enpower[0] ?? null;
    if (!state.enpower) {
      return [];
    }
    logger.info(`Discovered Enpower ${state.enpower.serialNumber}`);
    return [buildDevice(gladys, state.enpower)];
  },

  /** Refresh the Enpower device. */
  async onPoll(gladys) {
    if (!state.enpower) {
      return;
    }
    await gladys.publishStates(buildStates(gladys, state.enpower));
  },
};
