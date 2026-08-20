/**
 * Reusable state model for every writable HomeKit control that maps onto a
 * Honda remote command (lock/unlock, climate on/off, charging on/off, the
 * horn/lights trigger, ...).
 *
 * Every one of those controls must follow the same request lifecycle:
 *
 *   HomeKit request -> send ONE Honda command -> mark command in flight ->
 *   wait for the result -> update HomeKit state -> clear command in flight
 *
 * and a routine status poll must never be mistaken for a new HomeKit
 * command. Two real, independently-reported failure modes on live hardware
 * both trace back to that lifecycle not being enforced:
 *
 *  - A HomeKit controller that doesn't see a write acknowledged quickly
 *    enough (Honda's own commands can legitimately take several seconds to
 *    tens of seconds — see client.ts's waitForCommand) may resend the same
 *    write. If that resend arrives *while the first command is still in
 *    flight*, de-duplicating against the in-flight promise (below) is
 *    enough. But if Honda's command has already settled — in particular,
 *    timed out, which is exactly what happens when the vehicle is asleep —
 *    by the time the resend arrives, there is nothing "in flight" to
 *    de-duplicate against, and a naive guard dispatches a second, fully
 *    independent Honda command. Live hardware showed this precisely: six
 *    "turning climate control on" commands roughly 20-25 seconds apart —
 *    not concurrent, but each one landing just after the previous one had
 *    already timed out and cleared. This class also guards against *that*:
 *    a command that failed for a given target within the settle window is
 *    remembered, and an identical retry for that same target during the
 *    window reuses the cached failure instead of dispatching Honda again.
 *  - Honda's dashboard cache (read by routine polling, client.ts's
 *    getDashboard) is a separate, slower-updating path than a command's own
 *    completion confirmation. A poll landing in that lag window reads back
 *    the pre-command state and, if pushed straight into a HomeKit
 *    characteristic, looks like an unsolicited external contradiction —
 *    which a HomeKit controller can "correct" by re-issuing the opposite
 *    command, producing a self-sustaining oscillation with no further
 *    HomeKit tap involved.
 *
 * This class is the one place that lifecycle is implemented, so every
 * writable control gets the same protection instead of it being
 * re-invented (and potentially re-broken, or only partially applied) once
 * per service.
 */

/** Minimal logging surface this class needs — satisfied by Homebridge's own Logger. */
export interface RemoteCommandGuardLogger {
  debug(message: string, ...parameters: unknown[]): void;
}

export class RemoteCommandGuard<T> {
  private inFlight?: { target: T; promise: Promise<void> };
  private desired?: T;
  private desiredAt = 0;
  /** The most recent failure for a given target, so an identical retry within the settle window doesn't hit Honda again — see the class doc comment. */
  private lastFailure?: { target: T; at: number; error: unknown };
  private nextRequestId = 1;

  /**
   * @param settleMs Governs two related things: (1) how long a confirmed
   *   command's outcome is trusted over a status poll that reports
   *   something else (`effective()`), and (2) how long a failed command's
   *   outcome is trusted enough to short-circuit an identical retry instead
   *   of re-dispatching to Honda. One knob, not two, because both exist for
   *   the same reason — Honda's own state (whether success or failure)
   *   settles on a timescale slower than HomeKit's own retry cadence.
   * @param log Optional diagnostic logger (Homebridge's own `Logger` works)
   *   — every `run()` call emits a `debug`-level trace of the decision it
   *   made (deduplicated / short-circuited / dispatched) and why, gated
   *   behind Homebridge's debug/verbose logging so it is silent in normal
   *   operation.
   * @param label Short name for this guard used in its own diagnostic
   *   lines (e.g. "climate", "lock") so logs from several guards on the
   *   same accessory are easy to tell apart.
   */
  constructor(
    private readonly settleMs: number,
    private readonly log?: RemoteCommandGuardLogger,
    private readonly label = 'command',
  ) {}

  private debug(message: string, ...parameters: unknown[]): void {
    this.log?.debug(`[RemoteCommandGuard:${this.label}] ${message}`, ...parameters);
  }

  /**
   * Sends `target` to Honda via `command`, unless:
   *  - a command for the exact same target is already in flight, in which
   *    case that command's own outcome is reused, or
   *  - `target` is already the confirmed/desired value within the settle
   *    window, in which case there is nothing to do, or
   *  - `target` most recently *failed* within the settle window, in which
   *    case that same failure is re-thrown without a new Honda call.
   *
   * A duplicate/retried HomeKit write for what was really a single tap
   * never becomes a second Honda command, whether the duplicate arrives
   * while the first is still running or after it has already settled.
   *
   * On success, `target` becomes the desired value `effective()` trusts
   * over a conflicting poll for `settleMs`, and any prior failure record is
   * cleared. On failure (including a timeout), the failure is recorded
   * (see above) but nothing is treated as confirmed — a subsequent poll's
   * own data is trusted immediately by `effective()`, so a failed command
   * can never leave HomeKit stuck showing the state that failed to be
   * reached. Either way, the in-flight marker is always cleared once the
   * command settles — this guard only ever reacts to an inbound request;
   * it never re-sends anything on its own initiative.
   */
  async run(target: T, command: () => Promise<void>): Promise<void> {
    const requestId = this.nextRequestId++;
    this.debug(
      'request #%d: target=%s inFlight=%s desired=%s (age %dms) lastFailure=%s (age %dms)',
      requestId,
      target,
      this.inFlight ? this.inFlight.target : 'none',
      this.desired !== undefined ? this.desired : 'none',
      this.desired !== undefined ? Date.now() - this.desiredAt : -1,
      this.lastFailure ? this.lastFailure.target : 'none',
      this.lastFailure ? Date.now() - this.lastFailure.at : -1,
    );

    const existing = this.inFlight;
    if (existing && existing.target === target) {
      this.debug('request #%d: DEDUPLICATED — identical target already in flight, reusing its outcome instead of a new Honda call', requestId);
      return existing.promise;
    }

    if (this.desired === target && Date.now() - this.desiredAt < this.settleMs) {
      this.debug('request #%d: NO-OP — target already confirmed %dms ago, within the settle window; not re-dispatching', requestId, Date.now() - this.desiredAt);
      return;
    }

    if (this.lastFailure && this.lastFailure.target === target && Date.now() - this.lastFailure.at < this.settleMs) {
      this.debug(
        'request #%d: SHORT-CIRCUITED — identical target failed %dms ago, within the settle window; reusing that failure instead of retrying Honda',
        requestId,
        Date.now() - this.lastFailure.at,
      );
      throw this.lastFailure.error;
    }

    this.debug('request #%d: DISPATCHED — sending a new Honda command for target=%s', requestId, target);
    const promise = (async () => {
      try {
        await command();
        this.desired = target;
        this.desiredAt = Date.now();
        this.lastFailure = undefined;
        this.debug('request #%d: Honda command resolved successfully; target=%s now confirmed', requestId, target);
      } catch (err) {
        this.lastFailure = { target, at: Date.now(), error: err };
        this.debug('request #%d: Honda command failed/timed out: %s', requestId, err instanceof Error ? err.message : String(err));
        throw err;
      }
    })();

    this.inFlight = { target, promise };
    try {
      await promise;
    } finally {
      if (this.inFlight?.promise === promise) {
        this.inFlight = undefined;
        this.debug('request #%d: cleared in-flight marker', requestId);
      }
    }
  }

  /**
   * The value to treat as authoritative for a HomeKit read/poll refresh:
   * normally whatever polling last reported (`polled`), except within
   * `settleMs` of a confirmed command whose outcome polling still
   * contradicts — see the class doc comment for why.
   */
  effective(polled: T | undefined): T | undefined {
    if (
      polled !== undefined &&
      this.desired !== undefined &&
      this.desired !== polled &&
      Date.now() - this.desiredAt < this.settleMs
    ) {
      return this.desired;
    }
    return polled;
  }
}
