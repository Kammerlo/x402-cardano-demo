# Masumi assetTransferMethod Extension — Implementation Plan

> **For agentic workers:** execute task-by-task with a review gate after each. Steps use checkbox syntax.

**Goal:** Extend the x402-cardano-demo to also support the `masumi` assetTransferMethod (escrow-lock with a 19-field inline Plutus datum) alongside the existing `default` address-to-address method, using dummy purchase data that is clearly marked in code.

**Architecture:** Facilitator gains a `MasumiTransferVerifier` (ports the TS `verifyMasumiLock`) plugged into the existing `AssetTransferMethodVerifier` strategy; the resource server adds a second route advertising the masumi `extra` (dummy purchase identifiers); the frontend signer builds the 19-field `Constr 0` lock datum and attaches it as an inline datum on the escrow output. `default` keeps working unchanged.

**Full research reference (exact datum field order, TS check order, API signatures):** `/private/tmp/claude-501/-Users-thkammer-Documents-dev-cardano-x402-cardano-demo/b2cedeb0-ea59-4b37-81c6-c1b7a4b4c043/scratchpad/masumi-research.json` and the TS reference `../x402/typescript/packages/mechanisms/cardano/src/exact/masumi/{datum,lock,verify,constants}.ts`.

## Global Constraints

- **Escrow (locked decision):** a **dummy recoverable** escrow. `payTo == extra.contractAddress == MASUMI_ESCROW_ADDRESS`, a preprod address the operator controls (recoverable — NOT the real `vested_pay` contract). Default `MASUMI_ESCROW_ADDRESS` to `SERVER_CARDANO_ADDRESS` when unset. Mark it clearly as a dummy stand-in for the real escrow.
- **Faithful TS port:** OMIT the spec's "tx validity upper bound ≤ pay_by_time" sub-check (not feasible — facilitator has slots not POSIX time; the TS reference omits it too). `paymentType` stays advisory (unchecked, TS parity). Compare datum fields **structurally** (credential hash / BigInteger / byte[]), NEVER by datum-hex (Evolution emits indefinite-length CBOR, cardano-client definite-length — hex would spuriously mismatch).
- **Two routes:** keep `GET /api/message` on `default`; add a second route for masumi. Register both verifiers.
- **The 19-field lock datum** (`Constr 0`, field index → source), which BOTH the frontend builds and the facilitator parses (they must agree byte-structurally):
  0 `buyer` = payer address (key-cred) — derived at build (wallet's own addr) · 1 `buyer_return_address` = None · 2 `seller` = extra.sellerAddress (key-cred) · 3 `seller_return_address` = None · 4 `reference_key` = extra.referenceKey bytes · 5 `reference_signature` = extra.referenceSignature bytes (≥16) · 6 `seller_nonce` = extra.sellerNonce bytes · 7 `buyer_nonce` = extra.identifierFromPurchaser bytes (**name mismatch**) · 8 `agent_identifier` = extra.agentIdentifier bytes · 9 `collateral_return_lovelace` = int(extra.collateralReturnLovelace, default 0) · 10 `input_hash` = extra.inputHash bytes (default empty) · 11 `result_hash` = empty bytes (constant) · 12 `pay_by_time` = int(extra.payByTime) · 13 `submit_result_time` = int(extra.submitResultTime) · 14 `unlock_time` = int(extra.unlockTime) · 15 `external_dispute_unlock_time` = int(extra.externalDisputeUnlockTime) · 16 `seller_cooldown_time` = int 0 (constant) · 17 `buyer_cooldown_time` = int 0 (constant) · 18 `state` = `Constr 0 []` FundsLocked (constant).
  - **Address datum encoding** (fields 0, 2), mirror `datum.ts` byte-for-byte: `Constr 0 [paymentCred, stakeOption]`; `paymentCred` = `Constr 0 [bytes keyhash]` for a key credential, `Constr 1 [bytes scripthash]` for script; `stakeOption` = `Constr 0 [Constr 0 [Constr 0 [bytes stakehash]]]` (Some→Inline→cred) when a stake credential exists, else `Constr 1 []` (None).
- **Dummy values** (fabricated Masumi purchase identifiers — mark each with a `// DUMMY:` comment): `referenceKey="a1b2c3d4"`, `referenceSignature="9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"` (32 B), `identifierFromPurchaser="1122334455667788"`, `sellerNonce="8877665544332211"`, `agentIdentifier="deadbeefdeadbeefdeadbeefdeadbeef"`, `inputHash=""`, `collateralReturnLovelace="0"`, `payByTime="2000000000000"`, `submitResultTime="2000000600000"`, `unlockTime="2000001200000"`, `externalDisputeUnlockTime="2000001800000"`. Real (not dummy): `sellerAddress` (server addr), `buyer` (wallet, derived). `paymentType="Web3CardanoV2"` is a real required-by-spec constant (advisory).
- **Toolchain:** Java gradle commands run with `JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home` (wrapper is Gradle 8.14, won't run on JDK 25). cardano-client-lib is 0.7.0-beta2. Frontend/server are Node/npm; `./setup.sh` builds `../x402/typescript` if needed.
- **Commits:** conventional, subject ≤72 chars, ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. `.superpowers/` git-excluded.

---

### Task M1: Facilitator — MasumiTransferVerifier + error codes + masumi datum test fixture

**Files:** Create `facilitator/src/main/java/org/x402cardano/facilitator/cardano/MasumiTransferVerifier.java`; modify `ErrorCodes.java` (+4 codes), `ExactCardanoFacilitatorScheme.java` (register verifier in the `methodVerifiers` list); create test `MasumiTransferVerifierTest.java` and extend `TestTx.java` with a masumi-lock fixture builder.

**ErrorCodes to add** (values byte-identical to TS `constants.ts`, all = `INVALID_PAYLOAD + suffix`):
`MASUMI_CONTRACT_MISMATCH="invalid_exact_cardano_payload_masumi_contract_mismatch"`, `MASUMI_DATUM_MISSING="invalid_exact_cardano_payload_masumi_datum_missing"`, `MASUMI_DATUM_INVALID="invalid_exact_cardano_payload_masumi_datum_invalid"`, `MASUMI_DATUM_MISMATCH="invalid_exact_cardano_payload_masumi_datum_mismatch"`.

**`MasumiTransferVerifier.check(extra, requirements, tx, payer)`** — verbatim port of TS `verifyMasumiLock`, exact order (return the error code string on first failure, else `Optional.empty()`):
- **STEP 1 contract:** `extra.contractAddress` present AND equals `requirements.payTo()`, else `MASUMI_CONTRACT_MISMATCH`.
- **STEP 2 locate+parse:** find the first `tx.outputs()` output with `address==payTo`, `coin>=BigInteger(amount)`, and `raw().getInlineDatum()!=null`; none → `MASUMI_DATUM_MISSING`. The datum must be `ConstrPlutusData` with `getAlternative()==0` and exactly 19 fields, else `MASUMI_DATUM_INVALID`.
- **STEP 3 structural invariants** (any fail → `MASUMI_DATUM_INVALID`), in order: (a) f18 state = `Constr 0 []`; (b) f11 result_hash bytes length 0; (c) f9 collateral `BigInteger.signum() >= 0`; (d) f0 buyer & f2 seller payment credential are NOT script (address-datum = `Constr 0 [paymentCred, stakeOption]`, paymentCred `Constr` alt 1 = Script = invalid); (e) f5 reference_signature bytes length ≥ 16; (f) time ordering f12 ≤ f13 ≤ f14 ≤ f15 (BigIntegers).
- **STEP 4 match against extra** (any fail → `MASUMI_DATUM_MISMATCH`), in order: (a) datum buyer credential == payer credential (compare payment-hash + payment-isScript flag + stake-hash-hex-or-""; do NOT compare stake isScript flag — TS parity); (b) datum seller == `extra.sellerAddress`; (c) hex fields for each PRESENT non-empty extra value: `extra.toLowerCase()==HexUtil.encodeHexString(fieldBytes).toLowerCase()` for referenceKey↔f4, referenceSignature↔f5, sellerNonce↔f6, identifierFromPurchaser↔f7, agentIdentifier↔f8, inputHash↔f10; (d) time fields for each present: `BigInteger(extra)==field` for payByTime↔f12, submitResultTime↔f13, unlockTime↔f14, externalDisputeUnlockTime↔f15; (e) if `collateralReturnLovelace` present: `BigInteger==f9`. Fields the server omits are SKIPPED. Then `Optional.empty()`.
- Use cardano-client `com.bloxbean.cardano.client.plutus.spec.{PlutusData, ConstrPlutusData, BytesPlutusData, BigIntPlutusData, ListPlutusData}`, `ConstrPlutusData.getAlternative()`/`getData().getPlutusDataList()`, `BytesPlutusData.getValue()`, `BigIntPlutusData.getValue()`, `com.bloxbean.cardano.client.address.Address` (getPaymentCredential().getType()/.getBytes(), getDelegationCredentialHash()), `com.bloxbean.cardano.client.util.HexUtil`. Wrap all parsing in try/catch → `MASUMI_DATUM_INVALID` on any ClassCastException/NPE.
- Register: `List.of(new DefaultTransferVerifier(), new MasumiTransferVerifier())` at the `methodVerifiers` field.

**`TestTx` masumi fixture:** add a builder that produces a signed preprod tx whose output-0 pays the escrow address the requested lovelace WITH an inline datum = the 19-field `Constr 0` built from a given masumi-extra map (buyer = `PAYER_ADDRESS`, seller = a fixed key-cred addr, dummy field values), using cardano-client `PlutusData` (`ConstrPlutusData.builder().alternative(0).data(ListPlutusData.of(...))`, `BytesPlutusData.of(hex)`, `BigIntPlutusData.of(n)`) and attaching via `TransactionOutput.setInlineDatum(...)`. Provide `Spec`-style mutators so tests can corrupt one field at a time.

**Tests** (`MasumiTransferVerifierTest`, via the same `FakeChainService` setup as `ExactCardanoVerifyTest`, calling `scheme.verify(...)` with `extra.assetTransferMethod="masumi"`): happy path → valid; each of these → its exact code: payTo≠contractAddress → `MASUMI_CONTRACT_MISMATCH`; output missing inline datum → `MASUMI_DATUM_MISSING`; wrong Constr alt / wrong field count → `MASUMI_DATUM_INVALID`; state not FundsLocked → `MASUMI_DATUM_INVALID`; non-empty result_hash → `MASUMI_DATUM_INVALID`; referenceSignature 8 bytes (<16) → `MASUMI_DATUM_INVALID`; time ordering violated → `MASUMI_DATUM_INVALID`; script-cred buyer or seller → `MASUMI_DATUM_INVALID`; buyer≠payer → `MASUMI_DATUM_MISMATCH`; seller≠extra.sellerAddress → `MASUMI_DATUM_MISMATCH`; a hex field mismatch → `MASUMI_DATUM_MISMATCH`; a time field mismatch → `MASUMI_DATUM_MISMATCH`. Keep the existing `default` and all other tests green.

- [ ] TDD: write `TestTx` masumi fixture + `MasumiTransferVerifierTest` first (RED), then implement `ErrorCodes` + `MasumiTransferVerifier` + register (GREEN). Run `JAVA_HOME=…21 ./gradlew test` full suite green. Commit.

---

### Task M2: Server — masumi route + dummy extra

**Files:** modify `server/src/server.ts`, `server/.env.example`.

- Add `MASUMI_ESCROW_ADDRESS` env (default to `SERVER_CARDANO_ADDRESS` when unset), documented as a **DUMMY recoverable stand-in** for the real `vested_pay` escrow.
- Add a second route `GET /api/message-masumi` (keep `GET /api/message` on `default`), `accepts`: `scheme:"exact"`, `network:"cardano:preprod"`, `payTo: MASUMI_ESCROW_ADDRESS`, `price:{amount:"5000000",asset:"lovelace"}` (5 tADA; comfortably above min-UTxO-with-datum), `maxTimeoutSeconds:600`, `extra:` the masumi block — `assetTransferMethod:"masumi"`, `paymentType:"Web3CardanoV2"`, `contractAddress: MASUMI_ESCROW_ADDRESS`, `sellerAddress: SERVER_CARDANO_ADDRESS`, and all the DUMMY fields from Global Constraints (each with a `// DUMMY:` comment). A short block comment must explain these are fabricated Masumi purchase identifiers a real deployment gets from the Masumi Payment Service. Handler returns the same `{message, paidAt}` shape (note in a comment: a successful masumi settle means "funds locked in escrow", not "delivered").
- `.env.example`: add `MASUMI_ESCROW_ADDRESS=` with the dummy explanation.
- Verify: `npm run typecheck` clean. Commit.

---

### Task M3: Frontend — cip30Signer masumi datum build + inline attach

**Files:** modify `frontend/src/x402/cip30Signer.ts` (optionally add `frontend/src/x402/masumiDatum.ts` for the datum builder).

- Branch on `const method = String(input.extra?.assetTransferMethod ?? "default")`. `default` → existing path unchanged. `masumi` → build the datum and attach it inline.
- Keep the lovelace-only guard.
- Build the 19-field `Constr 0` datum from `input.extra` per Global Constraints, mirroring `../x402/typescript/packages/mechanisms/cardano/src/exact/masumi/datum.ts` byte-for-byte. Use Evolution `Data.constr(index, fields)`, `Data.int(bigint)`, `Data.bytearray(hexString)`, `InlineDatum`. `buyer` = the wallet's own address (= nonce UTxO owner = facilitator's payer) — derive via `Address.toBech32(nonceUtxo.address)` or `client.address()`. **HAND-ROLL** `addressToData(bech32)` (do NOT trust `Plutus.Address.Codec.toData`) to emit exactly `Constr 0 [paymentCred, stakeOption]` with the Some/None/Inline/key/script shape from Global Constraints, so the Java parser accepts it. Copy the dummy time/nonce/hex values from `input.extra` VERBATIM (BigInt for ints, lowercase hex for byte fields).
- Attach: `.payToAddress({ address: Address.fromBech32(input.payTo), assets: Assets.fromLovelace(BigInt(input.amount)), datum: new InlineDatum.InlineDatum({ data: datum }) })` and build with `autoMinUtxo:true` (datum-bearing output needs extra min-ADA). Keep `.setValidity`/`.sign` unchanged.
- Add clear `// DUMMY:` markers where the fabricated purchase identifiers enter the datum.
- Verify: `npm run typecheck && npm run build` clean; `npm run dev` starts. (Full live masumi lock needs a wallet — deferred to the human.) Commit.

---

### Task M4: Frontend UI copy + README

**Files:** modify `frontend/src/App.tsx` (or the relevant component) to let the user pick which method to pay with (default vs masumi) OR add a second "pay via masumi (escrow lock)" action pointing at `/api/message-masumi`; keep the astonishing UI intact. Update `README.md` with a "Masumi method" subsection: what the escrow lock is, that it's demonstrated with **dummy purchase data** (list where), the recoverable-escrow choice, and the two routes.

- The UI must make clear (a step note or label) that masumi *locks* funds into an escrow rather than paying the seller directly, and that the datum values are dummy.
- Verify: frontend `npm run typecheck && npm run build` clean. Commit.

---

## Notes / known risk

- **Cross-component datum parity** (frontend Evolution build ↔ facilitator cardano-client parse) can only be fully verified by a live wallet run (the human's step). The Java tests prove the parser against a Java-built fixture; both the fixture and the frontend mirror `datum.ts`, so they should agree — but the address-datum encoding (fields 0/2) is the fragile point. If a live run rejects with `MASUMI_DATUM_INVALID`, the mismatch is in the address `Constr` shape; reconcile the frontend `addressToData` against what the Java parser expects.
