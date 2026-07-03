package org.x402cardano.facilitator.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

// Minimal health endpoint; Task 12 enriches this with chain/sync status.
@RestController
class HealthController {
    @GetMapping("/health")
    Map<String, Object> health() { return Map.of("status", "ok"); }
}
