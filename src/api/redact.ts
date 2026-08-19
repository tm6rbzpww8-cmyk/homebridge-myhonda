/**
 * Redaction helpers so vehicle identifiers never appear in full in error
 * messages or Homebridge log output.
 *
 * A VIN is not a secret the way a password or access token is — it's
 * stamped on the vehicle's windscreen and registration documents — but
 * it's still account-identifying data this plugin has no operational need
 * to print in full. Logs and errors keep just enough (the last 4
 * characters) to let a user with multiple vehicles tell them apart.
 *
 * This intentionally does NOT touch the VIN used internally for HomeKit
 * accessory identity (the UUID derived from it, and the AccessoryInformation
 * SerialNumber characteristic) — those are required for the plugin to
 * function as a HomeKit accessory and are not log output.
 */

/** Masks all but the last 4 characters, e.g. "SHHGE1234500001" -> "…00001". */
export function redactVin(vin: string): string {
  if (!vin) {
    return '';
  }
  if (vin.length <= 4) {
    return '*'.repeat(vin.length);
  }
  return `…${vin.slice(-4)}`;
}

const VIN_QUERY_PARAM = /([?&]vin=)([^&]+)/gi;

/** Redacts a `vin=` query parameter value embedded in a request path, for safe inclusion in error messages/logs. */
export function redactVinInPath(path: string): string {
  return path.replace(VIN_QUERY_PARAM, (_match, prefix: string, value: string) => `${prefix}${redactVin(decodeSafely(value))}`);
}

function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
