package org.x402cardano.facilitator.cardano;

import com.bloxbean.cardano.client.address.AddressProvider;
import com.bloxbean.cardano.client.address.Credential;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.crypto.KeyGenUtil;
import com.bloxbean.cardano.client.crypto.SecretKey;
import com.bloxbean.cardano.client.crypto.VerificationKey;
import com.bloxbean.cardano.client.spec.NetworkId;
import com.bloxbean.cardano.client.transaction.TransactionSigner;
import com.bloxbean.cardano.client.transaction.spec.*;
import com.bloxbean.cardano.client.util.HexUtil;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/** Deterministic signed-transaction fixtures for decoder/scheme tests. */
public final class TestTx {
    // Fixed 32-byte Ed25519 seed => stable payer key/address across runs.
    public static final SecretKey PAYER_KEY =
            new SecretKey("5820" + "11".repeat(32));
    public static final VerificationKey PAYER_VKEY;
    public static final String PAYER_ADDRESS;
    public static final String PAY_TO; // the "server" address fixtures pay to
    public static final String NONCE_TX_HASH = "ab".repeat(32);
    public static final String NONCE = NONCE_TX_HASH + "#0";

    static {
        try {
            PAYER_VKEY = KeyGenUtil.getPublicKeyFromPrivateKey(PAYER_KEY);
            PAYER_ADDRESS = AddressProvider.getEntAddress(
                    Credential.fromKey(KeyGenUtil.getKeyHash(PAYER_VKEY)), Networks.testnet()).toBech32();
            SecretKey serverKey = new SecretKey("5820" + "22".repeat(32));
            PAY_TO = AddressProvider.getEntAddress(
                    Credential.fromKey(KeyGenUtil.getKeyHash(KeyGenUtil.getPublicKeyFromPrivateKey(serverKey))),
                    Networks.testnet()).toBech32();
        } catch (Exception e) { throw new ExceptionInInitializerError(e); }
    }

    public record Spec(String payTo, BigInteger amount, Long ttl, Long validityStart,
                       NetworkId networkId, boolean sign, List<TransactionInput> extraInputs) {
        public static Spec defaults() {
            return new Spec(PAY_TO, BigInteger.valueOf(2_000_000L), 1_000_000L, null, null, true, List.of());
        }
        public Spec withPayTo(String v) { return new Spec(v, amount, ttl, validityStart, networkId, sign, extraInputs); }
        public Spec withAmount(BigInteger v) { return new Spec(payTo, v, ttl, validityStart, networkId, sign, extraInputs); }
        public Spec withTtl(Long v) { return new Spec(payTo, amount, v, validityStart, networkId, sign, extraInputs); }
        public Spec withValidityStart(Long v) { return new Spec(payTo, amount, ttl, v, networkId, sign, extraInputs); }
        public Spec withNetworkId(NetworkId v) { return new Spec(payTo, amount, ttl, validityStart, v, sign, extraInputs); }
        public Spec unsigned() { return new Spec(payTo, amount, ttl, validityStart, networkId, false, extraInputs); }
        public Spec withExtraInputs(List<TransactionInput> v) { return new Spec(payTo, amount, ttl, validityStart, networkId, sign, v); }
    }

    /** Builds a signed (or unsigned) tx: input = NONCE utxo (+extras), output0 = payment, output1 = change. */
    public static String buildBase64(Spec spec) {
        try {
            List<TransactionInput> inputs = new ArrayList<>();
            inputs.add(new TransactionInput(NONCE_TX_HASH, 0));
            inputs.addAll(spec.extraInputs());
            TransactionOutput payment = TransactionOutput.builder()
                    .address(spec.payTo())
                    .value(Value.builder().coin(spec.amount()).build()).build();
            TransactionOutput change = TransactionOutput.builder()
                    .address(PAYER_ADDRESS)
                    .value(Value.builder().coin(BigInteger.valueOf(7_000_000L)).build()).build();
            TransactionBody.TransactionBodyBuilder body = TransactionBody.builder()
                    .inputs(inputs).outputs(List.of(payment, change))
                    .fee(BigInteger.valueOf(170_000L));
            if (spec.ttl() != null) body.ttl(spec.ttl());
            if (spec.validityStart() != null) body.validityStartInterval(spec.validityStart());
            if (spec.networkId() != null) body.networkId(spec.networkId());
            Transaction tx = Transaction.builder().body(body.build())
                    .witnessSet(new TransactionWitnessSet()).build();
            Transaction result = spec.sign() ? TransactionSigner.INSTANCE.sign(tx, PAYER_KEY) : tx;
            return Base64.getEncoder().encodeToString(result.serialize());
        } catch (Exception e) { throw new RuntimeException(e); }
    }

    /** A signed tx whose signature bytes were corrupted after signing. */
    public static String buildBase64WithBadSignature() {
        byte[] raw = Base64.getDecoder().decode(buildBase64(Spec.defaults()));
        // Signatures sit near the end of [body, witnessSet, ...]; flip a byte inside the
        // witness area. Adjust index if the assert below fails to find a signature change.
        raw[raw.length - 40] ^= 0x01;
        return Base64.getEncoder().encodeToString(raw);
    }

    /** cclib can't emit ttl=0, so rewrite the body map: key 3 -> 0. Unsigned is fine
     *  for decoder assertions (ttl extraction doesn't depend on witnesses). */
    public static String buildBase64TtlZero() {
        try {
            byte[] raw = Base64.getDecoder().decode(buildBase64(Spec.defaults().withTtl(1L).unsigned()));
            co.nstant.in.cbor.model.Array tx = (co.nstant.in.cbor.model.Array)
                    co.nstant.in.cbor.CborDecoder.decode(raw).get(0);
            co.nstant.in.cbor.model.Map body = (co.nstant.in.cbor.model.Map) tx.getDataItems().get(0);
            body.put(new co.nstant.in.cbor.model.UnsignedInteger(3),
                     new co.nstant.in.cbor.model.UnsignedInteger(0));
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            new co.nstant.in.cbor.CborEncoder(out).encode(tx);
            return Base64.getEncoder().encodeToString(out.toByteArray());
        } catch (Exception e) { throw new RuntimeException(e); }
    }

    private TestTx() {}
}
