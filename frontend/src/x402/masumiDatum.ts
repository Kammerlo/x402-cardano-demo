/**
 * Masumi escrow-lock datum builder for the frontend CIP-30 signer.
 *
 * Builds the 19-field `Constr 0` inline Plutus datum documented in
 * `docs/superpowers/plans/2026-07-06-masumi-extension.md` (Task M3 / Global
 * Constraints), mirroring the normative TS reference BYTE-FOR-BYTE:
 * `../x402/typescript/packages/mechanisms/cardano/src/exact/masumi/datum.ts`
 * (`buildMasumiLockDatum` / `addressToData` / `credentialToData`). Any
 * deviation from datum.ts's Constr indices, field order, or address-datum
 * shape will make the facilitator's `MasumiTransferVerifier` reject the lock
 * with `MASUMI_DATUM_INVALID` or `MASUMI_DATUM_MISMATCH` — see
 * `facilitator/src/main/java/org/x402cardano/facilitator/cardano/MasumiTransferVerifier.java`
 * for the parser this datum must satisfy.
 *
 * The address-Constr shape (`Constr 0 [paymentCred, stakeOption]`) is
 * hand-rolled here with `Data.constr` rather than delegated to Evolution's
 * `Plutus.Address.Codec.toData` — that helper takes a structured
 * `{ payment_credential, stake_credential }` object (not a bech32 string),
 * and its Some/None/Inline nesting is easy to get subtly wrong from memory.
 * Hand-rolling keeps the byte-for-byte match with datum.ts explicit and
 * auditable (its resulting shape was independently cross-checked against a
 * live-executed `Plutus.Address.Codec.toData` call, which agrees).
 */
import { Address, Credential, Data, InlineDatum } from "@evolution-sdk/evolution";

/** A payment or stake credential extracted from a bech32 address. */
interface MasumiCredential {
  isScript: boolean;
  hash: string;
}

/** A bech32 address split into its payment + optional stake credential. */
interface MasumiAddressCredentials {
  payment: MasumiCredential;
  stake?: MasumiCredential;
}

/** The state constructor index for a fresh lock (`FundsLocked`). */
const MASUMI_STATE_FUNDS_LOCKED = 0n;

/**
 * Lowercases and validates a hex string (even length, `[0-9a-f]*` only).
 *
 * @param value - The candidate hex string.
 * @param field - Field name used in the thrown error message.
 * @returns The lowercased hex string.
 */
export function hex(value: string, field = "value"): string {
  const lower = value.toLowerCase();
  if (lower.length % 2 !== 0 || !/^[0-9a-f]*$/.test(lower)) {
    throw new Error(`Masumi datum field "${field}" is not valid hex: "${value}"`);
  }
  return lower;
}

/**
 * Encodes a credential as Plutus data: `Constr 0 [hash]` for a key
 * credential, `Constr 1 [hash]` for a script credential (Aiken convention).
 * Mirrors datum.ts `credentialToData`.
 *
 * @param cred - The credential to encode.
 * @returns The Plutus data credential.
 */
function credentialToData(cred: MasumiCredential): Data.Data {
  return Data.constr(cred.isScript ? 1n : 0n, [Data.bytearray(cred.hash)]);
}

/**
 * Asserts a credential-hash hex string is exactly the raw 28-byte hash (56
 * lowercase hex chars, no CBOR/tag wrapping). The Java facilitator's
 * `MasumiTransferVerifier` compares this datum's credential bytes against raw
 * 28-byte hashes; if Evolution's `Credential.toHex` ever changed shape (e.g.
 * started including a CBOR tag or a differently-sized hash), the mismatch
 * would otherwise surface only as a silent `MASUMI_DATUM_MISMATCH` /
 * `MASUMI_DATUM_INVALID` rejection at the facilitator. This turns that into
 * an immediate, loud failure here instead.
 *
 * @param value - The lowercased candidate credential-hash hex string.
 * @returns The same hex string, once validated.
 */
function assertCredentialHashHex(value: string): string {
  if (!/^[0-9a-f]{56}$/.test(value)) {
    throw new Error(
      `Masumi datum: expected 28-byte credential hash, got ${value} (${value.length} chars) — Evolution Credential encoding may have changed`,
    );
  }
  return value;
}

/**
 * Extracts the payment and (optional) stake credentials of a bech32 address.
 * Mirrors datum.ts `addressCredentials`.
 *
 * @param bech32 - The Cardano address.
 * @returns Its payment credential and, for base addresses, its stake credential.
 */
function addressCredentials(bech32: string): MasumiAddressCredentials {
  const parsed = Address.fromBech32(bech32);
  const payment: MasumiCredential = {
    isScript: parsed.paymentCredential._tag === "ScriptHash",
    hash: assertCredentialHashHex(Credential.toHex(parsed.paymentCredential).toLowerCase()),
  };
  if (!parsed.stakingCredential) {
    return { payment };
  }
  return {
    payment,
    stake: {
      isScript: parsed.stakingCredential._tag === "ScriptHash",
      hash: assertCredentialHashHex(Credential.toHex(parsed.stakingCredential).toLowerCase()),
    },
  };
}

/**
 * Encodes a bech32 address as the Plutus `Address` datum shape:
 * `Constr 0 [paymentCred, stakeOption]`; `stakeOption` = `Constr 1 []`
 * (None) or `Constr 0 [Constr 0 [cred]]` (Some -> Inline) when a stake
 * credential exists. Mirrors datum.ts `addressToData` byte-for-byte.
 *
 * @param bech32 - The Cardano address.
 * @returns The Plutus data address.
 */
function addressToData(bech32: string): Data.Data {
  const creds = addressCredentials(bech32);
  const stakeOption = creds.stake
    ? Data.constr(0n, [Data.constr(0n, [credentialToData(creds.stake)])]) // Some(Inline(cred))
    : Data.constr(1n, []); // None
  return Data.constr(0n, [credentialToData(creds.payment), stakeOption]);
}

/**
 * Encodes an optional address as `Some(address)` / `None`. Mirrors datum.ts
 * `optionAddressToData`.
 *
 * @param bech32 - The optional Cardano address.
 * @returns `Constr 0 [address]` when present, else `Constr 1 []`.
 */
function optionAddressToData(bech32: string | undefined): Data.Data {
  return bech32 ? Data.constr(0n, [addressToData(bech32)]) : Data.constr(1n, []);
}

/**
 * Reads a required string field from the masumi `extra` block. These values
 * are purchase-bound (supplied by the server / Masumi Payment Service in a
 * real deployment); an absent value is a caller error.
 *
 * @param extra - The masumi `extra` block.
 * @param key - The required field name.
 * @returns The field value.
 */
function requireStr(extra: Record<string, unknown>, key: string): string {
  const value = extra[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Masumi payment requires "${key}" in requirements.extra`);
  }
  return value;
}

/**
 * Reads an optional string field from the masumi `extra` block.
 *
 * @param extra - The masumi `extra` block.
 * @param key - The optional field name.
 * @returns The field value, or `undefined` when absent / not a string.
 */
function optionalStr(extra: Record<string, unknown>, key: string): string | undefined {
  const value = extra[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Builds the Masumi `vested_pay` escrow-lock inline datum (`Constr 0`, 19
 * fields; `state = FundsLocked`, empty `result_hash`, zero cooldowns) from
 * the payment `extra` block and the buyer's bech32 address.
 *
 * In this demo, `extra`'s purchase-identifier fields (referenceKey,
 * referenceSignature, sellerNonce, identifierFromPurchaser, agentIdentifier,
 * inputHash, the four lock-deadline times, collateralReturnLovelace) are
 * // DUMMY: fabricated Masumi purchase identifiers declared by the server
 * (see `server/src/server.ts`'s `/api/message-masumi` route) — a real
 * deployment gets them from the Masumi Payment Service. They are copied here
 * VERBATIM, never regenerated, since the facilitator's
 * `MasumiTransferVerifier` compares them structurally against those exact
 * strings.
 *
 * @param extra - The masumi `extra` block from the payment requirements.
 * @param buyerAddress - The wallet's own bech32 address (= the nonce UTxO
 *   owner = the payer the facilitator resolves). MUST equal what the
 *   facilitator derives as payer, or the buyer-match check fails.
 * @returns The inline datum to attach to the escrow output.
 */
export function buildMasumiLockInline(
  extra: Record<string, unknown>,
  buyerAddress: string,
): InlineDatum.InlineDatum {
  const sellerAddress = requireStr(extra, "sellerAddress"); // real: server's own address
  const buyerReturnAddress = optionalStr(extra, "buyerReturnAddress");
  const sellerReturnAddress = optionalStr(extra, "sellerReturnAddress");

  // DUMMY: fabricated Masumi purchase identifiers (see server.ts) — copied
  // verbatim, not regenerated, so the facilitator's structural comparison matches.
  const referenceKey = hex(requireStr(extra, "referenceKey"), "referenceKey");
  const referenceSignature = hex(requireStr(extra, "referenceSignature"), "referenceSignature");
  const sellerNonce = hex(requireStr(extra, "sellerNonce"), "sellerNonce");
  // DUMMY + NAME MISMATCH: extra's key is `identifierFromPurchaser`; the datum field is `buyer_nonce` (f7).
  const buyerNonce = hex(requireStr(extra, "identifierFromPurchaser"), "identifierFromPurchaser");
  const agentIdentifier = hex(requireStr(extra, "agentIdentifier"), "agentIdentifier");
  const inputHash = hex(optionalStr(extra, "inputHash") ?? "", "inputHash"); // DUMMY default: empty

  const collateralReturnLovelaceRaw = optionalStr(extra, "collateralReturnLovelace");
  const collateralReturnLovelace =
    collateralReturnLovelaceRaw !== undefined ? BigInt(collateralReturnLovelaceRaw) : 0n; // DUMMY default: 0

  // DUMMY: fabricated POSIX-ms lock deadlines (see server.ts).
  const payByTime = BigInt(requireStr(extra, "payByTime"));
  const submitResultTime = BigInt(requireStr(extra, "submitResultTime"));
  const unlockTime = BigInt(requireStr(extra, "unlockTime"));
  const externalDisputeUnlockTime = BigInt(requireStr(extra, "externalDisputeUnlockTime"));

  const datum = Data.constr(0n, [
    addressToData(buyerAddress), // 0 buyer = the wallet's own address (real, derived from the nonce UTxO)
    optionAddressToData(buyerReturnAddress), // 1 buyer_return_address
    addressToData(sellerAddress), // 2 seller = extra.sellerAddress (real, server's address)
    optionAddressToData(sellerReturnAddress), // 3 seller_return_address
    Data.bytearray(referenceKey), // 4 reference_key
    Data.bytearray(referenceSignature), // 5 reference_signature
    Data.bytearray(sellerNonce), // 6 seller_nonce
    Data.bytearray(buyerNonce), // 7 buyer_nonce (extra.identifierFromPurchaser)
    Data.bytearray(agentIdentifier), // 8 agent_identifier
    Data.int(collateralReturnLovelace), // 9 collateral_return_lovelace
    Data.bytearray(inputHash), // 10 input_hash
    Data.bytearray(""), // 11 result_hash = empty (constant at lock)
    Data.int(payByTime), // 12 pay_by_time
    Data.int(submitResultTime), // 13 submit_result_time
    Data.int(unlockTime), // 14 unlock_time
    Data.int(externalDisputeUnlockTime), // 15 external_dispute_unlock_time
    Data.int(0n), // 16 seller_cooldown_time (constant 0)
    Data.int(0n), // 17 buyer_cooldown_time (constant 0)
    Data.constr(MASUMI_STATE_FUNDS_LOCKED, []), // 18 state = FundsLocked (constant)
  ]);

  return new InlineDatum.InlineDatum({ data: datum });
}
