package org.x402cardano.facilitator.protocol;

public record SettleRequest(Integer x402Version, PaymentPayload paymentPayload, PaymentRequirements paymentRequirements) {
}
