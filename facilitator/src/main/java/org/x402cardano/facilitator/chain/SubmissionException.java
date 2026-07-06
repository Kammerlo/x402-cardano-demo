package org.x402cardano.facilitator.chain;

/**
 * Thrown when the chain node rejects a submitted transaction.
 */
public class SubmissionException extends RuntimeException {
    public SubmissionException(String message) {
        super(message);
    }

    public SubmissionException(String message, Throwable cause) {
        super(message, cause);
    }
}
