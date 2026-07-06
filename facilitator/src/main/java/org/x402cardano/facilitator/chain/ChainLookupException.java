package org.x402cardano.facilitator.chain;

/**
 * Thrown when a chain query (e.g. UTxO lookup) fails for reasons other than
 * a definitive "not found" answer — provider outage, network error, etc.
 */
public class ChainLookupException extends RuntimeException {
    public ChainLookupException(String message) {
        super(message);
    }

    public ChainLookupException(String message, Throwable cause) {
        super(message, cause);
    }
}
