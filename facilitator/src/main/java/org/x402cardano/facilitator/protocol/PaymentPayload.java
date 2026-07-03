package org.x402cardano.facilitator.protocol;

import java.util.Map;

public record PaymentPayload(int x402Version, Map<String, Object> resource, PaymentRequirements accepted,
                             Map<String, Object> payload, Map<String, Object> extensions) {
}
