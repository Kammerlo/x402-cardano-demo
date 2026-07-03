package org.x402cardano.facilitator.cardano;

/**
 * Wire-identical error codes for the exact-cardano scheme. Port of the
 * ERR_* constants in ../x402/typescript/packages/mechanisms/cardano/src/constants.ts
 * used by scheme.ts's verify()/settle().
 */
public final class ErrorCodes {
    public static final String UNSUPPORTED_SCHEME = "unsupported_scheme";
    public static final String INVALID_PAYLOAD = "invalid_exact_cardano_payload";
    public static final String UNSUPPORTED_VERSION = INVALID_PAYLOAD + "_unsupported_version";
    public static final String NETWORK_MISMATCH = "network_mismatch";
    public static final String DECODE_FAILED = INVALID_PAYLOAD + "_transaction_decode_failed";
    public static final String NETWORK_ID_MISMATCH = INVALID_PAYLOAD + "_network_id_mismatch";
    public static final String UNSIGNED = INVALID_PAYLOAD + "_unsigned";
    public static final String INVALID_SIGNATURE = INVALID_PAYLOAD + "_invalid_signature";
    public static final String TTL_EXPIRED = INVALID_PAYLOAD + "_ttl_expired";
    public static final String NOT_YET_VALID = INVALID_PAYLOAD + "_not_yet_valid";
    public static final String NONCE_INVALID = INVALID_PAYLOAD + "_nonce_invalid";
    public static final String NONCE_NOT_IN_INPUTS = INVALID_PAYLOAD + "_nonce_not_in_inputs";
    public static final String NONCE_NOT_ON_CHAIN = INVALID_PAYLOAD + "_nonce_not_on_chain";
    public static final String INPUT_NOT_AVAILABLE = INVALID_PAYLOAD + "_input_not_available";
    public static final String RECIPIENT_MISMATCH = INVALID_PAYLOAD + "_recipient_mismatch";
    public static final String ASSET_MISMATCH = INVALID_PAYLOAD + "_asset_mismatch";
    public static final String AMOUNT_INSUFFICIENT = INVALID_PAYLOAD + "_amount_insufficient";
    public static final String MIN_UTXO_INSUFFICIENT = INVALID_PAYLOAD + "_min_utxo_insufficient";
    public static final String VERIFICATION_ERROR = INVALID_PAYLOAD + "_verification_error";
    public static final String CHAIN_LOOKUP_FAILED = "exact_cardano_facilitator_chain_lookup_failed";
    public static final String SETTLEMENT_FAILED = "exact_cardano_settlement_failed";
    public static final String SETTLEMENT_NOT_CONFIRMED = "exact_cardano_settlement_not_confirmed";
    public static final String DUPLICATE_SETTLEMENT = "duplicate_settlement";

    private ErrorCodes() {}
}
