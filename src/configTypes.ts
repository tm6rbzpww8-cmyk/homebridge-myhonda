import { PlatformConfig } from 'homebridge';

export interface VehicleOverrideConfig {
  vin: string;
  name?: string;
  enableClimateSwitch?: boolean;
  enableChargeSwitch?: boolean;
  enableHornSwitch?: boolean;
  enablePresenceSensor?: boolean;
}

export interface MyHondaPlatformConfig extends PlatformConfig {
  email: string;
  password: string;
  verificationLink?: string;
  locale?: string;
  pollIntervalSeconds?: number;
  wakeVehicleOnPoll?: boolean;
  enableClimateSwitch?: boolean;
  enableChargeSwitch?: boolean;
  enableHornSwitch?: boolean;
  enablePresenceSensor?: boolean;
  vehicles?: VehicleOverrideConfig[];
}

export function isMyHondaPlatformConfig(config: PlatformConfig): config is MyHondaPlatformConfig {
  return typeof config.email === 'string' && typeof config.password === 'string';
}
