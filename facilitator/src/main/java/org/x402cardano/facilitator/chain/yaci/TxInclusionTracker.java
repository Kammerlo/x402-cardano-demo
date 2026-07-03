package org.x402cardano.facilitator.chain.yaci;

import com.bloxbean.cardano.yaci.store.events.RollbackEvent;
import com.bloxbean.cardano.yaci.store.events.TransactionEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Records tx inclusion from the facilitator's own yaci-store chain view and
 * invalidates entries beyond a rollback point (Ouroboros rollbacks are real:
 * "confirmed" here means observed-in-a-block, matching the TS reference).
 */
@Component
public class TxInclusionTracker {
    private static final int MAX_ENTRIES = 50_000;
    private final ConcurrentHashMap<String, Long> includedAtSlot = new ConcurrentHashMap<>();

    @EventListener
    public void onTransactions(TransactionEvent event) {
        if (event.getTransactions() == null) return;
        long slot = event.getMetadata().getSlot();
        event.getTransactions().forEach(tx ->
                includedAtSlot.put(tx.getTxHash().toLowerCase(), slot));
        if (includedAtSlot.size() > MAX_ENTRIES) {
            long minSlot = slot - 7200; // ~2h of preprod slots; ancient entries are settled history
            includedAtSlot.values().removeIf(s -> s < minSlot);
        }
    }

    @EventListener
    public void onRollback(RollbackEvent event) {
        long rollbackSlot = event.getRollbackTo().getSlot();
        includedAtSlot.values().removeIf(slot -> slot > rollbackSlot);
    }

    public boolean isIncluded(String txHashHex) {
        return includedAtSlot.containsKey(txHashHex.toLowerCase());
    }

    public boolean awaitInclusion(String txHashHex, Duration timeout, Duration pollInterval) {
        long deadline = System.currentTimeMillis() + timeout.toMillis();
        while (System.currentTimeMillis() < deadline) {
            if (isIncluded(txHashHex)) return true;
            try { Thread.sleep(pollInterval.toMillis()); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); return false; }
        }
        return isIncluded(txHashHex);
    }
}
