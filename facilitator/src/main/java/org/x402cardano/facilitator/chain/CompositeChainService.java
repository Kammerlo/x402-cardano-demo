package org.x402cardano.facilitator.chain;

import org.x402cardano.facilitator.chain.yaci.ChainTipTracker;
import org.x402cardano.facilitator.chain.yaci.TxInclusionTracker;

import java.math.BigInteger;
import java.time.Duration;
import java.util.Optional;

/**
 * Division of chain authority (see design spec):
 * - Blockfrost: full-UTxO-set questions (nonce/input unspent), protocol params, submission.
 * - Embedded yaci-store: the facilitator's OWN view for current slot (TTL rule)
 *   and settlement confirmation (tx observed in a block it indexed itself).
 */
public class CompositeChainService implements FacilitatorChainService {
    private static final Duration TIP_FRESHNESS = Duration.ofSeconds(90);
    private final BlockfrostChainService blockfrost;
    private final ChainTipTracker tip;
    private final TxInclusionTracker inclusion;
    private final Duration pollInterval;

    public CompositeChainService(BlockfrostChainService blockfrost, ChainTipTracker tip,
                                 TxInclusionTracker inclusion, Duration pollInterval) {
        this.blockfrost = blockfrost;
        this.tip = tip;
        this.inclusion = inclusion;
        this.pollInterval = pollInterval;
    }

    @Override public Optional<UtxoInfo> getUtxo(String txHashHex, int index) {
        return blockfrost.getUtxo(txHashHex, index);
    }
    @Override public BigInteger getCoinsPerUtxoByte() { return blockfrost.getCoinsPerUtxoByte(); }
    @Override public String submitTransaction(byte[] txBytes) { return blockfrost.submitTransaction(txBytes); }

    @Override public long getCurrentSlot() {
        if (tip.isFresh(TIP_FRESHNESS) && tip.tipSlot().isPresent()) return tip.tipSlot().getAsLong();
        return blockfrost.getCurrentSlot(); // yaci still syncing or stalled
    }

    @Override public boolean awaitInclusion(String txHashHex, Duration timeout) {
        return inclusion.awaitInclusion(txHashHex, timeout, pollInterval);
    }
}
