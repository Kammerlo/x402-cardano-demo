/**
 * A ClientCardanoSigner backed by a CIP-30 browser wallet (Eternl, Lace, ...).
 *
 * The x402 "exact" scheme on Cardano is CLIENT-DRIVEN: this code builds the
 * complete payment transaction in the browser (Evolution SDK + Blockfrost for
 * UTxOs/protocol parameters), the wallet only signs it. The facilitator never
 * builds or signs anything — it verifies and broadcasts.
 *
 * Mirrors the reference signer recipe in @x402/cardano (signer.ts):
 *   nonce  = first wallet UTxO, forced as an input via collectFrom
 *            (the facilitator's replay protection - verification rule 5)
 *   output = payTo receives the requested asset (lovelace or a native token)
 *   TTL    = now + maxTimeoutSeconds (verification rule 6)
 */
import {
  Address,
  Assets,
  Client,
  Data,
  Transaction,
  preprod,
} from "@evolution-sdk/evolution";
import {
  buildMasumiLockInline,
  LOVELACE_ASSET,
  masumiTokenLockLovelace,
  parseAssetUnit,
  type CardanoExtraMasumi,
  type ClientCardanoSigner,
  type ClientCardanoSignInput,
} from "@x402/cardano";

/**
 * Builds the output value for the requested asset.
 *
 * x402 names an asset either as the literal `lovelace` or as
 * `policyId.assetNameHex` (e.g. tUSDM). Lovelace sits in the output's coin
 * field; a native token goes in the multi-asset map and still needs coin
 * alongside it, which `autoMinUtxo` raises to the protocol minimum at build
 * time (a token output costs roughly 1.2-1.5 ADA of min-UTxO on top).
 *
 * @param asset  - `lovelace` or `policyId.assetNameHex`.
 * @param amount - Amount in the asset's smallest unit.
 * @returns The Evolution assets value for the payment output.
 */
function buildOutputAssets(asset: string, amount: bigint): Assets.Assets {
  if (asset.toLowerCase() === LOVELACE_ASSET) return Assets.fromLovelace(amount);
  const { policyId, assetNameHex } = parseAssetUnit(asset);
  return Assets.addByHex(Assets.zero, policyId, assetNameHex, amount);
}

export interface Cip30WalletApi {
  // Minimal CIP-30 surface we rely on (window.cardano.<wallet>.enable() result).
  getNetworkId(): Promise<number>;
}

/**
 * Reads the live `coinsPerUtxoByte` protocol parameter.
 *
 * Fetched straight from Blockfrost because a CIP-30-backed Evolution client
 * exposes no `getProtocolParameters()` on its promise API (only seed-backed
 * clients do). Needed to size a Masumi token lock, which cannot rely on
 * `autoMinUtxo` — see buildOutputAssets' masumi branch.
 *
 * @param blockfrost - Provider connection.
 * @returns The `coinsPerUtxoByte` value.
 */
async function fetchCoinsPerUtxoByte(blockfrost: {
  baseUrl: string;
  projectId: string;
}): Promise<bigint> {
  const res = await fetch(`${blockfrost.baseUrl}/epochs/latest/parameters`, {
    headers: { project_id: blockfrost.projectId },
  });
  if (!res.ok) throw new Error(`Blockfrost returned ${res.status} fetching protocol parameters`);
  const params = (await res.json()) as { coins_per_utxo_size?: string };
  if (!params.coins_per_utxo_size) {
    throw new Error("Blockfrost protocol parameters did not include coins_per_utxo_size");
  }
  return BigInt(params.coins_per_utxo_size);
}

/** `txHash#index` for a wallet UTxO, matching the x402 nonce format. */
function utxoRef(u: { transactionId: { hash: Uint8Array }; index: bigint | number }): string {
  return `${Buffer.from(u.transactionId.hash).toString("hex").toLowerCase()}#${Number(u.index)}`;
}

/**
 * Fetches every unspent UTxO reference the chain currently holds for an address.
 *
 * Blockfrost's address-UTxO endpoint returns only unspent entries, so this is
 * the authoritative "still live" set. It pages to the end because a wallet with
 * more than one page of UTxOs would otherwise look partly spent.
 *
 * @param address    - The wallet's bech32 address.
 * @param blockfrost - Provider connection used for the lookup.
 * @returns Live `txHash#index` references, lowercased.
 */
async function fetchLiveRefs(
  address: string,
  blockfrost: { baseUrl: string; projectId: string },
): Promise<Set<string>> {
  const refs = new Set<string>();
  for (let page = 1; ; page++) {
    const res = await fetch(
      `${blockfrost.baseUrl}/addresses/${address}/utxos?count=100&page=${page}`,
      { headers: { project_id: blockfrost.projectId } },
    );
    if (res.status === 404) break; // Address has no UTxOs at all.
    if (!res.ok) throw new Error(`Blockfrost returned ${res.status} listing UTxOs for ${address}`);
    const rows = (await res.json()) as Array<{ tx_hash: string; output_index: number }>;
    for (const r of rows) refs.add(`${r.tx_hash.toLowerCase()}#${r.output_index}`);
    if (rows.length < 100) break;
  }
  return refs;
}

/**
 * Narrows the wallet's UTxO list to those the chain still reports as unspent.
 *
 * A CIP-30 wallet serves its UTxO list from its own cache, which lags the chain
 * after a payment settles — so it can still offer an input a previous run
 * already spent. Spending one is fatal twice over: the facilitator rejects the
 * payment (`..._nonce_not_on_chain`) if it's the nonce, and the node rejects the
 * transaction outright (`BadInputsUTxO`) if coin selection merely picks it up
 * for fees. Both are avoided by building only from this filtered set.
 *
 * @param utxos      - UTxOs as reported by the wallet.
 * @param address    - The wallet's bech32 address.
 * @param blockfrost - Provider connection used for the liveness check.
 * @returns The confirmed-unspent subset, and whether the check actually ran.
 */
async function liveUtxos<T extends { transactionId: { hash: Uint8Array }; index: bigint | number }>(
  utxos: readonly T[],
  address: string,
  blockfrost: { baseUrl: string; projectId: string },
): Promise<{ usable: readonly T[]; verified: boolean }> {
  let live: Set<string>;
  try {
    live = await fetchLiveRefs(address, blockfrost);
  } catch (err) {
    // Couldn't reach the provider. Proceed on the wallet's word rather than
    // block the demo, but say so loudly: if this run then fails with
    // `..._nonce_not_on_chain` or BadInputsUTxO, this warning is the reason.
    console.warn(
      "[x402] Could not verify UTxO liveness against Blockfrost — building from the " +
        "wallet's (possibly stale) view. A spent input here surfaces later as " +
        `\`..._nonce_not_on_chain\` or BadInputsUTxO.\n  ${String(err)}`,
    );
    return { usable: utxos, verified: false };
  }

  const usable = utxos.filter((u) => live.has(utxoRef(u)));
  if (usable.length === 0) {
    throw new Error(
      `Your wallet lists ${utxos.length} UTxO(s), but none are unspent on-chain — its cache ` +
        "is stale (this is normal right after a payment). Reload the page or reconnect the " +
        "wallet, and if you just paid, wait ~20-60s for that transaction to confirm.",
    );
  }
  return { usable, verified: true };
}

export async function createCip30Signer(
  walletApi: unknown,
  blockfrost: { baseUrl: string; projectId: string },
): Promise<ClientCardanoSigner> {
  // Provider (reads chain state) + CIP-30 (signs) = a full signing client.
  const client = Client.make(preprod)
    .withBlockfrost(blockfrost)
    .withCip30(walletApi as never);

  const address = Address.toBech32(await client.address());

  return {
    getAddress: () => address,

    async buildAndSignPaymentTransaction(input: ClientCardanoSignInput) {
      const isLovelace = input.asset.toLowerCase() === LOVELACE_ASSET;

      const utxos = await client.getWalletUtxos();
      if (utxos.length === 0) throw new Error("Wallet has no UTxOs — fund it at the preprod faucet");

      // A wallet UTxO becomes the x402 nonce. collectFrom() guarantees it
      // appears as a transaction input; settling spends it, which is what makes
      // the payment replay-proof.
      //
      // Build only from inputs the CHAIN still reports as unspent, rather than
      // blindly trusting the extension's cached list — see liveUtxos(). The
      // nonce comes from this set, and so does coin selection (`availableUtxos`
      // below), so neither the nonce nor a fee input can be a spent UTxO.
      const { usable } = await liveUtxos(utxos, address, blockfrost);
      const nonceUtxo = usable[0];
      const nonceTxHash = Buffer.from(nonceUtxo.transactionId.hash).toString("hex").toLowerCase();
      const nonce = `${nonceTxHash}#${Number(nonceUtxo.index)}`;

      // "default" pays payTo a plain lovelace output (unchanged). "masumi"
      // additionally attaches the 19-field inline escrow-lock datum, which
      // @x402/cardano builds for us from the server's seller-side extra. The
      // third argument is the buyer-side half of the datum: the server answered
      // an unauthenticated request and cannot know it, so the wallet supplies
      // it. Passing nothing lets the library generate a fresh buyer nonce and
      // take the contract defaults — enough for this demo, which has no real
      // Masumi purchase to bind to.
      //
      // The datum's `buyer` field must equal the payer the facilitator resolves
      // — the nonce UTxO's owner — so it's derived from that UTxO, not from
      // client.address() (usually the same wallet address, but the nonce UTxO
      // is what the facilitator checks).
      const method = String(input.extra?.assetTransferMethod ?? "default");
      const datum =
        method === "masumi"
          ? buildMasumiLockInline(
              input.extra as unknown as CardanoExtraMasumi,
              Address.toBech32(nonceUtxo.address),
            )
          : undefined;
      // Both a datum-bearing output and a native-token output need more coin
      // than a plain lovelace payment: the datum enlarges the output, and a
      // token output must still carry min-ADA alongside the token. autoMinUtxo
      // raises the coin to the protocol minimum for those two cases, leaving a
      // plain lovelace payment to build exactly as before.
      const autoMinUtxo = method === "masumi" || !isLovelace;

      // A native-token Masumi lock is the one case autoMinUtxo cannot size.
      // The escrow output's lovelace there is purely structural: the requested
      // amount is the TOKEN, and the coin alongside it must still clear the
      // *post-result* min-UTxO (the datum grows once result_hash is filled)
      // and cover the collateral the seller later reclaims. autoMinUtxo only
      // measures today's smaller datum, so compute the floor explicitly —
      // mirroring the reference signer in @x402/cardano.
      let outputAssets = buildOutputAssets(input.asset, BigInt(input.amount));
      if (method === "masumi" && datum && !isLovelace) {
        const coinsPerUtxoByte = await fetchCoinsPerUtxoByte(blockfrost);
        const datumBytes = Data.toCBORHex(datum.data).length / 2;
        const masumiExtra = input.extra as unknown as CardanoExtraMasumi;
        const collateral = masumiExtra.collateralReturnLovelace
          ? BigInt(masumiExtra.collateralReturnLovelace)
          : 0n;
        const { policyId, assetNameHex } = parseAssetUnit(input.asset);
        outputAssets = Assets.addByHex(
          Assets.fromLovelace(masumiTokenLockLovelace(datumBytes, collateral, coinsPerUtxoByte)),
          policyId,
          assetNameHex,
          BigInt(input.amount),
        );
      }

      // Masumi: pin the validity upper bound to pay_by_time (see .setValidity
      // below). Masumi invalidates a lock that lands after that deadline, so
      // the transaction must be unable to settle past it.
      const payByTime = input.extra?.payByTime;
      const ttlMs =
        method === "masumi" && typeof payByTime === "string"
          ? BigInt(payByTime)
          : BigInt(Date.now()) + BigInt(input.maxTimeoutSeconds) * 1000n;

      const signBuilder = await client
        .newTx()
        .collectFrom({ inputs: [nonceUtxo] })
        .payToAddress({
          address: Address.fromBech32(input.payTo),
          assets: outputAssets,
          ...(datum ? { datum } : {}),
        })
        // Wall-clock ms; the SDK converts it to the TTL slot. For masumi the
        // upper bound is anchored to the datum's pay_by_time so the lock can
        // never settle past the escrow deadline — the facilitator rejects a
        // masumi lock whose TTL could land after it. Other methods just use
        // maxTimeoutSeconds.
        .setValidity({ to: ttlMs })
        // availableUtxos restricts coin selection to the confirmed-unspent set.
        // Without it the builder would draw fee inputs from the wallet's cached
        // list, so a fresh nonce could still be paired with an already-spent
        // input and the node would reject the whole transaction at submit.
        .build({ changeAddress: await client.address(), availableUtxos: usable, autoMinUtxo });

      // Prompts the user's wallet extension for approval.
      const submitBuilder = await signBuilder.sign();

      const unsigned = await signBuilder.toTransaction();
      const signed = new Transaction.Transaction({
        body: unsigned.body,
        witnessSet: submitBuilder.witnessSet,
        isValid: true,
        auxiliaryData: null,
      });

      return {
        transaction: Buffer.from(Transaction.toCBORBytes(signed)).toString("base64"),
        nonce,
      };
    },
  };
}
