package org.x402cardano.facilitator.cardano;

import org.junit.jupiter.api.*;
import org.x402cardano.facilitator.chain.*;
import org.x402cardano.facilitator.protocol.*;
import java.math.BigInteger;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import static org.assertj.core.api.Assertions.assertThat;

class ExactCardanoVerifyTest {
    FakeChainService chain;
    ExactCardanoFacilitatorScheme scheme;

    PaymentRequirements requirements(String network, String payTo, String amount, String asset) {
        return new PaymentRequirements("exact", network, asset, amount, payTo, 600,
                Map.of("assetTransferMethod", "default"));
    }

    PaymentPayload payload(String txB64, String nonce, PaymentRequirements accepted) {
        Map<String, Object> p = new HashMap<>();
        p.put("transaction", txB64);
        p.put("nonce", nonce);
        return new PaymentPayload(2, null, accepted, p, null);
    }

    @BeforeEach
    void setUp() {
        chain = new FakeChainService();
        chain.utxos.put(TestTx.NONCE, new UtxoInfo(TestTx.PAYER_ADDRESS)); // nonce unspent, owned by payer
        chain.currentSlot = 500_000L; // fixture ttl = 1_000_000 => valid
        scheme = new ExactCardanoFacilitatorScheme(chain, new CardanoTransactionDecoder(),
                new ExactCardanoFacilitatorScheme.SettleConfig(
                        Duration.ofSeconds(5), false, Duration.ofSeconds(120)));
    }

    VerifyResponse verifyDefault() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        return scheme.verify(payload(TestTx.buildBase64(TestTx.Spec.defaults()), TestTx.NONCE, req), req);
    }

    @Test void happyPath() {
        VerifyResponse r = verifyDefault();
        assertThat(r.isValid()).isTrue();
        assertThat(r.payer()).isEqualTo(TestTx.PAYER_ADDRESS);
    }

    @Test void rejectsWrongVersion() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        PaymentPayload p = new PaymentPayload(1, null, req,
                Map.of("transaction", TestTx.buildBase64(TestTx.Spec.defaults()), "nonce", TestTx.NONCE), null);
        VerifyResponse r = scheme.verify(p, req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.UNSUPPORTED_VERSION);
        assertThat(r.payer()).isEmpty();
    }

    @Test void rejectsWrongScheme() {
        PaymentRequirements req = new PaymentRequirements("upto", "cardano:preprod", "lovelace",
                "2000000", TestTx.PAY_TO, 600, Map.of());
        VerifyResponse r = scheme.verify(
                payload(TestTx.buildBase64(TestTx.Spec.defaults()), TestTx.NONCE, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.UNSUPPORTED_SCHEME);
    }

    @Test void rejectsNetworkMismatchBetweenAcceptedAndRequirements() {
        PaymentRequirements accepted = requirements("cardano:preview", TestTx.PAY_TO, "2000000", "lovelace");
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        VerifyResponse r = scheme.verify(
                payload(TestTx.buildBase64(TestTx.Spec.defaults()), TestTx.NONCE, accepted), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.NETWORK_MISMATCH);
    }

    @Test void acceptsCip34AliasAsAcceptedNetwork() {
        PaymentRequirements accepted = requirements("cip34:0-1", TestTx.PAY_TO, "2000000", "lovelace");
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        assertThat(scheme.verify(
                payload(TestTx.buildBase64(TestTx.Spec.defaults()), TestTx.NONCE, accepted), req)
                .isValid()).isTrue();
    }

    @Test void rejectsUnsupportedNetwork() {
        PaymentRequirements req = requirements("base-sepolia", TestTx.PAY_TO, "2000000", "lovelace");
        VerifyResponse r = scheme.verify(
                payload(TestTx.buildBase64(TestTx.Spec.defaults()), TestTx.NONCE, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.NETWORK_MISMATCH);
    }

    @Test void rejectsMissingPayloadFields() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        VerifyResponse r = scheme.verify(new PaymentPayload(2, null, req, Map.of("nonce", TestTx.NONCE), null), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.INVALID_PAYLOAD);
    }

    @Test void rejectsMalformedNonce() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        VerifyResponse r = scheme.verify(
                payload(TestTx.buildBase64(TestTx.Spec.defaults()), "not-a-utxo-ref", req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.NONCE_INVALID);
    }

    @Test void rejectsUndecodableTransaction() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        VerifyResponse r = scheme.verify(payload("bm90LWEtdHg=", TestTx.NONCE, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.DECODE_FAILED);
    }

    @Test void rejectsWrongNetworkId() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        String tx = TestTx.buildBase64(TestTx.Spec.defaults()
                .withNetworkId(com.bloxbean.cardano.client.spec.NetworkId.MAINNET));
        VerifyResponse r = scheme.verify(payload(tx, TestTx.NONCE, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.NETWORK_ID_MISMATCH);
    }

    @Test void rejectsUnsignedTransaction() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        String tx = TestTx.buildBase64(TestTx.Spec.defaults().unsigned());
        VerifyResponse r = scheme.verify(payload(tx, TestTx.NONCE, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.UNSIGNED);
    }

    @Test void rejectsInvalidSignature() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        VerifyResponse r = scheme.verify(payload(TestTx.buildBase64WithBadSignature(), TestTx.NONCE, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.INVALID_SIGNATURE);
    }

    @Test void rejectsExpiredTtl() {
        chain.currentSlot = 2_000_000L; // fixture ttl 1_000_000 in the past
        VerifyResponse r = verifyDefault();
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.TTL_EXPIRED);
    }

    @Test void rejectsNotYetValid() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        String tx = TestTx.buildBase64(TestTx.Spec.defaults().withValidityStart(900_000L));
        chain.currentSlot = 800_000L;
        VerifyResponse r = scheme.verify(payload(tx, TestTx.NONCE, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.NOT_YET_VALID);
    }

    @Test void rejectsNonceNotInInputs() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        String otherRef = "cd".repeat(32) + "#1";
        chain.utxos.put(otherRef, new UtxoInfo(TestTx.PAYER_ADDRESS));
        VerifyResponse r = scheme.verify(
                payload(TestTx.buildBase64(TestTx.Spec.defaults()), otherRef, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.NONCE_NOT_IN_INPUTS);
    }

    @Test void rejectsNonceNotOnChain() {
        chain.utxos.clear(); // nonce spent / never existed
        VerifyResponse r = verifyDefault();
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.NONCE_NOT_ON_CHAIN);
        assertThat(r.payer()).isEmpty();
    }

    @Test void rejectsSpentNonNonceInput() {
        var extra = new com.bloxbean.cardano.client.transaction.spec.TransactionInput("ee".repeat(32), 2);
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        String tx = TestTx.buildBase64(TestTx.Spec.defaults().withExtraInputs(List.of(extra)));
        // nonce exists, the extra input does NOT:
        VerifyResponse r = scheme.verify(payload(tx, TestTx.NONCE, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.INPUT_NOT_AVAILABLE);
        assertThat(r.payer()).isEqualTo(TestTx.PAYER_ADDRESS); // payer already resolved
    }

    @Test void mapsLookupErrorToChainLookupFailed() {
        chain.throwOnLookup = true;
        VerifyResponse r = verifyDefault();
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.CHAIN_LOOKUP_FAILED);
    }

    @Test void rejectsRecipientMismatch() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAYER_ADDRESS /* wrong */, "2000000", "lovelace");
        PaymentRequirements accepted = requirements("cardano:preprod", TestTx.PAYER_ADDRESS, "2000000", "lovelace");
        // tx pays PAY_TO; requirements demand PAYER_ADDRESS... but change output also goes to payer,
        // so use a third address to avoid accidental match:
        String other = "addr_test1vqneq3v0dqh3x3muv6ee3lt8e5729xymnxuavx6tndcjc2cv24ef9";
        req = requirements("cardano:preprod", other, "2000000", "lovelace");
        accepted = req;
        VerifyResponse r = scheme.verify(
                payload(TestTx.buildBase64(TestTx.Spec.defaults()), TestTx.NONCE, accepted), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.RECIPIENT_MISMATCH);
    }

    @Test void rejectsAssetMismatch() {
        String usdm = "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde.0014df105553444d";
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", usdm);
        VerifyResponse r = scheme.verify(
                payload(TestTx.buildBase64(TestTx.Spec.defaults()), TestTx.NONCE, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.ASSET_MISMATCH);
    }

    @Test void rejectsInsufficientAmount() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "3000000", "lovelace");
        VerifyResponse r = scheme.verify(
                payload(TestTx.buildBase64(TestTx.Spec.defaults()), TestTx.NONCE, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.AMOUNT_INSUFFICIENT);
    }

    @Test void acceptsOverpayment() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "1500000", "lovelace");
        assertThat(scheme.verify(
                payload(TestTx.buildBase64(TestTx.Spec.defaults()), TestTx.NONCE, req), req).isValid()).isTrue();
    }

    @Test void rejectsBelowMinUtxo() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "100000", "lovelace");
        String tx = TestTx.buildBase64(TestTx.Spec.defaults().withAmount(java.math.BigInteger.valueOf(100_000L)));
        VerifyResponse r = scheme.verify(payload(tx, TestTx.NONCE, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.MIN_UTXO_INSUFFICIENT);
    }

    @Test void rejectsUnknownTransferMethod() {
        PaymentRequirements req = new PaymentRequirements("exact", "cardano:preprod", "lovelace",
                "2000000", TestTx.PAY_TO, 600, Map.of("assetTransferMethod", "script"));
        VerifyResponse r = scheme.verify(
                payload(TestTx.buildBase64(TestTx.Spec.defaults()), TestTx.NONCE, req), req);
        // "script" is not implemented in this demo; TS uses unsupported_scheme for unknown methods
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.UNSUPPORTED_SCHEME);
    }
}
