package org.x402cardano.facilitator.cardano;

import java.time.Duration;

/**
 * Placeholder for Task 8's in-process duplicate-settlement guard. Only the
 * constructor exists so {@link ExactCardanoFacilitatorScheme} compiles;
 * Task 8 replaces the body with the real claim/release logic (TS parity:
 * scheme.ts's settlementCache Map + tryClaim/releaseClaim).
 */
public class DuplicateSettlementCache {
    public DuplicateSettlementCache(Duration ttl) {
        // no-op: Task 8 implements the cache
    }
}
