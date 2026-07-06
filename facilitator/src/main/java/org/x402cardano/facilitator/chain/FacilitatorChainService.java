package org.x402cardano.facilitator.chain;

import java.math.BigInteger;
import java.time.Duration;
import java.util.Optional;

/**
 * Everything the verify()/settle() scheme implementations need from the
 * Cardano chain. Java mirror of the TypeScript FacilitatorCardanoSigner
 * (../x402/typescript/packages/mechanisms/cardano/src/facilitator.ts).
 */
public interface FacilitatorChainService {
    /** empty = spent or never existed; throws ChainLookupException on lookup failure. */
    Optional<UtxoInfo> getUtxo(String txHashHex, int index);

    long getCurrentSlot();

    BigInteger getCoinsPerUtxoByte();

    /** Broadcasts; returns lowercase hex tx hash. Throws SubmissionException on node rejection. */
    String submitTransaction(byte[] txBytes);

    /** Blocks until the tx is seen in a block or timeout elapses. */
    boolean awaitInclusion(String txHashHex, Duration timeout);
}
