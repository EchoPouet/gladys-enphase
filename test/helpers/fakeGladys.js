// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface this integration relies on:
//   - externalIds(type, platformId) -> { device, feature(key) }
//   - publishStates                 -> record calls so tests can assert them
//   - publishDiscoveredDevices      -> record the last published list
//   - publishTransports             -> record the reported transports
//   - setConfig / getConfig         -> record the persisted config keys
//   - scanNetwork                   -> record the scan requests and return
//                                      the configured results
//   - setConnectionStatus           -> record the reported status
// This lets us test the pure "wiring" logic (discovery payloads, state
// mapping) without a running Gladys server or a real WebSocket.
//
// Extend it when you use a new SDK method, rather than mocking the SDK itself.
// -----------------------------------------------------------------------------

export function createFakeGladys({
  devices = [],
  config = {},
  mdnsResults = [],
  scanResults = [],
  selector = 'test-integration',
} = {}) {
  const published = [];
  const discovered = [];
  const transports = [];
  const configs = [];
  const statuses = [];
  const scans = [];

  let currentConfig = { ...config };

  return {
    published,
    discovered,
    transports,
    configs,
    statuses,
    scans,
    mdnsResults,
    scanResults,

    externalIds(type, platformId) {
      // Mirrors the real SDK: `ext:<selector>:<type>:<platformId>`.
      const device = `ext:${selector}:${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async publishStates(states) {
      for (const s of states) {
        published.push({
          featureExternalId: s.device_feature_external_id,
          state: s.state,
          text: s.text,
        });
      }
      return { success: true };
    },

    async publishState(featureExternalId, value) {
      published.push({ featureExternalId, state: value });
      return { success: true };
    },

    async publishDiscoveredDevices(list) {
      discovered.push(list);
      return { success: true, count: list.length };
    },

    async publishTransports(entries) {
      transports.push(entries);
      return { success: true };
    },

    async setConfig(partialConfig) {
      configs.push(partialConfig);
      currentConfig = { ...currentConfig, ...partialConfig };
      return { success: true };
    },

    async getConfig() {
      return { ...currentConfig };
    },

    async getDevices() {
      return devices;
    },

    async setConnectionStatus(connected, message) {
      statuses.push({ connected, message });
      return { success: true };
    },

    async scanNetwork(type, options = {}) {
      scans.push({ type, options });
      // mdns: [{ name, host, addresses, port, txt }]
      if (type === 'mdns') {
        return mdnsResults;
      }
      return scanResults;
    },
  };
}
