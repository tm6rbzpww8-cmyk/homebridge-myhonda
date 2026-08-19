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
 *    write while the first is still in flight. Without de-duplication, each
 *    resend became its own independent Honda API call.
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
export class RemoteCommandGuard<T> {
  private inFlight?: { target: T; promise: Promise<void> };
  private desired?: T;
  private desiredAt = 0;

  /**
   * @param settleMs How long after a confirmed command we keep trusting its
   *   outcome over a status poll that reports something else, before
   *   falling back to whatever polling reports. Bounded rather than
   *   indefinite, so a later genuine external change (physical key, the
   *   Honda app) is still detected once enough time has passed for a fresh
   *   poll to be credible. Controls that never consult `effective()` (pure
   *   momentary actions like the horn trigger, which HomeKit does not
   *   mirror actual vehicle state into) can pass any value — it is unused
   *   unless `effective()` is called.
   */
  constructor(private readonly settleMs: number) {}

  /**
   * Whether a command for `target` is already in flight — if so, the
   * caller should await/reuse it (see `run`) instead of treating this as a
   * distinct new request.
   */
  isInFlightFor(target: T): boolean {
    return this.inFlight?.target === target;
  }

  /**
   * Sends `target` to Honda via `command`, unless a command for the exact
   * same target is already in flight, in which case that command's own
   * outcome is reused — a duplicate/retried HomeKit write for what was
   * really a single tap never becomes a second Honda command.
   *
   * On success, `target` becomes the desired value `effective()` trusts
   * over a conflicting poll for `settleMs`. On failure (including a
   * timeout), nothing is recorded as desired — nothing here is treated as
   * confirmed, and a subsequent poll's own data is trusted immediately, so
   * a failed command can never leave HomeKit stuck showing the state that
   * failed to be reached. Either way, the in-flight marker is always
   * cleared once the command settles, so the very next distinct request
   * (a genuinely new tap, or a retry after a timeout) can proceed — a
   * timeout here never triggers an automatic retry by the guard itself;
   * it only ever reacts to an inbound HomeKit request.
   */
  async run(target: T, command: () => Promise<void>): Promise<void> {
    const existing = this.inFlight;
    if (existing && existing.target === target) {
      return existing.promise;
    }

    const promise = (async () => {
      await command();
      this.desired = target;
      this.desiredAt = Date.now();
    })();

    this.inFlight = { target, promise };
    try {
      await promise;
    } finally {
      if (this.inFlight?.promise === promise) {
        this.inFlight = undefined;
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
