import type { WalletInfo } from "../lib/cip30";
import { WalletPicker, type WalletConnection } from "./WalletPicker";

export type RunState = "idle" | "running" | "done" | "error";

interface ControlPanelProps {
  wallets: WalletInfo[];
  connecting: string | null;
  connection: WalletConnection | null;
  connectError: string | null;
  onSelectWallet: (key: string) => void;
  runState: RunState;
  onBegin: () => void;
  onReset: () => void;
}

/** Connect a wallet, then run the protocol. The one place on the page that
 * asks the visitor to do something. */
export function ControlPanel({
  wallets,
  connecting,
  connection,
  connectError,
  onSelectWallet,
  runState,
  onBegin,
  onReset,
}: ControlPanelProps) {
  const onPreprod = connection?.networkId === 0;

  return (
    <section className="control-panel" aria-label="Connect a wallet and run the protocol">
      <div className="control-panel__step">
        <span className="control-panel__step-label mono-tag">Step A</span>
        <h2>Connect a wallet</h2>
        <WalletPicker
          wallets={wallets}
          connecting={connecting}
          connection={connection}
          connectError={connectError}
          onSelect={onSelectWallet}
        />
      </div>

      <div className="control-panel__divider" aria-hidden="true" />

      <div className="control-panel__step">
        <span className="control-panel__step-label mono-tag">Step B</span>
        <h2>Run the protocol</h2>
        <p className="control-panel__hint">
          Requests the paid resource, pays the 2 tADA it costs, and shows every step of x402 doing its job.
        </p>
        {runState === "done" || runState === "error" ? (
          <button type="button" className="btn btn--ghost" onClick={onReset}>
            Run it again
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            onClick={onBegin}
            disabled={!connection || !onPreprod || runState === "running"}
          >
            {runState === "running" ? "Running…" : "Begin the x402 flow"}
          </button>
        )}
        {!connection && <p className="control-panel__hint control-panel__hint--muted">Connect a wallet first.</p>}
      </div>
    </section>
  );
}
