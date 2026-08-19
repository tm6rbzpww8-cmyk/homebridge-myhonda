/**
 * Minimal logger contract used throughout the API layer, satisfied by both
 * Homebridge's real `Logger` (via accessories/vehicleAccessory.ts's
 * asHondaClientLogger) and plain test doubles. Kept in its own module (no
 * imports) so it can be shared by client.ts, auth.ts, and diagnostics.ts
 * without creating an import cycle between them.
 */
export interface HondaClientLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
