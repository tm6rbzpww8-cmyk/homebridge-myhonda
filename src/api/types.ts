/**
 * Wire types for the Honda Connect Europe ("My Honda+") mobile API.
 *
 * These interfaces describe the JSON shapes actually returned by
 * mobile-api.connected.honda-eu.com, reverse-engineered from observed
 * traffic. Honda does not publish an API contract, so fields are
 * intentionally optional/loose — unknown or missing fields must not crash
 * the plugin, they should just result in "unknown" values further up the
 * stack.
 */

export interface RawLoginTokens {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  personalId?: string;
  personal_id?: string;
  userId?: string;
}

export interface InitiateLoginResponse {
  transactionId: string;
  signatureChallenge: string;
}

export interface RefreshTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface AsyncCommandAccepted {
  statusQueryGetUri?: string;
}

export interface AsyncCommandStatusOutput {
  RequestStatus?: string;
  RequestId?: string;
  NotificationFeature?: string;
  StatusReason?: string;
  functionTimedOut?: boolean;
  Content?: string;
}

export interface AsyncCommandStatusResponse {
  output?: AsyncCommandStatusOutput;
}

export interface RawCapabilityEntry {
  featureStatus?: string;
}

export interface RawVehicleCapability {
  capabilities?: Record<string, RawCapabilityEntry>;
}

export interface RawSubscriptionServiceEntry {
  code?: string;
  description?: string;
}

export interface RawPackageInfoEntry {
  description?: string;
  billStatus?: string;
  packageType?: string;
  price?: number | string;
  currency1?: string;
  paymentTerm?: string;
  term?: number | string;
  trialTerm?: number | string;
  renewal?: boolean;
  startDate?: string;
  endDate?: string;
  nextPaymentDate?: string;
  services?: RawSubscriptionServiceEntry[];
}

export interface RawVehicleUiConfiguration {
  friendlyModelName?: string;
  hideWindowStatus?: boolean;
  hideRearDoorStatus?: boolean;
  shouldHideInternalTemperature?: boolean;
  shouldHideClimateSettingsButton?: boolean;
}

export interface RawVehicleInfo {
  vin?: string;
  vehicleNickName?: string;
  vehicleRegNumber?: string;
  role?: string;
  fuelType?: string;
  grade?: string;
  modelYear?: number | string;
  vehicleCategoryCode?: string;
  registrationDate?: string;
  dateProduction?: string;
  doors?: number | string;
  transmission?: string;
  weight?: number | string;
  countryCode?: string;
  vehicleFront34ImageUrl?: string;
  vehicleSideImageUrl?: string;
  vehicleUIConfiguration?: RawVehicleUiConfiguration;
  vehicleCapability?: RawVehicleCapability;
  packageInfo?: RawPackageInfoEntry[];
}

export interface RawUserInfoResponse {
  firstName?: string;
  lastName?: string;
  email?: string;
  vehiclesInfo?: RawVehicleInfo[];
}

export interface RawDoorEntry {
  lockState?: string;
  openState?: string;
}

export interface RawWindowEntry {
  closeState?: string;
}

export interface RawLightEntry {
  lightState?: string;
}

export interface RawWarningLampMessage {
  lampName?: string;
  condition?: string;
}

export interface RawEvStatus {
  soc?: number | string;
  evRange?: number | string;
  evClimateOffRange?: number | string;
  totalRange?: number | string;
  rangeUnit?: string;
  chargeStatus?: string;
  plugStatus?: string;
  homeAway?: string;
  chargeLimitHome?: number | string;
  chargeLimitAway?: number | string;
  intTemp?: number | string;
  igStatus?: string;
  chargeMode?: string;
  timeToTargetSoc?: number | string;
  acTempVal?: string;
  acDurationSetting?: number | string;
  acDefAutoSetting?: string;
}

export interface RawGpsCoordinate {
  latitude?: string;
  longitude?: string;
}

export interface RawGpsVelocity {
  value?: number | string;
  unit?: string;
}

export interface RawGpsData {
  coordinate?: RawGpsCoordinate;
  velocity?: RawGpsVelocity;
}

export interface RawDashboardResponse {
  timestamp?: string;
  evStatus?: RawEvStatus;
  gpsData?: RawGpsData;
  doorStatus?: Record<string, RawDoorEntry>;
  windowStatus?: Record<string, RawWindowEntry>;
  lightStatus?: Record<string, RawLightEntry>;
  climateControl?: { status?: { isActive?: boolean } };
  temperature?: { cabin?: { value?: number | string; unit?: string } };
  odometer?: { value?: number | string; unit?: string };
  warningLamps?: { messages?: RawWarningLampMessage[] };
}
