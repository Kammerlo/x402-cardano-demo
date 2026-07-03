package org.x402cardano.facilitator.chain;

/**
 * Minimal view of a UTxO the verify()/settle() paths need from the chain.
 */
public record UtxoInfo(String address) {
}
