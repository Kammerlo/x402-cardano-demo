import { useElapsedSeconds } from "../lib/hooks";
import { formatElapsed } from "../lib/format";

interface SettlementWaitProps {
  startedAt: number;
}

/**
 * The emotional peak of the demo: the facilitator has broadcast the
 * transaction and is polling preprod for a block that includes it. This is a
 * real 20-60s wait, not a spinner standing in for one — the ticking clock is
 * the point.
 */
export function SettlementWait({ startedAt }: SettlementWaitProps) {
  const elapsed = useElapsedSeconds(startedAt, true);

  // The visual clock ticks every 250ms (see useElapsedSeconds) — fine to look
  // at, unbearable to have re-announced by a screen reader. This separate
  // hidden live region announces once at the start, then only when the
  // 10-second bucket changes, so it stays sparse for the whole 20-60s wait.
  const announcement =
    elapsed < 10
      ? "Waiting for on-chain confirmation…"
      : `Still waiting, about ${Math.floor(elapsed / 10) * 10} seconds.`;

  return (
    <div className="settlement-wait">
      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
      <div className="settlement-wait__pulse" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="settlement-wait__copy">
        <p className="settlement-wait__title">Waiting for a preprod block to include this transaction…</p>
        <p className="settlement-wait__detail">
          The facilitator already broadcast it. Cardano preprod produces a block roughly every 20 seconds; the
          facilitator is polling until it sees this transaction land in one. Typical wait: 20–60s.
        </p>
      </div>
      <div className="settlement-wait__clock mono-tag">{formatElapsed(elapsed)}</div>
    </div>
  );
}
