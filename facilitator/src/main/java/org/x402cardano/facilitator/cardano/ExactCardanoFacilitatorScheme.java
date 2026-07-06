// ExactCardanoFacilitatorScheme.java
package org.x402cardano.facilitator.cardano;

import com.bloxbean.cardano.client.api.model.ProtocolParams;
import com.bloxbean.cardano.client.common.MinAdaCalculator;
import org.x402cardano.facilitator.chain.*;
import org.x402cardano.facilitator.protocol.*;
import org.x402cardano.facilitator.registry.CardanoNetworks;
import org.x402cardano.facilitator.registry.SchemeNetworkFacilitator;

import java.math.BigInteger;
import java.time.Duration;
import java.util.*;
import java.util.Base64;
import java.util.regex.Pattern;

/**
 * Port of @x402/cardano's facilitator ExactCardanoScheme
 * (../x402/typescript/packages/mechanisms/cardano/src/exact/facilitator/scheme.ts).
 * Check order and error codes are wire-identical.
 */
public class ExactCardanoFacilitatorScheme implements SchemeNetworkFacilitator {

    public record SettleConfig(Duration confirmationTimeout, boolean acceptMempool, Duration duplicateCacheTtl) {}

    private static final Pattern NONCE_PATTERN = Pattern.compile("^[0-9a-fA-F]{64}#\\d+$");
    private static final String SCHEME_EXACT = "exact";

    private final FacilitatorChainService chain;
    private final CardanoTransactionDecoder decoder;
    private final SettleConfig config;
    private final List<AssetTransferMethodVerifier> methodVerifiers =
            List.of(new DefaultTransferVerifier(), new MasumiTransferVerifier());
    private final DuplicateSettlementCache duplicateCache; // Task 8

    public ExactCardanoFacilitatorScheme(FacilitatorChainService chain,
                                         CardanoTransactionDecoder decoder, SettleConfig config) {
        this.chain = chain;
        this.decoder = decoder;
        this.config = config;
        this.duplicateCache = new DuplicateSettlementCache(config.duplicateCacheTtl());
    }

    @Override public String scheme() { return SCHEME_EXACT; }
    @Override public String caipFamily() { return "cardano:*"; }

    @Override
    public VerifyResponse verify(PaymentPayload payload, PaymentRequirements requirements) {
        try {
            if (payload.x402Version() != 2)
                return VerifyResponse.invalid(ErrorCodes.UNSUPPORTED_VERSION, null, "");
            if (payload.accepted() == null
                    || !SCHEME_EXACT.equals(payload.accepted().scheme())
                    || !SCHEME_EXACT.equals(requirements.scheme()))
                return VerifyResponse.invalid(ErrorCodes.UNSUPPORTED_SCHEME, null, "");
            if (!Objects.equals(CardanoNetworks.normalize(payload.accepted().network()),
                    CardanoNetworks.normalize(requirements.network())))
                return VerifyResponse.invalid(ErrorCodes.NETWORK_MISMATCH, null, "");
            if (!CardanoNetworks.isSupported(requirements.network()))
                return VerifyResponse.invalid(ErrorCodes.NETWORK_MISMATCH, null, "");

            String txB64 = str(payload.payload(), "transaction");
            String nonce = str(payload.payload(), "nonce");
            if (txB64 == null || txB64.isEmpty() || nonce == null || nonce.isEmpty())
                return VerifyResponse.invalid(ErrorCodes.INVALID_PAYLOAD, null, "");
            if (!NONCE_PATTERN.matcher(nonce).matches())
                return VerifyResponse.invalid(ErrorCodes.NONCE_INVALID, null, "");

            DecodedTransaction tx;
            try {
                tx = decoder.decode(txB64);
            } catch (CardanoTransactionDecoder.TransactionDecodeException e) {
                return VerifyResponse.invalid(ErrorCodes.DECODE_FAILED, e.getMessage(), "");
            }

            // Rule 1: body networkId, when declared, must match. Absence is allowed —
            // bech32 payTo is network-tagged, so Rule 2/3 still pin the network.
            int expectedNetworkId = CardanoNetworks.networkId(requirements.network());
            if (tx.networkId() != null && tx.networkId() != expectedNetworkId)
                return VerifyResponse.invalid(ErrorCodes.NETWORK_ID_MISMATCH, null, "");

            // SECURITY: refuse unsigned txs so /verify can't green-light an unpaid request.
            if (tx.vkeyWitnessCount() == 0 && tx.scriptWitnessCount() == 0)
                return VerifyResponse.invalid(ErrorCodes.UNSIGNED, null, "");
            if (!tx.signaturesValid())
                return VerifyResponse.invalid(ErrorCodes.INVALID_SIGNATURE, null, "");

            // Rule 6: TTL upper bound + lower validity bound vs current slot.
            if (tx.ttlSlot() != null || tx.validityStartSlot() != null) {
                long currentSlot;
                try {
                    currentSlot = chain.getCurrentSlot();
                } catch (RuntimeException e) {
                    return VerifyResponse.invalid(ErrorCodes.CHAIN_LOOKUP_FAILED, e.getMessage(), "");
                }
                if (tx.ttlSlot() != null && tx.ttlSlot() <= currentSlot)
                    return VerifyResponse.invalid(ErrorCodes.TTL_EXPIRED, null, "");
                if (tx.validityStartSlot() != null && tx.validityStartSlot() > currentSlot)
                    return VerifyResponse.invalid(ErrorCodes.NOT_YET_VALID, null, "");
            }

            // Rule 5a: the nonce must be one of the tx inputs. Parse and rebuild the
            // ref (TS parseUtxoRef parity) so "<hash>#00" still matches "<hash>#0".
            int sep = nonce.indexOf('#');
            String nonceLower = nonce.substring(0, sep).toLowerCase()
                    + "#" + Integer.parseInt(nonce.substring(sep + 1));
            if (!tx.inputs().contains(nonceLower))
                return VerifyResponse.invalid(ErrorCodes.NONCE_NOT_IN_INPUTS, null, "");

            // Rule 5b: EVERY input must currently be unspent; payer = nonce UTxO owner.
            Map<String, Optional<UtxoInfo>> snapshots = new LinkedHashMap<>();
            try {
                for (String ref : tx.inputs()) {
                    int hashEnd = ref.indexOf('#');
                    snapshots.put(ref, chain.getUtxo(ref.substring(0, hashEnd),
                            Integer.parseInt(ref.substring(hashEnd + 1))));
                }
            } catch (RuntimeException e) {
                return VerifyResponse.invalid(ErrorCodes.CHAIN_LOOKUP_FAILED, e.getMessage(), "");
            }
            Optional<UtxoInfo> nonceUtxo = snapshots.get(nonceLower);
            if (nonceUtxo.isEmpty())
                return VerifyResponse.invalid(ErrorCodes.NONCE_NOT_ON_CHAIN, null, "");
            String payer = nonceUtxo.get().address();
            if (snapshots.values().stream().anyMatch(Optional::isEmpty))
                return VerifyResponse.invalid(ErrorCodes.INPUT_NOT_AVAILABLE, null, payer);

            // Rules 2/3/4: at least one output pays >= amount of the exact asset to payTo.
            BigInteger requestedAmount = new BigInteger(requirements.amount());
            String assetKey = requirements.asset().toLowerCase();
            boolean isLovelace = "lovelace".equals(assetKey);
            boolean recipientFound = false, assetFound = false;
            BigInteger bestAvailable = BigInteger.ZERO;

            for (DecodedTransaction.Output out : tx.outputs()) {
                if (!out.address().equals(requirements.payTo())) continue;
                recipientFound = true;
                BigInteger available = isLovelace ? out.coin() : out.assets().get(assetKey);
                if (available == null) continue;
                assetFound = true;
                if (available.compareTo(bestAvailable) > 0) bestAvailable = available;
                if (available.compareTo(requestedAmount) >= 0) {
                    // Rule 7: min-UTxO with live coinsPerUtxoByte (MinAdaCalculator = CIP-55 formula).
                    BigInteger coinsPerUtxoByte;
                    try {
                        coinsPerUtxoByte = chain.getCoinsPerUtxoByte();
                    } catch (RuntimeException e) {
                        return VerifyResponse.invalid(ErrorCodes.CHAIN_LOOKUP_FAILED, e.getMessage(), payer);
                    }
                    ProtocolParams pp = new ProtocolParams();
                    pp.setCoinsPerUtxoSize(coinsPerUtxoByte.toString());
                    BigInteger minUtxo = new MinAdaCalculator(pp).calculateMinAda(out.raw());
                    if (out.coin().compareTo(minUtxo) < 0)
                        return VerifyResponse.invalid(ErrorCodes.MIN_UTXO_INSUFFICIENT,
                                "output to " + requirements.payTo() + " carries " + out.coin()
                                        + " lovelace, min-UTXO requires " + minUtxo, payer);

                    // Method checks read CANONICAL requirements.extra (never accepted.extra).
                    String method = requirements.extra() == null ? "default"
                            : String.valueOf(requirements.extra().getOrDefault("assetTransferMethod", "default"));
                    Optional<AssetTransferMethodVerifier> verifier = methodVerifiers.stream()
                            .filter(v -> v.supports(method)).findFirst();
                    if (verifier.isEmpty()) // TS returns ERR_UNSUPPORTED_SCHEME for unknown methods
                        return VerifyResponse.invalid(ErrorCodes.UNSUPPORTED_SCHEME,
                                "assetTransferMethod '" + method + "' is not supported by this facilitator", payer);
                    Optional<String> methodError = verifier.get()
                            .check(requirements.extra(), requirements, tx, payer);
                    if (methodError.isPresent())
                        return VerifyResponse.invalid(methodError.get(), null, payer);

                    return VerifyResponse.valid(payer);
                }
            }

            if (!recipientFound) return VerifyResponse.invalid(ErrorCodes.RECIPIENT_MISMATCH, null, payer);
            if (!assetFound) return VerifyResponse.invalid(ErrorCodes.ASSET_MISMATCH, null, payer);
            return VerifyResponse.invalid(ErrorCodes.AMOUNT_INSUFFICIENT,
                    "output to " + requirements.payTo() + " pays " + bestAvailable
                            + ", requires " + requestedAmount, payer);
        } catch (Exception e) {
            return VerifyResponse.invalid(ErrorCodes.VERIFICATION_ERROR, e.getMessage(), "");
        }
    }

    @Override
    public SettleResponse settle(PaymentPayload payload, PaymentRequirements requirements) {
        VerifyResponse verify = verify(payload, requirements);
        String network = payload.accepted() != null ? payload.accepted().network() : requirements.network();
        if (!verify.isValid())
            return SettleResponse.fail(
                    verify.invalidReason() != null ? verify.invalidReason() : "verification_failed",
                    verify.invalidMessage(), network);

        String txB64 = (String) payload.payload().get("transaction");
        // Atomic claim BEFORE submission so concurrent settles can't all pass the check.
        if (!duplicateCache.tryClaim(txB64))
            return SettleResponse.fail(ErrorCodes.DUPLICATE_SETTLEMENT, null, network);

        try {
            String txHash = chain.submitTransaction(Base64.getDecoder().decode(txB64));
            boolean confirmed = chain.awaitInclusion(txHash, config.confirmationTimeout());
            String status = confirmed ? "confirmed" : "mempool";
            if (!confirmed && !config.acceptMempool())
                // Claim KEPT: the tx may still land; retries must not rebroadcast.
                return SettleResponse.failWithTx(ErrorCodes.SETTLEMENT_NOT_CONFIRMED,
                        txHash, network, verify.payer(), status);
            return SettleResponse.ok(txHash, network, verify.payer(), status);
        } catch (RuntimeException e) {
            duplicateCache.release(txB64); // legitimate retry may re-attempt
            return SettleResponse.fail(ErrorCodes.SETTLEMENT_FAILED, describeErrorChain(e), network);
        }
    }

    private static String describeErrorChain(Throwable t) {
        StringBuilder sb = new StringBuilder();
        for (Throwable c = t; c != null; c = c.getCause()) {
            if (sb.length() > 0) sb.append(" | ");
            sb.append(c.getMessage() != null ? c.getMessage() : c.getClass().getSimpleName());
        }
        return sb.toString();
    }

    private static String str(Map<String, Object> map, String key) {
        Object v = map == null ? null : map.get(key);
        return v instanceof String s ? s : null;
    }
}
