package org.x402cardano.facilitator.cardano;

import com.bloxbean.cardano.client.crypto.Blake2bUtil;
import com.bloxbean.cardano.client.crypto.api.impl.EdDSASigningProvider;
import com.bloxbean.cardano.client.spec.NetworkId;
import com.bloxbean.cardano.client.transaction.spec.*;
import com.bloxbean.cardano.client.transaction.util.TransactionUtil;
import com.bloxbean.cardano.client.util.HexUtil;

import java.math.BigInteger;
import java.util.*;

/**
 * Decodes a base64 CBOR Cardano transaction into the view verify() needs.
 * Port of ../x402/typescript/packages/mechanisms/cardano/src/utils.ts
 * (decodeCardanoTransaction). CORRECTNESS: the tx hash / signature message is
 * blake2b-256 over the RAW body bytes from the wire — TransactionUtil extracts
 * them without re-serialization.
 */
public class CardanoTransactionDecoder {

    public static class TransactionDecodeException extends RuntimeException {
        public TransactionDecodeException(String msg, Throwable cause) { super(msg, cause); }
    }

    private final EdDSASigningProvider ed25519 = new EdDSASigningProvider();

    public DecodedTransaction decode(String base64Tx) {
        byte[] raw;
        Transaction tx;
        String txHashHex;
        try {
            raw = Base64.getDecoder().decode(base64Tx);
            tx = Transaction.deserialize(raw);
            txHashHex = TransactionUtil.getTxHash(raw); // blake2b-256(raw body bytes)
        } catch (Exception e) {
            throw new TransactionDecodeException("Transaction CBOR decode failed", e);
        }

        TransactionBody body = tx.getBody();

        List<String> inputs = body.getInputs().stream()
                .map(i -> i.getTransactionId().toLowerCase() + "#" + i.getIndex())
                .toList();

        List<DecodedTransaction.Output> outputs = new ArrayList<>();
        for (TransactionOutput out : body.getOutputs()) {
            Map<String, BigInteger> assets = new HashMap<>();
            if (out.getValue().getMultiAssets() != null) {
                for (MultiAsset ma : out.getValue().getMultiAssets()) {
                    for (Asset a : ma.getAssets()) {
                        String nameHex = a.getNameAsHex();
                        if (nameHex.startsWith("0x")) nameHex = nameHex.substring(2);
                        assets.put((ma.getPolicyId() + "." + nameHex).toLowerCase(), a.getValue());
                    }
                }
            }
            outputs.add(new DecodedTransaction.Output(out.getAddress(), out.getValue().getCoin(), assets, out));
        }

        // cardano-client-lib models ttl/validityStart as primitive longs (0 when
        // absent), but a REAL `ttl: 0` must fail as expired (TS parity), so detect
        // key presence in the raw body CBOR map: key 3 = ttl, key 8 = validity start.
        java.util.Set<Long> bodyKeys = topLevelBodyKeys(raw);
        Long ttl = bodyKeys.contains(3L) ? body.getTtl() : null;
        Long validityStart = bodyKeys.contains(8L) ? body.getValidityStartInterval() : null;
        Integer networkId = body.getNetworkId() == null ? null
                : (body.getNetworkId() == NetworkId.MAINNET ? 1 : 0);

        TransactionWitnessSet ws = tx.getWitnessSet() == null ? new TransactionWitnessSet() : tx.getWitnessSet();
        List<VkeyWitness> vkeys = ws.getVkeyWitnesses() == null ? List.of() : ws.getVkeyWitnesses();
        int bootstrapCount = ws.getBootstrapWitnesses() == null ? 0 : ws.getBootstrapWitnesses().size();
        int scriptWitnessCount = size(ws.getNativeScripts()) + size(ws.getPlutusV1Scripts())
                + size(ws.getPlutusV2Scripts()) + size(ws.getPlutusV3Scripts()) + size(ws.getRedeemers());

        // Every vkey witness must Ed25519-verify over the 32-byte body hash.
        // Vacuously true with zero vkey witnesses (TS parity: .every() on []) —
        // the scheme's UNSIGNED check handles the no-witness case separately.
        byte[] bodyHash = HexUtil.decodeHexString(txHashHex);
        boolean signaturesValid = true;
        for (VkeyWitness w : vkeys) {
            if (!ed25519.verify(w.getSignature(), bodyHash, w.getVkey())) {
                signaturesValid = false;
                break;
            }
        }

        return new DecodedTransaction(txHashHex, inputs, outputs, ttl, validityStart, networkId,
                vkeys.size() + bootstrapCount, scriptWitnessCount, signaturesValid);
    }

    private static int size(List<?> l) { return l == null ? 0 : l.size(); }

    /** Integer keys present in the body map, read from the raw wire bytes. */
    private static java.util.Set<Long> topLevelBodyKeys(byte[] rawTx) {
        try {
            byte[] bodyBytes = TransactionUtil.extractTransactionBodyFromTx(rawTx);
            co.nstant.in.cbor.model.DataItem item =
                    co.nstant.in.cbor.CborDecoder.decode(bodyBytes).get(0);
            java.util.Set<Long> keys = new HashSet<>();
            for (co.nstant.in.cbor.model.DataItem k : ((co.nstant.in.cbor.model.Map) item).getKeys()) {
                if (k instanceof co.nstant.in.cbor.model.UnsignedInteger u) keys.add(u.getValue().longValue());
            }
            return keys;
        } catch (Exception e) {
            throw new TransactionDecodeException("Transaction body CBOR map decode failed", e);
        }
    }
}
