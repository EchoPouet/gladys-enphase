# Gladys Enphase IQ Gateway

External [Gladys Assistant](https://gladysassistant.com) integration for the [Enphase IQ Gateway](https://enphase.com) local API. It monitors your solar installation entirely **locally** — no cloud account, no Enphase developer credentials.

## Documentation

Detailed, user-oriented documentation is available in the [`docs/`](./docs) folder:

- [English](./docs/en.md) — overview, prerequisites, configuration, published devices, certificate security and troubleshooting.
- [Français](./docs/fr.md) — the same documentation in French.

The documentation is also re-hosted by Gladys and linked from the **Configuration** screen of the integration.

## Notes

- Requires **Gladys Assistant ≥ 4.86.0** and an **IQ Gateway with D8+ firmware** (November 2023 or later).
- A **local access token** is required: on the gateway web UI, go to **System > Local Access**, sign the Enphase agreement and copy the displayed JWT token.
- The integration makes **no cloud calls**: everything stays on your local network.
- The transport badge stays **local** when the gateway answers, and switches to **unreachable** when it stops responding.

## License

Apache-2.0
