# x402-on-Cardano Demo — Design

**Date:** 2026-07-03
**Status:** Approved
**Network:** Cardano preprod, `exact` scheme, address-to-address (`assetTransferMethod: default`), priced in lovelace.

## Goal

A three-component demo of the x402 payment protocol on Cardano preprod:

1. **Frontend** — React, educative step-by-step client using Evolution SDK with a CIP-30 browser wallet.
2. **Resource server** — deliberately minimal TypeScript/Express server that serves a small JSON proof once payment settles.
3. **Facilitator** — Java 21 / Spring Boot 3 / Gradle, built on embedded **yaci-store** and **cardano-client-lib**. This is the correctness centerpiece.

The frontend and server consume the TypeScript libraries from the sibling repo `../x402` (`@x402/core`, `@x402/fetch`, `@x402/express`, `@x402/cardano`). `@x402/cardano` is **not published to npm**, so both apps link the local workspace via `file:` dependencies; a `setup.sh` builds `../x402/typescript` once (`pnpm install && pnpm build`).

The facilitator has **no dependency on `../x402` code**. The `org.x402` Java library is dead and must not be used. The facilitator is a from-scratch Java replication of:

- `../x402/typescript/packages/core` — protocol types, facilitator registry, HTTP surface,
- `../x402/typescript/packages/mechanisms/cardano/src/exact/facilitator` — the `exact` Cardano scheme,

with `../x402/specs/schemes/exact/scheme_exact_cardano.md` as the normative spec and `../x402/specs/x402-specification-v2.md` + `specs/transports-v2/http.md` for the envelope. Protocol version: **x402 v2 only**.

## Locked decisions

| Decision | Choice |
|---|---|
| Wallet | CIP-30 browser wallet (Eternl/Lace/…) |
| Chain infra | Blockfrost preprod (frontend provider, facilitator UTxO/params/submit) + embedded yaci-store synced from public relay over N2N |
| Asset | `lovelace`, price `2000000` (2 tADA) per request |
| Settlement | `/settle` blocks until the tx is included in a block (`status: "confirmed"`); mempool-only is a failure unless `acceptMempool` config is set |
| Java lib | None — replicate TS in Java |
| Facilitator architecture | Embedded yaci-store starters (H2), hexagonal core |
| Validation | Port TS unit/integration tests to Java; HTTP contract tests; live runbook |
| Build | Gradle, yaci-store `2.0.0-beta1`, cardano-client-lib `0.6.4`, Spring Boot 3.x |

## Repo layout

```
x402-cardano-demo/
├── frontend/      React + Vite + TS; @x402/core+fetch+cardano(client); Evolution SDK CIP-30 signer
├── server/        Express; @x402/express + @x402/cardano(server); ~60 commented lines
├── facilitator/   Spring Boot; embedded yaci-store; cardano-client-lib; x402 protocol port
├── setup.sh       builds ../x402/typescript workspace
├── docs/superpowers/specs/   this document
└── README.md      architecture diagram, prerequisites, runbook
```

## Protocol wire contract (what all three components implement)

- HTTP v2 headers, all base64(JSON): request `PAYMENT-SIGNATURE` (PaymentPayload), 402 response `PAYMENT-REQUIRED` (PaymentRequired; body is `{}`), success response `PAYMENT-RESPONSE` (SettleResponse).
- `PaymentRequirements` = `{scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra}`.
- `PaymentPayload` = `{x402Version: 2, resource?, accepted: PaymentRequirements, payload: {transaction, nonce}, extensions?}` where `transaction` = base64 of the CBOR full signed Conway tx `[body, witness_set, true, null]` and `nonce` = `"<txHashHex>#<index>"`, which MUST be an input of the tx.
- Facilitator endpoints:
  - `POST /verify`, `POST /settle` — body `{x402Version, paymentPayload, paymentRequirements}`. Logical failures are HTTP **200**. Missing fields → 400 `{"error": ...}`. Exceptions → 500 `{"error": ...}`.
  - `VerifyResponse` = `{isValid, invalidReason?, invalidMessage?, payer?}`.
  - `SettleResponse` = `{success, errorReason?, errorMessage?, payer?, transaction, network, extra?: {status}}` — `transaction` (`""` on failure) and `network` are REQUIRED even on failure (the TS resource server's Zod schema rejects the response otherwise). `network` echoes `payload.accepted.network`.
  - `GET /supported` → `{"kinds":[{"x402Version":2,"scheme":"exact","network":"cardano:preprod"}],"extensions":[],"signers":{"cardano:*":[]}}`. Canonical ids only; never CIP-34 aliases.
  - `GET /health` → sync/tip status.
- Network ids: canonical `cardano:preprod` (also `cardano:mainnet`, `cardano:preview`); CIP-34 aliases `cip34:0-1` (preprod), `cip34:1-764824073`, `cip34:0-2` accepted as input and normalized. Tx-body `networkId` field: 0 for testnets, 1 for mainnet; absence allowed.
- Asset format: `"lovelace"` or `policyId.assetNameHex` (`/^(lovelace|[0-9a-fA-F]{56}\.[0-9a-fA-F]{0,64})$/`); nonce `/^[0-9a-fA-F]{64}#\d+$/`; address `/^(addr1|addr_test1)[0-9a-z]+$/`.

## Frontend

Single-page walkthrough that drives the payment step by step with library primitives (not the auto-retry wrapper), pausing to display each protocol artifact:

1. Call `GET /api/message` → show 402 + decoded `PAYMENT-REQUIRED` requirements.
2. Connect CIP-30 wallet (enumerate `window.cardano`, `enable()`), show address + preprod check.
3. Build + sign the payment tx via `Cip30CardanoSigner` → show nonce UTxO, outputs, TTL, fee, and the base64 payload.
4. Retry the request with `PAYMENT-SIGNATURE` → show settlement progress (~20–60 s, "waiting for block inclusion").
5. Show the resource JSON + decoded `PAYMENT-RESPONSE` with a Cardanoscan preprod link.

`Cip30CardanoSigner` implements the `ClientCardanoSigner` interface from `@x402/cardano` (`getAddress()`, `buildAndSignPaymentTransaction({network, payTo, asset, amount, maxTimeoutSeconds, extra}) → {transaction, nonce}`) using Evolution SDK (`@evolution-sdk/evolution` 0.5.x) with a Blockfrost preprod provider and the wallet attached via CIP-30. Build recipe replicates the upstream reference signer: pick the first wallet UTxO as nonce and force it via `collectFrom`, `payToAddress(payTo, amount)`, `setValidity({to: Date.now() + maxTimeoutSeconds*1000})`, sign, return base64 CBOR + `txHash#index`. A code panel shows the `wrapFetchWithPayment` one-liner alternative. Errors surfaced per step (wallet declined, insufficient funds, verify/settle failures).

Env: `VITE_BLOCKFROST_PROJECT_ID`, `VITE_SERVER_URL`.

## Resource server

One Express file with heavy comments:

- `cors()` exposing `PAYMENT-REQUIRED, PAYMENT-RESPONSE` and allowing the `PAYMENT-SIGNATURE` request header (required for browsers; absent from all upstream examples).
- `paymentMiddleware` with one route: `GET /api/message`, `accepts: {scheme: "exact", network: "cardano:preprod", payTo: SERVER_ADDRESS, price: {amount: "2000000", asset: "lovelace"}, maxTimeoutSeconds: 600, extra: {assetTransferMethod: "default"}}`, `x402ResourceServer` with `ExactCardanoScheme` (server role) registered for `cardano:preprod` and `HTTPFacilitatorClient({url: FACILITATOR_URL})`.
- Handler returns `{message, paidAt}` — the proof it was done.
- Note: middleware calls the facilitator's `GET /supported` at startup and refuses the route if the kind is missing — a built-in interop check.

Env: `SERVER_CARDANO_ADDRESS` (payTo), `FACILITATOR_URL`, `PORT`.

## Facilitator

Hexagonal Spring Boot app, base package `org.x402cardano.facilitator`, structured to be diffable against the TS sources:

- **`protocol`** — Jackson DTOs replicating `@x402/core` types with identical JSON field names; lenient unknown fields, NON_NULL serialization.
- **`registry`** — `X402Facilitator` registry + `SchemeNetworkFacilitator` interface (`scheme()`, `caipFamily()`, `getExtra()`, `getSigners()`, `verify()`, `settle()`). Dispatch: version bucket by `paymentPayload.x402Version`, then match **top-level** `paymentRequirements.scheme` + `.network` (exact set membership, then `cardano:*` wildcard). Top-level `paymentRequirements` is authoritative for all value checks; deep-comparing `accepted` vs requirements is the resource server's job.
- **`api`** — the four endpoints with the envelope above.
- **`cardano`** — `ExactCardanoFacilitatorScheme` porting the TS `verify()` checks in order, with identical error-code strings:
  1. `payload.x402Version == 2` else `invalid_exact_cardano_payload_unsupported_version`
  2. `accepted.scheme` and `requirements.scheme` both `"exact"` else `unsupported_scheme`
  3. normalized `accepted.network == requirements.network` else `network_mismatch`
  4. network ∈ supported set (after CIP-34 normalization) else `network_mismatch`
  5. payload has non-empty `transaction` + `nonce` else `invalid_exact_cardano_payload`
  6. nonce regex else `..._nonce_invalid`
  7. CBOR decode else `..._transaction_decode_failed`
  8. body `networkId` if present must match (preprod→0) else `..._network_id_mismatch`
  9. zero vkey+bootstrap AND zero script witnesses → `..._unsigned`
  10. every vkey witness must Ed25519-verify over the blake2b-256 hash of the **raw wire body bytes** else `..._invalid_signature`
  11. if `ttl`/`validityIntervalStart` set: `ttl <= currentSlot` → `..._ttl_expired`; `validityStart > currentSlot` → `..._not_yet_valid`
  12. nonce ∈ inputs (lowercase `txhash#index`) else `..._nonce_not_in_inputs`
  13. `getUtxo` for EVERY input: nonce absent → `..._nonce_not_on_chain`; `payer` := nonce UTxO's address; other absent input → `..._input_not_available`; lookup error → `exact_cardano_facilitator_chain_lookup_failed`
  14. some output with address == `payTo` (canonical bech32/credential-bytes comparison) carrying `>= amount` of `asset` (overpayment allowed); failures map to `..._recipient_mismatch` / `..._asset_mismatch` / `..._amount_insufficient`
  15. min-UTxO on the matching output: `(160 + |CBOR(TxOut)|) * coinsPerUtxoByte` (live protocol param, cached) else `..._min_utxo_insufficient`
  16. method checks from **canonical `requirements.extra`** (never client-echoed `accepted.extra`) via `AssetTransferMethodVerifier` strategy — `default`: no-op; `masumi`/`script`: explicit not-supported stubs (extension point)
  17. (optional `evaluateTransaction` dry-run — skipped in the demo; no-op for address-to-address)

  Failures before step 13 return `payer: ""`. A top-level catch maps unexpected exceptions to `invalid_exact_cardano_payload_verification_error`.

  `settle()` = full re-verify → **synchronous** duplicate-claim on the base64 tx string (in-memory map, TTL 120 s, cap 1024; already claimed → `duplicate_settlement`) → submit → await inclusion. Not confirmed in time and `!acceptMempool` → `{success:false, errorReason:"exact_cardano_settlement_not_confirmed", transaction: txHash, network, payer, extra:{status}}` with claim **kept**; submit throw → claim **released**, `errorReason:"exact_cardano_settlement_failed"`, `transaction:""`. Success → `{success:true, transaction: txHashHex, network: accepted.network, payer, extra:{status:"confirmed"}}`.

  Transaction decoding via cardano-client-lib with two non-negotiable rules from the TS implementation: (a) txHash = blake2b-256 over the raw body bytes sliced from the original wire CBOR — never re-serialized; (b) witness verification signs that 32-byte hash. Outputs expose canonical address, `coin`, assets keyed lowercase `policyHex.nameHex`, and serialized TxOut byte length (for min-UTxO).

- **`chain`** — port `FacilitatorChainService`: `getUtxo(outRef) → Optional<UtxoInfo{address}>` (empty = spent-or-never-existed; lookup failures THROW), `getCurrentSlot()`, `getCoinsPerUtxoByte()`, `submitTransaction(bytes) → txHash`, `awaitInclusion(txHash, timeout) → boolean`. Division of authority:
  - **BlockfrostChainService** (cardano-client-lib `BFBackendService`): nonce/input unspent checks (resolve outref → owning address → membership in that address's live UTxO set), protocol params, tx submission. Rationale: a from-tip yaci-store sync cannot authoritatively answer full-UTxO-set questions.
  - **YaciStoreChainService** (embedded starters `blocks` + `transaction`, H2, N2N from `preprod-node.play.dev.cardano.org:3001`, protocol magic 1, sync starting near tip): current tip/slot for the TTL rule (wall-clock fallback from preprod slot config if the tip is stale), and settlement confirmation by polling its own index until the tx appears in a block.
  - Composition is config-driven so a full-sync deployment can hand UTxO checks to yaci-store later.
- **`config`** — `x402.networks=cardano:preprod`, Blockfrost url/projectId, `settle.confirmation-timeout` (default 180 s), `settle.accept-mempool` (false), `duplicate-cache.ttl` (120 s), yaci-store `store.cardano.*` sync settings.

Env: `BLOCKFROST_PROJECT_ID`, optional `BLOCKFROST_BASE_URL`, port 4022 by default.

## Error handling summary

All TS error-code strings preserved verbatim. Notable behaviors: overpayment accepted (`>=`); concurrent double-settle → exactly one success + one `duplicate_settlement`; confirmation timeout keeps the duplicate claim (tx may still land — documented); settle failure responses always include `transaction` + `network`; facilitator never signs or holds funds.

## Testing

1. **Unit fixtures (Java)** — deterministic signed preprod txs built in test code with cardano-client-lib (fixed keys), mutated per case: every verify rule violated once, asserting the exact error code, mirroring TS `scheme.test.ts` (24 cases) + `exact-cardano.test.ts` (19 cases) against a mocked `FacilitatorChainService`.
2. **HTTP contract tests (MockMvc)** — endpoint envelopes: 200-on-logical-failure, 400/500 shapes, settle-failure carrying `transaction`/`network`, `/supported` kind exactness.
3. **Concurrency test** — parallel `/settle` with the same tx → one success, one `duplicate_settlement`.
4. **Live runbook (README)** — start facilitator (`./gradlew bootRun`), server (`pnpm dev`), frontend (`pnpm dev`); pay with a CIP-30 wallet holding preprod tADA (faucet link); verify tx on Cardanoscan preprod. Optional follow-up documented: wiring into `../x402/e2e` as an external facilitator.

## Out of scope (kept open by design)

Masumi and script transfer methods (strategy stubs + `extra` passthrough exist), fee sponsorship (unsupported by scheme), x402 v1 interop, the dead `org.x402` dialect, N-block confirmation depth (config hook noted), Docker packaging.
