package org.x402cardano.facilitator.chain;

import com.bloxbean.cardano.client.api.model.Result;
import com.bloxbean.cardano.client.api.model.Utxo;
import com.bloxbean.cardano.client.backend.api.BackendService;
import com.bloxbean.cardano.client.backend.blockfrost.service.BFBackendService;

import java.math.BigInteger;
import java.time.Duration;
import java.util.List;
import java.util.Optional;

/**
 * Blockfrost adapter: owns the checks that need the FULL UTxO set (nonce/input
 * unspent), protocol parameters, and tx submission. "Unspent" = the outref is
 * present in its owning address's live UTxO set (Blockfrost address UTxOs are
 * unspent-only). yaci-store (Task 12) owns tip/slot + inclusion tracking.
 */
public class BlockfrostChainService implements FacilitatorChainService {
    private final BackendService backend;
    private volatile BigInteger cachedCoinsPerUtxoByte; // governance-settable; cache first read

    public BlockfrostChainService(String baseUrl, String projectId) {
        this(new BFBackendService(baseUrl.endsWith("/") ? baseUrl : baseUrl + "/", projectId));
    }
    public BlockfrostChainService(BackendService backend) { this.backend = backend; }

    @Override
    public Optional<UtxoInfo> getUtxo(String txHashHex, int index) {
        try {
            Result<Utxo> outputRes = backend.getUtxoService().getTxOutput(txHashHex, index);
            if (!outputRes.isSuccessful()) {
                if (outputRes.code() == 404) return Optional.empty(); // never existed
                throw new ChainLookupException("Blockfrost getTxOutput failed: " + outputRes.getResponse());
            }
            String owner = outputRes.getValue().getAddress();
            for (int page = 1; ; page++) {
                Result<List<Utxo>> pageRes = backend.getUtxoService().getUtxos(owner, 100, page);
                if (!pageRes.isSuccessful()) {
                    if (pageRes.code() == 404) return Optional.empty(); // address has no UTxOs => spent
                    throw new ChainLookupException("Blockfrost getUtxos failed: " + pageRes.getResponse());
                }
                List<Utxo> utxos = pageRes.getValue();
                if (utxos == null || utxos.isEmpty()) return Optional.empty(); // exhausted => spent
                boolean present = utxos.stream().anyMatch(u ->
                        u.getTxHash().equalsIgnoreCase(txHashHex) && u.getOutputIndex() == index);
                if (present) return Optional.of(new UtxoInfo(owner));
                if (utxos.size() < 100) return Optional.empty();
            }
        } catch (ChainLookupException e) {
            throw e;
        } catch (Exception e) {
            throw new ChainLookupException("Blockfrost lookup failed", e);
        }
    }

    @Override
    public long getCurrentSlot() {
        try {
            var res = backend.getBlockService().getLatestBlock();
            if (!res.isSuccessful()) throw new ChainLookupException("Blockfrost latest block: " + res.getResponse());
            return res.getValue().getSlot();
        } catch (ChainLookupException e) { throw e; }
        catch (Exception e) { throw new ChainLookupException("Blockfrost latest block failed", e); }
    }

    @Override
    public BigInteger getCoinsPerUtxoByte() {
        if (cachedCoinsPerUtxoByte != null) return cachedCoinsPerUtxoByte;
        try {
            var res = backend.getEpochService().getProtocolParameters();
            if (!res.isSuccessful()) throw new ChainLookupException("Blockfrost params: " + res.getResponse());
            cachedCoinsPerUtxoByte = new BigInteger(res.getValue().getCoinsPerUtxoSize());
            return cachedCoinsPerUtxoByte;
        } catch (ChainLookupException e) { throw e; }
        catch (Exception e) { throw new ChainLookupException("Blockfrost params failed", e); }
    }

    @Override
    public String submitTransaction(byte[] txBytes) {
        try {
            Result<String> res = backend.getTransactionService().submitTransaction(txBytes);
            if (!res.isSuccessful())
                throw new SubmissionException("Blockfrost submit rejected: " + res.getResponse());
            return res.getValue().toLowerCase();
        } catch (SubmissionException e) { throw e; }
        catch (Exception e) { throw new SubmissionException("Blockfrost submit failed", e); }
    }

    @Override
    public boolean awaitInclusion(String txHashHex, Duration timeout) {
        // Fallback-only path (yaci-store is primary, Task 12): poll Blockfrost for the tx.
        long deadline = System.currentTimeMillis() + timeout.toMillis();
        while (System.currentTimeMillis() < deadline) {
            try {
                var res = backend.getTransactionService().getTransaction(txHashHex);
                if (res.isSuccessful()) return true;
            } catch (Exception ignored) { /* transient; keep polling */ }
            try { Thread.sleep(3000); } catch (InterruptedException e) {
                Thread.currentThread().interrupt(); return false;
            }
        }
        return false;
    }
}
