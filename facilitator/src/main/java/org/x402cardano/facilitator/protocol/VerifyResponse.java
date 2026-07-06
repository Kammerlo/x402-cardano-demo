// VerifyResponse.java
package org.x402cardano.facilitator.protocol;

public record VerifyResponse(boolean isValid, String invalidReason, String invalidMessage, String payer) {
    public static VerifyResponse valid(String payer) { return new VerifyResponse(true, null, null, payer); }
    public static VerifyResponse invalid(String reason, String message, String payer) {
        return new VerifyResponse(false, reason, message, payer == null ? "" : payer);
    }
}
