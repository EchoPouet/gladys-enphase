# Enphase IQ Gateway integration

This integration monitors your Enphase solar installation **locally**: production, consumption (when a meter is present), battery (when an IQ Battery is installed), the individual production of every **micro-inverter**, the **IQ System Controller** and the **CT meters**.

## Prerequisites

- An **IQ Gateway** with **D8+** firmware (November 2023 or later).
- The gateway reachable from the same local network as your Gladys instance.
- A **local access token**: on the gateway web UI, go to **System > Local Access**, sign the Enphase agreement and copy the displayed JWT token.

## Configuration

1. Install the integration from the Gladys catalog.
2. Enter the gateway **local IP address** (or click **“Detect gateway”**, which finds it over mDNS).
3. Paste your **local access token**.
4. Choose the **refresh interval** (15 to 600 seconds, 60 by default).
5. Enable **“Monitor each micro-inverter”** to get one device per inverter.

The integration makes **no cloud calls**: everything stays on your local network.

## Published devices

Values are published in **kW / kWh** (power / energy), **%** (battery level), **°C** (temperature), **V** (voltage) and **A** (current), rounded to **3 decimal places maximum**.

- **One “gateway” device**: production (kW), today / last 7 days / lifetime production (kWh), consumption (kW and kWh/day) when a meter exists, and battery (level %, charge/discharge power, remaining energy) when an IQ Battery is installed.
- **One device per micro-inverter** (when enabled): instantaneous power (kW) and a text status (“Active”, “Offline…”) to spot a failing inverter.
- **One device per IQ Battery (Encharge)**: level (%), temperature (°C), power (kW) and capacity (kWh).
- **One “IQ System Controller” device (Enpower)**: grid mode, temperature (°C) and admin state.
- **One device per CT meter**: active power (kW), delivered / received energy (kWh), voltage (V) and current (A).

The Encharge, Enpower and CT meter devices are only published when the gateway reports them (automatic detection).

## Security: pin the gateway certificate

The gateway uses a **self-signed certificate**, so the integration cannot cryptographically prove its identity by default. Anyone able to impersonate the gateway on your local network could in theory capture your access token.

**Recommended:** fill in the **“Gateway certificate fingerprint (optional)”** field. The integration then only trusts a gateway that presents exactly that certificate — an impostor is rejected (`CERT_PIN_MISMATCH`) even though TLS validation stays relaxed.

1. From a trusted machine on the same network, read the real gateway's fingerprint:
   ```
   openssl s_client -connect <gateway_ip>:443 \
     < /dev/null 2>/dev/null | \
     openssl x509 -noout -fingerprint -sha256
   ```
2. Copy the `SHA256 Fingerprint=...` value into the **Gateway certificate fingerprint** field.
3. Save — the pin is applied immediately. Case and separator spacing don't matter (the code normalises them).

If the gateway's certificate ever changes (firmware update, hardware replacement), the integration will refuse to connect: re-read the new fingerprint and update the field.

Note: the pin protects every connection made after it is set. Always read the fingerprint from your own, trusted gateway — never through an intermediate source.

## Troubleshooting

- **“Token refused”**: the token is invalid, expired or revoked. Regenerate it in the gateway menu (System > Local Access).
- **“Gateway unreachable”**: check that the gateway is powered, on the same network, and that the IP is correct (the “Detect gateway” button finds it over mDNS).
- **No consumption shown**: your installation has no consumption meter connected — the integration only publishes data the gateway actually reports.
- **Certificate fingerprint rejected**: the gateway certificate changed or a device is trying to impersonate the gateway. Re-read the real fingerprint and update the field.
- The transport badge stays **local** when all is well, and switches to **unreachable** when the gateway stops answering.
