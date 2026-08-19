# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

- Fixed a crash on every Homebridge restart: `Cannot add a Service with the same UUID
  '00000049-0000-1000-8000-0026BB765291' and subtype 'charging' as another Service in this
  Accessory.` Homebridge restores cached accessories (with their services already attached)
  before the plugin runs, but the Climate, Charging, Find My Car, and Away From Home services,
  plus the lazily-created Cabin Temperature sensor, were unconditionally calling `addService()`
  instead of reusing the already-restored service — colliding with what Homebridge had just
  restored from cache. All five now use the same get-or-create pattern already used by the Lock,
  Battery, and Charge Cable services. Also fixed: the Battery and Charge Cable services weren't
  refreshing their displayed name on a restored accessory, so an accessory cached before the
  service-naming fix below would keep showing its old name forever — all services now refresh
  their name on every restart. No authentication, API, encryption, or configuration changes.
- Fixed HomeKit service naming: every service (Doors, Battery, Charge Cable, Climate, Charging,
  Find My Car, Away From Home, Cabin Temperature) now has a short, self-contained name instead of
  being prefixed with the vehicle's own nickname — the prefixed form was displaying as just the
  vehicle's name for every control in the Home app. The Lock Mechanism ("Doors") is now marked
  the accessory's primary service, and the Battery service is linked to it so a battery indicator
  can appear on the Doors tile, per the standard HAP pattern for battery-powered accessories.
  No authentication, API, encryption, or configuration changes.

## [1.0.0] - 2026-08-19

Initial release.

- Honda Connect Europe ("My Honda+") API client: encrypted login (AES-256-CBC + RSA envelope),
  device key registration and email verification flow, access/refresh token management.
- Homebridge dynamic platform: discovers vehicles on the account and publishes one accessory per
  vehicle, restoring cached accessories across restarts.
- HomeKit services: Lock Mechanism (door lock status + lock/unlock), Battery (state of charge,
  charging state, low-battery flag), Contact Sensor (charge cable), Switches (climate
  pre-conditioning, charging, horn & lights), Occupancy Sensor (away-from-home), Temperature
  Sensor (cabin temperature) — each gated on Honda's reported per-vehicle capabilities.
- Configurable status polling interval, with an opt-in "wake vehicle" mode for fresh (rather than
  cached) data.
- Secure on-disk token/device-key storage (0600 permissions) under Homebridge's storage directory.
- Homebridge UI configuration schema, including a guided first-run device-verification flow.
- Unit test suite (Jest) covering the crypto envelope, auth flow, dashboard parsing, capability
  gating, HomeKit accessory wiring, and platform discovery/authentication.
