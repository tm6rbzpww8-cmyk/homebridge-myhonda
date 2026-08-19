# homebridge-myhonda

[![npm](https://img.shields.io/npm/v/homebridge-myhonda.svg)](https://www.npmjs.com/package/homebridge-myhonda)
[![CI](https://github.com/tm6rbzpww8-cmyk/homebridge-myhonda/actions/workflows/ci.yml/badge.svg)](https://github.com/tm6rbzpww8-cmyk/homebridge-myhonda/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [Homebridge](https://homebridge.io) plugin that brings your Honda into Apple HomeKit using the same
**My Honda+** (Honda Connect Europe) account and API used by the official My Honda+ mobile app.

Built and tested against a **2020 Honda e (UK)**. The underlying API is shared with other
Honda Connect Europe vehicles (e:Ny1, ZR-V, CR-V, Civic, HR-V, Jazz 2020+), so the plugin should
work with those too, but only the Honda e has been verified end-to-end — see
[Supported vehicles](#supported-vehicles--limitations) below.

> **Unofficial project.** This plugin is not affiliated with, endorsed by, or supported by Honda
> Motor Co., Ltd. It talks to Honda's own mobile API the same way the My Honda+ app does. Honda may
> change that API at any time without notice, which could break this plugin. Use at your own risk —
> see [Disclaimer](#disclaimer).

## What you get in the Home app

| HomeKit service | Shown as | Honda data it reflects | Notes |
|---|---|---|---|
| **Lock** | "Doors" | Door lock state; lock/unlock command | The accessory's primary service; lock/unlock control requires the vehicle's remote-lock capability |
| **Battery** | "Battery" | State of charge, charging state, low-battery flag | Electric vehicles only. Linked to the Doors service so Home can show a battery badge alongside it |
| **Contact Sensor** | "Charge Cable" | Whether the charge cable is plugged in | Electric vehicles only. HomeKit's contact-sensor states are always labelled "Open"/"Closed" by Apple's Home app — "Open" here means the cable is *unplugged*, not that a door is open |
| **Switch** | "Climate" | Start/stop remote climate pre-conditioning | Only shown if your vehicle supports it |
| **Switch** | "Charging" | Start/stop charging | Only shown if your vehicle supports it |
| **Switch** | "Find My Car" | Sound the horn & flash the lights | Momentary switch, auto-resets after firing |
| **Occupancy Sensor** | "Away From Home" | Honda's own home/away geofence signal | Handy for "when my car leaves home…" automations. Apple's Home app always labels occupancy sensor states "Triggered"/"Not Triggered" |
| **Temperature Sensor** | "Cabin Temperature" | Cabin temperature | Only added once Honda reports a value |

Each service's own name (shown in the "Shown as" column) is what appears on its tile in the
Home app — every vehicle's accessory groups all of these together, so with two vehicles you'll
see e.g. "Doors" under both your Honda e and your CR-V, distinguished by which accessory/room
they're in, the same way any other multi-service HomeKit accessory works.

Everything is driven entirely by what Honda's API actually reports for **your** vehicle: a
switch or sensor only appears if Honda says the underlying capability is active for your VIN.
Nothing here is guessed or invented.

### What's intentionally not exposed

HomeKit has no native "range", "odometer", or "map location" characteristic that Apple's Home
app renders usefully, so those aren't mapped to HomeKit services. Range, odometer, and GPS
coordinates are logged at debug level on every poll if you want to consume them via a log-scraping
automation tool — see [Logging](#logging).

## Requirements

- Homebridge 1.8 or newer (or the 2.0 beta)
- Node.js 18.20.4+, 20.18.1+, 22.10.0+, or 24.x
- An active [My Honda+](https://www.honda.co.uk/cars/owners/my-honda-plus.html) account with at
  least one vehicle linked, and an active remote-services subscription for that vehicle

## Installation

Install via the Homebridge UI (search for "My Honda"), or from the command line:

```bash
npm install -g homebridge-myhonda
```

Then add the platform in your Homebridge config, either through the Homebridge UI's plugin
settings screen, or by hand in `config.json`:

```jsonc
{
  "platforms": [
    {
      "platform": "MyHonda",
      "name": "My Honda",
      "email": "you@example.com",
      "password": "your-my-honda-plus-password",
      "locale": "en-GB",
      "pollIntervalSeconds": 300
    }
  ]
}
```

### First run: device verification

Honda requires every new "device" (in this case, your Homebridge instance) to be verified by
email before it will allow sign-in. This can't be automated — it needs access to your inbox — so
on first run:

1. Save your config with just `email`, `password`, and `name` filled in, and restart Homebridge.
2. Watch the Homebridge log. You'll see:
   > A verification email has been sent to your Honda account. Open it, copy the verification
   > LINK (do not click it), and paste it into this plugin's "Verification Link" config field...
3. Open the email Honda sends you. **Copy the link URL itself rather than clicking it** (clicking
   it in a browser can consume the one-time verification before the plugin uses it).
4. Paste that link into the **Verification Link** field in the Homebridge UI (or `verificationLink`
   in `config.json`), save, and restart Homebridge once more.
5. Once you see `Signed in to My Honda+ successfully.` in the log, you can delete the
   `verificationLink` value — it's only needed once. Tokens are cached to disk after that, so
   Homebridge won't need to sign in again on future restarts (until the refresh token itself
   eventually expires or is revoked, at which point the same one-time steps repeat).

If sign-in ever fails afterwards (e.g. after changing your Honda password), the plugin will
detect it, request a fresh verification email automatically, and log the same instructions again.

## Configuration reference

| Key | Type | Default | Description |
|---|---|---|---|
| `email` | string | — | **Required.** Your My Honda+ account email. |
| `password` | string | — | **Required.** Your My Honda+ account password. |
| `verificationLink` | string | — | One-time device verification link, see above. Safe to remove once signed in. |
| `locale` | string | `en-GB` | Language/country code sent with API requests (e.g. `it-IT`, `de-DE`, `fr-FR`). |
| `pollIntervalSeconds` | number | `300` | How often to refresh vehicle status. Minimum `60`. |
| `wakeVehicleOnPoll` | boolean | `false` | If `true`, every poll wakes the car's telematics unit for fresh data instead of using Honda's cache. Slower (up to ~90s) and uses more 12V battery — leave this off unless you need near-real-time data. |
| `enableClimateSwitch` | boolean | `true` | Expose the climate pre-conditioning switch (if supported). |
| `enableChargeSwitch` | boolean | `true` | Expose the start/stop charging switch (if supported). |
| `enableHornSwitch` | boolean | `true` | Expose the horn & lights ("Find My Car") switch (if supported). |
| `enablePresenceSensor` | boolean | `true` | Expose the away-from-home occupancy sensor. |
| `vehicles` | array | — | Per-VIN overrides (`vin`, `name`, and any of the `enable*` flags above) if you have multiple vehicles and want different settings per car. |

## Supported vehicles & limitations

- **Verified**: Honda e (2020, UK/EU market).
- **Expected to work, unverified**: other Honda Connect Europe vehicles — e:Ny1, ZR-V, CR-V,
  Civic, HR-V, Jazz (2020+) — since they use the same account/API. Non-EV models won't get the
  Battery, Charge Cable, or Charging services (those are gated on the vehicle reporting an
  electric fuel type).
- **Region**: this plugin targets the **Honda Connect Europe** ("My Honda+") backend used in the
  UK/EU. It does not work with Honda's separate North American **HondaLink** service, which is a
  different account system and API.
- Every remote command (lock/unlock, climate, charging, horn) is gated on Honda's own
  per-vehicle capability flags — if your trim/subscription doesn't support a feature, the
  corresponding HomeKit service simply won't appear rather than silently failing.
- Commands that need to reach the car (lock, climate, charge, horn) can take several seconds to
  tens of seconds, and will occasionally time out if the vehicle is asleep or out of cellular
  coverage — HomeKit will show a "No Response"-style timeout in that case rather than a false
  success.
- Fresh (`wakeVehicleOnPoll: true`) status refreshes wake the car's telematics control unit,
  which uses 12V battery power. Frequent polling with this enabled on a car that sits for long
  periods (e.g. at an airport) is not recommended.

## Logging

The plugin logs vehicle nicknames, battery %, range, lock state, and command outcomes at
`info`/`debug` level to help with troubleshooting. It never logs your password, access/refresh
tokens, or the device's private key. Enable Homebridge's debug logging (`-D` / verbose mode in
the UI) to see per-poll dashboard summaries.

## Security & credential storage

- Your My Honda+ password is only ever sent to Honda's own API (`mobile-api.connected.honda-eu.com`),
  inside the same AES/RSA-encrypted envelope Honda's own app uses — never in plaintext, and never
  to any third party.
- Access/refresh tokens and this Homebridge instance's device keypair are cached under
  Homebridge's storage directory (`<storagePath>/myhonda/`) with file permissions restricted to
  the owning user (`0600`). They are not encrypted at rest — Homebridge has no standard
  secret-storage API — so treat your Homebridge host's filesystem access as sensitive, the same
  as you would for any other cloud-connected Homebridge plugin's cached credentials.
- Nothing is written to the Homebridge config file except what you put there yourself.

## How it works

This plugin talks directly to the same `mobile-api.connected.honda-eu.com` endpoints the My
Honda+ Android/iOS app uses, reimplemented from scratch in TypeScript. Development was informed by
studying the request/response shapes of the excellent MIT-licensed
[pymyhondaplus](https://github.com/enricobattocchi/pymyhondaplus) project and its companion
[Home Assistant integration](https://github.com/enricobattocchi/myhondaplus-homeassistant) — both
unofficial, community-reverse-engineered clients for the same API — without copying their code.

## Development

```bash
git clone https://github.com/tm6rbzpww8-cmyk/homebridge-myhonda.git
cd homebridge-myhonda
npm install
npm run build
npm test
npm run lint
```

Project layout:

```
src/
  api/            Honda Connect Europe API client (auth, crypto, HTTP, parsing) — no HomeKit code here
  accessories/    Maps a Vehicle + live status onto HomeKit services
  platform.ts     Homebridge DynamicPlatformPlugin: discovery, auth flow, polling
  index.ts        Plugin entry point
test/             Jest unit tests mirroring src/
```

## Disclaimer

This project is **unofficial** and **not affiliated with, endorsed by, or connected to Honda
Motor Co., Ltd.** in any way.

- Use at your own risk. The authors accept no responsibility for any damage to your vehicle,
  account, or warranty.
- Honda may change their API at any time, which could break this plugin without notice.
- Sending remote commands (lock, unlock, climate, charging) to your vehicle is your
  responsibility. Make sure you understand what each command does before enabling it, especially
  before wiring it into automations.
- This project does not store or transmit your credentials to any third party. Authentication is
  performed directly with Honda's own servers.

## License

[MIT](LICENSE)
