import { redactVin, redactVinInPath } from '../../src/api/redact';

describe('redactVin', () => {
  it('keeps only the last 4 characters of a real-length VIN', () => {
    expect(redactVin('SHHGE1234500001')).toBe('…0001');
  });

  it('masks a short value entirely rather than reveal it', () => {
    expect(redactVin('AB')).toBe('**');
  });

  it('returns an empty string for an empty input', () => {
    expect(redactVin('')).toBe('');
  });
});

describe('redactVinInPath', () => {
  it('redacts a vin query parameter while leaving the rest of the path intact', () => {
    const path = '/tsp/dashboard-latest?vin=SHHGE1234500001&languageCode=en';
    expect(redactVinInPath(path)).toBe('/tsp/dashboard-latest?vin=…0001&languageCode=en');
  });

  it('redacts a vin parameter that is not first in the query string', () => {
    const path = '/tsp/remote-lock?foo=bar&vin=SHHGE1234500001';
    expect(redactVinInPath(path)).toBe('/tsp/remote-lock?foo=bar&vin=…0001');
  });

  it('leaves a path with no vin parameter unchanged', () => {
    const path = '/user/get-login-info?userid=abc123&agreementType=1';
    expect(redactVinInPath(path)).toBe(path);
  });

  it('is case-insensitive for the vin= parameter name', () => {
    const path = '/tsp/dashboard-latest?VIN=SHHGE1234500001';
    expect(redactVinInPath(path)).toBe('/tsp/dashboard-latest?VIN=…0001');
  });
});
