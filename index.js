// -----------------------------------------------------------------------------
// Entry point of the Gladys external integration.
//
// Role of this file: wire the SDK to the device blueprints (src/devices/) and
// to the Enphase gateway client (src/enphase.js). It holds NO hardware logic;
// this file only:
//   - instantiates the SDK (connection, auth, reconnection: handled for you);
//   - registers the event handlers BEFORE connect();
//   - on connection, checks the gateway token and publishes the devices;
//   - the mDNS scan (find the gateway IP) is registered at the registry level
//     (action `detect_gateway`), like the template's `identify` action.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { isConfigured, isValidGatewayIp, normalizeConfig } from './src/config.js';
import {
  buildDiscoveredDevices,
  DEVICE_BLUEPRINTS,
  findBlueprintByDevice,
} from './src/devices/index.js';
import { systemDevice } from './src/devices/systemDevice.js';
import {
  checkJwt,
  EnphaseError,
  fetchProduction,
  setPinnedCertFingerprint,
} from './src/enphase.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();
// Mirror the (optional) configured certificate pin into the gateway client as
// soon as the config is known.
setPinnedCertFingerprint(config.pinned_cert_fingerprint);

// The gateway identity learned at build time (used to publish the transports
// of the system device). Kept here and not in the blueprint to keep the
// blueprint purely functional — it is a cache of the last successful read.
const systemState = {
  serial: null,
};

/** Shown in the Supervision screen while the gateway has not responded yet. */
const NOT_CONFIGURED_MESSAGE = {
  en: 'Fill in the gateway IP and token to start monitoring.',
  fr: 'Renseignez l’IP du gateway et le jeton pour démarrer le suivi.',
};

/**
 * Publish the discovered devices — unless we do not know WHERE to look at all.
 * The gateway is read live (site_info + inverters), so the ids are stable
 * once a serial is known.
 * @returns {Promise<boolean>} whether there was anything to publish
 */
async function publishDevices() {
  if (!isConfigured(config)) {
    logger.warn('No gateway configured yet: nothing to discover');
    await gladys.setConnectionStatus(false, NOT_CONFIGURED_MESSAGE).catch(() => {});
    return false;
  }

  try {
    const devices = await buildDiscoveredDevices(gladys, config);
    logger.debug('publishDiscoveredDevices ->', JSON.stringify(devices));
    const response = await gladys.publishDiscoveredDevices(devices);
    logger.info(`Published ${response?.count ?? devices.length} device(s) to the Discovery screen`);

    // Remember the gateway serial for the transport badge of the system device.
    const system = devices.find((device) => device.external_id.includes(':enphase-system:'));
    if (system) {
      const serialParam = system.params?.find((param) => param.name === 'GATEWAY_SERIAL');
      systemState.serial = serialParam?.value ?? null;
    }
    return true;
  } catch (err) {
    logger.error('Gladys refused the discovered devices', err);
    const reason = String(err?.message ?? err).slice(0, 150);
    await gladys
      .setConnectionStatus(false, {
        en: `Gladys refused the device: ${reason}`,
        fr: `Gladys a refusé l’appareil : ${reason}`,
      })
      .catch(() => {});
    throw err;
  }
}

/** Remember the last published transports, to only publish changes. */
const lastTransportReachable = new Map();

/**
 * Publish the transport of every device whose gateway state just changed.
 * Called after each refresh; keeps the badge in sync without spamming.
 */
async function publishTransportChanges(reachable) {
  const entries = [];
  if (systemState.serial) {
    entries.push({
      external_id: gladys.externalIds('enphase-system', systemState.serial).device,
      transport: reachable ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
    });
  }
  for (const externalId of DEVICE_BLUEPRINTS.flatMap((bp) =>
    bp.key === 'enphase-inverter' && bp.publishedDeviceIds ? bp.publishedDeviceIds(gladys) : [],
  )) {
    entries.push({
      external_id: externalId,
      transport: reachable ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
    });
  }

  const changed = entries.filter(
    (entry) => lastTransportReachable.get(entry.external_id) !== reachable,
  );
  if (changed.length === 0) {
    return;
  }
  for (const entry of changed) {
    lastTransportReachable.set(entry.external_id, reachable);
  }
  try {
    await gladys.publishTransports(changed);
  } catch (err) {
    logger.error('publishTransports failed', err);
  }
}

/** One refresh cycle over the whole installation. Never throws. */
let refreshInProgress = false; // true while a cycle is running

async function refreshNow() {
  // Skip when a previous cycle is still running: overlapping cycles flood the
  // gateway with concurrent requests, which makes the Envoy time out.
  if (refreshInProgress || !isConfigured(config)) {
    return;
  }
  refreshInProgress = true;
  try {
    try {
      await checkJwt(config.gateway_ip, config.access_token);
    } catch (err) {
      const message =
        err instanceof EnphaseError && (err.status === 401 || err.status === 403)
          ? {
              en: 'Token refused by the gateway, check the local access token.',
              fr: 'Jeton refusé par le gateway, vérifiez le jeton d’accès local.',
            }
          : {
              en: 'Gateway unreachable, check its IP address.',
              fr: 'Gateway injoignable, vérifiez son adresse IP.',
            };
      await gladys.setConnectionStatus(false, message).catch(() => {});
      await publishTransportChanges(false);
      return;
    }

    // Token OK: refresh the production (updates the system device states) and
    // the inverter list (so onPoll always has fresh data).
    try {
      const production = await fetchProduction(config.gateway_ip, config.access_token);
      const states = systemDevice.buildStates(gladys, production);
      if (states.length > 0) {
        await gladys.publishStates(states);
      }
    } catch (err) {
      logger.error('Production refresh failed', err);
    }

    try {
      const inverterBp = DEVICE_BLUEPRINTS.find((bp) => bp.key === 'enphase-inverter');
      await inverterBp.refreshInverters(gladys, config);
      // Publish the values of every micro-inverter (production power + status).
      // Without this the discovery devices exist but never receive a value.
      await inverterBp.publishAllStates(gladys);
    } catch (err) {
      logger.error('Inverter refresh failed', err);
    }

    // Refresh the optional devices (IQ Battery, System Controller, CT meters).
    // Each blueprint's onPoll is a no-op when the hardware is absent.
    for (const blueprint of DEVICE_BLUEPRINTS) {
      if (['enphase-system', 'enphase-inverter'].includes(blueprint.key)) continue;
      try {
        await blueprint.onPoll(gladys, config);
      } catch (err) {
        logger.error(`Refresh of ${blueprint.key} failed`, err);
      }
    }

    await gladys.setConnectionStatus(true).catch(() => {});
    await publishTransportChanges(true);
  } finally {
    // Whatever happened (including an early return above), release the lock so
    // the next scheduled cycle can run.
    refreshInProgress = false;
  }
}

// --- Discovery: Gladys asks for the list of devices --------------------------
// When no IP is configured yet, a scan is attempted: the gateway answers the
// mDNS query `_enphase-envoy._tcp`, the core relays it (bridge containers
// never see mDNS on their own). The discovered IP is written to the config so
// the user only has to fill the token.
gladys.onScanRequest(async () => {
  if (!config.gateway_ip) {
    logger.info('onScanRequest -> no IP yet, scanning the network');
    const found = await detectGateway();
    if (found) {
      config = normalizeConfig({ ...config, gateway_ip: found });
      await gladys.setConfig({ gateway_ip: found });
      logger.info(`Gateway detected at ${found}, publishing devices`);
    } else {
      logger.warn('No gateway found on the network');
      await gladys
        .setConnectionStatus(false, {
          en: 'No Enphase gateway found. Fill in its IP address manually.',
          fr: 'Aucun gateway Enphase trouvé. Renseignez son adresse IP manuellement.',
        })
        .catch(() => {});
      // Nothing to publish: an empty list would clear the Discovery screen.
      return;
    }
  }
  await publishDevices();
});

/** mDNS scan mediated by the core (declared in the manifest). */
async function detectGateway() {
  try {
    const results = await gladys.scanNetwork('mdns', { timeoutSeconds: 10 });
    const gateway = results.find(
      (entry) => entry.name?.includes('enphase') || entry.txt?.includes('enphase'),
    );
    const address = gateway?.addresses?.[0] ?? gateway?.host ?? null;
    const ip = address ? String(address) : null;
    if (!ip) return null;

    // Only ever store a private address. A public hostname/IP must not become
    // the target (and the recipient of our token) just because mDNS answered.
    if (!isValidGatewayIp(ip)) {
      logger.warn(`Discovered gateway address "${ip}" is not a private IP, ignoring it`);
      return null;
    }

    // When a token is already configured, prove the target actually accepts it
    // (and, when a cert pin is set, that it presents the pinned certificate)
    // before persisting the IP.
    if (config.access_token) {
      try {
        await checkJwt(ip, config.access_token);
      } catch (err) {
        logger.warn(
          `Discovered candidate at ${ip} did not validate (${err.code ?? err.status}), ignoring it`,
        );
        return null;
      }
    } else {
      logger.info(`Found gateway candidate at ${ip}; a token is needed to confirm it`);
    }
    return ip;
  } catch (err) {
    logger.error('mDNS scan failed', err);
    return null;
  }
}

// --- Polling: Gladys asks to refresh one device ------------------------------
gladys.onPoll(async (device) => {
  const blueprint = findBlueprintByDevice(device);
  if (!blueprint || typeof blueprint.onPoll !== 'function') {
    logger.debug(`onPoll ignored (no polling) for ${device.external_id}`);
    return;
  }
  await blueprint.onPoll(gladys, config, device);
});

// --- Manifest actions: buttons in the Configuration screen -------------------
// The `detect_gateway` action is registry-level: it writes the config (like
// the template's `identify`) and is not owned by a single blueprint.
gladys.onAction('detect_gateway', async () => {
  logger.info('Action detect_gateway -> scanning the network');
  const found = await detectGateway();
  if (!found) {
    return {
      en: 'No Enphase gateway found on the network. Check that it is powered and on the same LAN.',
      fr: 'Aucun gateway Enphase trouvé sur le réseau. Vérifiez qu’il est allumé et sur le même réseau local.',
    };
  }
  config = normalizeConfig({ ...config, gateway_ip: found });
  await gladys.setConfig({ gateway_ip: found });
  return {
    en: `Gateway found at ${found}. Fill in your local access token to start monitoring.`,
    fr: `Gateway trouvé à ${found}. Renseignez votre jeton d’accès local pour démarrer le suivi.`,
  };
});

// Other actions are owned by the blueprints.
for (const blueprint of DEVICE_BLUEPRINTS) {
  for (const [actionKey, handler] of Object.entries(blueprint.actions ?? {})) {
    if (actionKey === 'detect_gateway') continue; // registered above
    gladys.onAction(actionKey, (fields) => handler(gladys, { fields, config }));
  }
}

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
  setPinnedCertFingerprint(config.pinned_cert_fingerprint);
  // Re-publish the devices (IP/token changes affect the reads).
  await publishDevices();
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  try {
    // 1) Fetch the configuration filled in by the user.
    config = normalizeConfig(await gladys.getConfig());
    setPinnedCertFingerprint(config.pinned_cert_fingerprint);

    // 2) Validate the token, if configured.
    if (!isConfigured(config)) {
      await gladys.setConnectionStatus(false, NOT_CONFIGURED_MESSAGE);
      return;
    }
    try {
      await checkJwt(config.gateway_ip, config.access_token);
    } catch (err) {
      const message =
        err instanceof EnphaseError && (err.status === 401 || err.status === 403)
          ? {
              en: 'Token refused by the gateway, check the local access token.',
              fr: 'Jeton refusé par le gateway, vérifiez le jeton d’accès local.',
            }
          : {
              en: 'Gateway unreachable, check its IP address.',
              fr: 'Gateway injoignable, vérifiez son adresse IP.',
            };
      await gladys.setConnectionStatus(false, message).catch(() => {});
      return;
    }

    // 3) (Re)publish all devices as soon as we are connected.
    await publishDevices();

    // 4) Refresh once right away, then every poll_frequency seconds.
    await refreshNow();
    const intervalMs = config.poll_frequency * 1000;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      refreshNow().catch((err) => logger.error('Refresh cycle failed', err));
    }, intervalMs);

    // 5) Report the application-level status, shown in the Configuration
    // screen. Distinct from the container state machine.
    await gladys.setConnectionStatus(true);
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    const reason = String(err?.message ?? err).slice(0, 150);
    await gladys
      .setConnectionStatus(false, {
        en: `Initialization failed: ${reason}`,
        fr: `L’initialisation a échoué : ${reason}`,
      })
      .catch(() => {});
  }
});

let refreshTimer = null;

gladys.on('disconnected', () => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Enphase integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
