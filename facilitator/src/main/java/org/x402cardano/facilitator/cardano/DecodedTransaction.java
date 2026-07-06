package org.x402cardano.facilitator.cardano;

import java.math.BigInteger;
import java.util.List;
import java.util.Map;

/**
 * Structural view of a decoded Cardano transaction, surfacing only the
 * fields the facilitator's verify()/settle() paths need.
 *
 * Port of ../x402/typescript/packages/mechanisms/cardano/src/utils.ts
 * (DecodedCardanoTransaction).
 */
public record DecodedTransaction(
        String txHashHex,
        List<String> inputs, // lowercase "txhash#index"
        List<Output> outputs,
        Long ttlSlot, // null = absent
        Long validityStartSlot, // null = absent
        Integer networkId, // null = absent
        int vkeyWitnessCount,
        int scriptWitnessCount,
        boolean signaturesValid) {

    public record Output(
            String address,
            BigInteger coin,
            Map<String, BigInteger> assets, // "policyhex.namehex" lowercase
            com.bloxbean.cardano.client.transaction.spec.TransactionOutput raw) {
    }
}
