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
 *   - Lock Mechanism (primary) → door lock status, lock/unlock if supported
 *   - Battery Service   → state of charge, charging state, low-battery flag
 *                         (linked to the Lock service, see below)
 *   - Contact Sensor    → charge cable connected/disconnected
 *   - Switch            → climate pre-conditioning on/off (if supported)
 *   - Switch            → charging on/off (if supported)
 *   - Switch (momentary) → horn & lights "find my car" (if supported)
 *   - Occupancy Sensor   → vehicle away-from-home presence
 *   - Temperature Sensor → cabin temperature (if reported)
 *
 * Naming: each service's Name characteristic is a short, self-contained
 * label ("Doors", "Climate", "Charging", ...) rather than being prefixed
 * with the vehicle's own name (the previous "<nickname> Doors" form).
 * HomeKit already associates every service with its parent accessory —
 * whose own name is the vehicle's nickname — so prefixing each service's
 * name with that same nickname makes it start with a redundant repeat of
 * text Home already shows for the accessory. In practice (confirmed
 * against real Apple Home renderings, not just spec-reading) that
 * redundant-prefix form is exactly what caused every tile to display as
 * just the vehicle's name instead of the intended "Doors" / "Climate" /
 * etc. — Apple doesn't publish the precise tile-labelling algorithm this
 * falls out of, but short, distinct, non-prefixed service names are the
 * documented HAP-compliant baseline (Characteristic.Name) and are what
 * every well-behaved multi-service Homebridge accessory uses.
 *
 * The Lock Mechanism is marked the accessory's *primary* service
 * (`setPrimaryService`) — the standard HAP mechanism for telling HomeKit
 * which service represents "the accessory" for icon/category purposes —
 * and the Battery service is *linked* to it (`addLinkedService`), the
 * documented HAP pattern for surfacing a battery indicator alongside the
 * service it powers (the same mechanism a battery-powered smart lock
 * uses). This is what makes charge % show as a badge on the Doors tile
 * rather than sitting in its own easy-to-miss row — Battery is not a
 * service Apple gives its own tile in the Home grid on its own.
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
    // The service HomeKit treats as "the accessory" for icon/category
    // purposes — locking/unlocking the vehicle is its most central control.
    lock.setPrimaryService(true);

    lock.getCharacteristic(this.Characteristic.LockCurrentState).onGet(() => this.lockCurrentState());
    lock.getCharacteristic(this.Characteristic.LockTargetState)
      .onGet(() => this.lockTargetState())
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

  /**
   * LockCurrentState has a 4th valid value, UNKNOWN (3), specifically for
   * "we don't yet know the real state" — used here before the first
   * successful dashboard poll.
   */
  private lockCurrentState(): number {
    if (!this.lastStatus) {
      return this.Characteristic.LockCurrentState.UNKNOWN;
    }
    return this.lastStatus.doorsLocked
      ? this.Characteristic.LockCurrentState.SECURED
      : this.Characteristic.LockCurrentState.UNSECURED;
  }

  /**
   * LockTargetState, unlike LockCurrentState, has no UNKNOWN value — HAP
   * defines it as strictly {UNSECURED: 0, SECURED: 1} (minValue 0,
   * maxValue 1). Reusing lockCurrentState()'s UNKNOWN (3) here — the
   * original bug — got rejected by HomeKit with "characteristic was
   * supplied illegal value: number 3 exceeded maximum of 1", logged the
   * moment Home queried this characteristic before the first status poll
   * had completed. Default to SECURED (the safer assumption for a
   * vehicle) until real data arrives; once it has, this always mirrors
   * the real doorsLocked state, same as lockCurrentState().
   */
  private lockTargetState(): number {
    if (!this.lastStatus) {
      return this.Characteristic.LockTargetState.SECURED;
    }
    return this.lastStatus.doorsLocked
      ? this.Characteristic.LockTargetState.SECURED
      : this.Characteristic.LockTargetState.UNSECURED;
  }

  private setupBatteryService(): void {
    const name = this.serviceName('Battery');
    const battery = this.accessory.getService(this.Service.Battery)
      ?? this.accessory.addService(this.Service.Battery, name);
    // Explicitly refresh Name on every construction, not just at creation:
    // an accessory cached from before this naming scheme (or any future
    // rename) would otherwise keep showing its old, already-persisted name
    // forever, since addService()'s name argument only takes effect when
    // the service doesn't already exist.
    battery.setCharacteristic(this.Characteristic.Name, name);
    battery.getCharacteristic(this.Characteristic.BatteryLevel).onGet(() => this.lastStatus?.batteryLevelPercent ?? 0);
    battery.getCharacteristic(this.Characteristic.ChargingState).onGet(() => this.chargingState());
    battery.getCharacteristic(this.Characteristic.StatusLowBattery).onGet(() =>
      (this.lastStatus?.batteryLevelPercent ?? 100) <= LOW_BATTERY_THRESHOLD_PERCENT
        ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
    this.service.battery = battery;

    // Link to the primary (Lock) service so the Home app can surface the
    // battery indicator alongside the Doors tile, the same documented HAP
    // pattern used for e.g. a battery-powered smart lock — Battery has no
    // tile of its own in the Home grid, so an unlinked Battery service is
    // easy to miss entirely.
    this.service.lock?.addLinkedService(battery);
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
    const name = this.serviceName('Charge Cable');
    const contact = this.accessory.getService(this.Service.ContactSensor)
      ?? this.accessory.addService(this.Service.ContactSensor, name);
    contact.setCharacteristic(this.Characteristic.Name, name);
    contact.getCharacteristic(this.Characteristic.ContactSensorState).onGet(() =>
      this.lastStatus?.plugStatus === 'connected'
        ? this.Characteristic.ContactSensorState.CONTACT_DETECTED
        : this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    );
    this.service.chargeCable = contact;
  }

  private setupClimateSwitch(): void {
    const name = this.serviceName('Climate');
    const sw = this.accessory.getServiceById(this.Service.Switch, 'climate')
      ?? this.accessory.addService(this.Service.Switch, name, 'climate');
    sw.setCharacteristic(this.Characteristic.Name, name);
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
    const name = this.serviceName('Charging');
    const sw = this.accessory.getServiceById(this.Service.Switch, 'charging')
      ?? this.accessory.addService(this.Service.Switch, name, 'charging');
    sw.setCharacteristic(this.Characteristic.Name, name);
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
    const name = this.serviceName('Find My Car');
    const sw = this.accessory.getServiceById(this.Service.Switch, 'horn')
      ?? this.accessory.addService(this.Service.Switch, name, 'horn');
    sw.setCharacteristic(this.Characteristic.Name, name);
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
    const name = this.serviceName('Away From Home');
    const sensor = this.accessory.getServiceById(this.Service.OccupancySensor, 'presence')
      ?? this.accessory.addService(this.Service.OccupancySensor, name, 'presence');
    sensor.setCharacteristic(this.Characteristic.Name, name);
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
    // Guard against a cached accessory that already has this service from a
    // previous run (this method is called lazily, from applyStatus(), so
    // this.service.temperature above is only populated once per instance —
    // it says nothing about whether the underlying HAP accessory already
    // has the service from before this VehicleAccessory was constructed).
    const name = this.serviceName('Cabin Temperature');
    const sensor = this.accessory.getServiceById(this.Service.TemperatureSensor, 'cabin-temp')
      ?? this.accessory.addService(this.Service.TemperatureSensor, name, 'cabin-temp');
    sensor.setCharacteristic(this.Characteristic.Name, name);
    sensor.getCharacteristic(this.Characteristic.CurrentTemperature).onGet(() => this.lastStatus?.cabinTempCelsius ?? 0);
    this.service.temperature = sensor;
    return sensor;
  }

  /**
   * Short, self-contained service label (e.g. "Doors", "Climate") — not
   * prefixed with the vehicle's name. See the class-level doc comment for
   * why: HomeKit already shows the accessory (vehicle) name for context,
   * and a redundant repeat of it in the service name is what caused every
   * tile to display as just the vehicle's name in the Home app.
   */
  private serviceName(label: string): string {
    return label;
  }

  /** Applies freshly fetched dashboard data to all HomeKit characteristics. */
  applyStatus(status: EvStatus): void {
    this.lastStatus = status;

    if (this.service.lock) {
      this.service.lock.updateCharacteristic(this.Characteristic.LockCurrentState, this.lockCurrentState());
      // Keep target in sync with reality on every poll too, not just after
      // a HomeKit-initiated lock/unlock — otherwise if the vehicle is
      // locked/unlocked by some other means (key fob, the Honda app
      // itself), Home would keep showing a stale target state.
      this.service.lock.updateCharacteristic(this.Characteristic.LockTargetState, this.lockTargetState());
    }

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
