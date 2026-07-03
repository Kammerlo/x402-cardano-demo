/**
 * CIP-30 wallet discovery. The wallet standard injects each installed
 * extension at `window.cardano.<key>`; a real signing wallet exposes an
 * `enable()` method (distinguishes it from unrelated globals some
 * extensions also drop onto `window.cardano`).
 */

export interface Cip30Api {
  enable(): Promise<Cip30WalletApi>;
  name?: string;
  icon?: string;
}

export interface Cip30WalletApi {
  getNetworkId(): Promise<number>;
}

declare global {
  interface Window {
    cardano?: Record<string, Cip30Api>;
  }
}

export interface WalletInfo {
  key: string;
  name: string;
  icon?: string;
}

/** Lists every injected CIP-30 wallet, keyed by its `window.cardano` property name. */
export function listWallets(): WalletInfo[] {
  const cardano = window.cardano ?? {};
  return Object.keys(cardano)
    .filter((key) => typeof cardano[key]?.enable === "function")
    .map((key) => ({ key, name: cardano[key].name ?? key, icon: cardano[key].icon }));
}
