/**
 * Maps a single Honda vehicle onto a HomeKit accessory.
 *
 * Service choices are deliberately conservative: only HomeKit service/
 * characteristic types Apple's Home app actually renders are used, and a
 * service is only added when either (a) Honda's dashboard reliably
 * reports the underlying data, or (b) Honda's own reported vehicle
 * capabilities say the remote command is supported. Nothing here invents
 * functionality the API doesn't provide.
 *
 *   - Lock Mechanism   → door lock status, and lock/unlock if supported
 *   - Battery Service   → state of charge, charging state, low-battery flag
 *   - Contact Sensor    → charge cable connected/disconnected
 *   - Switch            → climate pre-conditioning on/off (if supported)
 *   - Switch            → charging on/off (if supported)
 *   - Switch (momentary) → horn & lights "find my car" (if supported)
 *   - Occupancy Sensor   → vehicle away-from-home presence
 *   - Temperature Sensor → cabin temperature (if reported)
 */

import type { API, Characteristic, Logger, PlatformAccessory, Service } from 'homebridge';
import { HondaApiClient, CommandResult, HondaClientLogger } from '../api/client';
import { EvStatus } from '../api/dashboard';
import { Vehicle } from '../api/vehicle';
import { HondaApiError, HondaCapabilityError, HondaVehicleUnreachableError } from '../api/errors';
import { redactVin } from '../api/redact';
import { VehicleOverrideConfig } from '../configTypes';

export interface VehicleAccessoryOptions {
  enableClimateSwitch: boolean;
  enableChargeSwitch: boolean;
  enableHornSwitch: boolean;
  enablePresenceSensor: boolean;
  wakeVehicleOnPoll: boolean;
}

const LOW_BATTERY_THRESHOLD_PERCENT = 20;
const HORN_SWITCH_RESET_DELAY_MS = 1000;

function resolveOptions(base: VehicleAccessoryOptions, override?: VehicleOverrideConfig): VehicleAccessoryOptions {
  if (!override) {
    return base;
  }
  return {
    enableClimateSwitch: override.enableClimateSwitch ?? base.enableClimateSwitch,
    enableChargeSwitch: override.enableChargeSwitch ?? base.enableChargeSwitch,
    enableHornSwitch: override.enableHornSwitch ?? base.enableHornSwitch,
    enablePresenceSensor: override.enablePresenceSensor ?? base.enablePresenceSensor,
    wakeVehicleOnPoll: base.wakeVehicleOnPoll,
  };
}

export class VehicleAccessory {
  private readonly service: {
    lock?: Service;
    battery?: Service;
    chargeCable?: Service;
    climateSwitch?: Service;
    chargeSwitch?: Service;
    hornSwitch?: Service;
    presence?: Service;
    temperature?: Service;
  } = {};

  private readonly options: VehicleAccessoryOptions;
  private readonly isElectric: boolean;
  private lastStatus?: EvStatus;

  constructor(
    private readonly api: API,
    private readonly log: Logger,
    private readonly accessory: PlatformAccessory,
    private vehicle: Vehicle,
    private readonly client: HondaApiClient,
    baseOptions: VehicleAccessoryOptions,
    override: VehicleOverrideConfig | undefined,
  ) {
    this.options = resolveOptions(baseOptions, override);
    this.isElectric = vehicle.fuelType.toUpperCase() === 'E';

    this.setupAccessoryInformation();
    this.setupLockService();
    if (this.isElectric) {
      this.setupBatteryService();
      this.setupChargeCableService();
      if (this.options.enableChargeSwitch && vehicle.capabilities.has('remoteCharge')) {
        this.setupChargeSwitch();
      }
    }
    if (this.options.enableClimateSwitch && vehicle.capabilities.has('remoteClimate')) {
      this.setupClimateSwitch();
    }
    if (this.options.enableHornSwitch && vehicle.capabilities.has('remoteHorn')) {
      this.setupHornSwitch();
    }
    if (this.options.enablePresenceSensor) {
      this.setupPresenceSensor();
    }
  }

  get vin(): string {
    return this.vehicle.vin;
  }

  /**
   * Label used in log output: the vehicle's nickname when set, otherwise a
   * redacted VIN (last 4 characters only) — enough to tell multiple
   * vehicles apart in the log without printing the full VIN.
   */
  private get logLabel(): string {
    return this.vehicle.nickname || redactVin(this.vin);
  }

  /** Called when the platform re-fetches the vehicle list (e.g. capability changes after a Honda app update). */
  updateVehicle(vehicle: Vehicle): void {
    this.vehicle = vehicle;
  }

  private get Service() {
    return this.api.hap.Service;
  }

  private get Characteristic(): typeof Characteristic {
    return this.api.hap.Characteristic;
  }

  private setupAccessoryInformation(): void {
    const info = this.accessory.getService(this.Service.AccessoryInformation)
      ?? this.accessory.addService(this.Service.AccessoryInformation);
    info
      .setCharacteristic(this.Characteristic.Manufacturer, 'Honda')
      .setCharacteristic(this.Characteristic.Model, this.vehicle.modelName || 'Honda vehicle')
      .setCharacteristic(this.Characteristic.SerialNumber, this.vehicle.vin)
      .setCharacteristic(this.Characteristic.FirmwareRevision, this.pluginVersion());
  }

  private pluginVersion(): string {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return (require('../../package.json') as { version: string }).version;
    } catch {
      return '0.0.0';
    }
  }

  private setupLockService(): void {
    const name = this.serviceName('Doors');
    const lock = this.accessory.getService(this.Service.LockMechanism)
      ?? this.accessory.addService(this.Service.LockMechanism, name);
    lock.setCharacteristic(this.Characteristic.Name, name);

    lock.getCharacteristic(this.Characteristic.LockCurrentState).onGet(() => this.lockCurrentState());
    lock.getCharacteristic(this.Characteristic.LockTargetState)
      .onGet(() => this.lockCurrentState())
      .onSet(async (value) => {
        if (!this.vehicle.capabilities.has('remoteLock')) {
          throw this.notSupportedError();
        }
        const targetLocked = value === this.Characteristic.LockTargetState.SECURED;
        this.log.info('%s: %s doors', this.logLabel, targetLocked ? 'Locking' : 'Unlocking');
        try {
          const result = targetLocked
            ? await this.client.lockDoors(this.vin, this.vehicle)
            : await this.client.unlockDoors(this.vin, this.vehicle);
          this.assertCommandOk(result);
          lock.updateCharacteristic(
            this.Characteristic.LockCurrentState,
            targetLocked ? this.Characteristic.LockCurrentState.SECURED : this.Characteristic.LockCurrentState.UNSECURED,
          );
        } catch (err) {
          this.handleCommandError(err, 'lock/unlock');
        }
      });

    this.service.lock = lock;
  }

  private lockCurrentState(): number {
    if (!this.lastStatus) {
      return this.Characteristic.LockCurrentState.UNKNOWN;
    }
    return this.lastStatus.doorsLocked
      ? this.Characteristic.LockCurrentState.SECURED
      : this.Characteristic.LockCurrentState.UNSECURED;
  }

  private setupBatteryService(): void {
    const battery = this.accessory.getService(this.Service.Battery)
      ?? this.accessory.addService(this.Service.Battery, this.serviceName('Battery'));
    battery.getCharacteristic(this.Characteristic.BatteryLevel).onGet(() => this.lastStatus?.batteryLevelPercent ?? 0);
    battery.getCharacteristic(this.Characteristic.ChargingState).onGet(() => this.chargingState());
    battery.getCharacteristic(this.Characteristic.StatusLowBattery).onGet(() =>
      (this.lastStatus?.batteryLevelPercent ?? 100) <= LOW_BATTERY_THRESHOLD_PERCENT
        ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
    this.service.battery = battery;
  }

  private chargingState(): number {
    if (!this.lastStatus) {
      return this.Characteristic.ChargingState.NOT_CHARGEABLE;
    }
    return this.lastStatus.chargeStatus === 'charging'
      ? this.Characteristic.ChargingState.CHARGING
      : this.Characteristic.ChargingState.NOT_CHARGING;
  }

  private setupChargeCableService(): void {
    const contact = this.accessory.getService(this.Service.ContactSensor)
      ?? this.accessory.addService(this.Service.ContactSensor, this.serviceName('Charge Cable'));
    contact.getCharacteristic(this.Characteristic.ContactSensorState).onGet(() =>
      this.lastStatus?.plugStatus === 'connected'
        ? this.Characteristic.ContactSensorState.CONTACT_DETECTED
        : this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    );
    this.service.chargeCable = contact;
  }

  private setupClimateSwitch(): void {
    const sw = this.accessory.addService(this.Service.Switch, this.serviceName('Climate'), 'climate');
    sw.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.lastStatus?.climateActive ?? false)
      .onSet(async (value) => {
        this.log.info('%s: turning climate control %s', this.logLabel, value ? 'on' : 'off');
        try {
          const result = value
            ? await this.client.startClimate(this.vin, this.vehicle)
            : await this.client.stopClimate(this.vin, this.vehicle);
          this.assertCommandOk(result);
        } catch (err) {
          this.handleCommandError(err, 'climate control');
        }
      });
    this.service.climateSwitch = sw;
  }

  private setupChargeSwitch(): void {
    const sw = this.accessory.addService(this.Service.Switch, this.serviceName('Charging'), 'charging');
    sw.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.lastStatus?.chargeStatus === 'charging')
      .onSet(async (value) => {
        this.log.info('%s: turning charging %s', this.logLabel, value ? 'on' : 'off');
        try {
          const result = value
            ? await this.client.startCharging(this.vin, this.vehicle)
            : await this.client.stopCharging(this.vin, this.vehicle);
          this.assertCommandOk(result);
        } catch (err) {
          this.handleCommandError(err, 'charge control');
        }
      });
    this.service.chargeSwitch = sw;
  }

  private setupHornSwitch(): void {
    const sw = this.accessory.addService(this.Service.Switch, this.serviceName('Find My Car'), 'horn');
    const onCharacteristic = sw.getCharacteristic(this.Characteristic.On);
    onCharacteristic
      .onGet(() => false)
      .onSet(async (value) => {
        if (!value) {
          return;
        }
        this.log.info('%s: sounding horn & flashing lights', this.logLabel);
        try {
          const result = await this.client.honkAndFlash(this.vin, this.vehicle);
          this.assertCommandOk(result);
        } catch (err) {
          this.handleCommandError(err, 'horn & lights');
        } finally {
          setTimeout(() => onCharacteristic.updateValue(false), HORN_SWITCH_RESET_DELAY_MS);
        }
      });
    this.service.hornSwitch = sw;
  }

  private setupPresenceSensor(): void {
    const sensor = this.accessory.addService(
      this.Service.OccupancySensor,
      this.serviceName('Away From Home'),
      'presence',
    );
    sensor.getCharacteristic(this.Characteristic.OccupancyDetected).onGet(() =>
      this.lastStatus?.homeAway === 'away'
        ? this.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
        : this.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
    );
    this.service.presence = sensor;
  }

  private ensureTemperatureService(): Service {
    if (this.service.temperature) {
      return this.service.temperature;
    }
    const sensor = this.accessory.addService(
      this.Service.TemperatureSensor,
      this.serviceName('Cabin Temperature'),
      'cabin-temp',
    );
    sensor.getCharacteristic(this.Characteristic.CurrentTemperature).onGet(() => this.lastStatus?.cabinTempCelsius ?? 0);
    this.service.temperature = sensor;
    return sensor;
  }

  private serviceName(suffix: string): string {
    const base = this.vehicle.nickname || this.vehicle.modelName || 'Honda';
    return `${base} ${suffix}`;
  }

  /** Applies freshly fetched dashboard data to all HomeKit characteristics. */
  applyStatus(status: EvStatus): void {
    this.lastStatus = status;

    this.service.lock?.updateCharacteristic(this.Characteristic.LockCurrentState, this.lockCurrentState());

    if (this.service.battery) {
      this.service.battery.updateCharacteristic(this.Characteristic.BatteryLevel, status.batteryLevelPercent);
      this.service.battery.updateCharacteristic(this.Characteristic.ChargingState, this.chargingState());
      this.service.battery.updateCharacteristic(
        this.Characteristic.StatusLowBattery,
        status.batteryLevelPercent <= LOW_BATTERY_THRESHOLD_PERCENT
          ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );
    }

    this.service.chargeCable?.updateCharacteristic(
      this.Characteristic.ContactSensorState,
      status.plugStatus === 'connected'
        ? this.Characteristic.ContactSensorState.CONTACT_DETECTED
        : this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    );

    this.service.climateSwitch?.updateCharacteristic(this.Characteristic.On, status.climateActive);
    this.service.chargeSwitch?.updateCharacteristic(this.Characteristic.On, status.chargeStatus === 'charging');

    this.service.presence?.updateCharacteristic(
      this.Characteristic.OccupancyDetected,
      status.homeAway === 'away'
        ? this.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
        : this.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
    );

    if (status.cabinTempCelsius !== undefined) {
      this.ensureTemperatureService().updateCharacteristic(this.Characteristic.CurrentTemperature, status.cabinTempCelsius);
    }

    if (status.activeWarnings.length > 0) {
      this.log.warn('%s: active warning lamps: %s', this.logLabel, status.activeWarnings.join(', '));
    }

    this.log.debug(
      '%s: battery %d%%, range %dkm (climate on) / %dkm (climate off), charge=%s, plug=%s, doors %s',
      this.logLabel,
      status.batteryLevelPercent,
      status.rangeClimateOn,
      status.rangeClimateOff,
      status.chargeStatus,
      status.plugStatus,
      status.doorsLocked ? 'locked' : 'unlocked',
    );
  }

  private assertCommandOk(result: CommandResult): void {
    HondaApiClient.assertCommandSucceeded(result);
  }

  private notSupportedError(): Error {
    return new this.api.hap.HapStatusError(this.api.hap.HAPStatus.RESOURCE_DOES_NOT_EXIST);
  }

  private handleCommandError(err: unknown, action: string): never {
    if (err instanceof HondaVehicleUnreachableError) {
      this.log.warn('%s: %s command timed out — vehicle may be asleep or out of coverage', this.logLabel, action);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.OPERATION_TIMED_OUT);
    }
    if (err instanceof HondaCapabilityError) {
      this.log.warn('%s: %s is not supported on this vehicle', this.logLabel, action);
      throw this.notSupportedError();
    }
    if (err instanceof HondaApiError) {
      this.log.error('%s: %s failed: %s', this.logLabel, action, err.message);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    this.log.error('%s: unexpected error during %s: %s', this.logLabel, action, (err as Error).message);
    throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }
}

export function asHondaClientLogger(log: Logger): HondaClientLogger {
  return {
    debug: (message, ...args) => log.debug(message, ...args),
    info: (message, ...args) => log.info(message, ...args),
    warn: (message, ...args) => log.warn(message, ...args),
    error: (message, ...args) => log.error(message, ...args),
  };
}
