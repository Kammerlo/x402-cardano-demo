package org.x402cardano.facilitator.registry;

import org.x402cardano.facilitator.protocol.PaymentPayload;
import org.x402cardano.facilitator.protocol.PaymentRequirements;
import org.x402cardano.facilitator.protocol.SettleResponse;
import org.x402cardano.facilitator.protocol.VerifyResponse;

public interface SchemeNetworkFacilitator {
    String scheme();
    String caipFamily();
    VerifyResponse verify(PaymentPayload p, PaymentRequirements r);
    SettleResponse settle(PaymentPayload p, PaymentRequirements r);
}
