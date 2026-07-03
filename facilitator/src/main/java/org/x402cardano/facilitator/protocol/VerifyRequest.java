package org.x402cardano.facilitator.protocol;

public record VerifyRequest(Integer x402Version, PaymentPayload paymentPayload, PaymentRequirements paymentRequirements) {
}
