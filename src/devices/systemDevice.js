// -----------------------------------------------------------------------------
// Device type: ENPHASE IQ GATEWAY (system).
//
// One device per gateway, reporting the whole installation: production (W and
// Wh), consumption (only when a meter is present) and battery (only when an IQ
// Battery is installed).
//
// The gateway identity (serial) is only known after a successful read of
// `/api/v1/site_info` (or its `/info.xml` fallback), so the module keeps it in
// memory: `buildDevice` performs the reads and updates it, `deviceExternalId`
// returns the stable id built on the serial once known (and null before the
// first successful read — nothing is published until the gateway has actually
// answered).
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { fetchProduction, fetchSystem, isNumber, round3 } from '../enphase.js';

export const DEVICE_TYPE = 'enphase-system';

const logger = createLogger({ name: DEVICE_TYPE });

// Gateway identity, known after the first successful read. Kept stable so the
// published device id never changes (an id moving breaks the user's scenes).
const state = {
  serial: null,
  name: 'Enphase gateway',
};

/** Feature keys, kept in one place so discovery and polling always agree. */
export const FEATURE = {
  PRODUCTION_POWER: 'production-power',
  PRODUCTION_TODAY: 'production-today',
  PRODUCTION_SEVEN_DAYS: 'production-seven-days',
  PRODUCTION_LIFETIME: 'production-lifetime',
  CONSUMPTION_POWER: 'consumption-power',
  CONSUMPTION_TODAY: 'consumption-today',
  BATTERY_LEVEL: 'battery-level',
  BATTERY_CHARGE_POWER: 'battery-charge-power',
  BATTERY_DISCHARGE_POWER: 'battery-discharge-power',
  BATTERY_ENERGY_REMAINING: 'battery-energy-remaining',
};

/** Multi-language labels of the features. */
const FEATURE_NAMES = {
  [FEATURE.PRODUCTION_POWER]: { en: 'Production', fr: 'Production' },
  [FEATURE.PRODUCTION_TODAY]: { en: 'Production today', fr: 'Production aujourd’hui' },
  [FEATURE.PRODUCTION_SEVEN_DAYS]: { en: 'Production (7 days)', fr: 'Production (7 jours)' },
  [FEATURE.PRODUCTION_LIFETIME]: { en: 'Production (lifetime)', fr: 'Production (cumulée)' },
  [FEATURE.CONSUMPTION_POWER]: { en: 'Consumption', fr: 'Consommation' },
  [FEATURE.CONSUMPTION_TODAY]: { en: 'Consumption today', fr: 'Consommation aujourd’hui' },
  [FEATURE.BATTERY_LEVEL]: { en: 'Battery level', fr: 'Niveau de batterie' },
  [FEATURE.BATTERY_CHARGE_POWER]: { en: 'Battery charge power', fr: 'Puissance de charge' },
  [FEATURE.BATTERY_DISCHARGE_POWER]: { en: 'Battery discharge power', fr: 'Puissance de décharge' },
  [FEATURE.BATTERY_ENERGY_REMAINING]: {
    en: 'Battery energy remaining',
    fr: 'Énergie restante de la batterie',
  },
};

/** Shape shared by every read-only power feature (kW). */
function powerFeature(externalId, name, category, type, max) {
  return {
    name,
    external_id: externalId,
    category,
    type,
    unit: DEVICE_FEATURE_UNITS.KILOWATT,
    min: 0,
    max,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  };
}

/** Shape shared by every read-only energy feature (kWh). */
function energyFeature(externalId, name) {
  return {
    name,
    external_id: externalId,
    category: DEVICE_FEATURE_CATEGORIES.ENERGY_PRODUCTION_SENSOR,
    type: DEVICE_FEATURE_TYPES.ENERGY_PRODUCTION_SENSOR.INDEX,
    unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  };
}

/** Shape shared by every read-only text-less battery feature. */
function batteryFeature(externalId, name, type, unit, min, max) {
  return {
    name,
    external_id: externalId,
    category: DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
    type,
    unit,
    min,
    max,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  };
}

/**
 * Build the discovery payload of the gateway system device.
 * Performs the live reads (system + production) — this is the "DO THE WORK"
 * step of the discovery.
 */
export async function buildDevice(gladys, config) {
  const system = await fetchSystem(config.gateway_ip, config.access_token);
  const production = await fetchProduction(config.gateway_ip, config.access_token);

  // Keep the identity stable once a serial is known.
  if (system.serial) {
    state.serial = system.serial;
    state.name = system.name || state.name;
  } else {
    // Nothing to publish without a serial: the id must stay stable.
    throw new Error('The gateway did not report its serial number');
  }

  const ids = gladys.externalIds(DEVICE_TYPE, state.serial);
  const features = [
    powerFeature(
      ids.feature(FEATURE.PRODUCTION_POWER),
      FEATURE_NAMES[FEATURE.PRODUCTION_POWER].en,
      DEVICE_FEATURE_CATEGORIES.ENERGY_PRODUCTION_SENSOR,
      DEVICE_FEATURE_TYPES.ENERGY_PRODUCTION_SENSOR.POWER,
      80,
    ),
    energyFeature(
      ids.feature(FEATURE.PRODUCTION_TODAY),
      FEATURE_NAMES[FEATURE.PRODUCTION_TODAY].en,
    ),
    energyFeature(
      ids.feature(FEATURE.PRODUCTION_SEVEN_DAYS),
      FEATURE_NAMES[FEATURE.PRODUCTION_SEVEN_DAYS].en,
    ),
    energyFeature(
      ids.feature(FEATURE.PRODUCTION_LIFETIME),
      FEATURE_NAMES[FEATURE.PRODUCTION_LIFETIME].en,
    ),
  ];

  // Consumption is only published when the gateway reports a meter.
  if (isNumber(production.consumptionWatts) || isNumber(production.consumptionTodayWh)) {
    features.push(
      powerFeature(
        ids.feature(FEATURE.CONSUMPTION_POWER),
        FEATURE_NAMES[FEATURE.CONSUMPTION_POWER].en,
        DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
        DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
        80,
      ),
      {
        ...energyFeature(
          ids.feature(FEATURE.CONSUMPTION_TODAY),
          FEATURE_NAMES[FEATURE.CONSUMPTION_TODAY].en,
        ),
        category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
        type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.DAILY_CONSUMPTION,
      },
    );
  }

  // Battery is only published when the gateway reports one.
  if (isNumber(production.batterySoc)) {
    features.push(
      batteryFeature(
        ids.feature(FEATURE.BATTERY_LEVEL),
        FEATURE_NAMES[FEATURE.BATTERY_LEVEL].en,
        DEVICE_FEATURE_TYPES.BATTERY_STORAGE.BATTERY_LEVEL,
        DEVICE_FEATURE_UNITS.PERCENT,
        0,
        100,
      ),
      powerFeature(
        ids.feature(FEATURE.BATTERY_CHARGE_POWER),
        FEATURE_NAMES[FEATURE.BATTERY_CHARGE_POWER].en,
        DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
        DEVICE_FEATURE_TYPES.BATTERY_STORAGE.CHARGE_POWER,
        80,
      ),
      powerFeature(
        ids.feature(FEATURE.BATTERY_DISCHARGE_POWER),
        FEATURE_NAMES[FEATURE.BATTERY_DISCHARGE_POWER].en,
        DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
        DEVICE_FEATURE_TYPES.BATTERY_STORAGE.DISCHARGE_POWER,
        80,
      ),
      batteryFeature(
        ids.feature(FEATURE.BATTERY_ENERGY_REMAINING),
        FEATURE_NAMES[FEATURE.BATTERY_ENERGY_REMAINING].en,
        DEVICE_FEATURE_TYPES.BATTERY_STORAGE.BATTERY_ENERGY_REMAINING,
        DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
    );
  }

  return {
    name: state.name,
    external_id: ids.device,
    // NO poll_frequency on purpose: the core only accepts a fixed enum of
    // intervals in MILLISECONDS (capped at one minute), while the gateway is
    // polled at a user-configurable interval in seconds. The integration runs
    // its own timer (see index.js) instead of relying on Gladys' polling.
    params: [
      { name: 'GATEWAY_IP', value: config.gateway_ip },
      { name: 'GATEWAY_SERIAL', value: state.serial },
      { name: 'GATEWAY_NAME', value: state.name },
    ],
    features,
  };
}

/**
 * Build the `publishStates` batch from one production reading, so the mapping
 * is testable offline.
 * @returns {Array<{ device_feature_external_id: string, state: number }>}
 */
export function buildStates(gladys, production) {
  if (!state.serial) {
    throw new Error('Cannot publish states before the gateway serial is known');
  }
  const ids = gladys.externalIds(DEVICE_TYPE, state.serial);
  const states = [];

  // The gateway reports W/Wh; the features are declared in kW/kWh, so power
  // and energy are divided by 1000. The battery level is a percent and stays
  // as-is (divisor 1).
  const push = (feature, value, divisor = 1000) => {
    if (isNumber(value)) {
      states.push({
        device_feature_external_id: ids.feature(feature),
        state: round3(value / divisor),
      });
    }
  };

  push(FEATURE.PRODUCTION_POWER, production.wattsNow);
  push(FEATURE.PRODUCTION_TODAY, production.whToday);
  push(FEATURE.PRODUCTION_SEVEN_DAYS, production.whSevenDays);
  push(FEATURE.PRODUCTION_LIFETIME, production.whLifetime);
  push(FEATURE.CONSUMPTION_POWER, production.consumptionWatts);
  push(FEATURE.CONSUMPTION_TODAY, production.consumptionTodayWh);
  push(FEATURE.BATTERY_LEVEL, production.batterySoc, 1);
  push(FEATURE.BATTERY_CHARGE_POWER, production.batteryChargeWatts);
  push(FEATURE.BATTERY_DISCHARGE_POWER, production.batteryDischargeWatts);
  push(FEATURE.BATTERY_ENERGY_REMAINING, production.batteryEnergyRemainingWh);

  return states;
}

export const systemDevice = {
  key: DEVICE_TYPE,

  buildStates,

  /** The device belongs to this blueprint when its id carries the type. */
  owns(device) {
    return device.external_id.includes(`:${DEVICE_TYPE}:`);
  },

  /** Build the discovery payload — performs the live reads. */
  async buildDevices(gladys, config) {
    return [await buildDevice(gladys, config)];
  },

  /** Manifest actions owned by this device type. */
  actions: {
    async test_gateway(gladys, { config }) {
      logger.info('Action test_gateway -> live request to the gateway');
      const system = await fetchSystem(config.gateway_ip, config.access_token);
      const production = await fetchProduction(config.gateway_ip, config.access_token);
      const wattLabel = `${(production.wattsNow / 1000).toFixed(2)} kW`;
      const todayLabel =
        production.whToday !== null ? `${Math.round(production.whToday / 1000)} kWh` : '—';
      return {
        en: `Gateway ${system.serial || system.name} OK: ${wattLabel} right now, ${todayLabel} today.`,
        fr: `Gateway ${system.serial || system.name} OK : ${wattLabel} actuellement, ${todayLabel} aujourd’hui.`,
      };
    },
  },

  /** Read the gateway and publish the states. */
  async onPoll(gladys, config) {
    logger.info(`Polling gateway ${state.serial}...`);

    const production = await fetchProduction(config.gateway_ip, config.access_token);
    const states = buildStates(gladys, production);
    if (states.length === 0) {
      logger.warn('No production data, nothing published');
      return;
    }
    logger.info(`Production: ${production.wattsNow} W, ${production.whToday ?? '—'} Wh today`);
    await gladys.publishStates(states);
  },
};
