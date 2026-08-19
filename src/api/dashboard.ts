/**
 * Parsing/normalization for Honda's `/tsp/dashboard-latest` response into a
 * stable, typed shape the HomeKit layer can consume without caring about
 * Honda's raw field names, unit aliases, or locale quirks.
 */

import { RawDashboardResponse } from './types';

export type ChargeStatus = 'charging' | 'stopped' | 'unknown';
export type PlugStatus = 'connected' | 'disconnected' | 'unknown';
export type HomeAway = 'home' | 'away' | 'unknown';
export type DistanceUnit = 'km' | 'miles';

export interface EvStatus {
  batteryLevelPercent: number;
  rangeClimateOn: number;
  rangeClimateOff: number;
  totalRange: number;
  distanceUnit: DistanceUnit;
  chargeStatus: ChargeStatus;
  plugStatus: PlugStatus;
  homeAway: HomeAway;
  chargeLimitHomePercent: number;
  chargeLimitAwayPercent: number;
  climateActive: boolean;
  cabinTempCelsius?: number;
  odometer: number;
  latitude?: number;
  longitude?: number;
  timestamp?: string;
  doorsLocked: boolean;
  allDoorsClosed: boolean;
  allWindowsClosed: boolean;
  ignitionOn: boolean;
  timeToFullChargeMinutes: number;
  activeWarnings: string[];
}

function toNumber(value: number | string | undefined, fallback = 0): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return Number.isFinite(n) ? n : fallback;
}

const DISTANCE_UNIT_ALIASES: Record<string, DistanceUnit> = {
  km: 'km',
  kms: 'km',
  kilometer: 'km',
  kilometers: 'km',
  kilometre: 'km',
  kilometres: 'km',
  mi: 'miles',
  mile: 'miles',
  miles: 'miles',
};

function normalizeDistanceUnit(raw: string | undefined, fallback: DistanceUnit = 'km'): DistanceUnit {
  if (!raw) {
    return fallback;
  }
  return DISTANCE_UNIT_ALIASES[raw.trim().toLowerCase()] ?? fallback;
}

const CHARGE_STATUS_MAP: Record<string, ChargeStatus> = {
  running: 'charging',
  stopped: 'stopped',
  unavailable: 'unknown',
  unknown: 'unknown',
};

function normalizeChargeStatus(raw: string | undefined): ChargeStatus {
  if (!raw) {
    return 'unknown';
  }
  return CHARGE_STATUS_MAP[raw.trim().toLowerCase()] ?? 'unknown';
}

function normalizePlugStatus(raw: string | undefined): PlugStatus {
  const key = (raw ?? '').trim().toLowerCase();
  if (key === 'connected' || key === 'plugged' || key === 'pluggedin' || key === 'plugin') {
    return 'connected';
  }
  if (key === 'disconnected' || key === 'unplugged' || key === 'notplugged') {
    return 'disconnected';
  }
  return 'unknown';
}

function normalizeHomeAway(raw: string | undefined): HomeAway {
  const key = (raw ?? '').trim().toLowerCase();
  return key === 'home' || key === 'away' ? key : 'unknown';
}

/**
 * Honda's DMS-with-commas coordinate strings look like "43,33,11.902" for
 * 43°33'11.902". Converts to signed decimal degrees.
 */
function dmsToDecimal(dms: string | undefined): number | undefined {
  if (!dms) {
    return undefined;
  }
  const parts = dms.split(',');
  if (parts.length !== 3) {
    const asFloat = parseFloat(dms);
    return Number.isFinite(asFloat) ? asFloat : undefined;
  }
  const [degStr, minStr, secStr] = parts;
  const deg = parseFloat(degStr);
  const min = parseFloat(minStr);
  const sec = parseFloat(secStr);
  if (!Number.isFinite(deg) || !Number.isFinite(min) || !Number.isFinite(sec)) {
    return undefined;
  }
  const sign = degStr.trim().startsWith('-') ? -1 : 1;
  return sign * (Math.abs(deg) + min / 60 + sec / 3600);
}

export function parseEvStatus(dashboard: RawDashboardResponse): EvStatus {
  const ev = dashboard.evStatus ?? {};
  const gps = dashboard.gpsData ?? {};
  const coord = gps.coordinate ?? {};
  const distanceUnit = normalizeDistanceUnit(ev.rangeUnit ?? dashboard.odometer?.unit);

  const doorEntries = Object.values(dashboard.doorStatus ?? {});
  const windowEntries = Object.values(dashboard.windowStatus ?? {});

  const doorsWithLockState = doorEntries.filter((d) => d.lockState !== undefined);
  const doorsLocked =
    doorsWithLockState.length > 0 && doorsWithLockState.every((d) => d.lockState === 'lock');

  const allDoorsClosed = doorEntries.length === 0 || doorEntries.every((d) => d.openState === 'closed');
  const allWindowsClosed =
    windowEntries.length === 0 || windowEntries.every((w) => w.closeState === 'closed');

  const activeWarnings = (dashboard.warningLamps?.messages ?? [])
    .filter((m) => m.condition === 'ON' && m.lampName)
    .map((m) => m.lampName as string);

  return {
    batteryLevelPercent: clampPercent(toNumber(ev.soc)),
    rangeClimateOn: toNumber(ev.evRange),
    rangeClimateOff: toNumber(ev.evRange) + toNumber(ev.evClimateOffRange),
    totalRange: toNumber(ev.totalRange),
    distanceUnit,
    chargeStatus: normalizeChargeStatus(ev.chargeStatus),
    plugStatus: normalizePlugStatus(ev.plugStatus),
    homeAway: normalizeHomeAway(ev.homeAway),
    chargeLimitHomePercent: toNumber(ev.chargeLimitHome),
    chargeLimitAwayPercent: toNumber(ev.chargeLimitAway),
    climateActive: dashboard.climateControl?.status?.isActive === true,
    cabinTempCelsius: toOptionalCelsius(dashboard.temperature?.cabin?.value, dashboard.temperature?.cabin?.unit),
    odometer: toNumber(dashboard.odometer?.value),
    latitude: dmsToDecimal(coord.latitude),
    longitude: dmsToDecimal(coord.longitude),
    timestamp: dashboard.timestamp,
    doorsLocked,
    allDoorsClosed,
    allWindowsClosed,
    ignitionOn: (ev.igStatus ?? '').toUpperCase() === 'ON',
    timeToFullChargeMinutes: toNumber(ev.timeToTargetSoc),
    activeWarnings,
  };
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function toOptionalCelsius(value: number | string | undefined, unit: string | undefined): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const n = toNumber(value, NaN);
  if (!Number.isFinite(n)) {
    return undefined;
  }
  if ((unit ?? '').toLowerCase().startsWith('f')) {
    return ((n - 32) * 5) / 9;
  }
  return n;
}

/** Converts a distance already expressed in `unit` into kilometres. */
export function toKilometres(value: number, unit: DistanceUnit): number {
  return unit === 'miles' ? value * 1.60934 : value;
}
