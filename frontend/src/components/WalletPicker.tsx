import type { WalletInfo } from "../lib/cip30";
import { shortenMiddle } from "../lib/format";

export interface WalletConnection {
  key: string;
  address: string;
  networkId: number;
}

interface WalletPickerProps {
  wallets: WalletInfo[];
  connecting: string | null;
  connection: WalletConnection | null;
  connectError: string | null;
  onSelect: (key: string) => void;
}

const PREPROD_NETWORK_ID = 0;

export function WalletPicker({ wallets, connecting, connection, connectError, onSelect }: WalletPickerProps) {
  if (connection) {
    const onPreprod = connection.networkId === PREPROD_NETWORK_ID;
    return (
      <div className="wallet-connected" data-network-ok={onPreprod}>
        <div className="wallet-connected__identity">
          <span className="wallet-connected__dot" aria-hidden="true" />
          <span className="mono-tag wallet-connected__address" title={connection.address}>
            {shortenMiddle(connection.address)}
          </span>
        </div>
        <span className="wallet-connected__network">
          {onPreprod ? "Preprod" : `Wrong network (id ${connection.networkId})`}
        </span>
        {!onPreprod && (
          <p className="wallet-connected__warning">
            This wallet is not on Cardano Preprod. Switch its network in the extension before starting the flow.
          </p>
        )}
      </div>
    );
  }

  if (wallets.length === 0) {
    return (
      <div className="wallet-empty">
        <p>
          No CIP-30 wallet found in this browser. Install{" "}
          <a href="https://eternl.io/" target="_blank" rel="noreferrer">
            Eternl
          </a>{" "}
          or{" "}
          <a href="https://www.lace.io/" target="_blank" rel="noreferrer">
            Lace
          </a>
          , switch it to <strong>Preprod</strong>, and reload this page.
        </p>
      </div>
    );
  }

  return (
    <div className="wallet-picker">
      <ul className="wallet-picker__list">
        {wallets.map((wallet) => (
          <li key={wallet.key}>
            <button
              type="button"
              className="wallet-option"
              onClick={() => onSelect(wallet.key)}
              disabled={connecting !== null}
              aria-busy={connecting === wallet.key}
            >
              {wallet.icon ? (
                <img src={wallet.icon} alt="" className="wallet-option__icon" />
              ) : (
                <span className="wallet-option__icon wallet-option__icon--fallback" aria-hidden="true" />
              )}
              <span className="wallet-option__name">{wallet.name}</span>
              <span className="wallet-option__action">{connecting === wallet.key ? "Connecting…" : "Connect"}</span>
            </button>
          </li>
        ))}
      </ul>
      {connectError && <p className="wallet-picker__error">{connectError}</p>}
    </div>
  );
}
