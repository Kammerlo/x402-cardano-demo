// Wallet-side library integration for the demo.
//
// This file is the demo's actual contribution: a small adapter that
// implements the library's `ClientCardanoSigner` Protocol on top of a
// CIP-30 wallet (via Mesh's `BrowserWallet` + `Transaction`). Once that
// adapter exists the rest of the flow is the library's:
// `x402Client.register("cardano:preprod", new ExactCardanoScheme(signer))`
// + `x402HTTPClient.createPaymentPayload(...)` +
// `x402HTTPClient.encodePaymentSignatureHeader(...)`.

import { Transaction, type UTxO } from "@meshsdk/core";
import { Decoder } from "cbor-x";

// mapsAsObjects: false decodes CBOR maps as JavaScript Map objects.
// The default (true) throws when a map key is a Uint8Array, which happens
// whenever the change output contains native tokens (policy IDs are byte strings).
const cborDecoder = new Decoder({ mapsAsObjects: false });

import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import {
  CARDANO_PREPROD_CAIP2,
  type ClientCardanoSignInput,
  type ClientCardanoSignResult,
  type ClientCardanoSigner,
} from "@x402/cardano";
import { ExactCardanoScheme as ExactCardanoClientScheme } from "@x402/cardano/exact/client";

/**
 * Structural shape every CIP-30-flavored wallet exposes. Both
 * `BrowserWallet` from `@meshsdk/core` and the React-flavored wallet
 * returned from `useWallet()` in `@meshsdk/react` satisfy this surface.
 *
 * Declaring it explicitly lets the signer adapter accept either without
 * fighting the nominally-different Mesh wallet classes.
 */
export type WalletLike = {
  getNetworkId(): Promise<number>;
  getUsedAddresses(): Promise<string[]>;
  getUsedAddressesBech32?(): Promise<string[]>;
  getUnusedAddresses(): Promise<string[]>;
  getUnusedAddressesBech32?(): Promise<string[]>;
  getChangeAddress(): Promise<string>;
  getChangeAddressBech32?(): Promise<string>;
  getUtxos?(): Promise<UTxO[]>;
  getUtxosMesh?(): Promise<UTxO[]>;
  getCollateral?(): Promise<UTxO[]>;
  getCollateralMesh?(): Promise<UTxO[]>;
  signTx(unsignedTx: string, partialSign?: boolean): Promise<string>;
  signTxReturnFullTx?(unsignedTx: string, partialSign?: boolean): Promise<string>;
};

type MeshInitiator = ConstructorParameters<typeof Transaction>[0]["initiator"];

/**
 * `ClientCardanoSigner` implementation backed by a CIP-30 wallet via Mesh.
 *
 * The library Protocol's `getAddress()` is synchronous, but CIP-30's
 * `getUsedAddresses` is async; we cache the address at construction time
 * via the static `create` factory so the sync getter has a value to
 * return.
 *
 * `signPaymentTransaction` uses Mesh's high-level Transaction builder to
 * construct + sign a lovelace payment, then decodes the resulting CBOR
 * with `cbor-x` to extract the first input — that becomes the x402
 * `nonce`. Returning `{ transaction, nonce }` from this method is exactly
 * what the library's `ExactCardanoScheme` (client) expects.
 */
export class CIP30CardanoSigner implements ClientCardanoSigner {
  private constructor(
    private readonly wallet: WalletLike,
    private readonly address: string,
  ) {}

  /**
   * Async factory that resolves a wallet address and caches it for the
   * synchronous `getAddress()` accessor. Falls back through
   * `getUsedAddresses` → `getUnusedAddresses` → `getChangeAddress` so
   * freshly-funded testnet wallets (which only ever *received* tADA, so
   * have no "used" addresses yet) still work.
   *
   * Also asserts the wallet is on a Cardano testnet (network id 0). If
   * the wallet is on mainnet the demo would build a mainnet tx and the
   * facilitator would reject it on rule 1, which is a confusing failure
   * mode; failing here gives a clearer message.
   *
   * @param wallet - A connected Mesh BrowserWallet.
   * @returns A signer adapter ready to register with `x402Client`.
   */
  static async create(wallet: WalletLike): Promise<CIP30CardanoSigner> {
    const networkId = await wallet.getNetworkId();
    if (networkId !== 0) {
      throw new Error(
        `Wallet is on Cardano mainnet (networkId=${networkId}); switch the wallet's network setting to preprod / testnet before connecting.`,
      );
    }

    let address: string | undefined;
    try {
      const used = await getUsedAddressesBech32(wallet);
      address = used[0];
    } catch {
      address = undefined;
    }

    if (!address) {
      try {
        const unused = await getUnusedAddressesBech32(wallet);
        address = unused[0];
      } catch {
        address = undefined;
      }
    }

    if (!address) {
      try {
        address = await getChangeAddressBech32(wallet);
      } catch {
        address = undefined;
      }
    }

    if (!address) {
      throw new Error(
        "Connected wallet did not expose any addresses (no used, unused, or change). Check that the wallet is funded and on preprod.",
      );
    }
    return new CIP30CardanoSigner(wallet, address);
  }

  /**
   * Returns the wallet's first used bech32 address.
   *
   * @returns The cached address.
   */
  getAddress(): string {
    return this.address;
  }

  /**
   * Build, sign, and return the signed transaction + nonce UTXO ref.
   *
   * @param input - Payment building parameters from the library.
   * @returns Library-shaped `{ transaction, nonce }`.
   */
  async signPaymentTransaction(
    input: ClientCardanoSignInput,
  ): Promise<ClientCardanoSignResult> {
    if (input.asset !== "lovelace") {
      throw new Error(
        `This demo signer only knows how to pay lovelace; got asset=${input.asset}`,
      );
    }
    // Mesh v2 exposes raw CIP-30 methods by default; the Transaction builder
    // still expects Mesh-shaped UTxOs and bech32 change addresses.
    const tx = new Transaction({ initiator: createMeshInitiator(this.wallet) });
    tx.sendLovelace(input.payTo, input.amount);
    const unsignedTx = await tx.build();
    const signedTxHex = await signTxReturnFullTx(this.wallet, unsignedTx);

    const bytes = hexToBytes(signedTxHex);
    const decoded = cborDecoder.decode(bytes) as unknown[];
    if (!Array.isArray(decoded) || decoded.length === 0) {
      throw new Error("Signed transaction did not decode as a CBOR array");
    }
    const inputs = readInputs(decoded[0]);
    if (inputs.length === 0) {
      throw new Error("Signed transaction has no inputs to use as nonce");
    }
    const [txHashBytes, idx] = inputs[0];
    const nonce = `${bytesToHex(txHashBytes)}#${idx}`;

    const transaction = base64FromBytes(bytes);
    return { transaction, nonce };
  }
}

/**
 * Build the demo's `x402HTTPClient` already wired with the Cardano client
 * scheme on `cardano:preprod`. The HTTP client gives us
 * `getPaymentRequiredResponse`, `createPaymentPayload`, and
 * `encodePaymentSignatureHeader` — every wire-protocol step the demo
 * needs.
 *
 * @param signer - A connected CIP-30 signer adapter.
 * @returns A configured x402HTTPClient ready to drive any Cardano backend.
 */
export function createX402Client(signer: CIP30CardanoSigner): x402HTTPClient {
  const client = new x402Client();
  client.register(CARDANO_PREPROD_CAIP2, new ExactCardanoClientScheme(signer));
  return new x402HTTPClient(client);
}

// Re-exports so main.ts has them in one place.
export type { PaymentRequirements };
export { x402HTTPClient };

function getUsedAddressesBech32(wallet: WalletLike): Promise<string[]> {
  return wallet.getUsedAddressesBech32?.() ?? wallet.getUsedAddresses();
}

function getUnusedAddressesBech32(wallet: WalletLike): Promise<string[]> {
  return wallet.getUnusedAddressesBech32?.() ?? wallet.getUnusedAddresses();
}

function getChangeAddressBech32(wallet: WalletLike): Promise<string> {
  return wallet.getChangeAddressBech32?.() ?? wallet.getChangeAddress();
}

async function getUtxosMesh(wallet: WalletLike): Promise<UTxO[]> {
  const utxos = await (wallet.getUtxosMesh?.() ?? wallet.getUtxos?.());
  if (!utxos) throw new Error("Connected wallet did not expose spendable UTxOs.");
  return utxos;
}

async function getCollateralMesh(wallet: WalletLike): Promise<UTxO[]> {
  return (await (wallet.getCollateralMesh?.() ?? wallet.getCollateral?.())) ?? [];
}

function signTxReturnFullTx(wallet: WalletLike, unsignedTx: string): Promise<string> {
  return wallet.signTxReturnFullTx?.(unsignedTx) ?? wallet.signTx(unsignedTx, false);
}

function createMeshInitiator(wallet: WalletLike): MeshInitiator {
  return {
    getChangeAddress: () => getChangeAddressBech32(wallet),
    getCollateral: () => getCollateralMesh(wallet),
    getUtxos: () => getUtxosMesh(wallet),
  };
}

// ---------------------------------------------------------------------------
// CBOR-decoding helpers (kept inside this module so the wire-protocol
// trivia does not leak into the UI layer).
// ---------------------------------------------------------------------------

/**
 * Pull the inputs (key 0 of the body map) out of a CBOR-decoded tx.
 *
 * @param body - Decoded CBOR transaction body.
 * @returns Array of `[txHashBytes, index]` tuples in declaration order.
 */
function readInputs(body: unknown): [Uint8Array, number][] {
  let raw: unknown;
  if (body instanceof Map) {
    raw = body.get(0);
  } else if (body && typeof body === "object") {
    const obj = body as Record<string | number, unknown>;
    raw = obj[0] ?? obj["0"];
  }
  if (!Array.isArray(raw) && !(raw instanceof Set)) {
    throw new Error("Transaction body did not contain an inputs array at key 0");
  }
  const list = raw instanceof Set ? Array.from(raw) : raw;
  return list.map(entry => {
    if (!Array.isArray(entry) || entry.length < 2) {
      throw new Error("Unexpected input shape in CBOR-decoded tx body");
    }
    const txHash = entry[0];
    const index = entry[1];
    if (!(txHash instanceof Uint8Array)) {
      throw new Error("First field of input is not bytes");
    }
    if (typeof index !== "number" && typeof index !== "bigint") {
      throw new Error("Second field of input is not an integer");
    }
    return [txHash, Number(index)] as [Uint8Array, number];
  });
}

/**
 * Convert a hex string to a Uint8Array.
 *
 * @param hex - Hex-encoded bytes.
 * @returns Decoded bytes.
 */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid hex length");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Convert a Uint8Array to a hex string.
 *
 * @param bytes - The bytes to encode.
 * @returns Lowercase hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

/**
 * Browser-safe base64 encoding of arbitrary bytes.
 *
 * @param bytes - Raw bytes.
 * @returns Base64 string.
 */
function base64FromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
