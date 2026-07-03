# x402-on-Cardano Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A three-component x402 demo on Cardano preprod — React/Evolution-SDK CIP-30 client, minimal Express resource server, and a spec-correct Java Spring Boot facilitator built on embedded yaci-store + cardano-client-lib.

**Architecture:** Frontend and server consume the TS packages from the sibling repo `../x402` via npm `file:` links. The facilitator is a from-scratch Java replication of `@x402/core`'s facilitator surface and `@x402/cardano`'s exact-scheme facilitator (hexagonal: protocol / registry / cardano scheme / chain port with Blockfrost + yaci-store adapters). Spec: `docs/superpowers/specs/2026-07-03-x402-cardano-demo-design.md`.

**Tech Stack:** React 19 + Vite + TypeScript, `@evolution-sdk/evolution` ^0.5.9, Express 4 + `@x402/express`, Java 21, Spring Boot 3.4.x (Gradle), `com.bloxbean.cardano:yaci-store-*-spring-boot-starter:2.0.0-beta1`, `com.bloxbean.cardano:cardano-client-lib:0.6.4` + `cardano-client-backend-blockfrost:0.6.4`, H2.

## Global Constraints

- **Network:** `cardano:preprod` only (CIP-34 alias `cip34:0-1` accepted as input, normalized, never advertised). Tx-body networkId for preprod = `0`.
- **Protocol:** x402 **v2 only**. `org.x402` Java lib is dead — never reference it.
- **Price:** `{amount: "2000000", asset: "lovelace"}`, `maxTimeoutSeconds: 600`, `extra: {assetTransferMethod: "default"}`.
- **Headers (base64 JSON):** request `PAYMENT-SIGNATURE`, 402 response `PAYMENT-REQUIRED` (body `{}`), success response `PAYMENT-RESPONSE`.
- **Facilitator endpoints:** `POST /verify`, `POST /settle` (body `{x402Version, paymentPayload, paymentRequirements}`; logical failures = HTTP **200**; missing fields = 400 `{"error":"Missing paymentPayload or paymentRequirements"}`; exceptions = 500 `{"error":"<msg>"}`), `GET /supported`, `GET /health`. Ports: facilitator **4022**, server **4021**, frontend **5173**.
- **SettleResponse invariant:** `transaction` (`""` on failure) and `network` (= `paymentPayload.accepted.network`) are ALWAYS present — the TS resource server's Zod schema rejects the response otherwise.
- **Error codes** (verbatim from `../x402/typescript/packages/mechanisms/cardano/src/constants.ts`): `unsupported_scheme`, `invalid_exact_cardano_payload`, `invalid_exact_cardano_payload_unsupported_version` (built as `invalid_exact_cardano_payload` + `_unsupported_version`), `network_mismatch`, `invalid_exact_cardano_payload_transaction_decode_failed`, `invalid_exact_cardano_payload_network_id_mismatch`, `invalid_exact_cardano_payload_unsigned`, `invalid_exact_cardano_payload_invalid_signature`, `invalid_exact_cardano_payload_ttl_expired`, `invalid_exact_cardano_payload_not_yet_valid`, `invalid_exact_cardano_payload_nonce_invalid`, `invalid_exact_cardano_payload_nonce_not_in_inputs`, `invalid_exact_cardano_payload_nonce_not_on_chain`, `invalid_exact_cardano_payload_input_not_available`, `invalid_exact_cardano_payload_recipient_mismatch`, `invalid_exact_cardano_payload_asset_mismatch`, `invalid_exact_cardano_payload_amount_insufficient`, `invalid_exact_cardano_payload_min_utxo_insufficient`, `invalid_exact_cardano_payload_verification_error`, `exact_cardano_facilitator_chain_lookup_failed`, `exact_cardano_settlement_failed`, `exact_cardano_settlement_not_confirmed`, `duplicate_settlement`.
- **Reference sources for porting** (read them before implementing the corresponding task):
  - verify/settle behavior: `../x402/typescript/packages/mechanisms/cardano/src/exact/facilitator/scheme.ts`
  - decoding rules: `../x402/typescript/packages/mechanisms/cardano/src/utils.ts`
  - constants/regexes: `../x402/typescript/packages/mechanisms/cardano/src/constants.ts`
  - signer contracts + build recipe: `../x402/typescript/packages/mechanisms/cardano/src/signer.ts`
  - wire types: `../x402/typescript/packages/core/src/types/{payments,facilitator}.ts`
  - endpoint envelope: `../x402/e2e/facilitators/typescript/index.ts`
  - normative spec: `../x402/specs/schemes/exact/scheme_exact_cardano.md`
- **Correctness invariants (non-negotiable):** txHash = blake2b-256 over the **raw body bytes extracted from the original wire CBOR** (use `TransactionUtil.getTxHash(byte[])` / `extractTransactionBodyFromTx(byte[])` from `com.bloxbean.cardano.client.transaction.util` — never re-serialize); Ed25519 witnesses verify over that 32-byte hash; amount check is `>=` (overpayment allowed); `assetTransferMethod` is read from canonical `requirements.extra`, never from client-echoed `accepted.extra`; verify failures before nonce resolution return `payer: ""`.
- **API drift note:** cardano-client-lib / yaci-store snippets below were checked against the library sources but minor signature drift is possible; if a call doesn't compile, look up the class in the resolved jar (IDE/`javap`) and adapt the call site only — never change the behavior being implemented.
- **Java conventions:** package root `org.x402cardano.facilitator`; Java records for DTOs; no Lombok in our code; JUnit 5 + AssertJ (via `spring-boot-starter-test`).
- **Commits:** conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`), subject ≤ 72 chars, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Env vars:** never commit real values; each app ships a `.env.example` (or `application.yml` placeholders) and README documents them. Required: `BLOCKFROST_PROJECT_ID` (facilitator), `VITE_BLOCKFROST_PROJECT_ID` + `VITE_SERVER_URL` (frontend), `SERVER_CARDANO_ADDRESS` + `FACILITATOR_URL` (server).

---

### Task 1: Repo scaffold + TS workspace link sanity

**Files:**
- Create: `setup.sh`, `.gitignore`, `README.md` (skeleton)

**Interfaces:**
- Produces: a built `../x402/typescript` workspace (each package has `dist/`), and the documented npm `file:` consumption pattern used by Tasks 13–14.

- [ ] **Step 1: Write `.gitignore`**

```gitignore
node_modules/
dist/
build/
.gradle/
data/
*.log
.env
.env.local
facilitator/.mvstore/
```

- [ ] **Step 2: Write `setup.sh`**

```bash
#!/usr/bin/env bash
# Builds the sibling x402 TypeScript workspace so this demo's npm `file:` links
# resolve to compiled packages. Run once before `npm install` in server/ or frontend/.
set -euo pipefail
X402_TS="$(cd "$(dirname "$0")/../x402/typescript" && pwd)"
echo "Building x402 TypeScript workspace at $X402_TS"
cd "$X402_TS"
pnpm install
pnpm build
echo "Done. Packages with dist/:"
ls -d packages/core/dist packages/http/express/dist packages/http/fetch/dist packages/mechanisms/cardano/dist
```

- [ ] **Step 3: Run it and verify**

Run: `chmod +x setup.sh && ./setup.sh`
Expected: ends with the four `dist/` paths listed. If `pnpm` is missing: `npm i -g pnpm`.

- [ ] **Step 4: Verify the npm `file:` consumption pattern works**

The previous demo (git history `37b5066`) consumed the packages with npm `file:` links. Sanity-check it still resolves before building real apps:

```bash
mkdir -p /tmp/x402-linktest && cd /tmp/x402-linktest && npm init -y >/dev/null
npm install --save \
  "@x402/core@file:$HOME/Documents/dev/cardano/x402/typescript/packages/core" \
  "@x402/cardano@file:$HOME/Documents/dev/cardano/x402/typescript/packages/mechanisms/cardano"
node -e "console.log(Object.keys(require('@x402/core')).length > 0 ? 'OK' : 'EMPTY')"
```

Expected: `OK`.
**Fallback if npm rejects a transitive `workspace:` spec:** in `../x402/typescript` run `pnpm --filter @x402/core pack --pack-destination <demo>/vendor` (repeat for `@x402/express`, `@x402/fetch`, `@x402/cardano` — `pnpm pack` rewrites `workspace:~` to real semver), point the demo deps at `file:../vendor/<name>-<version>.tgz`, and add npm `"overrides"` mapping `@x402/core` to the local tarball so the cardano package never resolves core from the npm registry. Record whichever path worked in README.

- [ ] **Step 5: Commit**

```bash
git add .gitignore setup.sh README.md
git commit -m "chore: scaffold repo with x402 workspace setup script"
```

### Task 2: Facilitator Gradle scaffold + boot smoke test

**Files:**
- Create: `facilitator/settings.gradle`, `facilitator/build.gradle`, `facilitator/gradle.properties`
- Create: `facilitator/src/main/java/org/x402cardano/facilitator/FacilitatorApplication.java`
- Create: `facilitator/src/main/resources/application.yml`
- Create: `facilitator/src/test/resources/application-test.yml`
- Test: `facilitator/src/test/java/org/x402cardano/facilitator/FacilitatorApplicationTest.java`

**Interfaces:**
- Produces: bootable Spring app; test profile `test` with yaci-store sync disabled (`store.cardano.sync-auto-start: false`) that ALL later Spring tests use via `@ActiveProfiles("test")`.

- [ ] **Step 1: `settings.gradle` and `build.gradle`**

```gradle
// settings.gradle
rootProject.name = 'x402-cardano-facilitator'
```

```gradle
// build.gradle
plugins {
    id 'java'
    id 'org.springframework.boot' version '3.4.5'
    id 'io.spring.dependency-management' version '1.1.7'
}

group = 'org.x402cardano'
version = '0.1.0'

java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }

repositories { mavenCentral() }

ext {
    yaciStoreVersion = '2.0.0-beta1'
    cardanoClientVersion = '0.6.4'
}

dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-web'
    // yaci-store: core sync engine + event pipeline (N2N chainsync from a remote relay)
    implementation "com.bloxbean.cardano:yaci-store-spring-boot-starter:${yaciStoreVersion}"
    implementation "com.bloxbean.cardano:yaci-store-blocks-spring-boot-starter:${yaciStoreVersion}"
    // cardano-client-lib: CBOR/tx model, crypto, Blockfrost backend
    implementation "com.bloxbean.cardano:cardano-client-lib:${cardanoClientVersion}"
    implementation "com.bloxbean.cardano:cardano-client-backend-blockfrost:${cardanoClientVersion}"
    runtimeOnly 'com.h2database:h2'
    testImplementation 'org.springframework.boot:spring-boot-starter-test'
}

tasks.named('test') { useJUnitPlatform() }
```

- [ ] **Step 2: Application class + config**

```java
// facilitator/src/main/java/org/x402cardano/facilitator/FacilitatorApplication.java
package org.x402cardano.facilitator;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class FacilitatorApplication {
    public static void main(String[] args) {
        SpringApplication.run(FacilitatorApplication.class, args);
    }
}
```

```yaml
# facilitator/src/main/resources/application.yml
server:
  port: 4022

spring:
  datasource:
    url: jdbc:h2:file:./data/yaci-store;AUTO_SERVER=TRUE
    username: sa
    password: ""
    driver-class-name: org.h2.Driver
  flyway:
    locations: classpath:db/store/{vendor}
    out-of-order: true

apiPrefix: /yaci-api

store:
  cardano:
    host: preprod-node.play.dev.cardano.org   # alt public relay: preprod-node.world.dev.cardano.org:30000
    port: 3001
    protocol-magic: 1

x402:
  network: cardano:preprod
  blockfrost:
    base-url: https://cardano-preprod.blockfrost.io/api/v0
    project-id: ${BLOCKFROST_PROJECT_ID:}
  settle:
    confirmation-timeout: 180s
    poll-interval: 3s
    accept-mempool: false
  duplicate-cache:
    ttl: 120s
  sync-from-tip:
    enabled: true
    blocks-behind: 30
```

```yaml
# facilitator/src/test/resources/application-test.yml
store:
  cardano:
    sync-auto-start: false
spring:
  datasource:
    url: jdbc:h2:mem:test
x402:
  blockfrost:
    project-id: test-project-id
  sync-from-tip:
    enabled: false
```

- [ ] **Step 3: Boot smoke test**

```java
// facilitator/src/test/java/org/x402cardano/facilitator/FacilitatorApplicationTest.java
package org.x402cardano.facilitator;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest
@ActiveProfiles("test")
class FacilitatorApplicationTest {
    @Test
    void contextLoads() {}
}
```

- [ ] **Step 4: Run**

Run: `cd facilitator && gradle wrapper --gradle-version 8.14 && ./gradlew test`
Expected: BUILD SUCCESSFUL. If yaci-store's flyway/H2 auto-config fails, read the error — the flyway `locations`/H2 combination above is the documented yaci-store setup; fix config, not code.

- [ ] **Step 5: Commit**

```bash
git add facilitator
git commit -m "feat(facilitator): scaffold Spring Boot app with embedded yaci-store"
```

---

### Task 3: x402 protocol DTOs

**Files:**
- Create: `facilitator/src/main/java/org/x402cardano/facilitator/protocol/PaymentRequirements.java`, `PaymentPayload.java`, `VerifyRequest.java`, `VerifyResponse.java`, `SettleRequest.java`, `SettleResponse.java`, `SupportedKind.java`, `SupportedResponse.java`
- Test: `facilitator/src/test/java/org/x402cardano/facilitator/protocol/ProtocolJsonTest.java`

**Interfaces:**
- Produces (used by every later task):
  - `record PaymentRequirements(String scheme, String network, String asset, String amount, String payTo, Integer maxTimeoutSeconds, Map<String,Object> extra)`
  - `record PaymentPayload(int x402Version, Map<String,Object> resource, PaymentRequirements accepted, Map<String,Object> payload, Map<String,Object> extensions)`
  - `record VerifyRequest(Integer x402Version, PaymentPayload paymentPayload, PaymentRequirements paymentRequirements)` (same shape for `SettleRequest`)
  - `record VerifyResponse(boolean isValid, String invalidReason, String invalidMessage, String payer)` + static factories `valid(payer)` / `invalid(reason, message, payer)`
  - `record SettleResponse(boolean success, String errorReason, String errorMessage, String payer, String transaction, String network, Map<String,Object> extra)` + factories `ok(txHash, network, payer, status)` / `fail(reason, message, network)` / `failWithTx(reason, txHash, network, payer, status)`
  - `record SupportedKind(int x402Version, String scheme, String network)`; `record SupportedResponse(List<SupportedKind> kinds, List<String> extensions, Map<String,List<String>> signers)`

- [ ] **Step 1: Write the failing JSON round-trip test.** Use exact JSON literals from the TS wire (this is the conformance anchor):

```java
// facilitator/src/test/java/org/x402cardano/facilitator/protocol/ProtocolJsonTest.java
package org.x402cardano.facilitator.protocol;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.assertThat;

class ProtocolJsonTest {
    private final ObjectMapper mapper = ProtocolJson.mapper();

    @Test
    void deserializesVerifyRequest() throws Exception {
        String json = """
            {"x402Version":2,
             "paymentPayload":{"x402Version":2,
               "accepted":{"scheme":"exact","network":"cardano:preprod","asset":"lovelace",
                           "amount":"2000000","payTo":"addr_test1abc","maxTimeoutSeconds":600,"extra":{}},
               "payload":{"transaction":"AAAA","nonce":"aa#0"},
               "unknownField":true},
             "paymentRequirements":{"scheme":"exact","network":"cardano:preprod","asset":"lovelace",
               "amount":"2000000","payTo":"addr_test1abc","maxTimeoutSeconds":600,
               "extra":{"assetTransferMethod":"default"}}}
            """;
        VerifyRequest req = mapper.readValue(json, VerifyRequest.class);
        assertThat(req.paymentPayload().accepted().network()).isEqualTo("cardano:preprod");
        assertThat(req.paymentPayload().payload().get("nonce")).isEqualTo("aa#0");
        assertThat(req.paymentRequirements().extra().get("assetTransferMethod")).isEqualTo("default");
    }

    @Test
    void settleFailureAlwaysCarriesTransactionAndNetwork() throws Exception {
        SettleResponse r = SettleResponse.fail("exact_cardano_settlement_failed", "boom", "cardano:preprod");
        String json = mapper.writeValueAsString(r);
        assertThat(json).contains("\"transaction\":\"\"").contains("\"network\":\"cardano:preprod\"");
        assertThat(json).doesNotContain("payer"); // NON_NULL: optional fields omitted
    }

    @Test
    void verifyValidOmitsInvalidReason() throws Exception {
        String json = mapper.writeValueAsString(VerifyResponse.valid("addr_test1payer"));
        assertThat(json).contains("\"isValid\":true").contains("\"payer\":\"addr_test1payer\"");
        assertThat(json).doesNotContain("invalidReason");
    }
}
```

- [ ] **Step 2: Run to verify it fails** — `./gradlew test --tests '*ProtocolJsonTest*'` → compile error (classes missing).

- [ ] **Step 3: Implement the records + shared mapper.** One file per record. Key file contents:

```java
// ProtocolJson.java — shared lenient mapper (mirrors TS tolerance + zod optionality)
package org.x402cardano.facilitator.protocol;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;

public final class ProtocolJson {
    private static final ObjectMapper MAPPER = new ObjectMapper()
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)
            .setSerializationInclusion(JsonInclude.Include.NON_NULL);
    private ProtocolJson() {}
    public static ObjectMapper mapper() { return MAPPER; }
}
```

```java
// SettleResponse.java — note: transaction/network are ALWAYS non-null (Zod contract)
package org.x402cardano.facilitator.protocol;

import java.util.Map;

public record SettleResponse(boolean success, String errorReason, String errorMessage,
                             String payer, String transaction, String network,
                             Map<String, Object> extra) {
    public static SettleResponse ok(String txHash, String network, String payer, String status) {
        return new SettleResponse(true, null, null, payer, txHash, network, Map.of("status", status));
    }
    public static SettleResponse fail(String reason, String message, String network) {
        return new SettleResponse(false, reason, message, null, "", network, null);
    }
    public static SettleResponse failWithTx(String reason, String txHash, String network,
                                            String payer, String status) {
        return new SettleResponse(false, reason, null, payer, txHash, network, Map.of("status", status));
    }
}
```

```java
// VerifyResponse.java
package org.x402cardano.facilitator.protocol;

public record VerifyResponse(boolean isValid, String invalidReason, String invalidMessage, String payer) {
    public static VerifyResponse valid(String payer) { return new VerifyResponse(true, null, null, payer); }
    public static VerifyResponse invalid(String reason, String message, String payer) {
        return new VerifyResponse(false, reason, message, payer == null ? "" : payer);
    }
}
```

The remaining records are plain data holders exactly as declared in **Interfaces** above (`PaymentRequirements`, `PaymentPayload`, `VerifyRequest`, `SettleRequest`, `SupportedKind`, `SupportedResponse`) — no logic. Register nothing with Spring; Task 10 wires the mapper into MVC.

- [ ] **Step 4: Run tests** — `./gradlew test --tests '*ProtocolJsonTest*'` → PASS.

- [ ] **Step 5: Commit** — `git add facilitator/src && git commit -m "feat(facilitator): x402 v2 protocol DTOs with wire-exact JSON"`

---

### Task 4: Network normalization + scheme registry

**Files:**
- Create: `facilitator/src/main/java/org/x402cardano/facilitator/registry/CardanoNetworks.java`, `SchemeNetworkFacilitator.java`, `X402FacilitatorRegistry.java`
- Test: `facilitator/src/test/java/org/x402cardano/facilitator/registry/CardanoNetworksTest.java`, `X402FacilitatorRegistryTest.java`

**Interfaces:**
- Produces:
  - `CardanoNetworks.normalize(String) -> String` (CIP-34 aliases → canonical; unknown ids returned unchanged), `CardanoNetworks.isSupported(String)`, `CardanoNetworks.networkId(String) -> int` (preprod/preview→0, mainnet→1)
  - `interface SchemeNetworkFacilitator { String scheme(); String caipFamily(); VerifyResponse verify(PaymentPayload p, PaymentRequirements r); SettleResponse settle(PaymentPayload p, PaymentRequirements r); }`
  - `X402FacilitatorRegistry.register(String network, SchemeNetworkFacilitator f)`, `.find(int x402Version, String scheme, String network) -> Optional<SchemeNetworkFacilitator>`, `.supported() -> SupportedResponse`

- [ ] **Step 1: Failing tests**

```java
// CardanoNetworksTest.java
package org.x402cardano.facilitator.registry;

import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.assertThat;

class CardanoNetworksTest {
    @Test void normalizesCip34Aliases() {
        assertThat(CardanoNetworks.normalize("cip34:0-1")).isEqualTo("cardano:preprod");
        assertThat(CardanoNetworks.normalize("cip34:1-764824073")).isEqualTo("cardano:mainnet");
        assertThat(CardanoNetworks.normalize("cip34:0-2")).isEqualTo("cardano:preview");
        assertThat(CardanoNetworks.normalize("cardano:preprod")).isEqualTo("cardano:preprod");
        assertThat(CardanoNetworks.normalize("base-sepolia")).isEqualTo("base-sepolia");
    }
    @Test void networkIds() {
        assertThat(CardanoNetworks.networkId("cardano:preprod")).isZero();
        assertThat(CardanoNetworks.networkId("cardano:mainnet")).isEqualTo(1);
    }
}
```

```java
// X402FacilitatorRegistryTest.java
package org.x402cardano.facilitator.registry;

import org.junit.jupiter.api.Test;
import org.x402cardano.facilitator.protocol.*;
import static org.assertj.core.api.Assertions.assertThat;

class X402FacilitatorRegistryTest {
    private final SchemeNetworkFacilitator exact = new SchemeNetworkFacilitator() {
        public String scheme() { return "exact"; }
        public String caipFamily() { return "cardano:*"; }
        public VerifyResponse verify(PaymentPayload p, PaymentRequirements r) { return VerifyResponse.valid("x"); }
        public SettleResponse settle(PaymentPayload p, PaymentRequirements r) { return SettleResponse.ok("h", r.network(), "x", "confirmed"); }
    };

    @Test void findsByVersionSchemeAndNormalizedNetwork() {
        var reg = new X402FacilitatorRegistry();
        reg.register("cardano:preprod", exact);
        assertThat(reg.find(2, "exact", "cardano:preprod")).isPresent();
        assertThat(reg.find(2, "exact", "cip34:0-1")).isPresent();    // alias normalized
        assertThat(reg.find(2, "exact", "cardano:mainnet")).isEmpty();
        assertThat(reg.find(1, "exact", "cardano:preprod")).isEmpty(); // v2 only
        assertThat(reg.find(2, "upto", "cardano:preprod")).isEmpty();
    }

    @Test void supportedAdvertisesCanonicalKindAndEmptySigners() {
        var reg = new X402FacilitatorRegistry();
        reg.register("cardano:preprod", exact);
        SupportedResponse s = reg.supported();
        assertThat(s.kinds()).containsExactly(new SupportedKind(2, "exact", "cardano:preprod"));
        assertThat(s.extensions()).isEmpty();
        assertThat(s.signers()).containsEntry("cardano:*", java.util.List.of());
    }
}
```

- [ ] **Step 2: Run to verify failure** — `./gradlew test --tests '*registry*'` → compile error.

- [ ] **Step 3: Implement**

```java
// CardanoNetworks.java
package org.x402cardano.facilitator.registry;

import java.util.Map;
import java.util.Set;

public final class CardanoNetworks {
    public static final String MAINNET = "cardano:mainnet";
    public static final String PREPROD = "cardano:preprod";
    public static final String PREVIEW = "cardano:preview";
    private static final Map<String, String> CIP34_ALIASES = Map.of(
            "cip34:1-764824073", MAINNET, "cip34:0-1", PREPROD, "cip34:0-2", PREVIEW);
    private static final Set<String> SUPPORTED = Set.of(MAINNET, PREPROD, PREVIEW);
    private CardanoNetworks() {}
    public static String normalize(String network) {
        // Exact alias-map lookup only — TS normalizeCardanoNetwork does no case or
        // whitespace folding, and neither may we ("CARDANO:PREPROD" is rejected).
        if (network == null) return null;
        return CIP34_ALIASES.getOrDefault(network, network);
    }
    public static boolean isSupported(String network) { return SUPPORTED.contains(normalize(network)); }
    public static int networkId(String network) { return MAINNET.equals(normalize(network)) ? 1 : 0; }
}
```

```java
// X402FacilitatorRegistry.java
package org.x402cardano.facilitator.registry;

import org.x402cardano.facilitator.protocol.*;
import java.util.*;

public class X402FacilitatorRegistry {
    private record Key(String scheme, String network) {}
    private final Map<Key, SchemeNetworkFacilitator> handlers = new LinkedHashMap<>();

    public void register(String network, SchemeNetworkFacilitator facilitator) {
        handlers.put(new Key(facilitator.scheme(), CardanoNetworks.normalize(network)), facilitator);
    }

    public Optional<SchemeNetworkFacilitator> find(int x402Version, String scheme, String network) {
        if (x402Version != 2) return Optional.empty();
        return Optional.ofNullable(handlers.get(new Key(scheme, CardanoNetworks.normalize(network))));
    }

    public SupportedResponse supported() {
        List<SupportedKind> kinds = handlers.keySet().stream()
                .map(k -> new SupportedKind(2, k.scheme(), k.network())).toList();
        Map<String, List<String>> signers = new LinkedHashMap<>();
        handlers.values().forEach(h -> signers.put(h.caipFamily(), List.of()));
        return new SupportedResponse(kinds, List.of(), signers);
    }
}
```

`SchemeNetworkFacilitator.java` is the four-method interface from **Interfaces** verbatim.

- [ ] **Step 4: Run tests** — PASS. **Step 5: Commit** — `git commit -m "feat(facilitator): network normalization and scheme registry"`

### Task 5: Transaction decoder + test fixture builder

**Files:**
- Create: `facilitator/src/main/java/org/x402cardano/facilitator/cardano/DecodedTransaction.java`, `CardanoTransactionDecoder.java`
- Create (test helper): `facilitator/src/test/java/org/x402cardano/facilitator/cardano/TestTx.java`
- Test: `facilitator/src/test/java/org/x402cardano/facilitator/cardano/CardanoTransactionDecoderTest.java`

**Interfaces:**
- Produces:
  - `record DecodedTransaction(String txHashHex, List<String> inputs /* lowercase "txhash#index" */, List<Output> outputs, Long ttlSlot /* null=absent */, Long validityStartSlot /* null=absent */, Integer networkId /* null=absent */, int vkeyWitnessCount, int scriptWitnessCount, boolean signaturesValid)` with nested `record Output(String address, java.math.BigInteger coin, Map<String, java.math.BigInteger> assets /* "policyhex.namehex" lowercase */, com.bloxbean.cardano.client.transaction.spec.TransactionOutput raw)`
  - `CardanoTransactionDecoder.decode(String base64Tx) -> DecodedTransaction` (throws `TransactionDecodeException` on malformed CBOR)
  - `TestTx` fixture builder producing deterministic signed preprod txs (used by Tasks 7–10 tests)

- [ ] **Step 1: Write `TestTx` fixture builder (test scope).** Deterministic keys, offline, no network:

```java
// facilitator/src/test/java/org/x402cardano/facilitator/cardano/TestTx.java
package org.x402cardano.facilitator.cardano;

import com.bloxbean.cardano.client.address.AddressProvider;
import com.bloxbean.cardano.client.address.Credential;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.crypto.KeyGenUtil;
import com.bloxbean.cardano.client.crypto.SecretKey;
import com.bloxbean.cardano.client.crypto.VerificationKey;
import com.bloxbean.cardano.client.transaction.TransactionSigner;
import com.bloxbean.cardano.client.transaction.spec.*;
import com.bloxbean.cardano.client.util.HexUtil;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/** Deterministic signed-transaction fixtures for decoder/scheme tests. */
public final class TestTx {
    // Fixed 32-byte Ed25519 seed => stable payer key/address across runs.
    public static final SecretKey PAYER_KEY =
            new SecretKey("5820" + "11".repeat(32));
    public static final VerificationKey PAYER_VKEY;
    public static final String PAYER_ADDRESS;
    public static final String PAY_TO; // the "server" address fixtures pay to
    public static final String NONCE_TX_HASH = "ab".repeat(32);
    public static final String NONCE = NONCE_TX_HASH + "#0";

    static {
        try {
            PAYER_VKEY = KeyGenUtil.getPublicKeyFromPrivateKey(PAYER_KEY);
            PAYER_ADDRESS = AddressProvider.getEntAddress(
                    Credential.fromKey(KeyGenUtil.getKeyHash(PAYER_VKEY)), Networks.testnet()).toBech32();
            SecretKey serverKey = new SecretKey("5820" + "22".repeat(32));
            PAY_TO = AddressProvider.getEntAddress(
                    Credential.fromKey(KeyGenUtil.getKeyHash(KeyGenUtil.getPublicKeyFromPrivateKey(serverKey))),
                    Networks.testnet()).toBech32();
        } catch (Exception e) { throw new ExceptionInInitializerError(e); }
    }

    public record Spec(String payTo, BigInteger amount, Long ttl, Long validityStart,
                       NetworkId networkId, boolean sign, List<TransactionInput> extraInputs) {
        public static Spec defaults() {
            return new Spec(PAY_TO, BigInteger.valueOf(2_000_000L), 1_000_000L, null, null, true, List.of());
        }
        public Spec withPayTo(String v) { return new Spec(v, amount, ttl, validityStart, networkId, sign, extraInputs); }
        public Spec withAmount(BigInteger v) { return new Spec(payTo, v, ttl, validityStart, networkId, sign, extraInputs); }
        public Spec withTtl(Long v) { return new Spec(payTo, amount, v, validityStart, networkId, sign, extraInputs); }
        public Spec withValidityStart(Long v) { return new Spec(payTo, amount, ttl, v, networkId, sign, extraInputs); }
        public Spec withNetworkId(NetworkId v) { return new Spec(payTo, amount, ttl, validityStart, v, sign, extraInputs); }
        public Spec unsigned() { return new Spec(payTo, amount, ttl, validityStart, networkId, false, extraInputs); }
        public Spec withExtraInputs(List<TransactionInput> v) { return new Spec(payTo, amount, ttl, validityStart, networkId, sign, v); }
    }

    /** Builds a signed (or unsigned) tx: input = NONCE utxo (+extras), output0 = payment, output1 = change. */
    public static String buildBase64(Spec spec) {
        try {
            List<TransactionInput> inputs = new ArrayList<>();
            inputs.add(new TransactionInput(NONCE_TX_HASH, 0));
            inputs.addAll(spec.extraInputs());
            TransactionOutput payment = TransactionOutput.builder()
                    .address(spec.payTo())
                    .value(Value.builder().coin(spec.amount()).build()).build();
            TransactionOutput change = TransactionOutput.builder()
                    .address(PAYER_ADDRESS)
                    .value(Value.builder().coin(BigInteger.valueOf(7_000_000L)).build()).build();
            TransactionBody.TransactionBodyBuilder body = TransactionBody.builder()
                    .inputs(inputs).outputs(List.of(payment, change))
                    .fee(BigInteger.valueOf(170_000L));
            if (spec.ttl() != null) body.ttl(spec.ttl());
            if (spec.validityStart() != null) body.validityStartInterval(spec.validityStart());
            if (spec.networkId() != null) body.networkId(spec.networkId());
            Transaction tx = Transaction.builder().body(body.build())
                    .witnessSet(new TransactionWitnessSet()).build();
            Transaction result = spec.sign() ? TransactionSigner.INSTANCE.sign(tx, PAYER_KEY) : tx;
            return Base64.getEncoder().encodeToString(result.serialize());
        } catch (Exception e) { throw new RuntimeException(e); }
    }

    /** A signed tx whose signature bytes were corrupted after signing. */
    public static String buildBase64WithBadSignature() {
        byte[] raw = Base64.getDecoder().decode(buildBase64(Spec.defaults()));
        // Signatures sit near the end of [body, witnessSet, ...]; flip a byte inside the
        // witness area. Adjust index if the assert below fails to find a signature change.
        raw[raw.length - 40] ^= 0x01;
        return Base64.getEncoder().encodeToString(raw);
    }

    private TestTx() {}
}
```

*Note:* if `buildBase64WithBadSignature`'s byte-flip happens to corrupt CBOR structure instead of the signature, decode it in the test and pick an offset inside `witnessSet.vkeyWitnesses[0].signature` (locate via `Transaction.deserialize(raw)` and `HexUtil`) — the requirement is: decodes fine, `signaturesValid == false`.

- [ ] **Step 2: Failing decoder tests**

```java
// CardanoTransactionDecoderTest.java
package org.x402cardano.facilitator.cardano;

import com.bloxbean.cardano.client.transaction.spec.NetworkId;
import com.bloxbean.cardano.client.transaction.util.TransactionUtil;
import org.junit.jupiter.api.Test;
import java.math.BigInteger;
import java.util.Base64;
import static org.assertj.core.api.Assertions.*;

class CardanoTransactionDecoderTest {
    private final CardanoTransactionDecoder decoder = new CardanoTransactionDecoder();

    @Test void decodesSignedPayment() {
        String b64 = TestTx.buildBase64(TestTx.Spec.defaults());
        DecodedTransaction d = decoder.decode(b64);
        assertThat(d.inputs()).containsExactly(TestTx.NONCE);
        assertThat(d.outputs().get(0).address()).isEqualTo(TestTx.PAY_TO);
        assertThat(d.outputs().get(0).coin()).isEqualTo(BigInteger.valueOf(2_000_000L));
        assertThat(d.ttlSlot()).isEqualTo(1_000_000L);
        assertThat(d.validityStartSlot()).isNull();
        assertThat(d.networkId()).isNull();
        assertThat(d.vkeyWitnessCount()).isEqualTo(1);
        assertThat(d.signaturesValid()).isTrue();
        // txHash must equal the raw-bytes hash cardano-client-lib computes:
        assertThat(d.txHashHex())
                .isEqualTo(TransactionUtil.getTxHash(Base64.getDecoder().decode(b64)));
    }

    @Test void flagsUnsigned() {
        DecodedTransaction d = decoder.decode(TestTx.buildBase64(TestTx.Spec.defaults().unsigned()));
        assertThat(d.vkeyWitnessCount()).isZero();
        assertThat(d.scriptWitnessCount()).isZero();
    }

    @Test void flagsBadSignature() {
        DecodedTransaction d = decoder.decode(TestTx.buildBase64WithBadSignature());
        assertThat(d.signaturesValid()).isFalse();
    }

    @Test void exposesNetworkIdWhenPresent() {
        DecodedTransaction d = decoder.decode(
                TestTx.buildBase64(TestTx.Spec.defaults().withNetworkId(NetworkId.TESTNET)));
        assertThat(d.networkId()).isZero();
    }

    @Test void throwsOnGarbage() {
        assertThatThrownBy(() -> decoder.decode(Base64.getEncoder().encodeToString(new byte[]{1, 2, 3})))
                .isInstanceOf(CardanoTransactionDecoder.TransactionDecodeException.class);
    }
}
```

- [ ] **Step 3: Run to verify failure**, then **Step 4: Implement the decoder**

```java
// CardanoTransactionDecoder.java
package org.x402cardano.facilitator.cardano;

import com.bloxbean.cardano.client.crypto.Blake2bUtil;
import com.bloxbean.cardano.client.crypto.api.impl.EdDSASigningProvider;
import com.bloxbean.cardano.client.transaction.spec.*;
import com.bloxbean.cardano.client.transaction.util.TransactionUtil;
import com.bloxbean.cardano.client.util.HexUtil;

import java.math.BigInteger;
import java.util.*;

/**
 * Decodes a base64 CBOR Cardano transaction into the view verify() needs.
 * Port of ../x402/typescript/packages/mechanisms/cardano/src/utils.ts
 * (decodeCardanoTransaction). CORRECTNESS: the tx hash / signature message is
 * blake2b-256 over the RAW body bytes from the wire — TransactionUtil extracts
 * them without re-serialization.
 */
public class CardanoTransactionDecoder {

    public static class TransactionDecodeException extends RuntimeException {
        public TransactionDecodeException(String msg, Throwable cause) { super(msg, cause); }
    }

    private final EdDSASigningProvider ed25519 = new EdDSASigningProvider();

    public DecodedTransaction decode(String base64Tx) {
        byte[] raw;
        Transaction tx;
        String txHashHex;
        try {
            raw = Base64.getDecoder().decode(base64Tx);
            tx = Transaction.deserialize(raw);
            txHashHex = TransactionUtil.getTxHash(raw); // blake2b-256(raw body bytes)
        } catch (Exception e) {
            throw new TransactionDecodeException("Transaction CBOR decode failed", e);
        }

        TransactionBody body = tx.getBody();

        List<String> inputs = body.getInputs().stream()
                .map(i -> i.getTransactionId().toLowerCase() + "#" + i.getIndex())
                .toList();

        List<DecodedTransaction.Output> outputs = new ArrayList<>();
        for (TransactionOutput out : body.getOutputs()) {
            Map<String, BigInteger> assets = new HashMap<>();
            if (out.getValue().getMultiAssets() != null) {
                for (MultiAsset ma : out.getValue().getMultiAssets()) {
                    for (Asset a : ma.getAssets()) {
                        String nameHex = a.getNameAsHex();
                        if (nameHex.startsWith("0x")) nameHex = nameHex.substring(2);
                        assets.put((ma.getPolicyId() + "." + nameHex).toLowerCase(), a.getValue());
                    }
                }
            }
            outputs.add(new DecodedTransaction.Output(out.getAddress(), out.getValue().getCoin(), assets, out));
        }

        // cardano-client-lib models ttl/validityStart as primitive longs (0 when
        // absent), but a REAL `ttl: 0` must fail as expired (TS parity), so detect
        // key presence in the raw body CBOR map: key 3 = ttl, key 8 = validity start.
        java.util.Set<Long> bodyKeys = topLevelBodyKeys(raw);
        Long ttl = bodyKeys.contains(3L) ? body.getTtl() : null;
        Long validityStart = bodyKeys.contains(8L) ? body.getValidityStartInterval() : null;
        Integer networkId = body.getNetworkId() == null ? null
                : (body.getNetworkId() == NetworkId.MAINNET ? 1 : 0);

        TransactionWitnessSet ws = tx.getWitnessSet() == null ? new TransactionWitnessSet() : tx.getWitnessSet();
        List<VkeyWitness> vkeys = ws.getVkeyWitnesses() == null ? List.of() : ws.getVkeyWitnesses();
        int bootstrapCount = ws.getBootstrapWitnesses() == null ? 0 : ws.getBootstrapWitnesses().size();
        int scriptWitnessCount = size(ws.getNativeScripts()) + size(ws.getPlutusV1Scripts())
                + size(ws.getPlutusV2Scripts()) + size(ws.getPlutusV3Scripts()) + size(ws.getRedeemers());

        // Every vkey witness must Ed25519-verify over the 32-byte body hash.
        // Vacuously true with zero vkey witnesses (TS parity: .every() on []) —
        // the scheme's UNSIGNED check handles the no-witness case separately.
        byte[] bodyHash = HexUtil.decodeHexString(txHashHex);
        boolean signaturesValid = true;
        for (VkeyWitness w : vkeys) {
            if (!ed25519.verify(w.getSignature(), bodyHash, w.getVkey())) {
                signaturesValid = false;
                break;
            }
        }

        return new DecodedTransaction(txHashHex, inputs, outputs, ttl, validityStart, networkId,
                vkeys.size() + bootstrapCount, scriptWitnessCount, signaturesValid);
    }

    private static int size(List<?> l) { return l == null ? 0 : l.size(); }

    /** Integer keys present in the body map, read from the raw wire bytes. */
    private static java.util.Set<Long> topLevelBodyKeys(byte[] rawTx) {
        try {
            byte[] bodyBytes = TransactionUtil.extractTransactionBodyFromTx(rawTx);
            co.nstant.in.cbor.model.DataItem item =
                    co.nstant.in.cbor.CborDecoder.decode(bodyBytes).get(0);
            java.util.Set<Long> keys = new HashSet<>();
            for (co.nstant.in.cbor.model.DataItem k : ((co.nstant.in.cbor.model.Map) item).getKeys()) {
                if (k instanceof co.nstant.in.cbor.model.UnsignedInteger u) keys.add(u.getValue().longValue());
            }
            return keys;
        } catch (Exception e) {
            throw new TransactionDecodeException("Transaction body CBOR map decode failed", e);
        }
    }
}
```

Add a decoder test for the `ttl: 0` case (in `CardanoTransactionDecoderTest`). cardano-client-lib itself omits `ttl == 0` when serializing, so the fixture patches the CBOR directly — add this helper to `TestTx`:

```java
    /** cclib can't emit ttl=0, so rewrite the body map: key 3 -> 0. Unsigned is fine
     *  for decoder assertions (ttl extraction doesn't depend on witnesses). */
    public static String buildBase64TtlZero() {
        try {
            byte[] raw = Base64.getDecoder().decode(buildBase64(Spec.defaults().withTtl(1L).unsigned()));
            co.nstant.in.cbor.model.Array tx = (co.nstant.in.cbor.model.Array)
                    co.nstant.in.cbor.CborDecoder.decode(raw).get(0);
            co.nstant.in.cbor.model.Map body = (co.nstant.in.cbor.model.Map) tx.getDataItems().get(0);
            body.put(new co.nstant.in.cbor.model.UnsignedInteger(3),
                     new co.nstant.in.cbor.model.UnsignedInteger(0));
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            new co.nstant.in.cbor.CborEncoder(out).encode(tx);
            return Base64.getEncoder().encodeToString(out.toByteArray());
        } catch (Exception e) { throw new RuntimeException(e); }
    }
```

```java
    @Test void ttlZeroIsPresentNotAbsent() {
        DecodedTransaction d = decoder.decode(TestTx.buildBase64TtlZero());
        assertThat(d.ttlSlot()).isZero(); // present => verify() must report ttl_expired
        DecodedTransaction noTtl = decoder.decode(TestTx.buildBase64(TestTx.Spec.defaults().withTtl(null)));
        assertThat(noTtl.ttlSlot()).isNull();
    }
```

`DecodedTransaction.java` is exactly the record from **Interfaces**.

- [ ] **Step 5: Run tests** — `./gradlew test --tests '*CardanoTransactionDecoderTest*'` → PASS (adjust API drift per Global Constraints if needed).

- [ ] **Step 6: Commit** — `git commit -m "feat(facilitator): CBOR transaction decoder with raw-body-hash signature verification"`

---

### Task 6: Chain port + in-memory test double

**Files:**
- Create: `facilitator/src/main/java/org/x402cardano/facilitator/chain/FacilitatorChainService.java`, `UtxoInfo.java`, `ChainLookupException.java`, `SubmissionException.java`
- Create (test scope): `facilitator/src/test/java/org/x402cardano/facilitator/chain/FakeChainService.java`

**Interfaces:**
- Produces (the Java mirror of TS `FacilitatorCardanoSigner`):

```java
public interface FacilitatorChainService {
    /** empty = spent or never existed; throws ChainLookupException on lookup failure. */
    Optional<UtxoInfo> getUtxo(String txHashHex, int index);
    long getCurrentSlot();
    java.math.BigInteger getCoinsPerUtxoByte();
    /** Broadcasts; returns lowercase hex tx hash. Throws SubmissionException on node rejection. */
    String submitTransaction(byte[] txBytes);
    /** Blocks until the tx is seen in a block or timeout elapses. */
    boolean awaitInclusion(String txHashHex, java.time.Duration timeout);
}
public record UtxoInfo(String address) {}
```

- [ ] **Step 1: Write the interface + records exactly as above** (plus two runtime exceptions with `(String message)` and `(String message, Throwable cause)` constructors).

- [ ] **Step 2: Write `FakeChainService`** (mutable maps/flags so scheme tests script every scenario):

```java
// facilitator/src/test/java/org/x402cardano/facilitator/chain/FakeChainService.java
package org.x402cardano.facilitator.chain;

import java.math.BigInteger;
import java.time.Duration;
import java.util.*;

public class FakeChainService implements FacilitatorChainService {
    public final Map<String, UtxoInfo> utxos = new HashMap<>(); // key "txhash#index"
    public long currentSlot = 500_000L;
    public BigInteger coinsPerUtxoByte = BigInteger.valueOf(4310);
    public boolean throwOnLookup = false;
    public boolean throwOnSubmit = false;
    public boolean included = true;
    public String submittedTxHash;
    public int submitCount = 0;

    @Override public Optional<UtxoInfo> getUtxo(String txHashHex, int index) {
        if (throwOnLookup) throw new ChainLookupException("provider down");
        return Optional.ofNullable(utxos.get(txHashHex.toLowerCase() + "#" + index));
    }
    @Override public long getCurrentSlot() { return currentSlot; }
    @Override public BigInteger getCoinsPerUtxoByte() { return coinsPerUtxoByte; }
    @Override public String submitTransaction(byte[] txBytes) {
        submitCount++;
        if (throwOnSubmit) throw new SubmissionException("BadInputsUTxO");
        submittedTxHash = com.bloxbean.cardano.client.transaction.util.TransactionUtil.getTxHash(txBytes);
        return submittedTxHash;
    }
    @Override public boolean awaitInclusion(String txHashHex, Duration timeout) { return included; }
}
```

- [ ] **Step 3: Compile** — `./gradlew testClasses` → BUILD SUCCESSFUL. **Step 4: Commit** — `git commit -m "feat(facilitator): chain service port and test fake"`

### Task 7: `ExactCardanoFacilitatorScheme.verify()`

**Files:**
- Create: `facilitator/src/main/java/org/x402cardano/facilitator/cardano/ErrorCodes.java`, `ExactCardanoFacilitatorScheme.java`, `AssetTransferMethodVerifier.java`, `DefaultTransferVerifier.java`
- Test: `facilitator/src/test/java/org/x402cardano/facilitator/cardano/ExactCardanoVerifyTest.java`

**Interfaces:**
- Consumes: `DecodedTransaction`/`CardanoTransactionDecoder` (Task 5), `FacilitatorChainService`/`FakeChainService` (Task 6), protocol records (Task 3), `CardanoNetworks` (Task 4).
- Produces: `ExactCardanoFacilitatorScheme implements SchemeNetworkFacilitator` — constructor `(FacilitatorChainService chain, CardanoTransactionDecoder decoder, SettleConfig config)` where `record SettleConfig(java.time.Duration confirmationTimeout, boolean acceptMempool, java.time.Duration duplicateCacheTtl)`; `interface AssetTransferMethodVerifier { boolean supports(String method); Optional<String> check(Map<String,Object> extra, PaymentRequirements req, DecodedTransaction tx, String payer); /* returns error code or empty */ }`.

- [ ] **Step 1: `ErrorCodes.java`** — all constants from Global Constraints as `public static final String`, named `UNSUPPORTED_SCHEME`, `INVALID_PAYLOAD`, `UNSUPPORTED_VERSION` (= `INVALID_PAYLOAD + "_unsupported_version"`), `NETWORK_MISMATCH`, `DECODE_FAILED`, `NETWORK_ID_MISMATCH`, `UNSIGNED`, `INVALID_SIGNATURE`, `TTL_EXPIRED`, `NOT_YET_VALID`, `NONCE_INVALID`, `NONCE_NOT_IN_INPUTS`, `NONCE_NOT_ON_CHAIN`, `INPUT_NOT_AVAILABLE`, `RECIPIENT_MISMATCH`, `ASSET_MISMATCH`, `AMOUNT_INSUFFICIENT`, `MIN_UTXO_INSUFFICIENT`, `VERIFICATION_ERROR` (= `INVALID_PAYLOAD + "_verification_error"`), `CHAIN_LOOKUP_FAILED`, `SETTLEMENT_FAILED`, `SETTLEMENT_NOT_CONFIRMED`, `DUPLICATE_SETTLEMENT`.

- [ ] **Step 2: Write the failing verify tests.** One test per check, exact error code asserted, in the reference order. Shared setup builds a happy-path world with `FakeChainService`:

```java
// ExactCardanoVerifyTest.java
package org.x402cardano.facilitator.cardano;

import org.junit.jupiter.api.*;
import org.x402cardano.facilitator.chain.*;
import org.x402cardano.facilitator.protocol.*;
import java.math.BigInteger;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import static org.assertj.core.api.Assertions.assertThat;

class ExactCardanoVerifyTest {
    FakeChainService chain;
    ExactCardanoFacilitatorScheme scheme;

    PaymentRequirements requirements(String network, String payTo, String amount, String asset) {
        return new PaymentRequirements("exact", network, asset, amount, payTo, 600,
                Map.of("assetTransferMethod", "default"));
    }

    PaymentPayload payload(String txB64, String nonce, PaymentRequirements accepted) {
        Map<String, Object> p = new HashMap<>();
        p.put("transaction", txB64);
        p.put("nonce", nonce);
        return new PaymentPayload(2, null, accepted, p, null);
    }

    @BeforeEach
    void setUp() {
        chain = new FakeChainService();
        chain.utxos.put(TestTx.NONCE, new UtxoInfo(TestTx.PAYER_ADDRESS)); // nonce unspent, owned by payer
        chain.currentSlot = 500_000L; // fixture ttl = 1_000_000 => valid
        scheme = new ExactCardanoFacilitatorScheme(chain, new CardanoTransactionDecoder(),
                new ExactCardanoFacilitatorScheme.SettleConfig(
                        Duration.ofSeconds(5), false, Duration.ofSeconds(120)));
    }

    VerifyResponse verifyDefault() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        return scheme.verify(payload(TestTx.buildBase64(TestTx.Spec.defaults()), TestTx.NONCE, req), req);
    }

    @Test void happyPath() {
        VerifyResponse r = verifyDefault();
        assertThat(r.isValid()).isTrue();
        assertThat(r.payer()).isEqualTo(TestTx.PAYER_ADDRESS);
    }

    @Test void rejectsWrongVersion() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        PaymentPayload p = new PaymentPayload(1, null, req,
                Map.of("transaction", TestTx.buildBase64(TestTx.Spec.defaults()), "nonce", TestTx.NONCE), null);
        VerifyResponse r = scheme.verify(p, req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.UNSUPPORTED_VERSION);
        assertThat(r.payer()).isEmpty();
    }

    @Test void rejectsWrongScheme() {
        PaymentRequirements req = new PaymentRequirements("upto", "cardano:preprod", "lovelace",
                "2000000", TestTx.PAY_TO, 600, Map.of());
        VerifyResponse r = scheme.verify(
                payload(TestTx.buildBase64(TestTx.Spec.defaults()), TestTx.NONCE, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.UNSUPPORTED_SCHEME);
    }

    @Test void rejectsNetworkMismatchBetweenAcceptedAndRequirements() {
        PaymentRequirements accepted = requirements("cardano:preview", TestTx.PAY_TO, "2000000", "lovelace");
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        VerifyResponse r = scheme.verify(
                payload(TestTx.buildBase64(TestTx.Spec.defaults()), TestTx.NONCE, accepted), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.NETWORK_MISMATCH);
    }

    @Test void acceptsCip34AliasAsAcceptedNetwork() {
        PaymentRequirements accepted = requirements("cip34:0-1", TestTx.PAY_TO, "2000000", "lovelace");
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        assertThat(scheme.verify(
                payload(TestTx.buildBase64(TestTx.Spec.defaults()), TestTx.NONCE, accepted), req)
                .isValid()).isTrue();
    }

    @Test void rejectsUnsupportedNetwork() {
        PaymentRequirements req = requirements("base-sepolia", TestTx.PAY_TO, "2000000", "lovelace");
        VerifyResponse r = scheme.verify(
                payload(TestTx.buildBase64(TestTx.Spec.defaults()), TestTx.NONCE, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.NETWORK_MISMATCH);
    }

    @Test void rejectsMissingPayloadFields() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        VerifyResponse r = scheme.verify(new PaymentPayload(2, null, req, Map.of("nonce", TestTx.NONCE), null), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.INVALID_PAYLOAD);
    }

    @Test void rejectsMalformedNonce() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        VerifyResponse r = scheme.verify(
                payload(TestTx.buildBase64(TestTx.Spec.defaults()), "not-a-utxo-ref", req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.NONCE_INVALID);
    }

    @Test void rejectsUndecodableTransaction() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        VerifyResponse r = scheme.verify(payload("bm90LWEtdHg=", TestTx.NONCE, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.DECODE_FAILED);
    }

    @Test void rejectsWrongNetworkId() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        String tx = TestTx.buildBase64(TestTx.Spec.defaults()
                .withNetworkId(com.bloxbean.cardano.client.transaction.spec.NetworkId.MAINNET));
        VerifyResponse r = scheme.verify(payload(tx, TestTx.NONCE, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.NETWORK_ID_MISMATCH);
    }

    @Test void rejectsUnsignedTransaction() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        String tx = TestTx.buildBase64(TestTx.Spec.defaults().unsigned());
        VerifyResponse r = scheme.verify(payload(tx, TestTx.NONCE, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.UNSIGNED);
    }

    @Test void rejectsInvalidSignature() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        VerifyResponse r = scheme.verify(payload(TestTx.buildBase64WithBadSignature(), TestTx.NONCE, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.INVALID_SIGNATURE);
    }

    @Test void rejectsExpiredTtl() {
        chain.currentSlot = 2_000_000L; // fixture ttl 1_000_000 in the past
        VerifyResponse r = verifyDefault();
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.TTL_EXPIRED);
    }

    @Test void rejectsNotYetValid() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        String tx = TestTx.buildBase64(TestTx.Spec.defaults().withValidityStart(900_000L));
        chain.currentSlot = 800_000L;
        VerifyResponse r = scheme.verify(payload(tx, TestTx.NONCE, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.NOT_YET_VALID);
    }

    @Test void rejectsNonceNotInInputs() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        String otherRef = "cd".repeat(32) + "#1";
        chain.utxos.put(otherRef, new UtxoInfo(TestTx.PAYER_ADDRESS));
        VerifyResponse r = scheme.verify(
                payload(TestTx.buildBase64(TestTx.Spec.defaults()), otherRef, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.NONCE_NOT_IN_INPUTS);
    }

    @Test void rejectsNonceNotOnChain() {
        chain.utxos.clear(); // nonce spent / never existed
        VerifyResponse r = verifyDefault();
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.NONCE_NOT_ON_CHAIN);
        assertThat(r.payer()).isEmpty();
    }

    @Test void rejectsSpentNonNonceInput() {
        var extra = new com.bloxbean.cardano.client.transaction.spec.TransactionInput("ee".repeat(32), 2);
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", "lovelace");
        String tx = TestTx.buildBase64(TestTx.Spec.defaults().withExtraInputs(List.of(extra)));
        // nonce exists, the extra input does NOT:
        VerifyResponse r = scheme.verify(payload(tx, TestTx.NONCE, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.INPUT_NOT_AVAILABLE);
        assertThat(r.payer()).isEqualTo(TestTx.PAYER_ADDRESS); // payer already resolved
    }

    @Test void mapsLookupErrorToChainLookupFailed() {
        chain.throwOnLookup = true;
        VerifyResponse r = verifyDefault();
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.CHAIN_LOOKUP_FAILED);
    }

    @Test void rejectsRecipientMismatch() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAYER_ADDRESS /* wrong */, "2000000", "lovelace");
        PaymentRequirements accepted = requirements("cardano:preprod", TestTx.PAYER_ADDRESS, "2000000", "lovelace");
        // tx pays PAY_TO; requirements demand PAYER_ADDRESS... but change output also goes to payer,
        // so use a third address to avoid accidental match:
        String other = "addr_test1vqneq3v0dqh3x3muv6ee3lt8e5729xymnxuavx6tndcjc2cv24ef9";
        req = requirements("cardano:preprod", other, "2000000", "lovelace");
        accepted = req;
        VerifyResponse r = scheme.verify(
                payload(TestTx.buildBase64(TestTx.Spec.defaults()), TestTx.NONCE, accepted), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.RECIPIENT_MISMATCH);
    }

    @Test void rejectsAssetMismatch() {
        String usdm = "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde.0014df105553444d";
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "2000000", usdm);
        VerifyResponse r = scheme.verify(
                payload(TestTx.buildBase64(TestTx.Spec.defaults()), TestTx.NONCE, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.ASSET_MISMATCH);
    }

    @Test void rejectsInsufficientAmount() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "3000000", "lovelace");
        VerifyResponse r = scheme.verify(
                payload(TestTx.buildBase64(TestTx.Spec.defaults()), TestTx.NONCE, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.AMOUNT_INSUFFICIENT);
    }

    @Test void acceptsOverpayment() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "1500000", "lovelace");
        assertThat(scheme.verify(
                payload(TestTx.buildBase64(TestTx.Spec.defaults()), TestTx.NONCE, req), req).isValid()).isTrue();
    }

    @Test void rejectsBelowMinUtxo() {
        PaymentRequirements req = requirements("cardano:preprod", TestTx.PAY_TO, "100000", "lovelace");
        String tx = TestTx.buildBase64(TestTx.Spec.defaults().withAmount(java.math.BigInteger.valueOf(100_000L)));
        VerifyResponse r = scheme.verify(payload(tx, TestTx.NONCE, req), req);
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.MIN_UTXO_INSUFFICIENT);
    }

    @Test void rejectsUnknownTransferMethod() {
        PaymentRequirements req = new PaymentRequirements("exact", "cardano:preprod", "lovelace",
                "2000000", TestTx.PAY_TO, 600, Map.of("assetTransferMethod", "masumi"));
        VerifyResponse r = scheme.verify(
                payload(TestTx.buildBase64(TestTx.Spec.defaults()), TestTx.NONCE, req), req);
        // masumi not implemented in this demo; TS uses unsupported_scheme for unknown methods
        assertThat(r.invalidReason()).isEqualTo(ErrorCodes.UNSUPPORTED_SCHEME);
    }
}
```

- [ ] **Step 3: Run to verify failure** — `./gradlew test --tests '*ExactCardanoVerifyTest*'` → compile errors.

- [ ] **Step 4: Implement `verify()`.** Faithful port of `scheme.ts` lines 160–411 — keep the exact order and early returns:

```java
// ExactCardanoFacilitatorScheme.java (verify half; settle added in Task 8)
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
    private final List<AssetTransferMethodVerifier> methodVerifiers = List.of(new DefaultTransferVerifier());
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
                    BigInteger minUtxo = new MinAdaCalculator(pp).calculateMinAdaRequired(out.raw());
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

    private static String str(Map<String, Object> map, String key) {
        Object v = map == null ? null : map.get(key);
        return v instanceof String s ? s : null;
    }

    // settle() + DuplicateSettlementCache: Task 8
}
```

```java
// AssetTransferMethodVerifier.java
package org.x402cardano.facilitator.cardano;

import org.x402cardano.facilitator.protocol.PaymentRequirements;
import java.util.Map;
import java.util.Optional;

/** Extension point for assetTransferMethod-specific checks (default/masumi/script). */
public interface AssetTransferMethodVerifier {
    boolean supports(String method);
    /** @return an error code when the check fails, empty when it passes. */
    Optional<String> check(Map<String, Object> extra, PaymentRequirements requirements,
                           DecodedTransaction tx, String payer);
}
```

```java
// DefaultTransferVerifier.java — address-to-address needs nothing beyond the shared checks.
package org.x402cardano.facilitator.cardano;

import org.x402cardano.facilitator.protocol.PaymentRequirements;
import java.util.Map;
import java.util.Optional;

public class DefaultTransferVerifier implements AssetTransferMethodVerifier {
    @Override public boolean supports(String method) { return method == null || method.equals("default"); }
    @Override public Optional<String> check(Map<String, Object> extra, PaymentRequirements requirements,
                                            DecodedTransaction tx, String payer) {
        return Optional.empty();
    }
}
```

*Compile note:* Task 8 defines `DuplicateSettlementCache` and `settle()`; until then stub `settle()` to `throw new UnsupportedOperationException()` and create an empty `DuplicateSettlementCache` class with the `(Duration)` constructor, or implement Tasks 7+8 in one commit if preferred — the review gate is per-task, tests are separate.

- [ ] **Step 5: Run** — `./gradlew test --tests '*ExactCardanoVerifyTest*'` → PASS (min-UTxO test may need `calculateMinAdaRequired` vs `calculateMinAda` API-drift fix).

- [ ] **Step 6: Commit** — `git commit -m "feat(facilitator): exact-cardano verify with spec rule ordering and error codes"`

---

### Task 8: `settle()` + duplicate-settlement cache

**Files:**
- Create: `facilitator/src/main/java/org/x402cardano/facilitator/cardano/DuplicateSettlementCache.java`
- Modify: `ExactCardanoFacilitatorScheme.java` (add `settle()`)
- Test: `facilitator/src/test/java/org/x402cardano/facilitator/cardano/ExactCardanoSettleTest.java`

**Interfaces:**
- Consumes: everything from Task 7.
- Produces: `settle(PaymentPayload, PaymentRequirements) -> SettleResponse`; `DuplicateSettlementCache.tryClaim(String key) -> boolean` (atomic), `.release(String key)`, TTL-based eviction, max 1024 entries.

- [ ] **Step 1: Failing tests**

```java
// ExactCardanoSettleTest.java
package org.x402cardano.facilitator.cardano;

import org.junit.jupiter.api.*;
import org.x402cardano.facilitator.chain.*;
import org.x402cardano.facilitator.protocol.*;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.*;
import static org.assertj.core.api.Assertions.assertThat;

class ExactCardanoSettleTest {
    FakeChainService chain;
    ExactCardanoFacilitatorScheme scheme;
    PaymentRequirements req;
    PaymentPayload payload;

    @BeforeEach void setUp() {
        chain = new FakeChainService();
        chain.utxos.put(TestTx.NONCE, new UtxoInfo(TestTx.PAYER_ADDRESS));
        scheme = new ExactCardanoFacilitatorScheme(chain, new CardanoTransactionDecoder(),
                new ExactCardanoFacilitatorScheme.SettleConfig(
                        Duration.ofSeconds(2), false, Duration.ofSeconds(120)));
        req = new PaymentRequirements("exact", "cardano:preprod", "lovelace", "2000000",
                TestTx.PAY_TO, 600, Map.of("assetTransferMethod", "default"));
        Map<String, Object> p = new HashMap<>();
        p.put("transaction", TestTx.buildBase64(TestTx.Spec.defaults()));
        p.put("nonce", TestTx.NONCE);
        payload = new PaymentPayload(2, null, req, p, null);
    }

    @Test void settlesHappyPath() {
        SettleResponse r = scheme.settle(payload, req);
        assertThat(r.success()).isTrue();
        assertThat(r.transaction()).isEqualTo(chain.submittedTxHash);
        assertThat(r.network()).isEqualTo("cardano:preprod");
        assertThat(r.payer()).isEqualTo(TestTx.PAYER_ADDRESS);
        assertThat(r.extra()).containsEntry("status", "confirmed");
    }

    @Test void settleFailsWhenVerifyFails() {
        chain.utxos.clear();
        SettleResponse r = scheme.settle(payload, req);
        assertThat(r.success()).isFalse();
        assertThat(r.errorReason()).isEqualTo(ErrorCodes.NONCE_NOT_ON_CHAIN);
        assertThat(r.transaction()).isEmpty();
        assertThat(r.network()).isEqualTo("cardano:preprod");
        assertThat(chain.submitCount).isZero();
    }

    @Test void secondSettleOfSameTxIsDuplicate() {
        assertThat(scheme.settle(payload, req).success()).isTrue();
        SettleResponse r2 = scheme.settle(payload, req);
        assertThat(r2.errorReason()).isEqualTo(ErrorCodes.DUPLICATE_SETTLEMENT);
        assertThat(chain.submitCount).isEqualTo(1); // claim retained on success
    }

    @Test void concurrentSettlesYieldExactlyOneSuccess() throws Exception {
        chain.included = true;
        int n = 8;
        ExecutorService pool = Executors.newFixedThreadPool(n);
        CountDownLatch start = new CountDownLatch(1);
        var futures = new java.util.ArrayList<Future<SettleResponse>>();
        for (int i = 0; i < n; i++) {
            futures.add(pool.submit(() -> { start.await(); return scheme.settle(payload, req); }));
        }
        start.countDown();
        long successes = 0, duplicates = 0;
        for (var f : futures) {
            SettleResponse r = f.get(10, TimeUnit.SECONDS);
            if (r.success()) successes++;
            else if (ErrorCodes.DUPLICATE_SETTLEMENT.equals(r.errorReason())) duplicates++;
        }
        pool.shutdown();
        assertThat(successes).isEqualTo(1);
        assertThat(duplicates).isEqualTo(n - 1);
        assertThat(chain.submitCount).isEqualTo(1);
    }

    @Test void submitFailureReleasesClaimAndReportsFailed() {
        chain.throwOnSubmit = true;
        SettleResponse r1 = scheme.settle(payload, req);
        assertThat(r1.errorReason()).isEqualTo(ErrorCodes.SETTLEMENT_FAILED);
        assertThat(r1.errorMessage()).contains("BadInputsUTxO");
        assertThat(r1.transaction()).isEmpty();
        chain.throwOnSubmit = false;
        assertThat(scheme.settle(payload, req).success()).isTrue(); // retry allowed
    }

    @Test void notIncludedInTimeReportsNotConfirmedAndKeepsClaim() {
        chain.included = false;
        SettleResponse r = scheme.settle(payload, req);
        assertThat(r.success()).isFalse();
        assertThat(r.errorReason()).isEqualTo(ErrorCodes.SETTLEMENT_NOT_CONFIRMED);
        assertThat(r.transaction()).isEqualTo(chain.submittedTxHash); // tx hash still reported
        assertThat(r.extra()).containsEntry("status", "mempool");
        assertThat(scheme.settle(payload, req).errorReason()).isEqualTo(ErrorCodes.DUPLICATE_SETTLEMENT);
    }
}
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement**

```java
// DuplicateSettlementCache.java
package org.x402cardano.facilitator.cardano;

import java.time.Duration;
import java.util.concurrent.ConcurrentHashMap;

/**
 * In-process duplicate-settlement guard (spec: "Duplicate Settlement Mitigation").
 * Claims are atomic (putIfAbsent), evicted after the TTL, capped at 1024 entries.
 * The on-chain nonce spend is the durable cross-instance guard; this cache only
 * covers the unconfirmed window.
 */
public class DuplicateSettlementCache {
    private static final int MAX_ENTRIES = 1024;
    private final ConcurrentHashMap<String, Long> claims = new ConcurrentHashMap<>();
    private final long ttlMillis;

    public DuplicateSettlementCache(Duration ttl) { this.ttlMillis = ttl.toMillis(); }

    /** @return true when this call won the claim; false when already claimed. */
    public boolean tryClaim(String key) {
        evictExpired();
        return claims.putIfAbsent(key, System.currentTimeMillis()) == null;
    }

    public void release(String key) { claims.remove(key); }

    private void evictExpired() {
        // TS parity: expired entries are removed only when the cache exceeds the cap;
        // live (in-TTL) claims are NEVER evicted — dropping one would let the same
        // tx be rebroadcast. The map may temporarily exceed MAX_ENTRIES if all
        // entries are live; the TTL bounds that window.
        if (claims.size() > MAX_ENTRIES) {
            long cutoff = System.currentTimeMillis() - ttlMillis;
            claims.values().removeIf(t -> t < cutoff);
        }
    }
}
```

```java
// settle() — add to ExactCardanoFacilitatorScheme (port of scheme.ts lines 420-490)
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
```

(Add `import java.util.Base64;` to the scheme class.)

- [ ] **Step 4: Run all scheme tests** — `./gradlew test --tests '*ExactCardano*'` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(facilitator): settle with atomic duplicate-settlement cache and confirmation wait"`

### Task 9: REST endpoints + HTTP contract tests

**Files:**
- Create: `facilitator/src/main/java/org/x402cardano/facilitator/api/FacilitatorController.java`, `ApiErrorHandler.java`
- Create: `facilitator/src/main/java/org/x402cardano/facilitator/config/FacilitatorConfig.java`, `X402Properties.java`
- Test: `facilitator/src/test/java/org/x402cardano/facilitator/api/FacilitatorControllerTest.java`

**Interfaces:**
- Consumes: `X402FacilitatorRegistry` (Task 4), `ExactCardanoFacilitatorScheme` (Tasks 7–8), `FacilitatorChainService` (Task 6; Spring bean arrives in Tasks 10–12 — tests override with `FakeChainService`).
- Produces: HTTP surface per Global Constraints; `X402Properties` bound to the `x402.*` yaml block: `record X402Properties(String network, Blockfrost blockfrost, Settle settle, DuplicateCache duplicateCache, SyncFromTip syncFromTip)` with nested records `Blockfrost(String baseUrl, String projectId)`, `Settle(Duration confirmationTimeout, Duration pollInterval, boolean acceptMempool)`, `DuplicateCache(Duration ttl)`, `SyncFromTip(boolean enabled, int blocksBehind)`.

- [ ] **Step 1: Failing MockMvc tests** (use `@SpringBootTest` + `@AutoConfigureMockMvc` + `@ActiveProfiles("test")`; provide a `@TestConfiguration` exposing `FakeChainService` as the `FacilitatorChainService` bean):

```java
// FacilitatorControllerTest.java
package org.x402cardano.facilitator.api;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.x402cardano.facilitator.cardano.TestTx;
import org.x402cardano.facilitator.chain.FacilitatorChainService;
import org.x402cardano.facilitator.chain.FakeChainService;
import org.x402cardano.facilitator.chain.UtxoInfo;

import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class FacilitatorControllerTest {

    @TestConfiguration
    static class FakeChain {
        @Bean @Primary FacilitatorChainService fakeChainService() {
            FakeChainService fake = new FakeChainService();
            fake.utxos.put(TestTx.NONCE, new UtxoInfo(TestTx.PAYER_ADDRESS));
            return fake;
        }
    }

    @Autowired MockMvc mvc;

    private String verifyBody(String network) {
        return """
            {"x402Version":2,
             "paymentPayload":{"x402Version":2,
               "accepted":{"scheme":"exact","network":"%s","asset":"lovelace","amount":"2000000",
                           "payTo":"%s","maxTimeoutSeconds":600,"extra":{}},
               "payload":{"transaction":"%s","nonce":"%s"}},
             "paymentRequirements":{"scheme":"exact","network":"%s","asset":"lovelace","amount":"2000000",
               "payTo":"%s","maxTimeoutSeconds":600,"extra":{"assetTransferMethod":"default"}}}
            """.formatted(network, TestTx.PAY_TO,
                TestTx.buildBase64(TestTx.Spec.defaults()), TestTx.NONCE, network, TestTx.PAY_TO);
    }

    @Test void supportedAdvertisesCanonicalKind() throws Exception {
        mvc.perform(get("/supported"))
           .andExpect(status().isOk())
           .andExpect(jsonPath("$.kinds[0].x402Version").value(2))
           .andExpect(jsonPath("$.kinds[0].scheme").value("exact"))
           .andExpect(jsonPath("$.kinds[0].network").value("cardano:preprod"))
           .andExpect(jsonPath("$.extensions").isArray())
           .andExpect(jsonPath("$.signers['cardano:*']").isArray());
    }

    @Test void verifyReturns200WithValidTrue() throws Exception {
        mvc.perform(post("/verify").contentType(APPLICATION_JSON).content(verifyBody("cardano:preprod")))
           .andExpect(status().isOk())
           .andExpect(jsonPath("$.isValid").value(true))
           .andExpect(jsonPath("$.payer").value(TestTx.PAYER_ADDRESS));
    }

    @Test void verifyLogicalFailureIsStill200() throws Exception {
        mvc.perform(post("/verify").contentType(APPLICATION_JSON)
                .content(verifyBody("cardano:preprod").replace("\"2000000\"", "\"9000000\"")))
           .andExpect(status().isOk())
           .andExpect(jsonPath("$.isValid").value(false))
           .andExpect(jsonPath("$.invalidReason")
               .value("invalid_exact_cardano_payload_amount_insufficient"));
    }

    @Test void unregisteredNetworkIs500() throws Exception {
        // TS parity: core throws for an unregistered (version, scheme, network) and
        // the reference facilitator maps that to HTTP 500 {"error"}.
        mvc.perform(post("/verify").contentType(APPLICATION_JSON).content(verifyBody("cardano:mainnet")))
           .andExpect(status().isInternalServerError())
           .andExpect(jsonPath("$.error").value(
               "No facilitator registered for scheme: exact and network: cardano:mainnet"));
    }

    @Test void missingFieldsIs400() throws Exception {
        mvc.perform(post("/verify").contentType(APPLICATION_JSON).content("{\"x402Version\":2}"))
           .andExpect(status().isBadRequest())
           .andExpect(jsonPath("$.error").value("Missing paymentPayload or paymentRequirements"));
    }

    @Test void settleFailureStillCarriesTransactionAndNetwork() throws Exception {
        // Logical failure on the REGISTERED network (amount too high => verify fails
        // inside settle): still HTTP 200 and the Zod-required fields are present.
        mvc.perform(post("/settle").contentType(APPLICATION_JSON)
                .content(verifyBody("cardano:preprod").replace("\"2000000\"", "\"9000000\"")))
           .andExpect(status().isOk())
           .andExpect(jsonPath("$.success").value(false))
           .andExpect(jsonPath("$.transaction").value(""))
           .andExpect(jsonPath("$.network").value("cardano:preprod"));
    }

    @Test void healthReportsStatus() throws Exception {
        mvc.perform(get("/health")).andExpect(status().isOk())
           .andExpect(jsonPath("$.status").exists());
    }
}
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement config + controller**

```java
// X402Properties.java
package org.x402cardano.facilitator.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import java.time.Duration;

@ConfigurationProperties(prefix = "x402")
public record X402Properties(String network, Blockfrost blockfrost, Settle settle,
                             DuplicateCache duplicateCache, SyncFromTip syncFromTip) {
    public record Blockfrost(String baseUrl, String projectId) {}
    public record Settle(Duration confirmationTimeout, Duration pollInterval, boolean acceptMempool) {}
    public record DuplicateCache(Duration ttl) {}
    public record SyncFromTip(boolean enabled, int blocksBehind) {}
}
```

```java
// FacilitatorConfig.java
package org.x402cardano.facilitator.config;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.x402cardano.facilitator.cardano.CardanoTransactionDecoder;
import org.x402cardano.facilitator.cardano.ExactCardanoFacilitatorScheme;
import org.x402cardano.facilitator.chain.FacilitatorChainService;
import org.x402cardano.facilitator.registry.X402FacilitatorRegistry;

@Configuration
@EnableConfigurationProperties(X402Properties.class)
public class FacilitatorConfig {
    @Bean CardanoTransactionDecoder cardanoTransactionDecoder() { return new CardanoTransactionDecoder(); }

    @Bean X402FacilitatorRegistry registry(FacilitatorChainService chain,
                                           CardanoTransactionDecoder decoder, X402Properties props) {
        var scheme = new ExactCardanoFacilitatorScheme(chain, decoder,
                new ExactCardanoFacilitatorScheme.SettleConfig(
                        props.settle().confirmationTimeout(),
                        props.settle().acceptMempool(),
                        props.duplicateCache().ttl()));
        var registry = new X402FacilitatorRegistry();
        registry.register(props.network(), scheme);
        return registry;
    }
}
```

```java
// FacilitatorController.java
package org.x402cardano.facilitator.api;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.x402cardano.facilitator.protocol.*;
import org.x402cardano.facilitator.registry.SchemeNetworkFacilitator;
import org.x402cardano.facilitator.registry.X402FacilitatorRegistry;

import java.util.Map;
import java.util.Optional;

@RestController
public class FacilitatorController {
    private final X402FacilitatorRegistry registry;

    public FacilitatorController(X402FacilitatorRegistry registry) { this.registry = registry; }

    @PostMapping("/verify")
    public ResponseEntity<?> verify(@RequestBody VerifyRequest req) {
        if (req.paymentPayload() == null || req.paymentRequirements() == null)
            return ResponseEntity.badRequest().body(Map.of("error", "Missing paymentPayload or paymentRequirements"));
        Optional<SchemeNetworkFacilitator> handler = registry.find(
                req.paymentPayload().x402Version(),
                req.paymentRequirements().scheme(), req.paymentRequirements().network());
        // TS parity: core x402Facilitator THROWS for an unregistered (version, scheme,
        // network) and the reference facilitator surfaces that as HTTP 500 {"error"}.
        if (handler.isEmpty())
            return ResponseEntity.internalServerError().body(Map.of("error",
                    "No facilitator registered for scheme: " + req.paymentRequirements().scheme()
                            + " and network: " + req.paymentRequirements().network()));
        return ResponseEntity.ok(handler.get().verify(req.paymentPayload(), req.paymentRequirements()));
    }

    @PostMapping("/settle")
    public ResponseEntity<?> settle(@RequestBody SettleRequest req) {
        if (req.paymentPayload() == null || req.paymentRequirements() == null)
            return ResponseEntity.badRequest().body(Map.of("error", "Missing paymentPayload or paymentRequirements"));
        Optional<SchemeNetworkFacilitator> handler = registry.find(
                req.paymentPayload().x402Version(),
                req.paymentRequirements().scheme(), req.paymentRequirements().network());
        if (handler.isEmpty())
            return ResponseEntity.internalServerError().body(Map.of("error",
                    "No facilitator registered for scheme: " + req.paymentRequirements().scheme()
                            + " and network: " + req.paymentRequirements().network()));
        return ResponseEntity.ok(handler.get().settle(req.paymentPayload(), req.paymentRequirements()));
    }

    @GetMapping("/supported")
    public SupportedResponse supported() { return registry.supported(); }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, String>> onError(Exception e) {
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(Map.of("error", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
    }
}
```

`ApiErrorHandler.java` is optional if the `@ExceptionHandler` lives on the controller (as above) — skip the extra file. Add a minimal `/health` controller now (Task 12 enriches it):

```java
// HealthController.java (same api package)
@RestController
class HealthController {
    @GetMapping("/health")
    Map<String, Object> health() { return Map.of("status", "ok"); }
}
```

Also register the shared mapper so MVC serialization matches `ProtocolJson` (NON_NULL):

```java
// In FacilitatorConfig:
@Bean org.springframework.http.converter.json.Jackson2ObjectMapperBuilderCustomizer jsonCustomizer() {
    return builder -> builder.serializationInclusion(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            .failOnUnknownProperties(false);
}
```

*Spring context note:* the app now requires a `FacilitatorChainService` bean; Task 12 wires the real one. Until then add this interim bean to `FacilitatorConfig` (Task 12 **deletes** it):

```java
// Interim bean so the context boots before Task 12; any use fails loudly.
@Bean
FacilitatorChainService chainService() {
    return new FacilitatorChainService() {
        private RuntimeException notWired() {
            return new IllegalStateException("FacilitatorChainService is wired in Task 12");
        }
        @Override public java.util.Optional<UtxoInfo> getUtxo(String txHashHex, int index) { throw notWired(); }
        @Override public long getCurrentSlot() { throw notWired(); }
        @Override public java.math.BigInteger getCoinsPerUtxoByte() { throw notWired(); }
        @Override public String submitTransaction(byte[] txBytes) { throw notWired(); }
        @Override public boolean awaitInclusion(String txHashHex, java.time.Duration timeout) { throw notWired(); }
    };
}
```

(The MockMvc tests still see the `@Primary` `FakeChainService`.) The boot smoke test from Task 2 must still pass.

- [ ] **Step 4: Run** — `./gradlew test` → ALL PASS. **Step 5: Commit** — `git commit -m "feat(facilitator): verify/settle/supported/health endpoints with TS-parity envelope"`

---

### Task 10: Blockfrost chain adapter

**Files:**
- Create: `facilitator/src/main/java/org/x402cardano/facilitator/chain/BlockfrostChainService.java`
- Test: `facilitator/src/test/java/org/x402cardano/facilitator/chain/BlockfrostChainServiceTest.java`

**Interfaces:**
- Consumes: `FacilitatorChainService` port (Task 6), `X402Properties` (Task 9).
- Produces: `BlockfrostChainService implements FacilitatorChainService` — constructor `(String baseUrl, String projectId)` building a `BFBackendService`; plus a constructor overload taking `com.bloxbean.cardano.client.backend.api.BackendService` for tests.

- [ ] **Step 1: Failing tests with a mocked `BackendService`** (Mockito ships in `spring-boot-starter-test`):

```java
// BlockfrostChainServiceTest.java
package org.x402cardano.facilitator.chain;

import com.bloxbean.cardano.client.api.model.Result;
import com.bloxbean.cardano.client.api.model.Utxo;
import com.bloxbean.cardano.client.backend.api.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import java.util.List;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class BlockfrostChainServiceTest {
    BackendService backend;
    UtxoService utxoService;
    BlockfrostChainService svc;

    @BeforeEach void setUp() throws Exception {
        backend = mock(BackendService.class);
        utxoService = mock(UtxoService.class);
        when(backend.getUtxoService()).thenReturn(utxoService);
        svc = new BlockfrostChainService(backend);
    }

    @Test void utxoExistsWhenPresentInOwningAddressSet() throws Exception {
        Utxo out = new Utxo();
        out.setTxHash("ab".repeat(32)); out.setOutputIndex(0); out.setAddress("addr_test1owner");
        when(utxoService.getTxOutput("ab".repeat(32), 0)).thenReturn(Result.success("ok").withValue(out));
        when(utxoService.getUtxos("addr_test1owner", 100, 1)).thenReturn(Result.success("ok").withValue(List.of(out)));
        var res = svc.getUtxo("ab".repeat(32), 0);
        assertThat(res).contains(new UtxoInfo("addr_test1owner"));
    }

    @Test void utxoSpentWhenAbsentFromOwningAddressSet() throws Exception {
        Utxo out = new Utxo();
        out.setTxHash("ab".repeat(32)); out.setOutputIndex(0); out.setAddress("addr_test1owner");
        when(utxoService.getTxOutput("ab".repeat(32), 0)).thenReturn(Result.success("ok").withValue(out));
        when(utxoService.getUtxos("addr_test1owner", 100, 1)).thenReturn(Result.success("ok").withValue(List.of()));
        assertThat(svc.getUtxo("ab".repeat(32), 0)).isEmpty();
    }

    @Test void utxoNeverExistedIsEmpty() throws Exception {
        when(utxoService.getTxOutput(anyString(), anyInt()))
                .thenReturn(Result.error("Not found").code(404));
        assertThat(svc.getUtxo("ab".repeat(32), 0)).isEmpty();
    }

    @Test void providerErrorThrowsChainLookup() throws Exception {
        when(utxoService.getTxOutput(anyString(), anyInt()))
                .thenReturn(Result.error("rate limited").code(429));
        assertThatThrownBy(() -> svc.getUtxo("ab".repeat(32), 0))
                .isInstanceOf(ChainLookupException.class);
    }
}
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement**

```java
// BlockfrostChainService.java
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
```

*API drift candidates:* `Result.code()`, `Result.success(...).withValue(...)` test helpers, `ProtocolParams.getCoinsPerUtxoSize()` type (String vs BigDecimal). Check the 0.6.4 jar and adapt the call sites/tests.

- [ ] **Step 4: Run** — `./gradlew test --tests '*BlockfrostChainServiceTest*'` → PASS. **Step 5: Commit** — `git commit -m "feat(facilitator): Blockfrost chain adapter for utxo/params/submit"`

### Task 11: yaci-store integration — tip tracking, inclusion tracking, sync-from-tip

**Files:**
- Create: `facilitator/src/main/java/org/x402cardano/facilitator/chain/yaci/ChainTipTracker.java`, `TxInclusionTracker.java`
- Create: `facilitator/src/main/java/org/x402cardano/facilitator/config/SyncFromTipEnvironmentPostProcessor.java`
- Create: `facilitator/src/main/resources/META-INF/spring.factories`
- Test: `facilitator/src/test/java/org/x402cardano/facilitator/chain/yaci/TxInclusionTrackerTest.java`, `ChainTipTrackerTest.java`

**Interfaces:**
- Consumes: yaci-store events `com.bloxbean.cardano.yaci.store.events.{BlockHeaderEvent, TransactionEvent, RollbackEvent}` (published by the embedded sync engine), `EventMetadata.getSlot()/getBlock()/getBlockHash()`, `TransactionEvent.getTransactions()` → `com.bloxbean.cardano.yaci.helper.model.Transaction.getTxHash()`, `RollbackEvent.getRollbackTo().getSlot()`.
- Produces:
  - `ChainTipTracker.tipSlot() -> OptionalLong`, `.lastBlockAgeSeconds() -> OptionalLong`, `.isFresh(Duration maxAge) -> boolean`
  - `TxInclusionTracker.isIncluded(String txHashHex) -> boolean`, `.awaitInclusion(String, Duration, Duration pollInterval) -> boolean`, rollback-safe.

- [ ] **Step 1: Failing tracker tests** (plain unit tests; construct events with their builders — yaci-store event classes are Lombok `@Builder`):

```java
// TxInclusionTrackerTest.java
package org.x402cardano.facilitator.chain.yaci;

import com.bloxbean.cardano.yaci.core.protocol.chainsync.messages.Point;
import com.bloxbean.cardano.yaci.helper.model.Transaction;
import com.bloxbean.cardano.yaci.store.events.EventMetadata;
import com.bloxbean.cardano.yaci.store.events.RollbackEvent;
import com.bloxbean.cardano.yaci.store.events.TransactionEvent;
import org.junit.jupiter.api.Test;
import java.time.Duration;
import java.util.List;
import static org.assertj.core.api.Assertions.assertThat;

class TxInclusionTrackerTest {
    private final TxInclusionTracker tracker = new TxInclusionTracker();

    private TransactionEvent txEvent(String txHash, long slot) {
        return TransactionEvent.builder()
                .metadata(EventMetadata.builder().slot(slot).block(10).blockHash("bh").build())
                .transactions(List.of(Transaction.builder().txHash(txHash).build()))
                .build();
    }

    @Test void tracksIncludedTransactions() {
        tracker.onTransactions(txEvent("AA11", 100));
        assertThat(tracker.isIncluded("aa11")).isTrue();  // case-insensitive
        assertThat(tracker.isIncluded("bb22")).isFalse();
    }

    @Test void rollbackRemovesTransactionsAfterRollbackPoint() {
        tracker.onTransactions(txEvent("aa11", 100));
        tracker.onTransactions(txEvent("bb22", 200));
        tracker.onRollback(RollbackEvent.builder()
                .rollbackTo(new Point(150, "hash150")).build());
        assertThat(tracker.isIncluded("aa11")).isTrue();   // slot 100 <= 150 survives
        assertThat(tracker.isIncluded("bb22")).isFalse();  // slot 200 > 150 rolled back
    }

    @Test void awaitInclusionReturnsOnceSeen() throws Exception {
        Thread t = new Thread(() -> {
            try { Thread.sleep(300); } catch (InterruptedException ignored) {}
            tracker.onTransactions(txEvent("cc33", 300));
        });
        t.start();
        boolean included = tracker.awaitInclusion("cc33", Duration.ofSeconds(5), Duration.ofMillis(50));
        t.join();
        assertThat(included).isTrue();
    }

    @Test void awaitInclusionTimesOut() {
        assertThat(tracker.awaitInclusion("dd44", Duration.ofMillis(200), Duration.ofMillis(50))).isFalse();
    }
}
```

```java
// ChainTipTrackerTest.java
package org.x402cardano.facilitator.chain.yaci;

import com.bloxbean.cardano.yaci.store.events.BlockHeaderEvent;
import com.bloxbean.cardano.yaci.store.events.EventMetadata;
import org.junit.jupiter.api.Test;
import java.time.Duration;
import static org.assertj.core.api.Assertions.assertThat;

class ChainTipTrackerTest {
    @Test void tracksTipSlotFromBlockHeaders() {
        ChainTipTracker tracker = new ChainTipTracker();
        assertThat(tracker.tipSlot()).isEmpty();
        tracker.onBlockHeader(BlockHeaderEvent.builder()
                .metadata(EventMetadata.builder().slot(123_456L).build()).build());
        assertThat(tracker.tipSlot()).hasValue(123_456L);
        assertThat(tracker.isFresh(Duration.ofMinutes(5))).isTrue();
    }
}
```

*Drift note:* if `BlockHeaderEvent` lacks a `metadata` builder field, check its actual fields (`gh api` or the jar) and adapt — any per-block event carrying `EventMetadata` works; `BlockEvent` is an alternative.

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement**

```java
// ChainTipTracker.java
package org.x402cardano.facilitator.chain.yaci;

import com.bloxbean.cardano.yaci.store.events.BlockHeaderEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.OptionalLong;
import java.util.concurrent.atomic.AtomicLong;

/** Tracks the facilitator's own chain-tip view from the embedded yaci-store sync. */
@Component
public class ChainTipTracker {
    private final AtomicLong tipSlot = new AtomicLong(-1);
    private final AtomicLong lastBlockWallClock = new AtomicLong(-1);

    @EventListener
    public void onBlockHeader(BlockHeaderEvent event) {
        tipSlot.set(event.getMetadata().getSlot());
        lastBlockWallClock.set(System.currentTimeMillis());
    }

    public OptionalLong tipSlot() {
        long v = tipSlot.get();
        return v < 0 ? OptionalLong.empty() : OptionalLong.of(v);
    }

    public OptionalLong lastBlockAgeSeconds() {
        long t = lastBlockWallClock.get();
        return t < 0 ? OptionalLong.empty()
                : OptionalLong.of((System.currentTimeMillis() - t) / 1000);
    }

    public boolean isFresh(Duration maxAge) {
        return lastBlockAgeSeconds().stream().anyMatch(age -> age <= maxAge.toSeconds());
    }
}
```

```java
// TxInclusionTracker.java
package org.x402cardano.facilitator.chain.yaci;

import com.bloxbean.cardano.yaci.store.events.RollbackEvent;
import com.bloxbean.cardano.yaci.store.events.TransactionEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Records tx inclusion from the facilitator's own yaci-store chain view and
 * invalidates entries beyond a rollback point (Ouroboros rollbacks are real:
 * "confirmed" here means observed-in-a-block, matching the TS reference).
 */
@Component
public class TxInclusionTracker {
    private static final int MAX_ENTRIES = 50_000;
    private final ConcurrentHashMap<String, Long> includedAtSlot = new ConcurrentHashMap<>();

    @EventListener
    public void onTransactions(TransactionEvent event) {
        long slot = event.getMetadata().getSlot();
        event.getTransactions().forEach(tx ->
                includedAtSlot.put(tx.getTxHash().toLowerCase(), slot));
        if (includedAtSlot.size() > MAX_ENTRIES) {
            long minSlot = slot - 7200; // ~2h of preprod slots; ancient entries are settled history
            includedAtSlot.values().removeIf(s -> s < minSlot);
        }
    }

    @EventListener
    public void onRollback(RollbackEvent event) {
        long rollbackSlot = event.getRollbackTo().getSlot();
        includedAtSlot.values().removeIf(slot -> slot > rollbackSlot);
    }

    public boolean isIncluded(String txHashHex) {
        return includedAtSlot.containsKey(txHashHex.toLowerCase());
    }

    public boolean awaitInclusion(String txHashHex, Duration timeout, Duration pollInterval) {
        long deadline = System.currentTimeMillis() + timeout.toMillis();
        while (System.currentTimeMillis() < deadline) {
            if (isIncluded(txHashHex)) return true;
            try { Thread.sleep(pollInterval.toMillis()); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); return false; }
        }
        return isIncluded(txHashHex);
    }
}
```

- [ ] **Step 4: Implement sync-from-tip.** Before yaci-store beans initialize, resolve a recent preprod point via Blockfrost and inject `store.cardano.sync-start-slot` / `sync-start-blockhash` (first run only — yaci-store's cursor wins on restarts):

```java
// SyncFromTipEnvironmentPostProcessor.java
package org.x402cardano.facilitator.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Map;

/**
 * Resolves a recent preprod block (tip minus N) from Blockfrost and injects it as
 * yaci-store's sync start point, so the demo facilitator is chain-current in
 * seconds instead of syncing preprod from genesis. Skipped when disabled, when
 * an explicit start point is configured, or when Blockfrost is unreachable
 * (yaci-store then falls back to its default behavior — log loudly).
 */
public class SyncFromTipEnvironmentPostProcessor implements EnvironmentPostProcessor {
    @Override
    public void postProcessEnvironment(ConfigurableEnvironment env, SpringApplication app) {
        if (!"true".equalsIgnoreCase(env.getProperty("x402.sync-from-tip.enabled", "true"))) return;
        if (env.getProperty("store.cardano.sync-start-slot") != null) return; // explicit wins
        String baseUrl = env.getProperty("x402.blockfrost.base-url",
                "https://cardano-preprod.blockfrost.io/api/v0");
        String projectId = env.getProperty("x402.blockfrost.project-id", "");
        if (projectId.isBlank()) {
            System.err.println("[sync-from-tip] BLOCKFROST_PROJECT_ID missing - yaci-store will sync from its default start point");
            return;
        }
        int blocksBehind = Integer.parseInt(env.getProperty("x402.sync-from-tip.blocks-behind", "30"));
        try {
            HttpClient http = HttpClient.newHttpClient();
            ObjectMapper json = new ObjectMapper();
            JsonNode latest = fetch(http, json, baseUrl + "/blocks/latest", projectId);
            long targetHeight = latest.get("height").asLong() - blocksBehind;
            JsonNode target = fetch(http, json, baseUrl + "/blocks/" + targetHeight, projectId);
            long slot = target.get("slot").asLong();
            String hash = target.get("hash").asText();
            env.getPropertySources().addFirst(new MapPropertySource("syncFromTip", Map.of(
                    "store.cardano.sync-start-slot", slot,
                    "store.cardano.sync-start-blockhash", hash)));
            System.out.println("[sync-from-tip] yaci-store will sync preprod from slot " + slot
                    + " (block " + targetHeight + ", " + blocksBehind + " behind tip)");
        } catch (Exception e) {
            System.err.println("[sync-from-tip] failed to resolve tip via Blockfrost: " + e.getMessage());
        }
    }

    private JsonNode fetch(HttpClient http, ObjectMapper json, String url, String projectId) throws Exception {
        HttpResponse<String> res = http.send(HttpRequest.newBuilder(URI.create(url))
                        .header("project_id", projectId).GET().build(),
                HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() != 200) throw new IllegalStateException(url + " -> HTTP " + res.statusCode());
        return json.readTree(res.body());
    }
}
```

```properties
# facilitator/src/main/resources/META-INF/spring.factories
org.springframework.boot.env.EnvironmentPostProcessor=org.x402cardano.facilitator.config.SyncFromTipEnvironmentPostProcessor
```

- [ ] **Step 5: Run tracker tests** — `./gradlew test --tests '*yaci*'` → PASS. Full suite still green.

- [ ] **Step 6: Commit** — `git commit -m "feat(facilitator): yaci-store tip/inclusion tracking and sync-from-tip bootstrap"`

---

### Task 12: Chain-service composition + enriched /health + live boot check

**Files:**
- Create: `facilitator/src/main/java/org/x402cardano/facilitator/chain/CompositeChainService.java`
- Modify: `facilitator/src/main/java/org/x402cardano/facilitator/config/FacilitatorConfig.java` (real beans), `api/HealthController.java` (enrich)

**Interfaces:**
- Produces: `CompositeChainService implements FacilitatorChainService` — Blockfrost for `getUtxo`/`getCoinsPerUtxoByte`/`submitTransaction`; yaci-store trackers for `getCurrentSlot` (fallback Blockfrost when tip stale > 90 s) and `awaitInclusion` (poll `TxInclusionTracker`); `/health` returns `{status, yaciTipSlot, yaciLastBlockAgeSeconds, network}`.

- [ ] **Step 1: Implement `CompositeChainService`**

```java
// CompositeChainService.java
package org.x402cardano.facilitator.chain;

import org.x402cardano.facilitator.chain.yaci.ChainTipTracker;
import org.x402cardano.facilitator.chain.yaci.TxInclusionTracker;

import java.math.BigInteger;
import java.time.Duration;
import java.util.Optional;

/**
 * Division of chain authority (see design spec):
 * - Blockfrost: full-UTxO-set questions (nonce/input unspent), protocol params, submission.
 * - Embedded yaci-store: the facilitator's OWN view for current slot (TTL rule)
 *   and settlement confirmation (tx observed in a block it indexed itself).
 */
public class CompositeChainService implements FacilitatorChainService {
    private static final Duration TIP_FRESHNESS = Duration.ofSeconds(90);
    private final BlockfrostChainService blockfrost;
    private final ChainTipTracker tip;
    private final TxInclusionTracker inclusion;
    private final Duration pollInterval;

    public CompositeChainService(BlockfrostChainService blockfrost, ChainTipTracker tip,
                                 TxInclusionTracker inclusion, Duration pollInterval) {
        this.blockfrost = blockfrost;
        this.tip = tip;
        this.inclusion = inclusion;
        this.pollInterval = pollInterval;
    }

    @Override public Optional<UtxoInfo> getUtxo(String txHashHex, int index) {
        return blockfrost.getUtxo(txHashHex, index);
    }
    @Override public BigInteger getCoinsPerUtxoByte() { return blockfrost.getCoinsPerUtxoByte(); }
    @Override public String submitTransaction(byte[] txBytes) { return blockfrost.submitTransaction(txBytes); }

    @Override public long getCurrentSlot() {
        if (tip.isFresh(TIP_FRESHNESS) && tip.tipSlot().isPresent()) return tip.tipSlot().getAsLong();
        return blockfrost.getCurrentSlot(); // yaci still syncing or stalled
    }

    @Override public boolean awaitInclusion(String txHashHex, Duration timeout) {
        return inclusion.awaitInclusion(txHashHex, timeout, pollInterval);
    }
}
```

- [ ] **Step 2: Wire the real bean** in `FacilitatorConfig` (replace the Task 9 placeholder):

```java
@Bean
FacilitatorChainService chainService(X402Properties props,
        org.x402cardano.facilitator.chain.yaci.ChainTipTracker tip,
        org.x402cardano.facilitator.chain.yaci.TxInclusionTracker inclusion) {
    var blockfrost = new org.x402cardano.facilitator.chain.BlockfrostChainService(
            props.blockfrost().baseUrl(), props.blockfrost().projectId());
    return new org.x402cardano.facilitator.chain.CompositeChainService(
            blockfrost, tip, inclusion, props.settle().pollInterval());
}
```

Enrich `/health`:

```java
@RestController
class HealthController {
    private final ChainTipTracker tip;
    private final X402Properties props;
    HealthController(ChainTipTracker tip, X402Properties props) { this.tip = tip; this.props = props; }

    @GetMapping("/health")
    Map<String, Object> health() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", tip.isFresh(Duration.ofSeconds(90)) ? "ok" : "syncing");
        body.put("network", props.network());
        body.put("yaciTipSlot", tip.tipSlot().isPresent() ? tip.tipSlot().getAsLong() : null);
        body.put("yaciLastBlockAgeSeconds",
                tip.lastBlockAgeSeconds().isPresent() ? tip.lastBlockAgeSeconds().getAsLong() : null);
        return body;
    }
}
```

- [ ] **Step 3: Full test suite** — `./gradlew test` → ALL PASS (MockMvc tests still use the `@Primary` fake).

- [ ] **Step 4: LIVE boot check (needs `BLOCKFROST_PROJECT_ID`)**

Run: `cd facilitator && BLOCKFROST_PROJECT_ID=<your-key> ./gradlew bootRun`
Expected within ~2 min:
1. Log line `[sync-from-tip] yaci-store will sync preprod from slot ...`
2. yaci-store chainsync logs showing blocks being processed near the current preprod tip.
3. `curl -s localhost:4022/supported` → `{"kinds":[{"x402Version":2,"scheme":"exact","network":"cardano:preprod"}],...}`
4. `curl -s localhost:4022/health` → `status: "ok"` once blocks flow (~20 s cadence on preprod).

- [ ] **Step 5: Commit** — `git commit -m "feat(facilitator): compose blockfrost + yaci-store chain authority with health status"`

### Task 13: TypeScript resource server

**Files:**
- Create: `server/package.json`, `server/tsconfig.json`, `server/src/server.ts`, `server/.env.example`

**Interfaces:**
- Consumes: facilitator `GET /supported` (validated at startup by `@x402/core`), `POST /verify` + `POST /settle`.
- Produces: `GET /api/message` behind `paymentMiddleware` on port **4021**; CORS exposing `PAYMENT-REQUIRED, PAYMENT-RESPONSE` and allowing `PAYMENT-SIGNATURE` — the frontend (Task 14) depends on exactly these header names.

- [ ] **Step 1: `package.json`** (npm + `file:` links — the pattern proven by the previous demo; use the Task 1 fallback if npm rejects `workspace:` specs):

```json
{
  "name": "x402-cardano-demo-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "tsx src/server.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@x402/cardano": "file:../../x402/typescript/packages/mechanisms/cardano",
    "@x402/core": "file:../../x402/typescript/packages/core",
    "@x402/express": "file:../../x402/typescript/packages/http/express",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.21.2"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/node": "^22.13.4",
    "tsx": "^4.19.2",
    "typescript": "^5.7.3"
  }
}
```

`tsconfig.json`: `{"compilerOptions": {"target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext", "strict": true, "skipLibCheck": true}, "include": ["src"]}`

- [ ] **Step 2: `src/server.ts`** — the whole server, heavily commented (this file IS the educative artifact):

```typescript
/**
 * x402 resource server — the "seller".
 *
 * The x402 flow, from this server's point of view:
 *   1. A request to GET /api/message without payment gets HTTP 402 + a
 *      PAYMENT-REQUIRED header describing what to pay (built by the middleware).
 *   2. The client retries with a PAYMENT-SIGNATURE header carrying a signed
 *      Cardano transaction.
 *   3. The middleware sends it to the FACILITATOR's /verify endpoint; when the
 *      payment checks out, our handler runs.
 *   4. After the handler succeeds, the middleware calls the facilitator's
 *      /settle — the facilitator submits the tx to preprod and waits for a
 *      block to include it (~20-60 s).
 *   5. The response goes out with a PAYMENT-RESPONSE header containing the
 *      settlement result (tx hash, status).
 */
import "dotenv/config";
import cors from "cors";
import express from "express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core";
import { paymentMiddleware } from "@x402/express";
import { ExactCardanoScheme } from "@x402/cardano/exact/server";

const PAY_TO = process.env.SERVER_CARDANO_ADDRESS; // preprod address that receives the 2 tADA
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://localhost:4022";
const PORT = Number(process.env.PORT ?? 4021);
if (!PAY_TO) throw new Error("SERVER_CARDANO_ADDRESS is required (addr_test1...)");

const app = express();

// CORS: a BROWSER client can only read the x402 headers when we expose them,
// and can only send its payment when PAYMENT-SIGNATURE is allowed.
app.use(
  cors({
    origin: true,
    allowedHeaders: ["Content-Type", "PAYMENT-SIGNATURE", "X-PAYMENT"],
    exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"],
  }),
);

// The resource server delegates verify/settle to the Java facilitator and
// registers the Cardano "exact" scheme for building PaymentRequirements.
// On the first request it calls GET /supported on the facilitator and refuses
// to serve the route if (exact, cardano:preprod) is not advertised.
const resourceServer = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: FACILITATOR_URL }),
).register("cardano:preprod", new ExactCardanoScheme());

app.use(
  paymentMiddleware(
    {
      "GET /api/message": {
        accepts: {
          scheme: "exact",
          network: "cardano:preprod",
          payTo: PAY_TO,
          // 2 tADA in lovelace. Comfortably above the ~1 ADA min-UTxO the
          // facilitator enforces (verification rule 7).
          price: { amount: "2000000", asset: "lovelace" },
          // Cardano blocks are slow vs EVM L2s; give the tx 10 minutes of TTL.
          maxTimeoutSeconds: 600,
          extra: { assetTransferMethod: "default" },
        },
        description: "A message you can only read after paying 2 tADA",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

// Only reached AFTER the facilitator verified the payment; the middleware
// settles it after we return (status < 400).
app.get("/api/message", (_req, res) => {
  res.json({
    message: "Hello from x402 on Cardano! This response was paid for on preprod.",
    paidAt: new Date().toISOString(),
  });
});

app.listen(PORT, () => console.log(`Resource server listening on :${PORT} (facilitator: ${FACILITATOR_URL})`));
```

`.env.example`:

```env
SERVER_CARDANO_ADDRESS=addr_test1...   # preprod address that receives payments
FACILITATOR_URL=http://localhost:4022
PORT=4021
```

- [ ] **Step 3: Install + typecheck** — `cd server && npm install && npm run typecheck` → clean. If the `ExactCardanoScheme` import path differs, check `../x402/typescript/packages/mechanisms/cardano/package.json` `exports` map (`./exact/server`).

- [ ] **Step 4: Smoke against the running facilitator** (facilitator from Task 12 still running):

```bash
cd server && cp .env.example .env  # fill SERVER_CARDANO_ADDRESS with any preprod addr_test1 address
npm run dev &
sleep 3
curl -si localhost:4021/api/message | head -20
```

Expected: `HTTP/1.1 402`, a `PAYMENT-REQUIRED` header (base64), body `{}`. Decode it:
`curl -si localhost:4021/api/message | grep -i payment-required | cut -d' ' -f2 | base64 -d | python3 -m json.tool`
→ shows `accepts[0]` with `scheme: exact`, `network: cardano:preprod`, `amount: "2000000"`, `asset: "lovelace"`, your `payTo`. This also proves the facilitator's `/supported` passed the middleware's startup validation.

- [ ] **Step 5: Commit** — `git add server && git commit -m "feat(server): minimal express resource server with x402 payment middleware"`

---

### Task 14: Frontend — scaffold + CIP-30 signer + step-driven flow

**Files:**
- Create: `frontend/package.json`, `frontend/tsconfig.json`, `frontend/vite.config.ts`, `frontend/index.html`, `frontend/.env.example`
- Create: `frontend/src/main.tsx`, `frontend/src/App.tsx`
- Create: `frontend/src/x402/cip30Signer.ts`, `frontend/src/x402/flow.ts`

**Interfaces:**
- Consumes: the server's `GET /api/message` (Task 13); `ClientCardanoSigner` interface from `@x402/cardano` (`getAddress(): string`, `buildAndSignPaymentTransaction(input) -> {transaction, nonce}`); Evolution SDK `Client.make(preprod).withBlockfrost({...}).withCip30(walletApi)`.
- Produces: `createCip30Signer(walletApi, blockfrost) -> Promise<ClientCardanoSigner>`; `runPaymentFlow(serverUrl, signer, onStep) -> Promise<FlowResult>` with `type FlowStep = {id: "request"|"required"|"build"|"pay"|"settled"; title: string; detail: unknown}` — Task 15's UI renders these steps.

- [ ] **Step 1: Scaffold config files**

```json
// frontend/package.json
{
  "name": "x402-cardano-demo-frontend",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --port 5173",
    "build": "tsc -b && vite build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@evolution-sdk/evolution": "^0.5.9",
    "@x402/cardano": "file:../../x402/typescript/packages/mechanisms/cardano",
    "@x402/core": "file:../../x402/typescript/packages/core",
    "react": "^19.2.4",
    "react-dom": "^19.2.4"
  },
  "devDependencies": {
    "@types/react": "^19.2.14",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.7.3",
    "vite": "^6.2.6",
    "vite-plugin-node-polyfills": "^0.23.0"
  }
}
```

```typescript
// frontend/vite.config.ts — Buffer polyfill: @x402/cardano's browser path and our
// base64 handling use Buffer, which Vite does not provide by default.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [react(), nodePolyfills({ globals: { Buffer: true } })],
});
```

`tsconfig.json`: `{"compilerOptions": {"target": "ES2022", "module": "ESNext", "moduleResolution": "bundler", "jsx": "react-jsx", "strict": true, "skipLibCheck": true, "types": ["vite/client"]}, "include": ["src"]}`
`index.html`: standard Vite shell with `<div id="root"></div>` and `<script type="module" src="/src/main.tsx"></script>`; title `x402 on Cardano`.
`.env.example`:

```env
VITE_BLOCKFROST_PROJECT_ID=preprod...   # Blockfrost preprod project id (used in-browser)
VITE_SERVER_URL=http://localhost:4021
```

- [ ] **Step 2: `src/x402/cip30Signer.ts`** — the CIP-30 `ClientCardanoSigner` (the demo's genuinely new educative piece; mirrors the reference mnemonic signer in `../x402/typescript/packages/mechanisms/cardano/src/signer.ts` but signs through the user's wallet):

```typescript
/**
 * A ClientCardanoSigner backed by a CIP-30 browser wallet (Eternl, Lace, ...).
 *
 * The x402 "exact" scheme on Cardano is CLIENT-DRIVEN: this code builds the
 * complete payment transaction in the browser (Evolution SDK + Blockfrost for
 * UTxOs/protocol parameters), the wallet only signs it. The facilitator never
 * builds or signs anything — it verifies and broadcasts.
 *
 * Mirrors the reference signer recipe in @x402/cardano (signer.ts):
 *   nonce  = first wallet UTxO, forced as an input via collectFrom
 *            (the facilitator's replay protection - verification rule 5)
 *   output = payTo receives the requested lovelace
 *   TTL    = now + maxTimeoutSeconds (verification rule 6)
 */
import {
  Address,
  Assets,
  Client,
  Transaction,
  TransactionWitnessSet,
  preprod,
} from "@evolution-sdk/evolution";
import type { ClientCardanoSigner, ClientCardanoSignInput } from "@x402/cardano";

export interface Cip30WalletApi {
  // Minimal CIP-30 surface we rely on (window.cardano.<wallet>.enable() result).
  getNetworkId(): Promise<number>;
}

export async function createCip30Signer(
  walletApi: unknown,
  blockfrost: { baseUrl: string; projectId: string },
): Promise<ClientCardanoSigner> {
  // Provider (reads chain state) + CIP-30 (signs) = a full signing client.
  const client = Client.make(preprod)
    .withBlockfrost(blockfrost)
    .withCip30(walletApi as never);

  const address = Address.toBech32(await client.address());

  return {
    getAddress: () => address,

    async buildAndSignPaymentTransaction(input: ClientCardanoSignInput) {
      if (input.asset.toLowerCase() !== "lovelace") {
        throw new Error(`This demo signer only pays lovelace, got: ${input.asset}`);
      }

      const utxos = await client.getWalletUtxos();
      if (utxos.length === 0) throw new Error("Wallet has no UTxOs — fund it at the preprod faucet");

      // The first wallet UTxO becomes the x402 nonce. collectFrom() guarantees
      // it appears as a transaction input; settling spends it, which is what
      // makes the payment replay-proof.
      const nonceUtxo = utxos[0];
      const nonceTxHash = Buffer.from(nonceUtxo.transactionId.hash).toString("hex").toLowerCase();
      const nonce = `${nonceTxHash}#${Number(nonceUtxo.index)}`;

      const signBuilder = await client
        .newTx()
        .collectFrom({ inputs: [nonceUtxo] })
        .payToAddress({
          address: Address.fromBech32(input.payTo),
          assets: Assets.fromLovelace(BigInt(input.amount)),
        })
        // Wall-clock ms; the SDK converts it to the TTL slot.
        .setValidity({ to: BigInt(Date.now()) + BigInt(input.maxTimeoutSeconds) * 1000n })
        .build({ changeAddress: await client.address() });

      // Prompts the user's wallet extension for approval.
      const submitBuilder = await signBuilder.sign();

      const unsigned = await signBuilder.toTransaction();
      const signed = new Transaction.Transaction({
        body: unsigned.body,
        witnessSet: submitBuilder.witnessSet,
        isValid: true,
        auxiliaryData: null,
      });

      return {
        transaction: Buffer.from(Transaction.toCBORBytes(signed)).toString("base64"),
        nonce,
      };
    },
  };
}
```

*Drift note:* if `.withCip30(...).getWalletUtxos()` or `signBuilder.sign()` differ in Evolution 0.5.x for CIP-30 clients, the fallback recipe is the docs' explicit path: build with a provider+`withAddress` client, sign via raw `walletApi.signTx(txCborHex, true)`, merge with `Transaction.addVKeyWitnessesHex(txCbor, TransactionWitnessSet.toCBORHex(witnessSet))` (see cardano-dev-skills `evolution-sdk/wallets/api-wallet.mdx`).

- [ ] **Step 3: `src/x402/flow.ts`** — step-driven payment using `@x402/core` primitives (not the auto wrapper), so the UI can show every protocol artifact:

```typescript
/**
 * Drives one x402 payment step by step. Each stage reports a FlowStep so the
 * UI can display the actual protocol artifacts (decoded headers, payloads).
 * The auto-retry alternative is a one-liner: wrapFetchWithPayment(fetch, client).
 */
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import type { ClientCardanoSigner } from "@x402/cardano";

export type FlowStep =
  | { id: "request"; title: string; detail: { url: string; status: number } }
  | { id: "required"; title: string; detail: unknown } // decoded PaymentRequired
  | { id: "build"; title: string; detail: { nonce: string; transactionBase64: string } }
  | { id: "pay"; title: string; detail: unknown } // full PaymentPayload sent
  | { id: "settled"; title: string; detail: unknown }; // decoded SettleResponse + body

export async function runPaymentFlow(
  serverUrl: string,
  signer: ClientCardanoSigner,
  onStep: (step: FlowStep) => void,
): Promise<void> {
  const url = `${serverUrl}/api/message`;

  // 1. Plain request -> expect 402 + PAYMENT-REQUIRED header.
  const first = await fetch(url);
  onStep({ id: "request", title: "GET /api/message without payment", detail: { url, status: first.status } });
  if (first.status !== 402) throw new Error(`Expected 402, got ${first.status}`);
  const requiredHeader = first.headers.get("PAYMENT-REQUIRED");
  if (!requiredHeader) throw new Error("402 without PAYMENT-REQUIRED header (check server CORS exposedHeaders)");
  const paymentRequired = decodePaymentRequiredHeader(requiredHeader);
  onStep({ id: "required", title: "Server describes the price (decoded PAYMENT-REQUIRED)", detail: paymentRequired });

  // 2. Pick the cardano:preprod exact option and build+sign the payment tx.
  const accepted = paymentRequired.accepts.find(
    (a: { scheme: string; network: string }) => a.scheme === "exact" && a.network === "cardano:preprod",
  );
  if (!accepted) throw new Error("Server offered no exact/cardano:preprod option");
  const scheme = new ExactCardanoScheme(signer);
  const result = await scheme.createPaymentPayload(2, accepted);
  onStep({
    id: "build",
    title: "Wallet built and signed the payment transaction",
    detail: {
      nonce: (result.payload as { nonce: string }).nonce,
      transactionBase64: (result.payload as { transaction: string }).transaction,
    },
  });

  // 3. Retry with the PAYMENT-SIGNATURE header (base64 JSON PaymentPayload).
  const paymentPayload = {
    x402Version: 2,
    resource: paymentRequired.resource,
    accepted,
    payload: result.payload,
  };
  onStep({ id: "pay", title: "Retrying with PAYMENT-SIGNATURE (facilitator verifies, then settles on-chain)", detail: paymentPayload });
  const paid = await fetch(url, {
    headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(paymentPayload) },
  });
  if (paid.status !== 200) {
    throw new Error(`Payment failed: HTTP ${paid.status} — ${await paid.text()}`);
  }

  // 4. Read the settlement receipt + the paid-for resource.
  const responseHeader = paid.headers.get("PAYMENT-RESPONSE");
  const settle = responseHeader ? decodePaymentResponseHeader(responseHeader) : null;
  onStep({ id: "settled", title: "Paid! Settlement receipt + resource", detail: { settle, body: await paid.json() } });
}
```

*Drift note:* the exact exported names of the header codecs live in `../x402/typescript/packages/core/src/http/index.ts` — check that file if `decodePaymentRequiredHeader`/`encodePaymentSignatureHeader`/`decodePaymentResponseHeader` don't resolve, and mirror how `x402HTTPClient` assembles the full `PaymentPayload` envelope.

- [ ] **Step 4: Minimal `App.tsx` + `main.tsx`** to make it runnable (Task 15 replaces the UI):

```tsx
// src/main.tsx
import { createRoot } from "react-dom/client";
import App from "./App";
createRoot(document.getElementById("root")!).render(<App />);
```

```tsx
// src/App.tsx — minimal harness: connect wallet, run flow, dump steps as JSON.
import { useState } from "react";
import { createCip30Signer } from "./x402/cip30Signer";
import { runPaymentFlow, type FlowStep } from "./x402/flow";

declare global {
  interface Window { cardano?: Record<string, { name?: string; enable(): Promise<unknown> }>; }
}

export default function App() {
  const [steps, setSteps] = useState<FlowStep[]>([]);
  const [error, setError] = useState<string>();

  async function payWith(walletKey: string) {
    setSteps([]); setError(undefined);
    try {
      const api = await window.cardano![walletKey].enable();
      const signer = await createCip30Signer(api, {
        baseUrl: "https://cardano-preprod.blockfrost.io/api/v0",
        projectId: import.meta.env.VITE_BLOCKFROST_PROJECT_ID,
      });
      await runPaymentFlow(import.meta.env.VITE_SERVER_URL ?? "http://localhost:4021",
        signer, step => setSteps(prev => [...prev, step]));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  const wallets = Object.keys(window.cardano ?? {}).filter(k => window.cardano![k]?.enable);
  return (
    <main>
      <h1>x402 on Cardano (preprod)</h1>
      {wallets.map(w => <button key={w} onClick={() => payWith(w)}>Pay 2 tADA via {w}</button>)}
      {wallets.length === 0 && <p>No CIP-30 wallet found — install Eternl or Lace and enable preprod.</p>}
      {error && <pre style={{ color: "red" }}>{error}</pre>}
      {steps.map((s, i) => (
        <details key={i} open>
          <summary>{i + 1}. {s.title}</summary>
          <pre>{JSON.stringify(s.detail, null, 2)}</pre>
        </details>
      ))}
    </main>
  );
}
```

- [ ] **Step 5: Install + typecheck + manual run** — `cd frontend && npm install && npm run typecheck && npm run dev`. With facilitator + server running and a preprod-funded CIP-30 wallet: click the wallet button, approve the signature, watch the five steps appear, and confirm step 5 shows `settle.success: true` with a tx hash. Verify the hash on `https://preprod.cardanoscan.io/transaction/<hash>`.

- [ ] **Step 6: Commit** — `git add frontend && git commit -m "feat(frontend): CIP-30 signer and step-driven x402 payment flow"`

---

### Task 15: Frontend — educative UI

**Files:**
- Create: `frontend/src/components/StepCard.tsx`, `frontend/src/components/WalletPicker.tsx`, `frontend/src/components/CodeAside.tsx`, `frontend/src/styles.css`
- Modify: `frontend/src/App.tsx`, `frontend/src/main.tsx` (import styles)

**Interfaces:**
- Consumes: `FlowStep` from Task 14 (unchanged).
- Produces: the final demo UI. No new protocol logic — presentation only.

- [ ] **Step 1: Build the walkthrough UI.** Requirements (keep the code simple; this is a teaching page, not a product):
  - A short intro header: what x402 is, what the three parties (client / server / facilitator) do, and a note that everything runs on preprod.
  - `WalletPicker`: enumerate `window.cardano`, show wallet icons/names, connected address (shortened) + a "preprod?" indicator via `walletApi.getNetworkId() === 0`.
  - A vertical timeline of `StepCard`s, one per `FlowStep`, appearing as the flow progresses, each with: plain-language explanation (2–3 sentences of *why this step exists in the protocol*), and a collapsible `<pre>` of the decoded artifact. For `build`, show nonce, TTL, and the base64 tx length; for `pay`, show both the decoded JSON and the raw base64 header value; for `settled`, render the tx hash as a link to `https://preprod.cardanoscan.io/transaction/<hash>` and the resource JSON prominently.
  - During the gap between `pay` and `settled` show a live "waiting for block inclusion on preprod (~20–60 s)" spinner with elapsed seconds — this wait is the settlement story, make it visible, not hidden.
  - `CodeAside`: a static, syntax-highlighted-ish `<pre>` showing the `wrapFetchWithPayment` one-liner alternative with a caption ("the whole flow above is this one line in production code").
  - Errors render inline on the step where they occurred (wallet declined, insufficient funds, verify/settle failure with the facilitator's error code).
  - Styling: single `styles.css`, no UI framework; readable width (~720 px), monospace for artifacts, green/amber/red status accents.

- [ ] **Step 2: Manual verification** — rerun the full happy path; additionally exercise two failure paths and confirm they render comprehensibly: (a) decline the wallet signature, (b) set `VITE_SERVER_URL` to a stopped server.

- [ ] **Step 3: Commit** — `git add frontend && git commit -m "feat(frontend): educative step-by-step payment walkthrough UI"`

---

### Task 16: README + full runbook + final verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything.

- [ ] **Step 1: Write the README** with these sections (all values must match the code):
  1. **What this demonstrates** — x402 v2 `exact` scheme, address-to-address, on Cardano preprod; one-paragraph protocol summary; mermaid sequence diagram of client → server → facilitator → chain (mirror the spec's flow).
  2. **Components** — table: `frontend/` (React + Evolution SDK CIP-30, port 5173), `server/` (Express + `@x402/express`, port 4021), `facilitator/` (Spring Boot + embedded yaci-store + cardano-client-lib, port 4022) with one sentence each on what x402 role it implements and which `../x402` sources it consumes or mirrors.
  3. **The facilitator's correctness story** — the 7 spec verification rules and where each lives (`ExactCardanoFacilitatorScheme`), the Blockfrost vs yaci-store division of authority and *why* (from-tip sync can't answer full-UTxO-set questions), the duplicate-settlement cache, and rollback handling in `TxInclusionTracker`.
  4. **Prerequisites** — Node 20+, pnpm, Java 21, a Blockfrost preprod project id, a CIP-30 wallet (Eternl/Lace) with preprod tADA from `https://docs.cardano.org/cardano-testnets/tools/faucet`, plus a second preprod address for the server's `payTo`.
  5. **Run it** — exact commands in order: `./setup.sh`; facilitator `BLOCKFROST_PROJECT_ID=... ./gradlew bootRun` (wait for `/health` → `ok`); server `cp .env.example .env && npm install && npm run dev`; frontend `cp .env.example .env && npm install && npm run dev`; open `http://localhost:5173`.
  6. **What to watch** — the five UI steps, the facilitator logs during verify/settle, the tx on Cardanoscan preprod.
  7. **Extending** — where masumi/script would plug in (`AssetTransferMethodVerifier`), how to add networks (registry), and a pointer to running `../x402/e2e` against this facilitator as an external proxy (`../x402/e2e/facilitators/external-proxies/`).
  8. **Troubleshooting** — npm `workspace:` fallback (Task 1), Blockfrost 402/429 limits, yaci-store resync (delete `facilitator/data/`), wallet-on-wrong-network.

- [ ] **Step 2: Full clean-room verification.** Kill everything, then execute the README run-steps literally, top to bottom, including one real payment from the browser. Confirm: facilitator `/health` ok; 402 → pay → 200 with `PAYMENT-RESPONSE`; tx visible on Cardanoscan; second immediate replay of the same flow yields a fresh payment (new nonce UTxO) — and `./gradlew test` + both `npm run typecheck`s pass.

- [ ] **Step 3: Commit** — `git add README.md && git commit -m "docs: architecture, correctness story, and runbook"`

---

## Plan Self-Review Notes

- **Spec coverage:** repo layout (T1), facilitator protocol/registry/api (T3/T4/T9), 17-check verify with exact codes (T7), settle + duplicate cache (T8), decoder raw-body-hash invariant (T5), chain port + Blockfrost/yaci-store division (T6/T10/T11/T12), sync-from-tip (T11), health (T12), resource server + CORS (T13), CIP-30 signer + step flow (T14), educative UI (T15), README/runbook + live verification (T16). Masumi/script stay stubs by design (`DefaultTransferVerifier` + rejection of unknown methods) — matches spec's "out of scope, kept open".
- **Known deliberate deviations from TS reference / spec:** input UTxO lookups run sequentially, not `Promise.all` (same result, simpler Java); `evaluateTransaction` dry-run omitted (spec-optional, no-op for address-to-address; the port interface can grow it later); `SchemeNetworkFacilitator` omits the spec's `getExtra()`/`getSigners()` methods (`supported()` hardcodes the empty extra/signers the Cardano scheme would return) and the registry needs no wildcard fallback while exactly one concrete network is registered — both trivially addable when a second scheme/network lands.
- **Type consistency spot-checks:** `SettleConfig` consumed in T9 matches T7's record; `FakeChainService` fields used in T7–T9 tests all exist in T6; `FlowStep` ids in T15 match T14.

