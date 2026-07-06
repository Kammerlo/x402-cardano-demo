package org.x402cardano.facilitator.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.x402cardano.facilitator.chain.yaci.ChainTipTracker;
import org.x402cardano.facilitator.config.X402Properties;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/** Reports the facilitator's own yaci-store sync status alongside basic liveness. */
@RestController
class HealthController {
    private final ChainTipTracker tip;
    private final X402Properties props;

    HealthController(ChainTipTracker tip, X402Properties props) {
        this.tip = tip;
        this.props = props;
    }

    @GetMapping("/health")
    Map<String, Object> health() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", tip.isFresh(Duration.ofSeconds(90)) ? "ok" : "syncing");
        body.put("network", props.network());
        body.put("yaciTipSlot", tip.tipSlot().isPresent() ? tip.tipSlot().getAsLong() : null);
        body.put("yaciLastBlockAgeSeconds",
                tip.lastBlockAgeSeconds().isPresent() ? tip.lastBlockAgeSeconds().getAsLong() : null);
        return body;
    }
}
