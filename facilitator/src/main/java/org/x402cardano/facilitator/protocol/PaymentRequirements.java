package org.x402cardano.facilitator.protocol;

import java.util.Map;

public record PaymentRequirements(String scheme, String network, String asset, String amount,
                                  String payTo, Integer maxTimeoutSeconds, Map<String, Object> extra) {
}
