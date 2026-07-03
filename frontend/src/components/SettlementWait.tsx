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

  return (
    <div className="settlement-wait" role="status">
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
