// MasumiTransferVerifier.java
package org.x402cardano.facilitator.cardano;

import com.bloxbean.cardano.client.address.Address;
import com.bloxbean.cardano.client.address.Credential;
import com.bloxbean.cardano.client.address.CredentialType;
import com.bloxbean.cardano.client.plutus.spec.BigIntPlutusData;
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ConstrPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.util.HexUtil;
import org.x402cardano.facilitator.protocol.PaymentRequirements;

import java.math.BigInteger;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Port of TS's {@code verifyMasumiLock}
 * (../x402/typescript/packages/mechanisms/cardano/src/exact/masumi/verify.ts), which
 * verifies that a payment locks funds into the masumi escrow (a dummy recoverable
 * stand-in for the real {@code vested_pay} contract in this demo) with a well-formed
 * {@code FundsLocked} datum matching the requirements. Check order and error codes are
 * wire-identical to the TS reference; only the on-chain lock is checked (x402's scope).
 *
 * Datum field encoding mirrors
 * ../x402/typescript/packages/mechanisms/cardano/src/exact/masumi/datum.ts byte-for-byte
 * (19-field {@code Constr 0}; addresses as {@code Constr 0 [paymentCred, stakeOption]}).
 * All datum fields are compared STRUCTURALLY (credential-hash bytes / BigInteger /
 * byte[]), never by datum-hex, since Evolution (the frontend) emits indefinite-length
 * CBOR while cardano-client-lib re-serializes definite-length -- hex equality would
 * spuriously fail even for an identical datum.
 */
public class MasumiTransferVerifier implements AssetTransferMethodVerifier {

    private static final int RESULT_HASH_FIELD = 11;
    private static final int STATE_FIELD = 18;

    @Override
    public boolean supports(String method) {
        return "masumi".equals(method);
    }

    @Override
    public Optional<String> check(Map<String, Object> extra, PaymentRequirements requirements,
                                   DecodedTransaction tx, String payer) {
        // STEP 1: extra.contractAddress must be declared and match payTo. Not defaulted --
        // locking to the wrong escrow silently strands the funds.
        String contractAddress = str(extra, "contractAddress");
        if (contractAddress == null || !contractAddress.equals(requirements.payTo())) {
            return Optional.of(ErrorCodes.MASUMI_CONTRACT_MISMATCH);
        }

        // STEP 2: locate the escrow output (>= amount) carrying an inline datum.
        BigInteger requested = new BigInteger(requirements.amount());
        DecodedTransaction.Output output = null;
        for (DecodedTransaction.Output o : tx.outputs()) {
            if (o.address().equals(requirements.payTo())
                    && o.coin().compareTo(requested) >= 0
                    && o.raw().getInlineDatum() != null) {
                output = o;
                break;
            }
        }
        if (output == null) {
            return Optional.of(ErrorCodes.MASUMI_DATUM_MISSING);
        }

        try {
            PlutusData datum = output.raw().getInlineDatum();
            ConstrPlutusData root = (ConstrPlutusData) datum;
            if (root.getAlternative() != 0) return Optional.of(ErrorCodes.MASUMI_DATUM_INVALID);
            List<PlutusData> f = root.getData().getPlutusDataList();
            if (f.size() != 19) return Optional.of(ErrorCodes.MASUMI_DATUM_INVALID);

            // STEP 3: structural invariants of a fresh lock (the validator never checks
            // these on lock, so a wrong datum would strand funds -- reject up front).
            ConstrPlutusData state = (ConstrPlutusData) f.get(STATE_FIELD);
            if (state.getAlternative() != 0 || !state.getData().getPlutusDataList().isEmpty()) {
                return Optional.of(ErrorCodes.MASUMI_DATUM_INVALID);
            }
            byte[] resultHash = ((BytesPlutusData) f.get(RESULT_HASH_FIELD)).getValue();
            if (resultHash.length != 0) return Optional.of(ErrorCodes.MASUMI_DATUM_INVALID);

            BigInteger collateral = ((BigIntPlutusData) f.get(9)).getValue();
            if (collateral.signum() < 0) return Optional.of(ErrorCodes.MASUMI_DATUM_INVALID);

            AddrCreds datumBuyer = parseAddressDatum(f.get(0));
            AddrCreds datumSeller = parseAddressDatum(f.get(2));
            if (datumBuyer == null || datumSeller == null) return Optional.of(ErrorCodes.MASUMI_DATUM_INVALID);
            if (datumBuyer.payment.isScript() || datumSeller.payment.isScript()) {
                return Optional.of(ErrorCodes.MASUMI_DATUM_INVALID);
            }

            // reference_signature: >= 16 bytes.
            byte[] referenceSignature = ((BytesPlutusData) f.get(5)).getValue();
            if (referenceSignature.length < 16) return Optional.of(ErrorCodes.MASUMI_DATUM_INVALID);

            // Time ordering: pay_by <= submit_result <= unlock <= external_dispute_unlock.
            BigInteger payByTime = ((BigIntPlutusData) f.get(12)).getValue();
            BigInteger submitResultTime = ((BigIntPlutusData) f.get(13)).getValue();
            BigInteger unlockTime = ((BigIntPlutusData) f.get(14)).getValue();
            BigInteger externalDisputeUnlockTime = ((BigIntPlutusData) f.get(15)).getValue();
            if (payByTime.compareTo(submitResultTime) > 0
                    || submitResultTime.compareTo(unlockTime) > 0
                    || unlockTime.compareTo(externalDisputeUnlockTime) > 0) {
                return Optional.of(ErrorCodes.MASUMI_DATUM_INVALID);
            }

            // f16 seller_cooldown_time / f17 buyer_cooldown_time: unused by the checks
            // but TS parseMasumiLockDatum reads BOTH as asInt (returns null ->
            // MASUMI_DATUM_INVALID if either is not an integer). Read them to enforce the
            // same "all 19 fields well-typed" contract -- a ClassCastException here is
            // caught below. No value constraint (TS only requires they're ints; they're
            // constant 0 at lock but TS doesn't enforce the 0).
            ((BigIntPlutusData) f.get(16)).getValue();
            ((BigIntPlutusData) f.get(17)).getValue();

            // STEP 4: field matching against the canonical requirements' extra.
            // buyer MUST be the payer; seller MUST be the declared seller.
            if (!sameCredentials(datumBuyer, addressCredentials(payer))) {
                return Optional.of(ErrorCodes.MASUMI_DATUM_MISMATCH);
            }
            String sellerAddress = str(extra, "sellerAddress");
            if (sellerAddress == null || !sameCredentials(datumSeller, addressCredentials(sellerAddress))) {
                return Optional.of(ErrorCodes.MASUMI_DATUM_MISMATCH);
            }

            // Server-declared datum fields, when present, MUST match the datum. Fields
            // the server omits are client-filled (random/default) and only invariant-checked.
            byte[] referenceKey = ((BytesPlutusData) f.get(4)).getValue();
            byte[] sellerNonce = ((BytesPlutusData) f.get(6)).getValue();
            byte[] buyerNonce = ((BytesPlutusData) f.get(7)).getValue();
            byte[] agentIdentifier = ((BytesPlutusData) f.get(8)).getValue();
            byte[] inputHash = ((BytesPlutusData) f.get(10)).getValue();

            if (!hexFieldOk(extra, "referenceKey", referenceKey)) return Optional.of(ErrorCodes.MASUMI_DATUM_MISMATCH);
            if (!hexFieldOk(extra, "referenceSignature", referenceSignature)) return Optional.of(ErrorCodes.MASUMI_DATUM_MISMATCH);
            if (!hexFieldOk(extra, "sellerNonce", sellerNonce)) return Optional.of(ErrorCodes.MASUMI_DATUM_MISMATCH);
            if (!hexFieldOk(extra, "identifierFromPurchaser", buyerNonce)) return Optional.of(ErrorCodes.MASUMI_DATUM_MISMATCH);
            if (!hexFieldOk(extra, "agentIdentifier", agentIdentifier)) return Optional.of(ErrorCodes.MASUMI_DATUM_MISMATCH);
            if (!hexFieldOk(extra, "inputHash", inputHash)) return Optional.of(ErrorCodes.MASUMI_DATUM_MISMATCH);

            if (!timeFieldOk(extra, "payByTime", payByTime)) return Optional.of(ErrorCodes.MASUMI_DATUM_MISMATCH);
            if (!timeFieldOk(extra, "submitResultTime", submitResultTime)) return Optional.of(ErrorCodes.MASUMI_DATUM_MISMATCH);
            if (!timeFieldOk(extra, "unlockTime", unlockTime)) return Optional.of(ErrorCodes.MASUMI_DATUM_MISMATCH);
            if (!timeFieldOk(extra, "externalDisputeUnlockTime", externalDisputeUnlockTime)) return Optional.of(ErrorCodes.MASUMI_DATUM_MISMATCH);
            if (!timeFieldOk(extra, "collateralReturnLovelace", collateral)) return Optional.of(ErrorCodes.MASUMI_DATUM_MISMATCH);

            return Optional.empty();
        } catch (RuntimeException e) {
            // ClassCastException / NPE / index-out-of-bounds from any malformed datum shape.
            return Optional.of(ErrorCodes.MASUMI_DATUM_INVALID);
        }
    }

    /** A payment or stake credential: whether it is a script hash, and the hash bytes. */
    private record Cred(boolean isScript, byte[] hash) {}

    /** An address's payment credential plus its stake-hash-or-"" (isScript not tracked -- TS parity). */
    private record AddrCreds(Cred payment, String stakeHex) {}

    private static boolean sameCredentials(AddrCreds a, AddrCreds b) {
        if (a.payment.isScript() != b.payment.isScript()) return false;
        if (!Arrays.equals(a.payment.hash(), b.payment.hash())) return false;
        return a.stakeHex().equals(b.stakeHex());
    }

    /** Extracts the payment + optional stake credential of a bech32 address. */
    private static AddrCreds addressCredentials(String bech32) {
        Address addr = new Address(bech32);
        Credential pc = addr.getPaymentCredential().orElseThrow();
        Cred payment = new Cred(pc.getType() == CredentialType.Script, pc.getBytes());
        String stakeHex = addr.getDelegationCredentialHash()
                .map(b -> HexUtil.encodeHexString(b).toLowerCase())
                .orElse("");
        return new AddrCreds(payment, stakeHex);
    }

    /**
     * Decodes a masumi {@code Address} datum ({@code Constr 0 [paymentCred, stakeOption]})
     * into its credentials. Returns null on any structural mismatch (caught by the
     * caller's try/catch as MASUMI_DATUM_INVALID when it isn't checked explicitly).
     */
    private static AddrCreds parseAddressDatum(PlutusData d) {
        ConstrPlutusData addr = (ConstrPlutusData) d;
        if (addr.getAlternative() != 0) return null;
        List<PlutusData> fields = addr.getData().getPlutusDataList();
        if (fields.size() != 2) return null;
        Cred payment = parseCredentialDatum(fields.get(0));
        if (payment == null) return null;

        ConstrPlutusData stakeOption = (ConstrPlutusData) fields.get(1);
        if (stakeOption.getAlternative() == 1) {
            return new AddrCreds(payment, ""); // None
        }
        if (stakeOption.getAlternative() != 0) return null;
        List<PlutusData> some = stakeOption.getData().getPlutusDataList();
        if (some.size() != 1) return null;
        ConstrPlutusData inline = (ConstrPlutusData) some.get(0); // Inline(cred)
        if (inline.getAlternative() != 0) return null;
        List<PlutusData> inlineFields = inline.getData().getPlutusDataList();
        if (inlineFields.size() != 1) return null;
        Cred stake = parseCredentialDatum(inlineFields.get(0));
        if (stake == null) return null;
        return new AddrCreds(payment, HexUtil.encodeHexString(stake.hash()).toLowerCase());
    }

    /** Decodes a Plutus credential ({@code Constr 0|1 [bytes]}) into a typed credential. */
    private static Cred parseCredentialDatum(PlutusData d) {
        ConstrPlutusData c = (ConstrPlutusData) d;
        long alt = c.getAlternative();
        if (alt != 0 && alt != 1) return null;
        List<PlutusData> fields = c.getData().getPlutusDataList();
        if (fields.size() != 1) return null;
        byte[] hash = ((BytesPlutusData) fields.get(0)).getValue();
        return new Cred(alt == 1, hash);
    }

    private static String str(Map<String, Object> extra, String key) {
        Object v = extra == null ? null : extra.get(key);
        return v instanceof String s ? s : null;
    }

    /** True when the field is omitted (skip), or its lowercase hex matches the datum bytes. */
    private static boolean hexFieldOk(Map<String, Object> extra, String key, byte[] actual) {
        String declared = str(extra, key);
        if (declared == null) return true;
        return declared.equalsIgnoreCase(HexUtil.encodeHexString(actual));
    }

    /** True when the field is omitted (skip), or its BigInteger value matches the datum. */
    private static boolean timeFieldOk(Map<String, Object> extra, String key, BigInteger actual) {
        String declared = str(extra, key);
        if (declared == null) return true;
        return new BigInteger(declared).equals(actual);
    }
}
