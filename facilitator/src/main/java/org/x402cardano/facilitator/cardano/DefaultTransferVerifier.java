// DefaultTransferVerifier.java — address-to-address needs nothing beyond the shared checks.
package org.x402cardano.facilitator.cardano;

import org.x402cardano.facilitator.protocol.PaymentRequirements;
import java.util.Map;
import java.util.Optional;

public class DefaultTransferVerifier implements AssetTransferMethodVerifier {
    @Override public boolean supports(String method) { return method == null || method.equals("default"); }
    @Override public Optional<String> check(Map<String, Object> extra, PaymentRequirements requirements,
                                            DecodedTransaction tx, String payer) {
        return Optional.empty();
    }
}
