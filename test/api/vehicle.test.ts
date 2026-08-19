import { parseVehicle, VehicleCapabilities } from '../../src/api/vehicle';

describe('VehicleCapabilities', () => {
  it('reports a capability active only when featureStatus is "active"', () => {
    const caps = VehicleCapabilities.fromApi({
      capabilities: {
        telematicsRemoteLockUnlock: { featureStatus: 'active' },
        telematicsRemoteClimate: { featureStatus: 'notSupported' },
      },
    });
    expect(caps.has('remoteLock')).toBe(true);
    expect(caps.has('remoteClimate')).toBe(false);
    expect(caps.has('remoteHorn')).toBe(false);
  });

  it('handles a missing capability map without throwing', () => {
    const caps = VehicleCapabilities.fromApi(undefined);
    expect(caps.has('remoteLock')).toBe(false);
    expect(caps.activeApiKeys()).toEqual([]);
  });

  it('lists active capability keys sorted', () => {
    const caps = VehicleCapabilities.fromApi({
      capabilities: {
        telematicsRemoteHorn: { featureStatus: 'active' },
        telematicsRemoteLockUnlock: { featureStatus: 'active' },
        digitalKey: { featureStatus: 'notSupported' },
      },
    });
    expect(caps.activeApiKeys()).toEqual(['telematicsRemoteHorn', 'telematicsRemoteLockUnlock']);
  });
});

describe('parseVehicle', () => {
  it('parses a Honda e vehicle listing', () => {
    const vehicle = parseVehicle({
      vin: 'SHHGE1234500001',
      vehicleNickName: 'My Honda e',
      vehicleRegNumber: 'AB12 CDE',
      fuelType: 'E',
      modelYear: 2020,
      vehicleUIConfiguration: { friendlyModelName: 'Honda e' },
      vehicleCapability: {
        capabilities: { telematicsRemoteLockUnlock: { featureStatus: 'active' } },
      },
    });

    expect(vehicle).toBeDefined();
    expect(vehicle?.vin).toBe('SHHGE1234500001');
    expect(vehicle?.nickname).toBe('My Honda e');
    expect(vehicle?.modelName).toBe('Honda e');
    expect(vehicle?.modelYear).toBe('2020');
    expect(vehicle?.fuelType).toBe('E');
    expect(vehicle?.capabilities.has('remoteLock')).toBe(true);
  });

  it('returns undefined for an entry without a VIN', () => {
    expect(parseVehicle({})).toBeUndefined();
  });

  it('falls back to "Honda" as the model name when Honda omits it', () => {
    const vehicle = parseVehicle({ vin: 'X' });
    expect(vehicle?.modelName).toBe('Honda');
  });
});
