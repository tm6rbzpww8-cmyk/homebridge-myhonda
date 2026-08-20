import { Service, Characteristic, uuid, HapStatusError, HAPStatus } from 'hap-nodejs';
import { PlatformAccessory } from 'homebridge/lib/platformAccessory';
import type { API, Logger, PlatformConfig } from 'homebridge';

import { HondaVerificationRequiredError } from '../src/api/errors';
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings';
import packageJson from '../package.json';

jest.mock('../src/api/client');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HondaApiClient } = jest.requireMock('../src/api/client');

import { MyHondaPlatform } from '../src/platform';

function fakeLogger(): Logger {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() } as unknown as Logger;
}

function fakeApi() {
  const listeners: Record<string, Array<() => void>> = {};
  const registered: unknown[][] = [];
  const unregistered: unknown[][] = [];
  const api = {
    hap: {
      Service,
      Characteristic,
      uuid,
      HapStatusError,
      HAPStatus: {
        OPERATION_TIMED_OUT: HAPStatus.OPERATION_TIMED_OUT,
        RESOURCE_DOES_NOT_EXIST: HAPStatus.RESOURCE_DOES_NOT_EXIST,
        SERVICE_COMMUNICATION_FAILURE: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      },
    },
    user: { storagePath: () => '/tmp/homebridge-myhonda-test' },
    platformAccessory: PlatformAccessory,
    on: jest.fn((event: string, cb: () => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
    }),
    registerPlatformAccessories: jest.fn((...args: unknown[]) => registered.push(args)),
    unregisterPlatformAccessories: jest.fn((...args: unknown[]) => unregistered.push(args)),
    emit: async (event: string) => {
      for (const cb of listeners[event] ?? []) {
        await cb();
      }
    },
  };
  return { api: api as unknown as API, registered, unregistered };
}

const VALID_CONFIG: PlatformConfig = {
  platform: PLATFORM_NAME,
  name: 'My Honda',
  email: 'user@example.com',
  password: 'hunter2',
};

beforeEach(() => {
  HondaApiClient.mockReset();
});

describe('MyHondaPlatform config validation', () => {
  it('logs an error and does nothing further when email/password are missing', async () => {
    const log = fakeLogger();
    const { api } = fakeApi();
    new MyHondaPlatform(log, { platform: PLATFORM_NAME, name: 'My Honda' } as PlatformConfig, api);

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('is not configured'));
    expect(HondaApiClient).not.toHaveBeenCalled();
  });
});

describe('MyHondaPlatform startup diagnostic', () => {
  // Several rapid fixes made it hard to tell which commit was actually
  // running on a given Homebridge install — this log line is the fix:
  // every startup identifies the exact build, unconditionally, even before
  // config validation, so it appears regardless of whether the config
  // itself is valid.
  it('logs the plugin name, version, and commit unconditionally, before config validation', () => {
    const log = fakeLogger();
    const { api } = fakeApi();

    new MyHondaPlatform(log, { platform: PLATFORM_NAME, name: 'My Honda' } as PlatformConfig, api);

    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('My Honda v%s initialising'),
      packageJson.version,
      expect.any(String),
    );
  });
});

describe('MyHondaPlatform vehicle discovery', () => {
  it('registers a new platform accessory per discovered vehicle', async () => {
    const log = fakeLogger();
    const { api, registered } = fakeApi();

    HondaApiClient.mockImplementation(() => ({
      restoreSession: jest.fn().mockResolvedValue(true),
      getVehicles: jest.fn().mockResolvedValue([
        {
          vin: 'VIN123',
          nickname: 'My Honda e',
          plate: 'AB12CDE',
          modelName: 'Honda e',
          modelYear: '2020',
          fuelType: 'E',
          capabilities: { has: () => true, activeApiKeys: () => [] },
        },
      ]),
      getDashboard: jest.fn().mockResolvedValue({
        batteryLevelPercent: 80,
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
        odometer: 500,
        doorsLocked: true,
        allDoorsClosed: true,
        allWindowsClosed: true,
        ignitionOn: false,
        timeToFullChargeMinutes: 0,
        activeWarnings: [],
      }),
    }));

    const platform = new MyHondaPlatform(log, VALID_CONFIG, api);
    await (api as unknown as { emit: (e: string) => Promise<void> }).emit('didFinishLaunching');
    // allow the async initialize() chain (login -> discover -> poll) to settle
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(registered).toHaveLength(1);
    expect(registered[0][0]).toBe(PLUGIN_NAME);
    expect(registered[0][1]).toBe(PLATFORM_NAME);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Adding new Honda vehicle'), expect.anything(), expect.anything());

    if (typeof (platform as unknown as { pollTimer?: { unref?: () => void } }).pollTimer !== 'undefined') {
      clearInterval((platform as unknown as { pollTimer: ReturnType<typeof setInterval> }).pollTimer);
    }
  });

  it('reuses a cached accessory instead of registering a duplicate', async () => {
    const log = fakeLogger();
    const { api, registered } = fakeApi();
    const existingUuid = uuid.generate('VIN123');
    const existingAccessory = new PlatformAccessory('My Honda e', existingUuid);

    HondaApiClient.mockImplementation(() => ({
      restoreSession: jest.fn().mockResolvedValue(true),
      getVehicles: jest.fn().mockResolvedValue([
        {
          vin: 'VIN123',
          nickname: 'My Honda e',
          plate: '',
          modelName: 'Honda e',
          modelYear: '2020',
          fuelType: 'E',
          capabilities: { has: () => false, activeApiKeys: () => [] },
        },
      ]),
      getDashboard: jest.fn().mockResolvedValue({
        batteryLevelPercent: 80, rangeClimateOn: 0, rangeClimateOff: 0, totalRange: 0, distanceUnit: 'km',
        chargeStatus: 'stopped', plugStatus: 'disconnected', homeAway: 'home', chargeLimitHomePercent: 0,
        chargeLimitAwayPercent: 0, climateActive: false, odometer: 0, doorsLocked: true, allDoorsClosed: true,
        allWindowsClosed: true, ignitionOn: false, timeToFullChargeMinutes: 0, activeWarnings: [],
      }),
    }));

    const platform = new MyHondaPlatform(log, VALID_CONFIG, api);
    platform.configureAccessory(existingAccessory as unknown as import('homebridge').PlatformAccessory);

    await (api as unknown as { emit: (e: string) => Promise<void> }).emit('didFinishLaunching');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(registered).toHaveLength(0);

    if (typeof (platform as unknown as { pollTimer?: { unref?: () => void } }).pollTimer !== 'undefined') {
      clearInterval((platform as unknown as { pollTimer: ReturnType<typeof setInterval> }).pollTimer);
    }
  });
});

describe('MyHondaPlatform authentication', () => {
  it('requests a verification email and instructs the user when the device is unregistered', async () => {
    jest.useFakeTimers();
    try {
      const log = fakeLogger();
      const { api } = fakeApi();
      const requestDeviceVerificationEmail = jest.fn().mockResolvedValue(undefined);

      HondaApiClient.mockImplementation(() => ({
        restoreSession: jest.fn().mockResolvedValue(false),
        login: jest.fn().mockRejectedValue(new HondaVerificationRequiredError()),
        requestDeviceVerificationEmail,
        getVehicles: jest.fn(),
      }));

      new MyHondaPlatform(log, VALID_CONFIG, api);
      await (api as unknown as { emit: (e: string) => Promise<void> }).emit('didFinishLaunching');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(requestDeviceVerificationEmail).toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('verification email has been sent'));
    } finally {
      jest.useRealTimers();
    }
  });
});
