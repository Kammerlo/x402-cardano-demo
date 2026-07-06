package org.x402cardano.facilitator.cardano;

import org.x402cardano.facilitator.protocol.PaymentRequirements;
import java.util.Map;
import java.util.Optional;

/** Extension point for assetTransferMethod-specific checks (default/masumi/script). */
public interface AssetTransferMethodVerifier {
    boolean supports(String method);
    /** @return an error code when the check fails, empty when it passes. */
    Optional<String> check(Map<String, Object> extra, PaymentRequirements requirements,
                           DecodedTransaction tx, String payer);
}
