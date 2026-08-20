/**
 * Homebridge dynamic platform: discovers Honda vehicles on the configured
 * account, publishes one accessory per vehicle, and polls Honda for
 * status updates on a timer.
 */

import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, DEFAULT_POLL_INTERVAL_SECONDS, MIN_POLL_INTERVAL_SECONDS } from './settings';
import { HondaApiClient } from './api/client';
import { Vehicle } from './api/vehicle';
import {
  HondaAccountLockedError,
  HondaApiError,
  HondaRateLimitError,
  HondaVerificationRequiredError,
} from './api/errors';
import { isMyHondaPlatformConfig, MyHondaPlatformConfig } from './configTypes';
import { asHondaClientLogger, VehicleAccessory, VehicleAccessoryOptions } from './accessories/vehicleAccessory';
import { redactVin } from './api/redact';
import { GIT_COMMIT } from './buildInfo';

const AUTH_RETRY_INTERVAL_MS = 5 * 60_000;

/**
 * Reads the installed package's own version at runtime — package.json ships
 * alongside dist/ regardless of how the plugin was installed, unlike the
 * git history GIT_COMMIT depends on (see buildInfo.ts), so this is read
 * fresh here rather than also being baked in at build time.
 */
function pluginVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

export class MyHondaPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly vehicleAccessories = new Map<string, VehicleAccessory>();
  private client?: HondaApiClient;
  private pollTimer?: ReturnType<typeof setInterval>;
  private readonly config?: MyHondaPlatformConfig;

  constructor(
    public readonly log: Logger,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    // Logged unconditionally, before config validation, so the exact build
    // running is identifiable from the log even when the config is broken —
    // several rapid fixes made it hard to tell which commit was actually
    // installed on a given Homebridge instance (see CHANGELOG 1.0.1).
    this.log.info('My Honda v%s initialising... (commit %s)', pluginVersion(), GIT_COMMIT);

    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    if (!isMyHondaPlatformConfig(config)) {
      this.log.error('Honda plugin is not configured: "email" and "password" are required in the plugin config.');
      this.config = undefined;
    } else {
      this.config = config;
    }

    this.api.on('didFinishLaunching', () => {
      if (this.config) {
        this.initialize(this.config).catch((err) => {
          this.log.error('Unexpected error during Honda plugin initialization: %s', (err as Error).message);
        });
      }
    });

    this.api.on('shutdown', () => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
      }
    });
  }

  /** Homebridge calls this once per cached accessory at startup, before didFinishLaunching. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug('Restoring cached accessory: %s', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  private async initialize(config: MyHondaPlatformConfig): Promise<void> {
    this.client = new HondaApiClient({
      email: config.email,
      password: config.password,
      locale: config.locale,
      storagePath: this.api.user.storagePath(),
      log: asHondaClientLogger(this.log),
    });

    const authenticated = await this.authenticate(this.client, config);
    if (!authenticated) {
      return;
    }

    await this.discoverVehicles(this.client, config);
    await this.pollOnce();

    const intervalSeconds = Math.max(
      config.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS,
      MIN_POLL_INTERVAL_SECONDS,
    );
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch((err) => this.log.error('Error while polling Honda for vehicle status: %s', (err as Error).message));
    }, intervalSeconds * 1000);
  }

  private async authenticate(client: HondaApiClient, config: MyHondaPlatformConfig): Promise<boolean> {
    if (await client.restoreSession()) {
      this.log.info('Restored existing Honda session from cache.');
      return true;
    }

    try {
      if (config.verificationLink) {
        this.log.info('Completing Honda device verification using the link from your configuration…');
        await client.completeDeviceVerification(config.verificationLink);
      } else {
        await client.login();
      }
      this.log.info('Signed in to My Honda+ successfully.');
      return true;
    } catch (err) {
      return this.handleAuthError(client, err);
    }
  }

  private async handleAuthError(client: HondaApiClient, err: unknown): Promise<boolean> {
    if (err instanceof HondaVerificationRequiredError) {
      this.log.warn(
        'This is the first time homebridge-myhonda has signed in with this device. ' +
        'Honda needs to verify it by email before remote access will work.',
      );
      try {
        await client.requestDeviceVerificationEmail();
        this.log.warn(
          'A verification email has been sent to your Honda account. Open it, copy the verification LINK ' +
          '(do not click it), and paste it into this plugin\'s "Verification Link" config field, then restart Homebridge.',
        );
      } catch (sendErr) {
        this.log.error('Could not request a Honda verification email: %s', (sendErr as Error).message);
      }
      this.scheduleAuthRetry();
      return false;
    }

    if (err instanceof HondaAccountLockedError) {
      this.log.error(err.message);
      this.scheduleAuthRetry();
      return false;
    }

    if (err instanceof HondaRateLimitError) {
      this.log.warn('Honda API rate-limited the sign-in attempt; will retry later.');
      this.scheduleAuthRetry();
      return false;
    }

    if (err instanceof HondaApiError) {
      this.log.error('Could not sign in to My Honda+: %s', err.message);
    } else {
      this.log.error('Unexpected error signing in to My Honda+: %s', (err as Error).message);
    }
    this.scheduleAuthRetry();
    return false;
  }

  private scheduleAuthRetry(): void {
    setTimeout(() => {
      if (!this.client || !this.config) {
        return;
      }
      this.authenticate(this.client, this.config)
        .then((ok) => {
          if (ok && this.client && this.config) {
            return this.discoverVehicles(this.client, this.config).then(() => this.pollOnce());
          }
          return undefined;
        })
        .catch((err) => this.log.error('Retry sign-in to Honda failed: %s', (err as Error).message));
    }, AUTH_RETRY_INTERVAL_MS);
  }

  private async discoverVehicles(client: HondaApiClient, config: MyHondaPlatformConfig): Promise<void> {
    let vehicles: Vehicle[];
    try {
      vehicles = await client.getVehicles();
    } catch (err) {
      this.log.error('Could not fetch vehicles from your Honda account: %s', (err as Error).message);
      return;
    }

    if (vehicles.length === 0) {
      this.log.warn('No vehicles were found on this Honda account.');
      return;
    }

    const seenUuids = new Set<string>();

    for (const vehicle of vehicles) {
      const uuid = this.api.hap.uuid.generate(vehicle.vin);
      seenUuids.add(uuid);
      const override = config.vehicles?.find((v) => v.vin === vehicle.vin);
      const displayName = override?.name || vehicle.nickname || `${vehicle.modelName} ${vehicle.modelYear}`.trim();

      let platformAccessory = this.accessories.get(uuid);
      if (!platformAccessory) {
        this.log.info('Adding new Honda vehicle: %s (VIN %s)', displayName, redactVin(vehicle.vin));
        platformAccessory = new this.api.platformAccessory(displayName, uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
        this.accessories.set(uuid, platformAccessory);
      } else {
        platformAccessory.displayName = displayName;
      }

      const existing = this.vehicleAccessories.get(vehicle.vin);
      if (existing) {
        existing.updateVehicle(vehicle);
        continue;
      }

      const options: VehicleAccessoryOptions = {
        enableClimateSwitch: config.enableClimateSwitch ?? true,
        enableChargeSwitch: config.enableChargeSwitch ?? true,
        enableHornSwitch: config.enableHornSwitch ?? true,
        enablePresenceSensor: config.enablePresenceSensor ?? true,
        wakeVehicleOnPoll: config.wakeVehicleOnPoll ?? false,
      };

      const vehicleAccessory = new VehicleAccessory(
        this.api,
        this.log,
        platformAccessory,
        vehicle,
        client,
        options,
        override,
      );
      this.vehicleAccessories.set(vehicle.vin, vehicleAccessory);
    }

    // Unregister accessories for vehicles no longer on the account.
    for (const [uuid, accessory] of this.accessories) {
      if (!seenUuids.has(uuid)) {
        this.log.info('Removing Honda accessory no longer on the account: %s', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.client) {
      return;
    }
    for (const [vin, accessory] of this.vehicleAccessories) {
      try {
        if (this.config?.wakeVehicleOnPoll) {
          await this.client.refreshDashboard(vin);
        }
        const status = await this.client.getDashboard(vin);
        accessory.applyStatus(status);
      } catch (err) {
        if (err instanceof HondaRateLimitError) {
          this.log.warn('Honda API rate limit hit while polling VIN %s; will try again next cycle.', redactVin(vin));
        } else {
          this.log.error('Failed to refresh status for VIN %s: %s', redactVin(vin), (err as Error).message);
        }
      }
    }
  }
}
