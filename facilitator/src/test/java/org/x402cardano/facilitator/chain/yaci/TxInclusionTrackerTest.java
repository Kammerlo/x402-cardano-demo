package org.x402cardano.facilitator.chain.yaci;

import com.bloxbean.cardano.yaci.core.protocol.chainsync.messages.Point;
import com.bloxbean.cardano.yaci.helper.model.Transaction;
import com.bloxbean.cardano.yaci.store.events.EventMetadata;
import com.bloxbean.cardano.yaci.store.events.RollbackEvent;
import com.bloxbean.cardano.yaci.store.events.TransactionEvent;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class TxInclusionTrackerTest {
    private final TxInclusionTracker tracker = new TxInclusionTracker();

    private TransactionEvent txEvent(String txHash, long slot) {
        return TransactionEvent.builder()
                .metadata(EventMetadata.builder().slot(slot).block(10).blockHash("bh").build())
                .transactions(List.of(Transaction.builder().txHash(txHash).build()))
                .build();
    }

    @Test void tracksIncludedTransactions() {
        tracker.onTransactions(txEvent("AA11", 100));
        assertThat(tracker.isIncluded("aa11")).isTrue();  // case-insensitive
        assertThat(tracker.isIncluded("bb22")).isFalse();
    }

    @Test void rollbackRemovesTransactionsAfterRollbackPoint() {
        tracker.onTransactions(txEvent("aa11", 100));
        tracker.onTransactions(txEvent("bb22", 200));
        tracker.onRollback(RollbackEvent.builder()
                .rollbackTo(new Point(150, "hash150")).build());
        assertThat(tracker.isIncluded("aa11")).isTrue();   // slot 100 <= 150 survives
        assertThat(tracker.isIncluded("bb22")).isFalse();  // slot 200 > 150 rolled back
    }

    @Test void awaitInclusionReturnsOnceSeen() throws Exception {
        Thread t = new Thread(() -> {
            try { Thread.sleep(300); } catch (InterruptedException ignored) {}
            tracker.onTransactions(txEvent("cc33", 300));
        });
        t.start();
        boolean included = tracker.awaitInclusion("cc33", Duration.ofSeconds(5), Duration.ofMillis(50));
        t.join();
        assertThat(included).isTrue();
    }

    @Test void awaitInclusionTimesOut() {
        assertThat(tracker.awaitInclusion("dd44", Duration.ofMillis(200), Duration.ofMillis(50))).isFalse();
    }
}
