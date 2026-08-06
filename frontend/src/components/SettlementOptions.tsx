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

/**
 * What the server's facilitator advertised it can settle, as reported by
 * `GET /demo/config`. The spec's matrix is wider than any one facilitator, and
 * `@x402/cardano` refuses to serve a 402 outside what was advertised — so the
 * controls offer this rather than the full matrix.
 */
export interface FacilitatorOptions {
  submissionPolicies: SubmissionPolicy[];
  l1Confirmations: Record<string, { minimum: number; maximum: number }>;
}

/** The spec's full range, used until the server has reported its own. */
const FULL_RANGE = { minimum: -1, maximum: 20 };

interface SettlementOptionsProps {
  value: DemoSettlement;
  onChange: (next: DemoSettlement) => void;
  disabled?: boolean;
  /** Null until `GET /demo/config` answers. */
  facilitator?: FacilitatorOptions | null;
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
  facilitator,
  syncing,
  syncError,
}: SettlementOptionsProps) {
  const supports = (policy: SubmissionPolicy) =>
    !facilitator || facilitator.submissionPolicies.includes(policy);
  const range = facilitator?.l1Confirmations[value.submissionPolicy] ?? FULL_RANGE;
  const unavailable = POLICIES.filter((p) => !supports(p.id));

  // Switching policy can strand the slider outside the new policy's range, so
  // the threshold moves with it — the server rejects the pair, not each field.
  function selectPolicy(policy: SubmissionPolicy) {
    const next = facilitator?.l1Confirmations[policy] ?? FULL_RANGE;
    onChange({
      ...value,
      submissionPolicy: policy,
      l1Confirmations: Math.min(Math.max(value.l1Confirmations, next.minimum), next.maximum),
    });
  }

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
              onClick={() => selectPolicy(option.id)}
              disabled={disabled || !supports(option.id)}
              title={
                supports(option.id)
                  ? option.blurb
                  : "This facilitator did not advertise it, so the server cannot issue a 402 for it."
              }
            >
              <span className="method-picker__option-label">{option.label}</span>
            </button>
          ))}
        </div>
        <p className="step-note">
          {POLICIES.find((p) => p.id === value.submissionPolicy)?.blurb}
        </p>
        {unavailable.length > 0 && (
          <p className="step-note">
            {unavailable.map((p) => p.label).join(" and ")}{" "}
            {unavailable.length === 1 ? "is" : "are"} unavailable: the facilitator advertises{" "}
            <code>submissionModes</code> this server cannot pair with them. Server submission
            needs a phase-1 ledger validator on the facilitator's signer, and{" "}
            <code>either</code> needs both modes at once.
          </p>
        )}
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
            min={range.minimum}
            max={range.maximum}
            step={1}
            value={value.l1Confirmations}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, l1Confirmations: Number(e.target.value) })}
          />
          <span className="mono-tag settlement-options__value">{value.l1Confirmations}</span>
        </div>
        <p className="step-note">{describeConfirmations(value.l1Confirmations)}</p>
        {(range.minimum !== FULL_RANGE.minimum || range.maximum !== FULL_RANGE.maximum) && (
          <p className="step-note">
            The spec allows −1..20; this facilitator accepts {range.minimum}..{range.maximum} for{" "}
            <code>{value.submissionPolicy}</code> submission
            {range.minimum > -1
              ? " — mempool-only evidence is refused unless its operator sets ACCEPT_MEMPOOL=true."
              : "."}
          </p>
        )}
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
