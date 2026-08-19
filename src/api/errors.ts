/**
 * Error hierarchy for the Honda Connect Europe ("My Honda+") API client.
 *
 * Kept separate from HomeKit code so callers (the platform/accessory layer)
 * can branch on error type without knowing anything about HTTP internals.
 */

export class HondaApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'HondaApiError';
  }
}

/** Authentication failed (bad credentials, expired/revoked refresh token, device not registered). */
export class HondaAuthError extends HondaApiError {
  constructor(message: string, statusCode?: number, body?: string) {
    super(message, statusCode, body);
    this.name = 'HondaAuthError';
  }
}

/** Login requires interactive email verification (magic link) before it can proceed. */
export class HondaVerificationRequiredError extends HondaAuthError {
  constructor(message = 'Honda requires email verification for this device. Check your inbox for a verification link from Honda and paste it into the plugin configuration.') {
    super(message);
    this.name = 'HondaVerificationRequiredError';
  }
}

/** The account is temporarily locked by Honda (too many failed attempts). */
export class HondaAccountLockedError extends HondaAuthError {
  constructor(message = 'Honda account is temporarily locked after too many failed sign-in attempts. Wait and try again later, or reset your password in the My Honda+ app.') {
    super(message);
    this.name = 'HondaAccountLockedError';
  }
}

/** Honda responded with HTTP 429 (or an equivalent throttling signal). */
export class HondaRateLimitError extends HondaApiError {
  constructor(message: string, public readonly retryAfterMs?: number) {
    super(message, 429);
    this.name = 'HondaRateLimitError';
  }
}

/** The vehicle did not respond in time (asleep / out of cellular coverage). */
export class HondaVehicleUnreachableError extends HondaApiError {
  constructor(message = 'Vehicle did not respond in time (it may be asleep or out of coverage).') {
    super(message);
    this.name = 'HondaVehicleUnreachableError';
  }
}

/** The requested action isn't supported by this vehicle/trim (per Honda's reported capabilities). */
export class HondaCapabilityError extends HondaApiError {
  constructor(message: string) {
    super(message);
    this.name = 'HondaCapabilityError';
  }
}
