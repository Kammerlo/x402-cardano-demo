package org.x402cardano.facilitator.cardano;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.x402cardano.facilitator.chain.FakeChainService;
import org.x402cardano.facilitator.chain.UtxoInfo;
import org.x402cardano.facilitator.protocol.PaymentPayload;
import org.x402cardano.facilitator.protocol.PaymentRequirements;
import org.x402cardano.facilitator.protocol.VerifyResponse;

import java.math.BigInteger;
import java.time.Duration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Tests for {@link MasumiTransferVerifier}, the Java port of TS's
 * {@code verifyMasumiLock} (../x402/typescript/packages/mechanisms/cardano/src/exact/masumi/verify.ts).
 * Uses the same {@link FakeChainService} setup as {@link ExactCardanoVerifyTest} so the
 * nonce UTxO owner (= {@link TestTx#PAYER_ADDRESS}) resolves as the payer/buyer.
 */
class MasumiTransferVerifierTest {
    FakeChainService chain;
    ExactCardanoFacilitatorScheme scheme;

    @BeforeEach
    void setUp() {
        chain = new FakeChainService();
        chain.utxos.put(TestTx.NONCE, new UtxoInfo(TestTx.PAYER_ADDRESS)); // nonce unspent, owned by payer
        chain.currentSlot = 500_000L;
        scheme = new ExactCardanoFacilitatorScheme(chain, new CardanoTransactionDecoder(),
                new ExactCardanoFacilitatorScheme.SettleConfig(
                        Duration.ofSeconds(5), false, Duration.ofSeconds(120)));
    }

    /** The masumi `extra` block the server would declare, matching TestTx.MasumiSpec.defaults(). */
    static Map<String, Object> defaultExtra() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("assetTransferMethod", "masumi");
        m.put("contractAddress", TestTx.PAY_TO);
        m.put("sellerAddress", TestTx.SELLER_ADDRESS);
        m.put("referenceKey", TestTx.MASUMI_REFERENCE_KEY);
        m.put("referenceSignature", TestTx.MASUMI_REFERENCE_SIGNATURE);
        m.put("sellerNonce", TestTx.MASUMI_SELLER_NONCE);
        m.put("identifierFromPurchaser", TestTx.MASUMI_IDENTIFIER_FROM_PURCHASER);
        m.put("agentIdentifier", TestTx.MASUMI_AGENT_IDENTIFIER);
        m.put("inputHash", TestTx.MASUMI_INPUT_HASH);
        m.put("collateralReturnLovelace", TestTx.MASUMI_COLLATERAL_RETURN_LOVELACE.toString());
        m.put("payByTime", TestTx.MASUMI_PAY_BY_TIME.toString());
        m.put("submitResultTime", TestTx.MASUMI_SUBMIT_RESULT_TIME.toString());
        m.put("unlockTime", TestTx.MASUMI_UNLOCK_TIME.toString());
        m.put("externalDisputeUnlockTime", TestTx.MASUMI_EXTERNAL_DISPUTE_UNLOCK_TIME.toString());
        return m;
    }

    PaymentRequirements requirements(Map<String, Object> extra) {
        return new PaymentRequirements("exact", "cardano:preprod", "lovelace",
                TestTx.MASUMI_AMOUNT.toString(), TestTx.PAY_TO, 600, extra);
    }

    PaymentPayload payload(String txB64, PaymentRequirements accepted) {
        Map<String, Object> p = new HashMap<>();
        p.put("transaction", txB64);
        p.put("nonce", TestTx.NONCE);
        return new PaymentPayload(2, null, accepted, p, null);
    }

    VerifyResponse verify(TestTx.MasumiSpec spec, Map<String, Object> extra) {
        PaymentRequirements req = requirements(extra);
        String tx = TestTx.buildMasumiLockBase64(TestTx.PAY_TO, spec);
        return scheme.verify(payload(tx, req), req);
    }

    VerifyResponse verifyDefault() {
        return verify(TestTx.MasumiSpec.defaults(), defaultExtra());
    }

    @Test void happyPath() {
        VerifyResponse r = verifyDefault();
        assertThat(r.invalidReason()).isNull();
        assertThat(r.isValid()).isTrue();
        assertThat(r.payer()).isEqualTo(TestTx.PAYER_ADDRESS);
    }

    @Test void rejectsContractMismatch() {
        Map<String, Object> extra = defaultExtra();
        extra.put("contractAddress", TestTx.SELLER_ADDRESS); // != requirements.payTo() (PAY_TO)
        VerifyResponse r = verify(TestTx.MasumiSpec.defaults(), extra);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.MASUMI_CONTRACT_MISMATCH);
    }

    @Test void rejectsMissingDatum() {
        // Plain (non-masumi) fixture: pays PAY_TO the masumi amount, but no inline datum.
        String tx = TestTx.buildBase64(TestTx.Spec.defaults().withAmount(TestTx.MASUMI_AMOUNT));
        PaymentRequirements req = requirements(defaultExtra());
        VerifyResponse r = scheme.verify(payload(tx, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.MASUMI_DATUM_MISSING);
    }

    @Test void rejectsWrongConstrAlt() {
        VerifyResponse r = verify(TestTx.MasumiSpec.defaults().withRootAlt(1), defaultExtra());
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.MASUMI_DATUM_INVALID);
    }

    @Test void rejectsWrongFieldCount() {
        VerifyResponse r = verify(TestTx.MasumiSpec.defaults().withFieldCount(18), defaultExtra());
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.MASUMI_DATUM_INVALID);
    }

    @Test void rejectsStateNotFundsLocked() {
        VerifyResponse r = verify(TestTx.MasumiSpec.defaults().withStateAlt(1), defaultExtra());
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.MASUMI_DATUM_INVALID);
    }

    @Test void rejectsNonEmptyResultHash() {
        VerifyResponse r = verify(TestTx.MasumiSpec.defaults().withResultHashHex("aa"), defaultExtra());
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.MASUMI_DATUM_INVALID);
    }

    @Test void rejectsNonIntegerCooldown() {
        // f16 seller_cooldown_time is a Constr, not an int; TS parseMasumiLockDatum reads
        // it as asInt and returns null -> MASUMI_DATUM_INVALID. Java must reject too.
        VerifyResponse r = verify(TestTx.MasumiSpec.defaults().withCooldownCorrupt(true), defaultExtra());
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.MASUMI_DATUM_INVALID);
    }

    @Test void rejectsShortReferenceSignature() {
        // 8 bytes < the required 16.
        VerifyResponse r = verify(
                TestTx.MasumiSpec.defaults().withReferenceSignatureHex("aabbccddeeff0011"), defaultExtra());
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.MASUMI_DATUM_INVALID);
    }

    @Test void rejectsBadTimeOrdering() {
        // payByTime > submitResultTime (default submitResultTime = ...600000).
        VerifyResponse r = verify(
                TestTx.MasumiSpec.defaults().withPayByTime(new BigInteger("2000000700000")), defaultExtra());
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.MASUMI_DATUM_INVALID);
    }

    @Test void rejectsScriptCredBuyer() {
        VerifyResponse r = verify(TestTx.MasumiSpec.defaults().withBuyerIsScript(true), defaultExtra());
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.MASUMI_DATUM_INVALID);
    }

    @Test void rejectsScriptCredSeller() {
        VerifyResponse r = verify(TestTx.MasumiSpec.defaults().withSellerIsScript(true), defaultExtra());
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.MASUMI_DATUM_INVALID);
    }

    @Test void rejectsBuyerNotPayer() {
        VerifyResponse r = verify(
                TestTx.MasumiSpec.defaults().withBuyerAddress(TestTx.SELLER_ADDRESS), defaultExtra());
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.MASUMI_DATUM_MISMATCH);
    }

    @Test void rejectsSellerMismatch() {
        VerifyResponse r = verify(
                TestTx.MasumiSpec.defaults().withSellerAddress(TestTx.PAYER_ADDRESS), defaultExtra());
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.MASUMI_DATUM_MISMATCH);
    }

    @Test void rejectsHexFieldMismatch() {
        // Datum's reference_key differs from what extra.referenceKey declares.
        VerifyResponse r = verify(
                TestTx.MasumiSpec.defaults().withReferenceKeyHex("ffffffff"), defaultExtra());
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.MASUMI_DATUM_MISMATCH);
    }

    @Test void rejectsTimeFieldMismatch() {
        // Datum's unlock_time differs from what extra.unlockTime declares; ordering still holds.
        VerifyResponse r = verify(
                TestTx.MasumiSpec.defaults().withUnlockTime(new BigInteger("2000001300000")), defaultExtra());
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.MASUMI_DATUM_MISMATCH);
    }
}
