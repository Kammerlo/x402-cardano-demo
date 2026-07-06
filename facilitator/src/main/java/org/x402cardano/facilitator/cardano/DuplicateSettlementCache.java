package org.x402cardano.facilitator.cardano;

import java.time.Duration;
import java.util.concurrent.ConcurrentHashMap;

/**
 * In-process duplicate-settlement guard (spec: "Duplicate Settlement Mitigation").
 * Claims are atomic (CAS-loop), reclaimable per-key once their TTL elapses, and
 * bulk-evicted only when the cache exceeds 1024 entries. The on-chain nonce spend
 * is the durable cross-instance guard; this cache only covers the unconfirmed window.
 */
public class DuplicateSettlementCache {
    private static final int MAX_ENTRIES = 1024;
    private final ConcurrentHashMap<String, Long> claims = new ConcurrentHashMap<>();
    private final long ttlMillis;

    public DuplicateSettlementCache(Duration ttl) { this.ttlMillis = ttl.toMillis(); }

    /** @return true when this call won the claim; false when already claimed. */
    public boolean tryClaim(String key) {
        evictExpired();
        long now = System.currentTimeMillis();
        // TS parity (scheme.ts tryClaim): a key is reclaimable at claim time once
        // its own TTL has elapsed, so a legitimate retry after the window proceeds
        // instead of being wrongly denied. CAS-loop keeps the per-key reclaim atomic.
        while (true) {
            Long existing = claims.putIfAbsent(key, now);
            if (existing == null) return true;                    // fresh claim
            if (now - existing <= ttlMillis) return false;         // live claim held elsewhere
            if (claims.replace(key, existing, now)) return true;   // reclaimed an expired key
            // lost the race on replace() -> retry the loop
        }
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
