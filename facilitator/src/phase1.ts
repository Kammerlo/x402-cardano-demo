/**
 * Cardano ledger phase-1 validation, required before SERVER submission.
 *
 * WHY THIS EXISTS. In server mode the resource server releases what the buyer
 * paid for *before* the facilitator broadcasts. If the transaction is then
 * rejected by the ledger, the buyer got the resource and the seller got
 * nothing. So `@x402/cardano` refuses to advertise or accept server submission
 * unless the operator supplies a validator that proves the exact signed
 * transaction would be accepted. It ships none itself, on purpose: the answer
 * depends on the chain provider, and an approximation here is worse than no
 * server mode at all. (Client mode needs none — the chain has already accepted
 * the transaction, and the facilitator authenticates that evidence.)
 *
 * WHAT IT COVERS. The `verify()` rules already establish that the payment is
 * *correct for the 402*: an output pays the right asset and amount to the right
 * address, the nonce is unspent, the TTL is within `maxTimeoutSeconds`. None of
 * that means the LEDGER will take it. This adds the ledger's own arithmetic:
 * value conservation, fee sufficiency, witness coverage and validity, size and
 * min-UTxO limits, and the validity interval against the live tip.
 *
 * HOW IT STAYS COMPLETE RATHER THAN APPROXIMATE. Value conservation is only
 * decidable from inputs and outputs when nothing else moves value — a mint,
 * withdrawal, certificate or deposit all change the equation. The decoder
 * reports every such feature in `unsupportedPhase1Operations`, and this
 * validator REFUSES any transaction carrying one. Within the shape it does
 * accept (a plain signed payment), the check is exact rather than heuristic:
 * that is the trade this makes to be honest about "complete".
 *
 * Two rules are deliberately STRICTER than the ledger, never weaker, because a
 * pre-submission gate may reject a valid transaction but must never pass an
 * invalid one:
 *   - the whole serialized output is measured against `max_val_size`, which
 *     bounds only the value inside it;
 *   - every input must be controlled by a payment KEY, so a vkey witness can be
 *     required for it. Script- and Byron-controlled inputs are refused rather
 *     than assumed authorized.
 */
import {
  decodeCardanoTransaction,
  decodeCardanoTransactionBytes,
  minUtxoLovelace,
  type CardanoUtxoSnapshot,
} from "@x402/cardano";

/** The protocol parameters phase-1 arithmetic depends on. */
interface ProtocolParameters {
  minFeeA: bigint;
  minFeeB: bigint;
  maxTxSize: number;
  maxValSize: number;
  coinsPerUtxoByte: bigint;
}

/**
 * How long fetched protocol parameters stay usable.
 *
 * They change at epoch boundaries, so caching them forever would eventually
 * validate against rules the chain no longer applies — and the failure would be
 * a submission rejection after the resource was already released. Five minutes
 * is far below an epoch and costs one request per window.
 */
const PARAMETERS_TTL_MS = 5 * 60_000;

export interface Phase1Dependencies {
  /** UTXO lookup, used to price and authorize every input. */
  getUtxo(ref: string, network: string): Promise<CardanoUtxoSnapshot>;
  /** Current absolute slot, used for the validity interval. */
  getCurrentSlot(network: string): Promise<bigint>;
  blockfrost: { baseUrl: string; projectId: string };
}

/**
 * Builds the `validatePhase1Transaction` callback the facilitator signer takes.
 *
 * @param deps - Chain access used to price inputs and read the live tip.
 * @returns A validator that resolves when the transaction would be accepted,
 *   and throws with the reason when it would not.
 */
export function createPhase1Validator(
  deps: Phase1Dependencies,
): (signedTransactionBase64: string, network: string) => Promise<void> {
  let cached: { at: number; parameters: ProtocolParameters } | null = null;

  async function protocolParameters(): Promise<ProtocolParameters> {
    if (cached && Date.now() - cached.at < PARAMETERS_TTL_MS) return cached.parameters;
    const res = await fetch(`${deps.blockfrost.baseUrl}/epochs/latest/parameters`, {
      headers: { project_id: deps.blockfrost.projectId },
    });
    if (!res.ok) throw new Error(`could not read protocol parameters (HTTP ${res.status})`);
    const raw = (await res.json()) as Record<string, unknown>;
    const parameters: ProtocolParameters = {
      minFeeA: BigInt(String(raw.min_fee_a)),
      minFeeB: BigInt(String(raw.min_fee_b)),
      maxTxSize: Number(raw.max_tx_size),
      maxValSize: Number(raw.max_val_size),
      coinsPerUtxoByte: BigInt(String(raw.coins_per_utxo_size)),
    };
    if (
      !Number.isFinite(parameters.maxTxSize) ||
      !Number.isFinite(parameters.maxValSize) ||
      parameters.coinsPerUtxoByte <= 0n
    ) {
      throw new Error("protocol parameters are incomplete");
    }
    cached = { at: Date.now(), parameters };
    return parameters;
  }

  return async function validatePhase1Transaction(
    signedTransactionBase64: string,
    network: string,
  ): Promise<void> {
    const decoded = decodeCardanoTransaction(signedTransactionBase64);

    // ── Shape: everything below assumes value moves only through inputs and
    //    outputs. Anything else and the conservation check would be a guess.
    if (decoded.unsupportedPhase1Operations.length > 0) {
      throw new Error(
        `transaction carries balance-changing operations this validator cannot price: ` +
          `${decoded.unsupportedPhase1Operations.join(", ")}`,
      );
    }
    if (!decoded.isValid) throw new Error("transaction is flagged invalid");
    if (decoded.scriptWitnessCount > 0) {
      throw new Error("script witnesses require phase-2 evaluation, which this validator omits");
    }
    if (decoded.inputs.length === 0) throw new Error("transaction has no inputs");
    if (new Set(decoded.inputs).size !== decoded.inputs.length) {
      throw new Error("transaction spends the same input twice");
    }

    // ── Witnesses. `signaturesValid` verifies each signature against the body
    //    hash; on its own that only proves SOMEONE signed. Coverage below is
    //    what proves the signers actually control the funds being spent.
    if (decoded.vkeyWitnessCount === 0) throw new Error("transaction carries no vkey witness");
    if (!decoded.signaturesValid) throw new Error("a vkey witness signature does not verify");

    const expectedNetworkId = network.endsWith(":mainnet") ? 1 : 0;
    if (decoded.networkId !== undefined && decoded.networkId !== expectedNetworkId) {
      throw new Error(
        `transaction declares network id ${decoded.networkId}, expected ${expectedNetworkId}`,
      );
    }

    const parameters = await protocolParameters();

    // ── Size and fee. The fee is checked against the ACTUAL serialized size,
    //    which is why this runs on the exact bytes rather than a rebuild.
    const size = decodeCardanoTransactionBytes(signedTransactionBase64).length;
    if (size > parameters.maxTxSize) {
      throw new Error(`transaction is ${size} bytes, over the ${parameters.maxTxSize} limit`);
    }
    const minFee = parameters.minFeeA * BigInt(size) + parameters.minFeeB;
    if (decoded.fee < minFee) {
      throw new Error(`fee ${decoded.fee} is below the ${minFee} required for ${size} bytes`);
    }

    // ── Outputs: each must be self-sustaining under min-UTxO.
    for (const [index, output] of decoded.outputs.entries()) {
      // Both limits below are measured on the serialized output, so an output
      // whose size the decoder could not report cannot be checked at all —
      // refuse it rather than let it through unmeasured.
      if (output.serializedSize === undefined) {
        throw new Error(`output ${index} has no measurable serialized size`);
      }
      const required = minUtxoLovelace(output.serializedSize, parameters.coinsPerUtxoByte);
      if (output.coin < required) {
        throw new Error(
          `output ${index} to ${output.address} holds ${output.coin} lovelace, min-UTXO requires ${required}`,
        );
      }
      if (output.serializedSize > parameters.maxValSize) {
        throw new Error(
          `output ${index} serializes to ${output.serializedSize} bytes, over the ${parameters.maxValSize} value limit`,
        );
      }
    }

    // ── Validity interval against the live tip. A transaction whose window has
    //    closed is rejected on submission, so catching it here is the whole
    //    point of validating before the resource is released.
    const slot = await deps.getCurrentSlot(network);
    if (decoded.validityStartSlot !== undefined && decoded.validityStartSlot > slot) {
      throw new Error(`transaction is not valid until slot ${decoded.validityStartSlot} (now ${slot})`);
    }
    if (decoded.ttlSlot !== undefined && decoded.ttlSlot <= slot) {
      throw new Error(`transaction expired at slot ${decoded.ttlSlot} (now ${slot})`);
    }

    // ── Inputs: exist, are key-controlled, and are witnessed.
    const snapshots = await Promise.all(
      decoded.inputs.map(ref => deps.getUtxo(ref, network).then(snapshot => ({ ref, snapshot }))),
    );
    const witnessed = new Set(decoded.vkeyHashes.map(hash => hash.toLowerCase()));
    let inputCoin = 0n;
    const inputAssets: Record<string, bigint> = {};
    for (const { ref, snapshot } of snapshots) {
      if (!snapshot.exists) throw new Error(`input ${ref} is not in the UTXO set`);
      if (snapshot.coin === undefined) {
        throw new Error(`input ${ref} has no readable lovelace amount`);
      }
      if (!snapshot.paymentKeyHash) {
        throw new Error(
          `input ${ref} is not controlled by a payment key, so no vkey witness can authorize it`,
        );
      }
      if (!witnessed.has(snapshot.paymentKeyHash.toLowerCase())) {
        throw new Error(`input ${ref} is not witnessed by its controlling key`);
      }
      inputCoin += snapshot.coin;
      for (const [unit, quantity] of Object.entries(snapshot.assets ?? {})) {
        inputAssets[unit] = (inputAssets[unit] ?? 0n) + quantity;
      }
    }

    // ── Value conservation. With no mint, withdrawal, certificate or deposit in
    //    play (refused above), the ledger's equation reduces to exact equality.
    let outputCoin = 0n;
    const outputAssets: Record<string, bigint> = {};
    for (const output of decoded.outputs) {
      outputCoin += output.coin;
      for (const [unit, quantity] of Object.entries(output.assets)) {
        outputAssets[unit] = (outputAssets[unit] ?? 0n) + quantity;
      }
    }
    if (inputCoin !== outputCoin + decoded.fee) {
      throw new Error(
        `lovelace does not balance: inputs ${inputCoin}, outputs ${outputCoin}, fee ${decoded.fee}`,
      );
    }
    for (const unit of new Set([...Object.keys(inputAssets), ...Object.keys(outputAssets)])) {
      const produced = outputAssets[unit] ?? 0n;
      const consumed = inputAssets[unit] ?? 0n;
      if (produced !== consumed) {
        throw new Error(`asset ${unit} does not balance: inputs ${consumed}, outputs ${produced}`);
      }
    }
  };
}
