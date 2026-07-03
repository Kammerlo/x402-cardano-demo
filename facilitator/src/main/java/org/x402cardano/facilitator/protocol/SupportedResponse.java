package org.x402cardano.facilitator.protocol;

import java.util.List;
import java.util.Map;

public record SupportedResponse(List<SupportedKind> kinds, List<String> extensions, Map<String, List<String>> signers) {
}
