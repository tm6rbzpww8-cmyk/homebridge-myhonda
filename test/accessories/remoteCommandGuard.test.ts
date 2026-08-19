import { RemoteCommandGuard } from '../../src/accessories/remoteCommandGuard';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('RemoteCommandGuard', () => {
  it('runs the command for a new target', async () => {
    const guard = new RemoteCommandGuard<boolean>(1000);
    const command = jest.fn().mockResolvedValue(undefined);

    await guard.run(true, command);

    expect(command).toHaveBeenCalledTimes(1);
  });

  it('reuses the in-flight command for a duplicate target instead of running a second one', async () => {
    const guard = new RemoteCommandGuard<boolean>(1000);
    const { promise, resolve } = deferred<void>();
    const command = jest.fn().mockReturnValue(promise);

    const first = guard.run(true, command);
    const second = guard.run(true, command);

    resolve(undefined);
    await Promise.all([first, second]);

    expect(command).toHaveBeenCalledTimes(1);
  });

  it('runs a fresh command for a different target even while one is in flight', async () => {
    const guard = new RemoteCommandGuard<boolean>(1000);
    const { promise: onPromise, resolve: resolveOn } = deferred<void>();
    const onCommand = jest.fn().mockReturnValue(onPromise);
    const offCommand = jest.fn().mockResolvedValue(undefined);

    const onRun = guard.run(true, onCommand);
    await guard.run(false, offCommand);
    resolveOn(undefined);
    await onRun;

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(offCommand).toHaveBeenCalledTimes(1);
  });

  it('clears the in-flight marker once the command settles, so a later identical request runs again', async () => {
    const guard = new RemoteCommandGuard<boolean>(1000);
    const command = jest.fn().mockResolvedValue(undefined);

    await guard.run(true, command);
    await guard.run(true, command);

    expect(command).toHaveBeenCalledTimes(2);
  });

  it('does not record a failed command as desired, and clears in-flight on failure so a later request can retry', async () => {
    const guard = new RemoteCommandGuard<boolean>(1000);
    const command = jest.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    await expect(guard.run(true, command)).rejects.toThrow('boom');
    expect(guard.effective(false)).toBe(false); // failure never overrides polled data

    await guard.run(true, command);
    expect(command).toHaveBeenCalledTimes(2);
  });

  it('a duplicate request while a command is failing shares the same rejection, without a second Honda call', async () => {
    const guard = new RemoteCommandGuard<boolean>(1000);
    const { promise, reject } = deferred<void>();
    const command = jest.fn().mockReturnValue(promise);

    const first = guard.run(true, command);
    const second = guard.run(true, command);
    reject(new Error('timeout'));

    await expect(first).rejects.toThrow('timeout');
    await expect(second).rejects.toThrow('timeout');
    expect(command).toHaveBeenCalledTimes(1);
  });

  describe('effective()', () => {
    it('returns the polled value when no command has ever been confirmed', () => {
      const guard = new RemoteCommandGuard<boolean>(1000);
      expect(guard.effective(true)).toBe(true);
      expect(guard.effective(false)).toBe(false);
      expect(guard.effective(undefined)).toBeUndefined();
    });

    it('trusts the confirmed command over a contradicting poll within the settle window', async () => {
      const guard = new RemoteCommandGuard<boolean>(60_000);
      await guard.run(true, jest.fn().mockResolvedValue(undefined));

      expect(guard.effective(false)).toBe(true); // stale/contradicting poll
      expect(guard.effective(true)).toBe(true); // poll has caught up
    });

    it('falls back to polled data once the settle window has passed', async () => {
      const guard = new RemoteCommandGuard<boolean>(60_000);
      await guard.run(true, jest.fn().mockResolvedValue(undefined));

      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
      try {
        expect(guard.effective(false)).toBe(false);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('returns undefined when there is no polled data at all, regardless of a confirmed command', async () => {
      const guard = new RemoteCommandGuard<boolean>(60_000);
      await guard.run(true, jest.fn().mockResolvedValue(undefined));

      expect(guard.effective(undefined)).toBeUndefined();
    });
  });
});
