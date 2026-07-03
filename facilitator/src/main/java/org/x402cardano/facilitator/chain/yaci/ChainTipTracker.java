package org.x402cardano.facilitator.chain.yaci;

import com.bloxbean.cardano.yaci.store.events.BlockHeaderEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.OptionalLong;
import java.util.concurrent.atomic.AtomicLong;

/** Tracks the facilitator's own chain-tip view from the embedded yaci-store sync. */
@Component
public class ChainTipTracker {
    private final AtomicLong tipSlot = new AtomicLong(-1);
    private final AtomicLong lastBlockWallClock = new AtomicLong(-1);

    @EventListener
    public void onBlockHeader(BlockHeaderEvent event) {
        tipSlot.set(event.getMetadata().getSlot());
        lastBlockWallClock.set(System.currentTimeMillis());
    }

    public OptionalLong tipSlot() {
        long v = tipSlot.get();
        return v < 0 ? OptionalLong.empty() : OptionalLong.of(v);
    }

    public OptionalLong lastBlockAgeSeconds() {
        long t = lastBlockWallClock.get();
        return t < 0 ? OptionalLong.empty()
                : OptionalLong.of((System.currentTimeMillis() - t) / 1000);
    }

    public boolean isFresh(Duration maxAge) {
        return lastBlockAgeSeconds().stream().anyMatch(age -> age <= maxAge.toSeconds());
    }
}
