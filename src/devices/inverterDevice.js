// -----------------------------------------------------------------------------
// Device type: ENPHASE MICRO-INVERTER.
//
// One device per micro-inverter, reporting its current production and a text
// status ("Active" / "Offline" / "Last report ..."). Enabled by the
// `include_inverters` config toggle — a failing unit shows 0 W immediately.
//
// The list of inverters comes from `GET /api/v1/production/inverters` and is
// kept in memory; `buildDevices` performs the read and updates it. The device
// id is built on the inverter serial, which is unique and stable.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { fetchInverters, round3 } from '../enphase.js';

export const DEVICE_TYPE = 'enphase-inverter';

const logger = createLogger({ name: DEVICE_TYPE });

// The per-inverter report, kept between polls so onPoll can refresh every
// device from a single API call. Outside tests, `refreshInverters` sets it.
const state = {
  inverters: [],
};

/** Feature keys, kept in one place so discovery and polling always agree. */
export const FEATURE = {
  POWER: 'power',
  STATUS: 'status',
};

/** Multi-language labels of the features. */
const FEATURE_NAMES = {
  [FEATURE.POWER]: { en: 'Production', fr: 'Production' },
  [FEATURE.STATUS]: { en: 'Status', fr: 'Statut' },
};

/** External id of the device of one micro-inverter. */
export function deviceExternalId(gladys, serial) {
  return gladys.externalIds(DEVICE_TYPE, serial).device;
}

/** The external ids currently published by this blueprint. */
export function publishedDeviceIds(gladys) {
  return state.inverters.map((inverter) => deviceExternalId(gladys, inverter.serialNumber));
}

/**
 * The current report date, in seconds, as the gateway reports it. Stored
 * separately so tests can inject a fixed one.
 */
export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** Text status of an inverter, in both languages. */
export function statusMessage(inverter, now = nowSeconds()) {
  const lastReportDate = Number(inverter.lastReportDate ?? 0);
  const ageSeconds = now > lastReportDate && lastReportDate > 0 ? now - lastReportDate : null;
  const isActive = ageSeconds !== null && ageSeconds < 300; // 5 minutes without a report -> offline

  if (isActive) {
    return inverter.lastReportWatts > 0
      ? { en: 'Active', fr: 'Actif' }
      : { en: 'Active (0 W)', fr: 'Actif (0 W)' };
  }
  if (ageSeconds === null) {
    return { en: 'Never reported', fr: 'N’a jamais communiqué' };
  }
  const minutes = Math.round(ageSeconds / 60);
  if (minutes < 60) {
    return { en: `Offline (${minutes} min)`, fr: `Hors-ligne (${minutes} min)` };
  }
  const hours = Math.round(minutes / 60);
  return { en: `Offline (${hours} h)`, fr: `Hors-ligne (${hours} h)` };
}

/** Shape shared by every inverter device feature (kW). */
function powerFeature(externalId, name) {
  return {
    name,
    external_id: externalId,
    category: DEVICE_FEATURE_CATEGORIES.ENERGY_PRODUCTION_SENSOR,
    type: DEVICE_FEATURE_TYPES.ENERGY_PRODUCTION_SENSOR.POWER,
    unit: DEVICE_FEATURE_UNITS.KILOWATT,
    min: 0,
    max: 0.8, // IQ micro-inverters peak at ~600-800 W
    read_only: true,
    has_feedback: false,
    keep_history: true,
  };
}

function statusFeature(externalId, name) {
  return {
    name,
    external_id: externalId,
    category: DEVICE_FEATURE_CATEGORIES.TEXT,
    type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
    min: 0,
    max: 0,
    read_only: true,
    has_feedback: false,
    keep_history: false, // a label, not a measure: nothing to chart
  };
}

/**
 * Build the discovery payload of ONE micro-inverter.
 */
export function buildDevice(gladys, inverter) {
  const ids = gladys.externalIds(DEVICE_TYPE, inverter.serialNumber);
  return {
    name: `Micro-inverter ${inverter.serialNumber.slice(-6)}`,
    external_id: ids.device,
    // NO poll_frequency: the integration refreshes all of them at once in
    // onPoll, driven by its own timer (see index.js).
    params: [
      { name: 'SERIAL_NUMBER', value: inverter.serialNumber },
      { name: 'MAX_REPORT_WATTS', value: String(inverter.maxReportWatts ?? 0) },
    ],
    features: [
      powerFeature(ids.feature(FEATURE.POWER), FEATURE_NAMES[FEATURE.POWER].en),
      statusFeature(ids.feature(FEATURE.STATUS), FEATURE_NAMES[FEATURE.STATUS].en),
    ],
  };
}

/** Build the `publishStates` batch of ONE inverter. */
export function buildStates(gladys, inverter) {
  const ids = gladys.externalIds(DEVICE_TYPE, inverter.serialNumber);
  return [
    {
      device_feature_external_id: ids.feature(FEATURE.POWER),
      // The gateway reports W; the feature is declared in kW.
      state: round3((inverter.lastReportWatts ?? 0) / 1000),
    },
    {
      device_feature_external_id: ids.feature(FEATURE.STATUS),
      text: statusMessage(inverter).en,
    },
  ];
}

export const inverterDevice = {
  key: DEVICE_TYPE,

  /** The device belongs to this blueprint when its id carries the type. */
  owns(device) {
    return device.external_id.includes(`:${DEVICE_TYPE}:`);
  },

  /** Build the discovery payloads — performs the live read of the list. */
  async buildDevices(gladys, config) {
    if (config.include_inverters === false) {
      return [];
    }
    const inverters = await fetchInverters(config.gateway_ip, config.access_token);
    state.inverters = inverters;
    logger.info(`Discovered ${inverters.length} micro-inverter(s)`);
    return inverters.map((inverter) => buildDevice(gladys, inverter));
  },

  /** Manifest actions owned by this device type. */
  actions: {
    async list_inverters(gladys, { config }) {
      const inverters = await fetchInverters(config.gateway_ip, config.access_token);
      state.inverters = inverters;
      if (inverters.length === 0) {
        return {
          en: 'The gateway reports no micro-inverter.',
          fr: 'Le gateway ne rapporte aucun micro-onduleur.',
        };
      }
      const lines = inverters.map((inverter, index) => {
        const status = statusMessage(inverter);
        return {
          en: `${index + 1}. ${inverter.serialNumber} — ${status.en} — ${inverter.lastReportWatts} W`,
          fr: `${index + 1}. ${inverter.serialNumber} — ${status.fr} — ${inverter.lastReportWatts} W`,
        };
      });
      const join = (language) => lines.map((line) => line[language]).join('\n');
      return {
        en: `Micro-inverters (${inverters.length}):\n${join('en')}`,
        fr: `Micro-onduleurs (${inverters.length}) :\n${join('fr')}`,
      };
    },
  },

  /** Refresh every inverter at once, from the in-memory list. */
  async onPoll(gladys, _config, device) {
    // The device ids are matched against the cached list; a device whose
    // inverter disappeared is simply ignored (it may be removed by the user).
    const known = state.inverters.find(
      (inverter) => deviceExternalId(gladys, inverter.serialNumber) === device.external_id,
    );
    if (!known) {
      throw new Error(`Inverter ${device.external_id} is not in the current report`);
    }
    await gladys.publishStates(buildStates(gladys, known));
  },

  /** Refresh the cached list so poll stays cheap. */
  async refreshInverters(gladys, config) {
    state.inverters = await fetchInverters(config.gateway_ip, config.access_token);
  },

  /**
   * Publish the states (production power + status) of every cached inverter in
   * a single batch. The integration refreshes all inverters at once from its
   * own timer (see index.js), so this is the only place their values are pushed.
   */
  async publishAllStates(gladys) {
    const states = state.inverters.flatMap((inverter) => buildStates(gladys, inverter));
    if (states.length > 0) {
      await gladys.publishStates(states);
    }
  },
};
