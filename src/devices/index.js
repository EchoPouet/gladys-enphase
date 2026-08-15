// -----------------------------------------------------------------------------
// Device registry.
//
// Two device TYPES, a variable NUMBER of devices:
//   - `systemDevice`     : ONE device, the gateway itself (serial-based id);
//   - `inverterDevice`   : ONE device per micro-inverter (serial-based id).
//
// Every blueprint exposes the same shape:
//   - key                                  : short identifier (used in logs)
//   - owns(device)                         : does this blueprint own the device?
//   - buildDevices(gladys, config)         : the discovery payloads sent to
//     Gladys (async: the gateway is read live)
//   - actions                              : manifest action handlers, keyed by
//     the action `key` declared in gladys-assistant-integration.json
//   - onPoll(gladys, config, device)       : read of ONE device
// -----------------------------------------------------------------------------

import { ctMeterDevice } from './ctMeterDevice.js';
import { enchargeDevice } from './enchargeDevice.js';
import { enpowerDevice } from './enpowerDevice.js';
import { inverterDevice } from './inverterDevice.js';
import { systemDevice } from './systemDevice.js';

export const DEVICE_BLUEPRINTS = [
  systemDevice,
  inverterDevice,
  enchargeDevice,
  enpowerDevice,
  ctMeterDevice,
];

/**
 * Build the discovery payload: every blueprint, for every device it can
 * publish. Performs the live gateway reads.
 */
/**
 * Build the discovery payload: every blueprint, for every device it can
 * publish. Performs the live gateway reads.
 *
 * The blueprints are read strictly one after the other: the Envoy gateway only
 * accepts a few simultaneous local connections, so flooding it with N parallel
 * requests (one per blueprint) makes it time out.
 */
export async function buildDiscoveredDevices(gladys, config) {
  const devices = [];
  for (const blueprint of DEVICE_BLUEPRINTS) {
    const built = await blueprint.buildDevices(gladys, config);
    devices.push(...built);
  }
  return devices;
}

/**
 * Find the blueprint that owns a given device, from its external_id.
 */
export function findBlueprintByDevice(device) {
  return DEVICE_BLUEPRINTS.find((blueprint) => blueprint.owns(device));
}

/**
 * Whether the published list covers the device: used to ignore poll requests
 * for devices the user created when their gateway/inverter disappeared.
 */
export function isPublishedDevice(gladys, device) {
  const blueprint = findBlueprintByDevice(device);
  return Boolean(blueprint);
}
