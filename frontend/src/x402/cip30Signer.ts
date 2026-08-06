/**
 * A ClientCardanoSigner backed by a CIP-30 browser wallet (Eternl, Lace, ...).
 *
 * The x402 "exact" scheme on Cardano is CLIENT-DRIVEN: this code builds the
 * complete payment transaction in the browser (Evolution SDK + Blockfrost for
 * UTxOs/protocol parameters) and the wallet signs it — and, in `client`
 * submission mode, broadcasts it through CIP-30 `submitTx` rather than through
 * this page's Blockfrost project. The facilitator never builds or signs
 * anything.
 *
 * Mirrors the reference signer recipe in @x402/cardano (signer.ts):
 *   nonce  = first wallet UTxO, forced as an input via collectFrom
 *            (the facilitator's replay protection - verification rule 5)
 *   output = payTo receives the requested asset (lovelace or a native token)
 *   TTL    = now + maxTimeoutSeconds, or pay_by_time for a Masumi lock
 *   submit = only in `client` submission mode; in `server` mode the signed
 *            transaction is handed over unbroadcast.
 */
import {
  Address,
  Assets,
  Client,
  Transaction,
  TransactionBody,
  TransactionHash,
  preprod,
} from "@evolution-sdk/evolution";
import {
  buildMasumiLock,
  LOVELACE_ASSET,
  parseAssetUnit,
  validateMasumiExtra,
  verifyMasumiAuthorization,
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
  /** Broadcasts a signed transaction; takes hex CBOR and returns its hash. */
  submitTx(tx: string): Promise<string>;
}

/**
 * Reads the live `coinsPerUtxoByte` protocol parameter.
 *
 * Fetched straight from Blockfrost because a CIP-30-backed Evolution client
 * exposes no `getProtocolParameters()` on its promise API (only seed-backed
 * clients do). A Masumi lock needs it to size `collateral_return_lovelace`.
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
      const method = String(input.extra?.assetTransferMethod ?? "default");

      // ── Masumi: validate the 402 BEFORE touching the wallet ────────────────
      //
      // The buyer is about to move real value, and in `client` submission mode
      // it broadcasts before any facilitator sees the payment. So the client
      // runs the seller-authorization checks itself: the request commitment
      // recomputes, `termsDigest` is what the seller's CIP-8 signature covers,
      // the escrow address derives from the deployment parameters, and the
      // compatibility identifier decodes to the same values. A malicious 402
      // that redirects `payTo` or invents terms is refused here, unpaid.
      let masumiExtra: CardanoExtraMasumi | undefined;
      if (method === "masumi") {
        const schema = validateMasumiExtra(input.extra, input.network);
        if (!schema.ok) throw new Error(`Masumi requirements are invalid: ${schema.detail}`);
        masumiExtra = schema.extra;

        const authorization = await verifyMasumiAuthorization(
          masumiExtra,
          {
            scheme: "exact",
            network: input.network as `${string}:${string}`,
            asset: input.asset,
            amount: input.amount,
            payTo: input.payTo,
            maxTimeoutSeconds: input.maxTimeoutSeconds,
            extra: input.extra ?? {},
          },
          // The demo's issuer echoes every committed part, so there is nothing
          // for the buyer to recompute locally — but requiring it means an
          // unverifiable part is refused rather than trusted.
          { requireAllPartContent: true },
        );
        if (!authorization.ok) {
          throw new Error(
            `Masumi seller authorization failed: ${authorization.reason}` +
              (authorization.detail ? ` (${authorization.detail})` : ""),
          );
        }
      }

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
      const nonce = utxoRef(nonceUtxo);

      // "default" pays payTo a plain output. "masumi" additionally attaches the
      // 19-field inline escrow-lock datum, which @x402/cardano builds from the
      // seller-signed terms.
      //
      // Everything in that datum now comes from `terms` — including
      // `buyer_nonce` and `input_hash`, which the seller signs. The only
      // buyer-chosen field left is `buyer_return_address` (omitted here), plus
      // `collateral_return_lovelace`, which the CLIENT computes: the seller
      // never supplies or signs it, and the escrow output must carry exactly
      // `requestedLovelace + collateral`.
      //
      // The datum's `buyer` must equal the payer the facilitator resolves — the
      // nonce UTxO's owner — so it is derived from that UTxO rather than from
      // client.address().
      let outputAssets = buildOutputAssets(input.asset, BigInt(input.amount));
      let datum: ReturnType<typeof buildMasumiLock>["datum"] | undefined;
      let autoMinUtxo = !isLovelace;

      if (method === "masumi") {
        const coinsPerUtxoByte = await fetchCoinsPerUtxoByte(blockfrost);
        const lock = buildMasumiLock(
          masumiExtra!,
          Address.toBech32(nonceUtxo.address),
          input.asset,
          BigInt(input.amount),
          coinsPerUtxoByte,
        );
        datum = lock.datum;
        // The escrow output carries EXACTLY the requested asset set with
        // exactly `requestedLovelace + collateral` lovelace — autoMinUtxo would
        // bump the coin and break that equality, so it stays off.
        autoMinUtxo = false;
        outputAssets = isLovelace
          ? Assets.fromLovelace(lock.lockedLovelace)
          : (() => {
              const { policyId, assetNameHex } = parseAssetUnit(input.asset);
              return Assets.addByHex(
                Assets.fromLovelace(lock.lockedLovelace),
                policyId,
                assetNameHex,
                BigInt(input.amount),
              );
            })();
      }

      // Masumi: pin the validity upper bound to pay_by_time. The facilitator
      // rejects a lock whose TTL could settle after the deadline, so the
      // transaction must be unable to land past it. Other methods use
      // maxTimeoutSeconds.
      const ttlMs =
        method === "masumi"
          ? BigInt(masumiExtra!.terms.payByTime)
          : BigInt(Date.now()) + BigInt(input.maxTimeoutSeconds) * 1000n;

      const signBuilder = await client
        .newTx()
        .collectFrom({ inputs: [nonceUtxo] })
        .payToAddress({
          address: Address.fromBech32(input.payTo),
          assets: outputAssets,
          ...(datum ? { datum } : {}),
        })
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

      // ── Submission mode ───────────────────────────────────────────────────
      //
      // `server`: hand the signed transaction over unbroadcast — the resource
      //   server or facilitator submits it after verifying.
      // `client`: broadcast NOW, before the paid retry. The facilitator then
      //   MUST NOT submit it again; it authenticates settlement evidence for
      //   this exact transaction instead. That means the retry only succeeds
      //   once the chain has actually seen it, so this path is slower to
      //   report success — that is the protocol working, not a bug.
      const transaction = Buffer.from(Transaction.toCBORBytes(signed)).toString("base64");
      if (input.submissionMode === "client") {
        // The canonical transaction id is the hash of the BODY bytes, computed
        // exactly as the facilitator does, so the evidence lookup matches.
        const txBytes = Uint8Array.from(Buffer.from(transaction, "base64"));
        const txHash = TransactionHash.toHex(
          TransactionBody.toHashFromBytes(Transaction.extractBodyBytes(txBytes)),
        );

        // Broadcast through the WALLET (CIP-30 `submitTx`), not through this
        // page's Blockfrost project. In client submission mode the protocol
        // point is that the *payer* puts the transaction on chain, and the
        // payer here is the wallet — using the demo's own provider key would
        // make the page the broadcaster while calling it client submission.
        // Evolution's submitBuilder.submit() delegates to the provider, which
        // is why it is not used on this path.
        //
        // The exact bytes handed to the facilitator are the bytes submitted:
        // hex of the same base64 above, so neither side re-serializes.
        const submitted = await (walletApi as Cip30WalletApi).submitTx(
          Buffer.from(transaction, "base64").toString("hex"),
        );
        // A wallet that re-serialized the transaction would put a DIFFERENT id
        // on chain, and the facilitator — which hashes the bytes it was given —
        // would then look for a transaction that does not exist. Say so now
        // rather than after a three-minute wait for evidence that cannot come.
        if (typeof submitted === "string" && submitted.toLowerCase() !== txHash.toLowerCase()) {
          throw new Error(
            `Your wallet broadcast ${submitted}, but the payment sent to the server hashes to ` +
              `${txHash}. The wallet re-encoded the transaction, so the facilitator cannot ` +
              "authenticate it. Try server submission instead.",
          );
        }
        // No chain polling here on purpose. Whether the network has really seen
        // this transaction is the FACILITATOR's question — it holds the
        // provider credentials and the confirmation policy. The client simply
        // presents the payment and retries while the answer is "not yet"; see
        // payWithRetry() in ./flow.ts.
      }

      return {
        transaction,
        nonce,
        submissionMode: input.submissionMode,
        // L1 only: this demo drives no Hydra head.
        ...(method === "masumi" ? { settlementLayer: "l1" as const } : {}),
      };
    },
  };
}
