/**
 * Vehicle metadata and remote-command capability parsing.
 *
 * Honda reports a `vehicleCapability.capabilities` map per vehicle listing
 * every remote feature it knows about, each flagged "active" or
 * "notSupported" for that specific VIN/trim/subscription. The plugin uses
 * this to decide which HomeKit services to expose — e.g. a vehicle without
 * an active `telematicsRemoteClimate` entry never gets a climate switch,
 * so we never claim functionality Honda itself says isn't available.
 */

import { RawVehicleCapability, RawVehicleInfo } from './types';

/** Honda API capability keys we know how to act on, mapped to a friendly name. */
export const CAPABILITY_KEYS = {
  remoteLock: 'telematicsRemoteLockUnlock',
  remoteClimate: 'telematicsRemoteClimate',
  remoteCharge: 'telematicsRemoteCharge',
  remoteHorn: 'telematicsRemoteHorn',
  maxCharge: 'telematicsMaxChargeSettings',
  carFinder: 'telematicsRemoteCarFinder',
} as const;

export type CapabilityName = keyof typeof CAPABILITY_KEYS;

export class VehicleCapabilities {
  constructor(private readonly raw: Record<string, { featureStatus?: string }>) {}

  static fromApi(capability: RawVehicleCapability | undefined): VehicleCapabilities {
    return new VehicleCapabilities(capability?.capabilities ?? {});
  }

  has(name: CapabilityName): boolean {
    const apiKey = CAPABILITY_KEYS[name];
    return this.raw[apiKey]?.featureStatus === 'active';
  }

  /** All capability keys Honda reports as active, verbatim, for diagnostics/logging. */
  activeApiKeys(): string[] {
    return Object.entries(this.raw)
      .filter(([, entry]) => entry?.featureStatus === 'active')
      .map(([key]) => key)
      .sort();
  }
}

export interface Vehicle {
  vin: string;
  nickname: string;
  plate: string;
  modelName: string;
  modelYear: string;
  fuelType: string;
  capabilities: VehicleCapabilities;
}

export function parseVehicle(raw: RawVehicleInfo): Vehicle | undefined {
  if (!raw.vin) {
    return undefined;
  }
  return {
    vin: raw.vin,
    nickname: raw.vehicleNickName ?? '',
    plate: raw.vehicleRegNumber ?? '',
    modelName: raw.vehicleUIConfiguration?.friendlyModelName ?? 'Honda',
    modelYear: raw.modelYear !== undefined ? String(raw.modelYear) : '',
    fuelType: raw.fuelType ?? '',
    capabilities: VehicleCapabilities.fromApi(raw.vehicleCapability),
  };
}
