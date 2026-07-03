package org.x402cardano.facilitator.cardano;

import java.time.Duration;
import java.util.concurrent.ConcurrentHashMap;

/**
 * In-process duplicate-settlement guard (spec: "Duplicate Settlement Mitigation").
 * Claims are atomic (putIfAbsent), evicted after the TTL, capped at 1024 entries.
 * The on-chain nonce spend is the durable cross-instance guard; this cache only
 * covers the unconfirmed window.
 */
public class DuplicateSettlementCache {
    private static final int MAX_ENTRIES = 1024;
    private final ConcurrentHashMap<String, Long> claims = new ConcurrentHashMap<>();
    private final long ttlMillis;

    public DuplicateSettlementCache(Duration ttl) { this.ttlMillis = ttl.toMillis(); }

    /** @return true when this call won the claim; false when already claimed. */
    public boolean tryClaim(String key) {
        evictExpired();
        return claims.putIfAbsent(key, System.currentTimeMillis()) == null;
    }

    public void release(String key) { claims.remove(key); }

    private void evictExpired() {
        // TS parity: expired entries are removed only when the cache exceeds the cap;
        // live (in-TTL) claims are NEVER evicted — dropping one would let the same
        // tx be rebroadcast. The map may temporarily exceed MAX_ENTRIES if all
        // entries are live; the TTL bounds that window.
        if (claims.size() > MAX_ENTRIES) {
            long cutoff = System.currentTimeMillis() - ttlMillis;
            claims.values().removeIf(t -> t < cutoff);
        }
    }
}
