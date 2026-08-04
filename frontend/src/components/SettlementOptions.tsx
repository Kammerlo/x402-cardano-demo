export type SubmissionPolicy = "server" | "client" | "either";
export type SubmissionMode = "server" | "client";

export interface DemoSettlement {
  /** What the 402 advertises in `extra.submissionPolicy`. */
  submissionPolicy: SubmissionPolicy;
  /** What the client picks when the policy is `either`. */
  preferredMode: SubmissionMode;
  /** `extra.confirmationPolicy.l1Confirmations`: −1 mempool, 0 block, 1..20 depth. */
  l1Confirmations: number;
}

interface SettlementOptionsProps {
  value: DemoSettlement;
  onChange: (next: DemoSettlement) => void;
  disabled?: boolean;
  /** Set while the server is being told about a change. */
  syncing?: boolean;
  syncError?: string | null;
}

const POLICIES: Array<{ id: SubmissionPolicy; label: string; blurb: string }> = [
  {
    id: "server",
    label: "Server submits",
    blurb: "You only sign. The facilitator broadcasts after it verifies.",
  },
  {
    id: "client",
    label: "I submit",
    blurb:
      "Your wallet broadcasts before the paid retry; the facilitator never sends it, it authenticates the transaction you already sent. Blockfrost has no mempool view, so the wallet waits for the chain to show the payment first — expect one extra block of waiting.",
  },
  {
    id: "either",
    label: "Either",
    blurb: "The server allows both and lets you choose.",
  },
];

/**
 * The two shared policies every x402 Cardano payment carries in
 * `PaymentRequirements.extra`. Changing them here rewrites what the server's
 * 402 advertises, so the whole feature matrix is reachable without a restart.
 */
export function SettlementOptions({
  value,
  onChange,
  disabled,
  syncing,
  syncError,
}: SettlementOptionsProps) {
  return (
    <div className="settlement-options">
      <div className="settlement-options__group">
        <span className="settlement-options__label">
          Who broadcasts <code>extra.submissionPolicy</code>
        </span>
        <div className="method-picker__control" role="radiogroup" aria-label="Submission policy">
          {POLICIES.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={value.submissionPolicy === option.id}
              className="method-picker__option"
              data-selected={value.submissionPolicy === option.id}
              onClick={() => onChange({ ...value, submissionPolicy: option.id })}
              disabled={disabled}
              title={option.blurb}
            >
              <span className="method-picker__option-label">{option.label}</span>
            </button>
          ))}
        </div>
        <p className="step-note">
          {POLICIES.find((p) => p.id === value.submissionPolicy)?.blurb}
        </p>
      </div>

      {value.submissionPolicy === "either" && (
        <div className="settlement-options__group">
          <span className="settlement-options__label">
            Your choice <code>payload.submissionMode</code>
          </span>
          <div className="method-picker__control" role="radiogroup" aria-label="Submission mode">
            {(["server", "client"] as SubmissionMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={value.preferredMode === mode}
                className="method-picker__option"
                data-selected={value.preferredMode === mode}
                onClick={() => onChange({ ...value, preferredMode: mode })}
                disabled={disabled}
              >
                <span className="method-picker__option-label">
                  {mode === "server" ? "Let the server" : "I submit"}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="settlement-options__group">
        <label className="settlement-options__label" htmlFor="l1-confirmations">
          Minimum blocks <code>extra.confirmationPolicy.l1Confirmations</code>
        </label>
        <div className="settlement-options__row">
          <input
            id="l1-confirmations"
            type="range"
            min={-1}
            max={20}
            step={1}
            value={value.l1Confirmations}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, l1Confirmations: Number(e.target.value) })}
          />
          <span className="mono-tag settlement-options__value">{value.l1Confirmations}</span>
        </div>
        <p className="step-note">{describeConfirmations(value.l1Confirmations)}</p>
      </div>

      {syncing && <p className="control-panel__hint control-panel__hint--muted">Updating the server…</p>}
      {syncError && <p className="control-panel__hint">Could not update the server: {syncError}</p>}
    </div>
  );
}

/**
 * Plain-language reading of an `l1Confirmations` value.
 *
 * @param n - The configured threshold.
 * @returns A sentence describing what the facilitator will wait for.
 */
function describeConfirmations(n: number): string {
  if (n === -1) {
    return "−1: authenticated mempool acceptance is enough. The fastest setting, and the riskiest — a mempool transaction can still be rolled back, so the facilitator refuses it unless its operator opted in (ACCEPT_MEMPOOL).";
  }
  if (n === 0) {
    return "0: the transaction must be in a canonical block. Roughly one block of waiting (~20s on preprod).";
  }
  return `${n}: ${n} newer block${n === 1 ? "" : "s"} must sit on top of the one containing the payment. Expect roughly ${n * 20}s of extra waiting; the spec default is 1.`;
}
