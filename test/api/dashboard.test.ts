import { parseEvStatus } from '../../src/api/dashboard';
import { RawDashboardResponse } from '../../src/api/types';

describe('parseEvStatus', () => {
  it('parses a realistic Honda e dashboard payload', () => {
    const raw: RawDashboardResponse = {
      timestamp: '2026-08-18T10:00:00.000Z',
      evStatus: {
        soc: '72',
        evRange: '120',
        evClimateOffRange: '15',
        totalRange: '120',
        rangeUnit: 'km',
        chargeStatus: 'running',
        plugStatus: 'connected',
        homeAway: 'Home',
        chargeLimitHome: '80',
        chargeLimitAway: '100',
        intTemp: '21',
        igStatus: 'OFF',
        chargeMode: 'normal',
        timeToTargetSoc: '95',
      },
      gpsData: {
        coordinate: { latitude: '51,30,0', longitude: '-0,7,0' },
        velocity: { value: '0', unit: 'kph' },
      },
      doorStatus: {
        driver: { lockState: 'lock', openState: 'closed' },
        passenger: { lockState: 'lock', openState: 'closed' },
      },
      windowStatus: {
        driver: { closeState: 'closed' },
      },
      climateControl: { status: { isActive: false } },
      temperature: { cabin: { value: '19', unit: 'c' } },
      odometer: { value: '12345', unit: 'km' },
      warningLamps: { messages: [{ lampName: 'tyre-pressure', condition: 'ON' }, { lampName: 'oil', condition: 'OFF' }] },
    };

    const status = parseEvStatus(raw);

    expect(status.batteryLevelPercent).toBe(72);
    expect(status.rangeClimateOn).toBe(120);
    expect(status.rangeClimateOff).toBe(135);
    expect(status.distanceUnit).toBe('km');
    expect(status.chargeStatus).toBe('charging');
    expect(status.plugStatus).toBe('connected');
    expect(status.homeAway).toBe('home');
    expect(status.chargeLimitHomePercent).toBe(80);
    expect(status.climateActive).toBe(false);
    expect(status.cabinTempCelsius).toBe(19);
    expect(status.odometer).toBe(12345);
    expect(status.doorsLocked).toBe(true);
    expect(status.allDoorsClosed).toBe(true);
    expect(status.allWindowsClosed).toBe(true);
    expect(status.ignitionOn).toBe(false);
    expect(status.activeWarnings).toEqual(['tyre-pressure']);
    expect(status.latitude).toBeCloseTo(51.5, 5);
    expect(status.longitude).toBeCloseTo(-0.1167, 3);
  });

  it('normalizes UK-style "mile" distance unit alias to "miles"', () => {
    const status = parseEvStatus({ evStatus: { rangeUnit: 'mile' } });
    expect(status.distanceUnit).toBe('miles');
  });

  it('treats an unlocked door as unlocked even if others are locked', () => {
    const status = parseEvStatus({
      doorStatus: {
        driver: { lockState: 'unlock' },
        passenger: { lockState: 'lock' },
      },
    });
    expect(status.doorsLocked).toBe(false);
  });

  it('defaults doorsLocked to false when no lock state is present at all', () => {
    const status = parseEvStatus({ doorStatus: {} });
    expect(status.doorsLocked).toBe(false);
  });

  it('handles missing evStatus/gpsData/doorStatus gracefully with sane defaults', () => {
    const status = parseEvStatus({});
    expect(status.batteryLevelPercent).toBe(0);
    expect(status.chargeStatus).toBe('unknown');
    expect(status.plugStatus).toBe('unknown');
    expect(status.homeAway).toBe('unknown');
    expect(status.doorsLocked).toBe(false);
    expect(status.allDoorsClosed).toBe(true);
    expect(status.latitude).toBeUndefined();
    expect(status.cabinTempCelsius).toBeUndefined();
  });

  it('clamps an out-of-range battery percentage', () => {
    expect(parseEvStatus({ evStatus: { soc: '150' } }).batteryLevelPercent).toBe(100);
    expect(parseEvStatus({ evStatus: { soc: '-5' } }).batteryLevelPercent).toBe(0);
  });

  it('converts Fahrenheit cabin temperature to Celsius', () => {
    const status = parseEvStatus({ temperature: { cabin: { value: '68', unit: 'f' } } });
    expect(status.cabinTempCelsius).toBeCloseTo(20, 1);
  });

  it('treats an unrecognized chargeStatus value as unknown rather than throwing', () => {
    const status = parseEvStatus({ evStatus: { chargeStatus: 'somethingNew' } });
    expect(status.chargeStatus).toBe('unknown');
  });
});
