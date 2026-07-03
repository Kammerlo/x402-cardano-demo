package org.x402cardano.facilitator.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import java.time.Duration;

@ConfigurationProperties(prefix = "x402")
public record X402Properties(String network, Blockfrost blockfrost, Settle settle,
                             DuplicateCache duplicateCache, SyncFromTip syncFromTip) {
    public record Blockfrost(String baseUrl, String projectId) {}
    public record Settle(Duration confirmationTimeout, Duration pollInterval, boolean acceptMempool) {}
    public record DuplicateCache(Duration ttl) {}
    public record SyncFromTip(boolean enabled, int blocksBehind) {}
}
