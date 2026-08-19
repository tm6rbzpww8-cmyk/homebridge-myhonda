import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('undici', () => ({ request: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { request: mockUndiciRequest } = jest.requireMock('undici') as { request: jest.Mock };

import { HondaApiClient, HondaClientLogger } from '../../src/api/client';
import { HondaCapabilityError, HondaVehicleUnreachableError } from '../../src/api/errors';
import { VehicleCapabilities } from '../../src/api/vehicle';

function jsonResponse(statusCode: number, body: unknown, headers: Record<string, string> = {}) {
  const raw = JSON.stringify(body);
  return {
    statusCode,
    headers,
    body: { text: async () => raw },
  };
}

function silentLogger(): HondaClientLogger {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function tempStoragePath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myhonda-test-'));
}

function queueResponses(map: Record<string, unknown>) {
  mockUndiciRequest.mockImplementation(async (url: string, opts: any) => {
    const method = opts?.method ?? 'GET';
    const u = new URL(url);
    const key = `${method} ${u.pathname}`;
    const entry = map[key];
    if (!entry) {
      throw new Error(`Unexpected request: ${key}`);
    }
    if (typeof entry === 'function') {
      return entry(u);
    }
    return entry;
  });
}

const CAPABLE_VEHICLE = {
  vin: 'VIN123',
  nickname: 'Test Honda e',
  plate: 'AB12CDE',
  modelName: 'Honda e',
  modelYear: '2020',
  fuelType: 'E',
  capabilities: VehicleCapabilities.fromApi({
    capabilities: {
      telematicsRemoteLockUnlock: { featureStatus: 'active' },
      telematicsRemoteClimate: { featureStatus: 'active' },
      telematicsRemoteCharge: { featureStatus: 'active' },
      telematicsRemoteHorn: { featureStatus: 'active' },
    },
  }),
};

const INCAPABLE_VEHICLE = {
  ...CAPABLE_VEHICLE,
  vin: 'VIN456',
  capabilities: VehicleCapabilities.fromApi({ capabilities: {} }),
};

beforeEach(() => {
  mockUndiciRequest.mockReset();
});

describe('HondaApiClient login + basic requests', () => {
  it('logs in and fetches vehicles', async () => {
    queueResponses({
      'POST /auth/initiate-login': jsonResponse(200, { transactionId: 't', signatureChallenge: 'c' }),
      'POST /auth/complete-login': jsonResponse(200, {
        access_token: 'access.' + Buffer.from(JSON.stringify({ sub: 'user-1' })).toString('base64') + '.sig',
        refresh_token: 'refresh-1',
        expires_in: 3600,
      }),
      'GET /user/get-login-info': jsonResponse(200, {
        vehiclesInfo: [
          { vin: 'VIN123', vehicleNickName: 'Test Honda e', fuelType: 'E', vehicleUIConfiguration: { friendlyModelName: 'Honda e' } },
        ],
      }),
    });

    const client = new HondaApiClient({
      email: 'user@example.com',
      password: 'hunter2',
      storagePath: tempStoragePath(),
      log: silentLogger(),
    });

    await client.login();
    expect(client.isAuthenticated).toBe(true);

    const vehicles = await client.getVehicles();
    expect(vehicles).toHaveLength(1);
    expect(vehicles[0].vin).toBe('VIN123');
  });

  it('captures personalId from get-login-info and sends it as x-app-personal-id on later requests', async () => {
    // The reference client (pymyhondaplus + its Home Assistant integration)
    // never gets personalId from the login/refresh token response — it's
    // only present on /user/get-login-info, and is required as the
    // x-app-personal-id header on subsequent authenticated requests.
    queueResponses({
      'POST /auth/initiate-login': jsonResponse(200, { transactionId: 't', signatureChallenge: 'c' }),
      'POST /auth/complete-login': jsonResponse(200, { access_token: 'a.b.c', refresh_token: 'r', expires_in: 3600 }),
      'GET /user/get-login-info': jsonResponse(200, { personalId: 'PID-789', vehiclesInfo: [] }),
      'GET /tsp/dashboard-latest': jsonResponse(200, { evStatus: { soc: '50' } }),
    });

    const client = new HondaApiClient({ email: 'user@example.com', password: 'p', storagePath: tempStoragePath(), log: silentLogger() });
    await client.login();
    await client.getVehicles();
    await client.getDashboard('VIN123');

    const dashboardCall = mockUndiciRequest.mock.calls.find(([url]: [string]) => url.includes('/tsp/dashboard-latest'));
    expect(dashboardCall?.[1]?.headers?.['x-app-personal-id']).toBe('PID-789');
  });

  it('does not send x-app-personal-id before it has been captured', async () => {
    queueResponses({
      'POST /auth/initiate-login': jsonResponse(200, { transactionId: 't', signatureChallenge: 'c' }),
      'POST /auth/complete-login': jsonResponse(200, { access_token: 'a.b.c', refresh_token: 'r', expires_in: 3600 }),
      'GET /tsp/dashboard-latest': jsonResponse(200, { evStatus: { soc: '50' } }),
    });

    const client = new HondaApiClient({ email: 'user@example.com', password: 'p', storagePath: tempStoragePath(), log: silentLogger() });
    await client.login();
    await client.getDashboard('VIN123');

    const dashboardCall = mockUndiciRequest.mock.calls.find(([url]: [string]) => url.includes('/tsp/dashboard-latest'));
    expect(dashboardCall?.[1]?.headers?.['x-app-personal-id']).toBeUndefined();
  });

  it('persists tokens across client instances (restoreSession)', async () => {
    const storagePath = tempStoragePath();
    queueResponses({
      'POST /auth/initiate-login': jsonResponse(200, { transactionId: 't', signatureChallenge: 'c' }),
      'POST /auth/complete-login': jsonResponse(200, {
        access_token: 'a.b.c',
        refresh_token: 'refresh-1',
        expires_in: 3600,
      }),
    });

    const client1 = new HondaApiClient({ email: 'user@example.com', password: 'p', storagePath, log: silentLogger() });
    await client1.login();

    const client2 = new HondaApiClient({ email: 'user@example.com', password: 'p', storagePath, log: silentLogger() });
    const restored = await client2.restoreSession();
    expect(restored).toBe(true);
    expect(client2.isAuthenticated).toBe(true);
  });

  it('refreshes the access token automatically on a 401 and retries once', async () => {
    const storagePath = tempStoragePath();
    let dashboardCallCount = 0;

    queueResponses({
      'POST /auth/initiate-login': jsonResponse(200, { transactionId: 't', signatureChallenge: 'c' }),
      'POST /auth/complete-login': jsonResponse(200, { access_token: 'expired-token', refresh_token: 'refresh-1', expires_in: 3600 }),
      'POST /auth/isv-prod/refresh': jsonResponse(200, { access_token: 'fresh-token', refresh_token: 'refresh-2', expires_in: 3600 }),
      'GET /tsp/dashboard-latest': () => {
        dashboardCallCount += 1;
        if (dashboardCallCount === 1) {
          return jsonResponse(401, { error: 'expired' });
        }
        return jsonResponse(200, { evStatus: { soc: '50' } });
      },
    });

    const client = new HondaApiClient({ email: 'user@example.com', password: 'p', storagePath, log: silentLogger() });
    await client.login();

    const status = await client.getDashboard('VIN123');
    expect(status.batteryLevelPercent).toBe(50);
    expect(dashboardCallCount).toBe(2);
  });
});

describe('HondaApiClient remote commands', () => {
  async function loggedInClient() {
    queueResponses({
      'POST /auth/initiate-login': jsonResponse(200, { transactionId: 't', signatureChallenge: 'c' }),
      'POST /auth/complete-login': jsonResponse(200, { access_token: 'a.b.c', refresh_token: 'r', expires_in: 3600 }),
    });
    const client = new HondaApiClient({ email: 'user@example.com', password: 'p', storagePath: tempStoragePath(), log: silentLogger() });
    await client.login();
    return client;
  }

  it('refuses to send a command the vehicle does not report as capable', async () => {
    const client = await loggedInClient();
    await expect(client.lockDoors(INCAPABLE_VEHICLE.vin, INCAPABLE_VEHICLE as any)).rejects.toBeInstanceOf(HondaCapabilityError);
    // No HTTP call should have been made for the lock command itself.
    expect(mockUndiciRequest).not.toHaveBeenCalledWith(expect.stringContaining('/tsp/remote-lock'), expect.anything());
  });

  it('locks doors and reports success once the command polls as successful', async () => {
    const client = await loggedInClient();
    queueResponses({
      'POST /auth/initiate-login': jsonResponse(200, {}),
      'POST /tsp/remote-lock': jsonResponse(202, { statusQueryGetUri: 'https://x/y?id=cmd-1' }),
      'GET /euw/tsp/async-command-status': jsonResponse(200, { output: { RequestStatus: 'success' } }),
    });

    const result = await client.lockDoors(CAPABLE_VEHICLE.vin, CAPABLE_VEHICLE as any);
    expect(result.outcome).toBe('success');
  });

  it('never includes the full VIN in an error message from a failed authenticated request', async () => {
    const client = await loggedInClient();
    queueResponses({
      'GET /tsp/dashboard-latest': jsonResponse(500, { error: 'boom' }),
    });

    let caught: Error | undefined;
    try {
      await client.getDashboard(CAPABLE_VEHICLE.vin);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).not.toContain(CAPABLE_VEHICLE.vin);
    expect(caught?.message).toContain('…N123'); // last 4 chars of VIN123, still identifiable
  });

  it('never includes the full VIN in an error message when Honda omits a command id', async () => {
    const client = await loggedInClient();
    queueResponses({
      'POST /tsp/remote-lock': jsonResponse(202, { statusQueryGetUri: 'https://x/y?nope=1' }),
    });

    let caught: Error | undefined;
    try {
      await client.lockDoors(CAPABLE_VEHICLE.vin, CAPABLE_VEHICLE as any);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).not.toContain(CAPABLE_VEHICLE.vin);
  });

  it('reports a timed-out command outcome when Honda flags functionTimedOut', async () => {
    const client = await loggedInClient();
    queueResponses({
      'POST /tsp/remote-climate': jsonResponse(202, { statusQueryGetUri: 'https://x/y?id=cmd-2' }),
      'GET /euw/tsp/async-command-status': jsonResponse(200, { output: { functionTimedOut: true, StatusReason: 'vehicle asleep' } }),
    });

    const result = await client.startClimate(CAPABLE_VEHICLE.vin, CAPABLE_VEHICLE as any);
    expect(result.outcome).toBe('timedOut');
    expect(() => HondaApiClient.assertCommandSucceeded(result)).toThrow(HondaVehicleUnreachableError);
  });

  it('reports a failed command outcome with the reason Honda provided', async () => {
    const client = await loggedInClient();
    queueResponses({
      'POST /tsp/remote-horn-light': jsonResponse(202, { statusQueryGetUri: 'https://x/y?id=cmd-3' }),
      'GET /euw/tsp/async-command-status': jsonResponse(200, { output: { RequestStatus: 'failed', StatusReason: 'nope' } }),
    });

    const result = await client.honkAndFlash(CAPABLE_VEHICLE.vin, CAPABLE_VEHICLE as any);
    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('nope');
  });
});
