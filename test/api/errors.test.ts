import {
  HondaApiError,
  HondaAuthError,
  HondaAccountLockedError,
  HondaVerificationRequiredError,
  HondaRateLimitError,
  HondaVehicleUnreachableError,
  HondaCapabilityError,
} from '../../src/api/errors';

describe('error hierarchy', () => {
  it('every Honda error is an instance of HondaApiError and Error', () => {
    const errors = [
      new HondaAuthError('x'),
      new HondaAccountLockedError(),
      new HondaVerificationRequiredError(),
      new HondaRateLimitError('x'),
      new HondaVehicleUnreachableError(),
      new HondaCapabilityError('x'),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(HondaApiError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('HondaVerificationRequiredError and HondaAccountLockedError are auth errors', () => {
    expect(new HondaVerificationRequiredError()).toBeInstanceOf(HondaAuthError);
    expect(new HondaAccountLockedError()).toBeInstanceOf(HondaAuthError);
  });

  it('HondaRateLimitError carries an optional retry-after hint', () => {
    const err = new HondaRateLimitError('slow down', 5000);
    expect(err.retryAfterMs).toBe(5000);
    expect(err.statusCode).toBe(429);
  });

  it('default messages are informative for end users', () => {
    expect(new HondaVerificationRequiredError().message).toMatch(/verif/i);
    expect(new HondaAccountLockedError().message).toMatch(/locked/i);
    expect(new HondaVehicleUnreachableError().message).toMatch(/respond/i);
  });
});
