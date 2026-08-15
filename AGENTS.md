# AGENTS.md

Guidance for developers and AI agents working on this codebase. Everything user-facing lives in [`docs/`](./docs) and is documented in the [README](./README.md).

## What this integration demonstrates

External [Gladys Assistant](https://gladysassistant.com) integration for the [Enphase IQ Gateway](https://enphase.com) local API. It deliberately shows several **device types** so you can see how a real-world hardware integration is structured. Everything lives in the [`src/devices/`](./src/devices) folder (one file per device type), and every place where the integration talks to the gateway is a live HTTP call to the local Enphase API.

| Device                | Type illustrated                                      | SDK hooks used                        |
| --------------------- | ----------------------------------------------------- | ------------------------------------- |
| Gateway (system)      | Read-only sensors (production, consumption, battery)  | `onPoll`, `publishStates`, `onAction` |
| Micro-inverter        | Read-only sensor per inverter + text status           | `onPoll`, `publishStates`, `onAction` |
| IQ Battery (Encharge) | Battery sensors (level, temperature, power, capacity) | `onPoll`, `publishStates`             |
| IQ System Controller  | Text + temperature sensors                            | `onPoll`, `publishStates`             |
| CT Meter              | Energy sensors (power, energy, voltage, current)      | `onPoll`, `publishStates`             |

The wiring (connection, auth, reconnection, dispatch) is in [`index.js`](./index.js) — you rarely need to touch it.

## Project structure

```
.
├─ index.js                          # SDK bootstrap + event wiring (no device logic)
├─ src/
│  ├─ devices/                       # ← one file per device type (edit these)
│  │  ├─ index.js                    #   registry: list your devices here
│  │  ├─ systemDevice.js             #   the gateway device (production, consumption, battery)
│  │  ├─ inverterDevice.js           #   one device per micro-inverter
│  │  ├─ enchargeDevice.js           #   one device per IQ Battery
│  │  ├─ enpowerDevice.js            #   the IQ System Controller
│  │  └─ ctMeterDevice.js            #   one device per CT meter
│  ├─ enphase.js                     # local gateway client (JWT D8+)
│  └─ config.js                      # config defaults + normalization
├─ docs/
│  ├─ en.md                          # user documentation (re-hosted by Gladys,
│  └─ fr.md                          #   linked from the Configuration screen)
├─ gladys-assistant-integration.json # manifest (name, config schema, image…)
├─ Dockerfile                        # Node 24 Alpine, read-only rootfs ready
└─ cover.png                         # catalog cover, 800×534 px, ≤150 KB
```

To add a device type, create a new file in `src/devices/` following the same shape as the existing ones, then register it in `src/devices/index.js`. Business logic (the device modules) and utilities (`enphase.js`, `config.js`) are kept separate so the parts you edit stay small.

The plumbing you would otherwise copy into every integration comes straight from the SDK (v0.12.0+):

- `logger` / `createLogger({ name })` — leveled console logger (`LOG_LEVEL` env var), with named/child loggers per module;
- `DEVICE_FEATURE_CATEGORIES`, `DEVICE_FEATURE_TYPES`, `DEVICE_FEATURE_UNITS` — the standard Gladys categories / types / units, no manual string copying;
- `gladys.externalIds(type, platformId)` — builds the unique, stable device and feature external ids;
- `gladys.handleShutdown(cleanup)` — graceful SIGTERM/SIGINT handling;
- `gladys.setConnectionStatus(connected, message?)` — application-level connection status shown in the Configuration screen;
- `gladys.onAction(key, cb)` — handler of a manifest `actions` button: the integration declares `detect_gateway`, `test_gateway` and `list_inverters` actions (manifest `actions` field), returning the multi-language message displayed under the button;
- mediated network discovery (`scanNetwork` + the manifest `network_discovery` field) — the core scans for the gateway over mDNS (`_enphase-envoy._tcp`) and fills in its IP address.

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="enphase" \
LOG_LEVEL=debug \
npm start
```

The three `GLADYS_*` variables are injected by the Gladys supervisor when the integration runs inside its sandboxed container. The SDK reads them automatically.

## Quality checks

The integration ships with the tooling every integration should keep:

```bash
npm run format:check   # Prettier: is everything formatted?
npm run format         # Prettier: format everything in place
npm run lint           # ESLint: catch real mistakes (unused vars, dead code…)
npm test               # Unit tests, via the built-in `node --test` runner
```

Tests live in [`test/`](test/) and use Node's native test runner — no extra test framework to install. Add a `*.test.js` file next to the ones already there and it is picked up automatically.

## Development notes

- All external identifiers are prefixed with `ext:<selector>:` — always build them with `gladys.externalIds(type, platformId)` (or the lower-level `gladys.externalId(suffix)`); the server rejects anything else. Derive `platformId` from the unique id the external platform gives you (serial, cloud id, MAC…), never from a hard-coded label.
- Values are published in **kW / kWh** (power / energy), **%** (battery level), **°C** (temperature), **V** (voltage) and **A** (current), rounded to **3 decimal places maximum**.
- The endpoint parsing (production, battery, ensemble, meters) is based on the work of the [pyenphase](https://github.com/pyenphase/pyenphase) project (used by Home Assistant) — a big thank you to its maintainers.
