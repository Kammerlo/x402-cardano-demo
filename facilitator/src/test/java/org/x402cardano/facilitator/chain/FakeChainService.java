package org.x402cardano.facilitator.chain;

import java.math.BigInteger;
import java.time.Duration;
import java.util.*;

/**
 * In-memory FacilitatorChainService test double. Mutable fields let scheme
 * tests script every scenario (missing UTxO, lookup failure, submission
 * rejection, non-inclusion) without touching a real chain.
 */
public class FakeChainService implements FacilitatorChainService {
    public final Map<String, UtxoInfo> utxos = new HashMap<>(); // key "txhash#index"
    public long currentSlot = 500_000L;
    public BigInteger coinsPerUtxoByte = BigInteger.valueOf(4310);
    public boolean throwOnLookup = false;
    public boolean throwOnSubmit = false;
    public boolean included = true;
    public String submittedTxHash;
    public int submitCount = 0;

    @Override public Optional<UtxoInfo> getUtxo(String txHashHex, int index) {
        if (throwOnLookup) throw new ChainLookupException("provider down");
        return Optional.ofNullable(utxos.get(txHashHex.toLowerCase() + "#" + index));
    }
    @Override public long getCurrentSlot() { return currentSlot; }
    @Override public BigInteger getCoinsPerUtxoByte() { return coinsPerUtxoByte; }
    @Override public String submitTransaction(byte[] txBytes) {
        submitCount++;
        if (throwOnSubmit) throw new SubmissionException("BadInputsUTxO");
        submittedTxHash = com.bloxbean.cardano.client.transaction.util.TransactionUtil.getTxHash(txBytes);
        return submittedTxHash;
    }
    @Override public boolean awaitInclusion(String txHashHex, Duration timeout) { return included; }
}
