import { Service, Characteristic, uuid, HapStatusError, HAPStatus } from 'hap-nodejs';
import { PlatformAccessory } from 'homebridge/lib/platformAccessory';
import type { API, Logger } from 'homebridge';

import { VehicleAccessory, VehicleAccessoryOptions } from '../../src/accessories/vehicleAccessory';
import { HondaApiClient, CommandResult } from '../../src/api/client';
import { Vehicle, VehicleCapabilities } from '../../src/api/vehicle';
import { EvStatus } from '../../src/api/dashboard';
import { HondaCapabilityError, HondaVehicleUnreachableError } from '../../src/api/errors';

function fakeApi(): API {
  return {
    hap: {
      Service,
      Characteristic,
      uuid,
      HapStatusError,
      // HAPStatus is declared as a TS `const enum` in hap-nodejs, so it can
      // only be referenced via member access, never as a bare value —
      // rebuild a plain object with just the members this plugin uses.
      HAPStatus: {
        OPERATION_TIMED_OUT: HAPStatus.OPERATION_TIMED_OUT,
        RESOURCE_DOES_NOT_EXIST: HAPStatus.RESOURCE_DOES_NOT_EXIST,
        SERVICE_COMMUNICATION_FAILURE: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      },
    },
  } as unknown as API;
}

function fakeLogger(): Logger {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() } as unknown as Logger;
}

function makeVehicle(overrides: Partial<Vehicle> = {}, capabilityKeys: string[] = []): Vehicle {
  const capabilities: Record<string, { featureStatus: string }> = {};
  for (const key of capabilityKeys) {
    capabilities[key] = { featureStatus: 'active' };
  }
  return {
    vin: 'VIN123',
    nickname: 'My Honda e',
    plate: 'AB12CDE',
    modelName: 'Honda e',
    modelYear: '2020',
    fuelType: 'E',
    capabilities: VehicleCapabilities.fromApi({ capabilities }),
    ...overrides,
  };
}

const FULL_OPTIONS: VehicleAccessoryOptions = {
  enableClimateSwitch: true,
  enableChargeSwitch: true,
  enableHornSwitch: true,
  enablePresenceSensor: true,
  wakeVehicleOnPoll: false,
};

const FULL_CAPS = [
  'telematicsRemoteLockUnlock',
  'telematicsRemoteClimate',
  'telematicsRemoteCharge',
  'telematicsRemoteHorn',
];

function evStatus(overrides: Partial<EvStatus> = {}): EvStatus {
  return {
    batteryLevelPercent: 60,
    rangeClimateOn: 100,
    rangeClimateOff: 110,
    totalRange: 100,
    distanceUnit: 'km',
    chargeStatus: 'stopped',
    plugStatus: 'disconnected',
    homeAway: 'home',
    chargeLimitHomePercent: 80,
    chargeLimitAwayPercent: 100,
    climateActive: false,
    odometer: 1000,
    doorsLocked: true,
    allDoorsClosed: true,
    allWindowsClosed: true,
    ignitionOn: false,
    timeToFullChargeMinutes: 0,
    activeWarnings: [],
    ...overrides,
  };
}

function fakeClient(overrides: Partial<Record<keyof HondaApiClient, jest.Mock>> = {}): HondaApiClient {
  const success: CommandResult = { outcome: 'success' };
  return {
    lockDoors: jest.fn().mockResolvedValue(success),
    unlockDoors: jest.fn().mockResolvedValue(success),
    startClimate: jest.fn().mockResolvedValue(success),
    stopClimate: jest.fn().mockResolvedValue(success),
    startCharging: jest.fn().mockResolvedValue(success),
    stopCharging: jest.fn().mockResolvedValue(success),
    honkAndFlash: jest.fn().mockResolvedValue(success),
    ...overrides,
  } as unknown as HondaApiClient;
}

function buildAccessory(
  vehicle: Vehicle,
  client: HondaApiClient,
  options: VehicleAccessoryOptions = FULL_OPTIONS,
  log: Logger = fakeLogger(),
) {
  const platformAccessory = new PlatformAccessory('Test Car', uuid.generate(vehicle.vin));
  const accessory = new VehicleAccessory(fakeApi(), log, platformAccessory as any, vehicle, client, options, undefined);
  return { platformAccessory, accessory, log };
}

/**
 * Constructs a *second* VehicleAccessory against an *already-populated*
 * PlatformAccessory — the same object a real Homebridge restart hands the
 * platform: configureAccessory() restores a cached accessory (services
 * already attached, exactly as persisted from the previous run), and the
 * platform then constructs a fresh VehicleAccessory instance wrapping it.
 * hap-nodejs's duplicate-service check operates purely on the accessory's
 * current .services array, so reusing the same in-memory object here is a
 * faithful reproduction of that restart scenario regardless of whether the
 * pre-existing services came from an actual disk round-trip.
 */
function rebuildAccessory(
  platformAccessory: PlatformAccessory,
  vehicle: Vehicle,
  client: HondaApiClient,
  options: VehicleAccessoryOptions = FULL_OPTIONS,
  log: Logger = fakeLogger(),
) {
  const accessory = new VehicleAccessory(fakeApi(), log, platformAccessory as any, vehicle, client, options, undefined);
  return { accessory, log };
}

/** Counts services grouped by "UUID:subtype" — a duplicate means more than one entry shares a key. */
function serviceCountsByUuidAndSubtype(platformAccessory: PlatformAccessory): Map<string, number> {
  const counts = new Map<string, number>();
  for (const svc of platformAccessory.services) {
    const key = `${svc.UUID}:${svc.subtype ?? ''}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

describe('VehicleAccessory service setup', () => {
  it('always adds a Lock Mechanism service', () => {
    const { platformAccessory } = buildAccessory(makeVehicle(), fakeClient());
    expect(platformAccessory.getService(Service.LockMechanism)).toBeDefined();
  });

  it('adds EV services (Battery, Contact Sensor) for an electric vehicle', () => {
    const { platformAccessory } = buildAccessory(makeVehicle({ fuelType: 'E' }), fakeClient());
    expect(platformAccessory.getService(Service.Battery)).toBeDefined();
    expect(platformAccessory.getService(Service.ContactSensor)).toBeDefined();
  });

  it('does not add EV services for a non-electric vehicle', () => {
    const { platformAccessory } = buildAccessory(makeVehicle({ fuelType: 'P' }), fakeClient());
    expect(platformAccessory.getService(Service.Battery)).toBeUndefined();
    expect(platformAccessory.getService(Service.ContactSensor)).toBeUndefined();
  });

  it('only adds the climate switch when the vehicle reports the capability', () => {
    const capable = buildAccessory(makeVehicle({}, ['telematicsRemoteClimate']), fakeClient());
    const incapable = buildAccessory(makeVehicle({ vin: 'VIN456' }, []), fakeClient());

    expect(capable.platformAccessory.getServiceById(Service.Switch, 'climate')).toBeDefined();
    expect(incapable.platformAccessory.getServiceById(Service.Switch, 'climate')).toBeUndefined();
  });

  it('respects enableChargeSwitch/enableHornSwitch/enablePresenceSensor options', () => {
    const options: VehicleAccessoryOptions = { ...FULL_OPTIONS, enableChargeSwitch: false, enableHornSwitch: false, enablePresenceSensor: false };
    const { platformAccessory } = buildAccessory(makeVehicle({}, FULL_CAPS), fakeClient(), options);

    expect(platformAccessory.getServiceById(Service.Switch, 'charging')).toBeUndefined();
    expect(platformAccessory.getServiceById(Service.Switch, 'horn')).toBeUndefined();
    expect(platformAccessory.getServiceById(Service.OccupancySensor, 'presence')).toBeUndefined();
  });

  it('sets accessory information from the vehicle', () => {
    const { platformAccessory } = buildAccessory(makeVehicle(), fakeClient());
    const info = platformAccessory.getService(Service.AccessoryInformation)!;
    expect(info.getCharacteristic(Characteristic.Manufacturer).value).toBe('Honda');
    expect(info.getCharacteristic(Characteristic.Model).value).toBe('Honda e');
    expect(info.getCharacteristic(Characteristic.SerialNumber).value).toBe('VIN123');
  });
});

describe('VehicleAccessory restart / cached-accessory reconstruction (regression for "Cannot add a Service with the same UUID")', () => {
  // Reported live: after a real Homebridge restart, Homebridge's own
  // configureAccessory() hands the platform a PlatformAccessory restored
  // from its on-disk cache — services already attached from the previous
  // run — before the platform constructs a fresh VehicleAccessory around
  // it. That reconstruction must not try to re-add services that already
  // exist on the accessory. rebuildAccessory() reproduces exactly that:
  // a second VehicleAccessory built against an already-populated accessory.

  it('does not throw when constructed a second time against an already-populated accessory (the reported crash)', () => {
    const { platformAccessory } = buildAccessory(makeVehicle({}, FULL_CAPS), fakeClient());

    expect(() => rebuildAccessory(platformAccessory, makeVehicle({}, FULL_CAPS), fakeClient())).not.toThrow();
  });

  it('every intended service exists exactly once after a simulated restart — no duplicate UUID/subtype pairs, for any service', () => {
    const { platformAccessory, accessory } = buildAccessory(makeVehicle({}, FULL_CAPS), fakeClient());
    // Populate the lazily-created Cabin Temperature sensor too, before the
    // "restart" — it's the one service added outside the constructor, via
    // applyStatus(), so it needs its own duplicate-on-reconstruction check.
    accessory.applyStatus(evStatus({ cabinTempCelsius: 20 }));

    rebuildAccessory(platformAccessory, makeVehicle({}, FULL_CAPS), fakeClient());

    const counts = serviceCountsByUuidAndSubtype(platformAccessory);
    for (const [key, count] of counts) {
      expect({ key, count }).toEqual({ key, count: 1 });
    }
    // Sanity: every expected service actually made it into the count at all
    // (a bug that silently dropped a service would also "pass" a bare
    // no-duplicates check).
    expect(counts.size).toBe(9); // AccessoryInformation, Lock, Battery, ContactSensor, 3 Switches, OccupancySensor, TemperatureSensor
  });

  it('specifically covers the Charging switch (subtype "charging") reported in the crash', () => {
    const { platformAccessory } = buildAccessory(makeVehicle({}, FULL_CAPS), fakeClient());
    rebuildAccessory(platformAccessory, makeVehicle({}, FULL_CAPS), fakeClient());

    const chargingServices = platformAccessory.services
      .filter((s) => s.UUID === Service.Switch.UUID && s.subtype === 'charging');
    expect(chargingServices).toHaveLength(1);
  });

  it('covers every other subtype-keyed service too: Climate, Find My Car, and Away From Home', () => {
    const { platformAccessory } = buildAccessory(makeVehicle({}, FULL_CAPS), fakeClient());
    rebuildAccessory(platformAccessory, makeVehicle({}, FULL_CAPS), fakeClient());

    expect(platformAccessory.getServiceById(Service.Switch, 'climate')).toBeDefined();
    expect(platformAccessory.getServiceById(Service.Switch, 'horn')).toBeDefined();
    expect(platformAccessory.getServiceById(Service.OccupancySensor, 'presence')).toBeDefined();
    for (const key of ['climate', 'horn']) {
      expect(platformAccessory.services
        .filter((s) => s.UUID === Service.Switch.UUID && s.subtype === key)).toHaveLength(1);
    }
    expect(platformAccessory.services
      .filter((s) => s.UUID === Service.OccupancySensor.UUID)).toHaveLength(1);
  });

  it('covers the non-subtype services too (Lock, Battery, Charge Cable) — no duplicates on reconstruction', () => {
    const { platformAccessory } = buildAccessory(makeVehicle({}, FULL_CAPS), fakeClient());
    rebuildAccessory(platformAccessory, makeVehicle({}, FULL_CAPS), fakeClient());

    for (const type of [Service.LockMechanism, Service.Battery, Service.ContactSensor]) {
      expect(platformAccessory.services.filter((s) => s.UUID === type.UUID)).toHaveLength(1);
    }
  });

  it('covers the lazily-added Cabin Temperature sensor: no duplicate if applyStatus runs again after reconstruction', () => {
    const { platformAccessory, accessory } = buildAccessory(makeVehicle({}, FULL_CAPS), fakeClient());
    accessory.applyStatus(evStatus({ cabinTempCelsius: 18 }));

    const { accessory: rebuiltAccessory } = rebuildAccessory(platformAccessory, makeVehicle({}, FULL_CAPS), fakeClient());
    expect(() => rebuiltAccessory.applyStatus(evStatus({ cabinTempCelsius: 19 }))).not.toThrow();

    const tempServices = platformAccessory.services
      .filter((s) => s.UUID === Service.TemperatureSensor.UUID);
    expect(tempServices).toHaveLength(1);
    expect(tempServices[0].getCharacteristic(Characteristic.CurrentTemperature).value).toBe(19);
  });

  it('refreshes each service Name on reconstruction, so a name-scheme change (e.g. 81b0ebc) takes effect on already-cached accessories', () => {
    const { platformAccessory } = buildAccessory(makeVehicle({}, FULL_CAPS), fakeClient());
    // Simulate an accessory that was cached under the OLD prefixed-name
    // scheme, before the reconstruction refreshes it.
    const lock = platformAccessory.getService(Service.LockMechanism)!;
    lock.updateCharacteristic(Characteristic.Name, 'Blue Honda e Doors');
    const chargeSwitch = platformAccessory.getServiceById(Service.Switch, 'charging')!;
    chargeSwitch.updateCharacteristic(Characteristic.Name, 'Blue Honda e Charging');

    rebuildAccessory(platformAccessory, makeVehicle({}, FULL_CAPS), fakeClient());

    expect(lock.getCharacteristic(Characteristic.Name).value).toBe('Doors');
    expect(chargeSwitch.getCharacteristic(Characteristic.Name).value).toBe('Charging');
  });

  it('reconstruction still marks Lock primary and keeps Battery linked to it, without duplicating the link', () => {
    const { platformAccessory } = buildAccessory(makeVehicle({}, FULL_CAPS), fakeClient());
    rebuildAccessory(platformAccessory, makeVehicle({}, FULL_CAPS), fakeClient());

    const lock = platformAccessory.getService(Service.LockMechanism)!;
    const battery = platformAccessory.getService(Service.Battery)!;
    expect(lock.isPrimaryService).toBe(true);
    expect(lock.linkedServices).toEqual([battery]);
  });
});

describe('VehicleAccessory Lock Current/Target State mapping (regression for "exceeded maximum of 1")', () => {
  // Reported live: "This plugin generated a warning from the characteristic
  // 'Lock Target State': characteristic was supplied illegal value: number 3
  // exceeded maximum of 1." That exact message is hap-nodejs's own
  // Characteristic.validateUserInput() text (see
  // node_modules/hap-nodejs/dist/lib/Characteristic.js), raised when the
  // real handleGetRequest() pipeline validates a get-handler's returned
  // value against the characteristic's declared min/maxValue. These tests
  // drive that real pipeline (not a hand-rolled range check) and listen for
  // hap-nodejs's own 'characteristic-warning' event, the same event
  // Homebridge surfaces as the logged warning.
  function collectWarnings(characteristic: Characteristic): string[] {
    const warnings: string[] = [];
    characteristic.on('characteristic-warning', (_type: string, message: string) => warnings.push(message));
    return warnings;
  }

  it('LockTargetState never emits a HAP warning before the first status poll (the reported bug)', async () => {
    const { platformAccessory } = buildAccessory(makeVehicle({}, FULL_CAPS), fakeClient());
    const lock = platformAccessory.getService(Service.LockMechanism)!;
    const targetChar = lock.getCharacteristic(Characteristic.LockTargetState);
    const warnings = collectWarnings(targetChar);

    const value = await targetChar.handleGetRequest();

    expect(warnings).toEqual([]);
    // LockTargetState's HAP-declared range is strictly [0, 1] (UNSECURED/SECURED) —
    // it has no UNKNOWN value, unlike LockCurrentState.
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
    expect(value).toBe(Characteristic.LockTargetState.SECURED);
  });

  it('LockCurrentState correctly reports UNKNOWN before the first status poll — valid for LockCurrentState, unlike LockTargetState', async () => {
    const { platformAccessory } = buildAccessory(makeVehicle({}, FULL_CAPS), fakeClient());
    const lock = platformAccessory.getService(Service.LockMechanism)!;
    const currentChar = lock.getCharacteristic(Characteristic.LockCurrentState);
    const warnings = collectWarnings(currentChar);

    const value = await currentChar.handleGetRequest();

    expect(warnings).toEqual([]);
    expect(value).toBe(Characteristic.LockCurrentState.UNKNOWN);
  });

  it('reports SECURED for both Current and Target state when Honda reports doorsLocked=true, with no HAP warnings', async () => {
    const { platformAccessory, accessory } = buildAccessory(makeVehicle({}, FULL_CAPS), fakeClient());
    accessory.applyStatus(evStatus({ doorsLocked: true }));

    const lock = platformAccessory.getService(Service.LockMechanism)!;
    const currentChar = lock.getCharacteristic(Characteristic.LockCurrentState);
    const targetChar = lock.getCharacteristic(Characteristic.LockTargetState);
    const warnings = [...collectWarnings(currentChar), ...collectWarnings(targetChar)];

    expect(await currentChar.handleGetRequest()).toBe(Characteristic.LockCurrentState.SECURED);
    expect(await targetChar.handleGetRequest()).toBe(Characteristic.LockTargetState.SECURED);
    expect(warnings).toEqual([]);
  });

  it('reports UNSECURED for both Current and Target state when Honda reports doorsLocked=false, with no HAP warnings', async () => {
    const { platformAccessory, accessory } = buildAccessory(makeVehicle({}, FULL_CAPS), fakeClient());
    accessory.applyStatus(evStatus({ doorsLocked: false }));

    const lock = platformAccessory.getService(Service.LockMechanism)!;
    const currentChar = lock.getCharacteristic(Characteristic.LockCurrentState);
    const targetChar = lock.getCharacteristic(Characteristic.LockTargetState);
    const warnings = [...collectWarnings(currentChar), ...collectWarnings(targetChar)];

    expect(await currentChar.handleGetRequest()).toBe(Characteristic.LockCurrentState.UNSECURED);
    expect(await targetChar.handleGetRequest()).toBe(Characteristic.LockTargetState.UNSECURED);
    expect(warnings).toEqual([]);
  });

  it('keeps LockTargetState in sync with reality on every poll, not just after a HomeKit-initiated command', () => {
    const { platformAccessory, accessory } = buildAccessory(makeVehicle({}, FULL_CAPS), fakeClient());
    const lock = platformAccessory.getService(Service.LockMechanism)!;

    accessory.applyStatus(evStatus({ doorsLocked: true }));
    expect(lock.getCharacteristic(Characteristic.LockTargetState).value).toBe(Characteristic.LockTargetState.SECURED);
    expect(lock.getCharacteristic(Characteristic.LockCurrentState).value).toBe(Characteristic.LockCurrentState.SECURED);

    // Simulate the vehicle being unlocked by some other means (key fob, the
    // Honda app itself) and picked up on the next poll — Target should
    // follow reality, not stay stuck on the last HomeKit-issued command.
    accessory.applyStatus(evStatus({ doorsLocked: false }));
    expect(lock.getCharacteristic(Characteristic.LockTargetState).value).toBe(Characteristic.LockTargetState.UNSECURED);
    expect(lock.getCharacteristic(Characteristic.LockCurrentState).value).toBe(Characteristic.LockCurrentState.UNSECURED);
  });
});

describe('VehicleAccessory HomeKit service naming', () => {
  // Regression coverage for the "every tile just shows the vehicle name"
  // issue: each service's Name characteristic must be a short, distinct
  // label — NOT prefixed with the vehicle's own nickname (the old
  // "<nickname> Doors" form) — because Apple's Home app collapses a
  // service's displayed label back to the accessory name when the
  // service's own name is just a repeat of it.
  it('constructs a full Honda EV accessory with every expected service, name, and subtype', () => {
    const { platformAccessory, accessory } = buildAccessory(
      makeVehicle({ nickname: 'Blue Honda e' }, FULL_CAPS),
      fakeClient(),
    );
    accessory.applyStatus(evStatus({ cabinTempCelsius: 19 }));

    const expectations: Array<{ service: typeof Service.LockMechanism; subtype?: string; name: string }> = [
      { service: Service.LockMechanism, name: 'Doors' },
      { service: Service.Battery, name: 'Battery' },
      { service: Service.ContactSensor, name: 'Charge Cable' },
      { service: Service.Switch, subtype: 'climate', name: 'Climate' },
      { service: Service.Switch, subtype: 'charging', name: 'Charging' },
      { service: Service.Switch, subtype: 'horn', name: 'Find My Car' },
      { service: Service.OccupancySensor, subtype: 'presence', name: 'Away From Home' },
      { service: Service.TemperatureSensor, subtype: 'cabin-temp', name: 'Cabin Temperature' },
    ];

    for (const { service: serviceType, subtype, name } of expectations) {
      const service = subtype
        ? platformAccessory.getServiceById(serviceType, subtype)
        : platformAccessory.getService(serviceType);
      expect(service).toBeDefined();
      expect(service!.getCharacteristic(Characteristic.Name).value).toBe(name);
      // None of these should ever start with the vehicle's nickname — that
      // redundant-prefix form is exactly the bug this test guards against.
      expect(service!.getCharacteristic(Characteristic.Name).value).not.toMatch(/^Blue Honda e/);
    }
  });

  it('does not prefix service names with the vehicle nickname, model, or "Honda"', () => {
    const { platformAccessory } = buildAccessory(makeVehicle({ nickname: 'My Honda e' }, FULL_CAPS), fakeClient());
    const lock = platformAccessory.getService(Service.LockMechanism)!;
    expect(lock.getCharacteristic(Characteristic.Name).value).toBe('Doors');
  });

  it('marks the Lock Mechanism (Doors) as the accessory primary service', () => {
    const { platformAccessory } = buildAccessory(makeVehicle({}, FULL_CAPS), fakeClient());
    const lock = platformAccessory.getService(Service.LockMechanism)!;
    expect(lock.isPrimaryService).toBe(true);
  });

  it('links the Battery service to the Lock Mechanism, so Home can show it on the Doors tile', () => {
    const { platformAccessory } = buildAccessory(makeVehicle({}, FULL_CAPS), fakeClient());
    const lock = platformAccessory.getService(Service.LockMechanism)!;
    const battery = platformAccessory.getService(Service.Battery)!;
    expect(lock.linkedServices).toContain(battery);
  });

  it('does not link Battery to Lock for a non-electric vehicle (no Battery service exists)', () => {
    const { platformAccessory } = buildAccessory(makeVehicle({ fuelType: 'P' }, FULL_CAPS), fakeClient());
    const lock = platformAccessory.getService(Service.LockMechanism)!;
    expect(lock.linkedServices).toEqual([]);
  });

  it('gives every Switch/sensor service a distinct HAP subtype so they persist as separate services', () => {
    const { platformAccessory, accessory } = buildAccessory(makeVehicle({}, FULL_CAPS), fakeClient());
    accessory.applyStatus(evStatus({ cabinTempCelsius: 20 }));

    expect(platformAccessory.getServiceById(Service.Switch, 'climate')).toBeDefined();
    expect(platformAccessory.getServiceById(Service.Switch, 'charging')).toBeDefined();
    expect(platformAccessory.getServiceById(Service.Switch, 'horn')).toBeDefined();
    expect(platformAccessory.getServiceById(Service.OccupancySensor, 'presence')).toBeDefined();
    expect(platformAccessory.getServiceById(Service.TemperatureSensor, 'cabin-temp')).toBeDefined();
  });
});

describe('VehicleAccessory applyStatus', () => {
  it('updates lock, battery, contact, switch and presence characteristics', () => {
    const { platformAccessory, accessory } = buildAccessory(makeVehicle({}, FULL_CAPS), fakeClient());

    accessory.applyStatus(evStatus({
      doorsLocked: false,
      batteryLevelPercent: 15,
      chargeStatus: 'charging',
      plugStatus: 'connected',
      climateActive: true,
      homeAway: 'away',
    }));

    const lock = platformAccessory.getService(Service.LockMechanism)!;
    expect(lock.getCharacteristic(Characteristic.LockCurrentState).value).toBe(Characteristic.LockCurrentState.UNSECURED);

    const battery = platformAccessory.getService(Service.Battery)!;
    expect(battery.getCharacteristic(Characteristic.BatteryLevel).value).toBe(15);
    expect(battery.getCharacteristic(Characteristic.ChargingState).value).toBe(Characteristic.ChargingState.CHARGING);
    expect(battery.getCharacteristic(Characteristic.StatusLowBattery).value).toBe(Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);

    const contact = platformAccessory.getService(Service.ContactSensor)!;
    expect(contact.getCharacteristic(Characteristic.ContactSensorState).value).toBe(Characteristic.ContactSensorState.CONTACT_DETECTED);

    const climateSwitch = platformAccessory.getServiceById(Service.Switch, 'climate')!;
    expect(climateSwitch.getCharacteristic(Characteristic.On).value).toBe(true);

    const presence = platformAccessory.getServiceById(Service.OccupancySensor, 'presence')!;
    expect(presence.getCharacteristic(Characteristic.OccupancyDetected).value).toBe(Characteristic.OccupancyDetected.OCCUPANCY_DETECTED);
  });

  it('adds a temperature sensor lazily once cabin temperature is known', () => {
    const { platformAccessory, accessory } = buildAccessory(makeVehicle({}, FULL_CAPS), fakeClient());
    expect(platformAccessory.getService(Service.TemperatureSensor)).toBeUndefined();

    accessory.applyStatus(evStatus({ cabinTempCelsius: 21 }));

    const sensor = platformAccessory.getService(Service.TemperatureSensor)!;
    expect(sensor).toBeDefined();
    expect(sensor.getCharacteristic(Characteristic.CurrentTemperature).value).toBe(21);
  });
});

describe('VehicleAccessory log redaction', () => {
  it('never logs the full VIN, falling back to a redacted VIN when no nickname is set', async () => {
    const client = fakeClient();
    const vehicleWithoutNickname = makeVehicle({ nickname: '', vin: 'SHHGE1234500001' }, FULL_CAPS);
    const { platformAccessory, log } = buildAccessory(vehicleWithoutNickname, client);
    const lock = platformAccessory.getService(Service.LockMechanism)!;

    await lock.getCharacteristic(Characteristic.LockTargetState).handleSetRequest(Characteristic.LockTargetState.SECURED, undefined as any);

    const allLoggedText = [...(log.info as jest.Mock).mock.calls, ...(log.warn as jest.Mock).mock.calls, ...(log.error as jest.Mock).mock.calls]
      .flat()
      .filter((arg): arg is string => typeof arg === 'string')
      .join('\n');

    expect(allLoggedText).not.toContain('SHHGE1234500001');
    expect(allLoggedText).toContain('…0001');
  });

  it('prefers the nickname over the VIN in logs when a nickname is set', async () => {
    const client = fakeClient();
    const { platformAccessory, log } = buildAccessory(makeVehicle({ nickname: 'My Honda e', vin: 'SHHGE1234500001' }, FULL_CAPS), client);
    const lock = platformAccessory.getService(Service.LockMechanism)!;

    await lock.getCharacteristic(Characteristic.LockTargetState).handleSetRequest(Characteristic.LockTargetState.SECURED, undefined as any);

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('%s'), 'My Honda e', expect.anything());
  });
});

describe('VehicleAccessory command handling', () => {
  it('locks the vehicle when LockTargetState is set to SECURED', async () => {
    const client = fakeClient();
    const { platformAccessory } = buildAccessory(makeVehicle({}, FULL_CAPS), client);
    const lock = platformAccessory.getService(Service.LockMechanism)!;

    await lock.getCharacteristic(Characteristic.LockTargetState).handleSetRequest(Characteristic.LockTargetState.SECURED, undefined as any);

    expect(client.lockDoors).toHaveBeenCalledWith('VIN123', expect.anything());
  });

  it('unlocks the vehicle when LockTargetState is set to UNSECURED', async () => {
    const client = fakeClient();
    const { platformAccessory } = buildAccessory(makeVehicle({}, FULL_CAPS), client);
    const lock = platformAccessory.getService(Service.LockMechanism)!;

    await lock.getCharacteristic(Characteristic.LockTargetState).handleSetRequest(Characteristic.LockTargetState.UNSECURED, undefined as any);

    expect(client.unlockDoors).toHaveBeenCalledWith('VIN123', expect.anything());
  });

  it('rejects with RESOURCE_DOES_NOT_EXIST when locking is not supported', async () => {
    const client = fakeClient();
    const { platformAccessory } = buildAccessory(makeVehicle({}, []), client);
    const lock = platformAccessory.getService(Service.LockMechanism)!;

    // hap-nodejs's characteristic set pipeline rejects with the raw HAPStatus
    // numeric code (not the HapStatusError instance) once it catches the
    // error thrown from the onSet handler — see Characteristic.js.
    await expect(
      lock.getCharacteristic(Characteristic.LockTargetState).handleSetRequest(Characteristic.LockTargetState.SECURED, undefined as any),
    ).rejects.toBe(HAPStatus.RESOURCE_DOES_NOT_EXIST);
    expect(client.lockDoors).not.toHaveBeenCalled();
  });

  it('translates a capability error from the API layer into RESOURCE_DOES_NOT_EXIST', async () => {
    const client = fakeClient({ startClimate: jest.fn().mockRejectedValue(new HondaCapabilityError('nope')) });
    const { platformAccessory } = buildAccessory(makeVehicle({}, FULL_CAPS), client);
    const sw = platformAccessory.getServiceById(Service.Switch, 'climate')!;

    await expect(sw.getCharacteristic(Characteristic.On).handleSetRequest(true, undefined as any)).rejects.toBe(
      HAPStatus.RESOURCE_DOES_NOT_EXIST,
    );
  });

  it('translates a vehicle-unreachable error into OPERATION_TIMED_OUT', async () => {
    const client = fakeClient({ startClimate: jest.fn().mockRejectedValue(new HondaVehicleUnreachableError()) });
    const { platformAccessory } = buildAccessory(makeVehicle({}, FULL_CAPS), client);
    const sw = platformAccessory.getServiceById(Service.Switch, 'climate')!;

    await expect(sw.getCharacteristic(Characteristic.On).handleSetRequest(true, undefined as any)).rejects.toBe(
      HAPStatus.OPERATION_TIMED_OUT,
    );
  });

  it('resets the horn switch back to off shortly after triggering', async () => {
    jest.useFakeTimers();
    try {
      const client = fakeClient();
      const { platformAccessory } = buildAccessory(makeVehicle({}, FULL_CAPS), client);
      const sw = platformAccessory.getServiceById(Service.Switch, 'horn')!;
      const onCharacteristic = sw.getCharacteristic(Characteristic.On);

      const updates: unknown[] = [];
      onCharacteristic.on('change', (change) => updates.push(change.newValue));

      await onCharacteristic.handleSetRequest(true, undefined as any);
      expect(client.honkAndFlash).toHaveBeenCalled();

      jest.advanceTimersByTime(1500);
      expect(onCharacteristic.value).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});
