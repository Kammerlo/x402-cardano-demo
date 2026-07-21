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
 *   output = payTo receives the requested lovelace
 *   TTL    = now + maxTimeoutSeconds (verification rule 6)
 */
import {
  Address,
  Assets,
  Client,
  Transaction,
  preprod,
} from "@evolution-sdk/evolution";
import {
  buildMasumiLockInline,
  type CardanoExtraMasumi,
  type ClientCardanoSigner,
  type ClientCardanoSignInput,
} from "@x402/cardano";

export interface Cip30WalletApi {
  // Minimal CIP-30 surface we rely on (window.cardano.<wallet>.enable() result).
  getNetworkId(): Promise<number>;
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
      if (input.asset.toLowerCase() !== "lovelace") {
        throw new Error(`This demo signer only pays lovelace, got: ${input.asset}`);
      }

      const utxos = await client.getWalletUtxos();
      if (utxos.length === 0) throw new Error("Wallet has no UTxOs — fund it at the preprod faucet");

      // The first wallet UTxO becomes the x402 nonce. collectFrom() guarantees
      // it appears as a transaction input; settling spends it, which is what
      // makes the payment replay-proof.
      const nonceUtxo = utxos[0];
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
      // A datum-bearing output needs extra min-ADA above the plain-lovelace
      // minimum, so autoMinUtxo only applies to the masumi (datum) path — the
      // "default" address-to-address path builds exactly as it did before
      // this extension.
      const autoMinUtxo = method === "masumi";

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
          assets: Assets.fromLovelace(BigInt(input.amount)),
          ...(datum ? { datum } : {}),
        })
        // Wall-clock ms; the SDK converts it to the TTL slot. For masumi the
        // upper bound is anchored to the datum's pay_by_time so the lock can
        // never settle past the escrow deadline — the facilitator rejects a
        // masumi lock whose TTL could land after it. Other methods just use
        // maxTimeoutSeconds.
        .setValidity({ to: ttlMs })
        .build({ changeAddress: await client.address(), autoMinUtxo });

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
