package org.x402cardano.facilitator.chain.yaci;

import com.bloxbean.cardano.yaci.store.events.BlockHeaderEvent;
import com.bloxbean.cardano.yaci.store.events.EventMetadata;
import org.junit.jupiter.api.Test;

import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;

class ChainTipTrackerTest {
    @Test void tracksTipSlotFromBlockHeaders() {
        ChainTipTracker tracker = new ChainTipTracker();
        assertThat(tracker.tipSlot()).isEmpty();
        tracker.onBlockHeader(BlockHeaderEvent.builder()
                .metadata(EventMetadata.builder().slot(123_456L).build()).build());
        assertThat(tracker.tipSlot()).hasValue(123_456L);
        assertThat(tracker.isFresh(Duration.ofMinutes(5))).isTrue();
    }
}
