import type { WalletInfo } from "../lib/cip30";
import type { PaymentMethod } from "../x402/flow";
import { WalletPicker, type WalletConnection } from "./WalletPicker";
import { MethodPicker } from "./MethodPicker";
import {
  SettlementOptions,
  type DemoSettlement,
  type FacilitatorOptions,
} from "./SettlementOptions";

export type RunState = "idle" | "running" | "done" | "error";

interface ControlPanelProps {
  wallets: WalletInfo[];
  connecting: string | null;
  connection: WalletConnection | null;
  connectError: string | null;
  onSelectWallet: (key: string) => void;
  method: PaymentMethod;
  onMethodChange: (method: PaymentMethod) => void;
  runState: RunState;
  onBegin: () => void;
  onReset: () => void;
  settlement: DemoSettlement;
  onSettlementChange: (next: DemoSettlement) => void;
  /** What the server's facilitator advertised; null until it answers. */
  facilitatorOptions: FacilitatorOptions | null;
  settlementSyncing?: boolean;
  settlementError?: string | null;
}

/** Connect a wallet, then run the protocol. The one place on the page that
 * asks the visitor to do something. */
export function ControlPanel({
  wallets,
  connecting,
  connection,
  connectError,
  onSelectWallet,
  method,
  onMethodChange,
  runState,
  onBegin,
  onReset,
  settlement,
  onSettlementChange,
  facilitatorOptions,
  settlementSyncing,
  settlementError,
}: ControlPanelProps) {
  const onPreprod = connection?.networkId === 0;
  const hint =
    method === "masumi"
      ? "Requests the paid resource, locks 5 tADA into the (demo) escrow contract it asks for, and shows every step of x402 doing its job."
      : "Requests the paid resource, pays the 2 tADA it costs, and shows every step of x402 doing its job.";

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
        <MethodPicker method={method} onChange={onMethodChange} disabled={runState === "running"} />
        <p className="control-panel__hint">{hint}</p>
        <SettlementOptions
          value={settlement}
          onChange={onSettlementChange}
          disabled={runState === "running"}
          facilitator={facilitatorOptions}
          syncing={settlementSyncing}
          syncError={settlementError}
        />
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
