# Java — `org.x402.cardano` developer guide

How to consume the x402 Cardano scheme from Java, with first-class Spring Boot wiring. The library is a servlet-API (`jakarta.servlet`) component, so it works with any container — Spring Boot, Quarkus, plain Tomcat or Jetty.

Reference service in this demo: [`server-java/src/main/java/com/example/x402demo/Application.java`](../server-java/src/main/java/com/example/x402demo/Application.java)

---

## Install

The Cardano support lives inside the `org.x402:x402` artifact at `org.x402.cardano.*`. The library isn't on Maven Central yet — install from the sibling [x402](https://github.com/cardano-foundation/x402) checkout:

```bash
cd ../x402/java
mvn -DskipTests -Dcheckstyle.skip=true -Dspotbugs.skip=true install
```

Then add to your `pom.xml`:

```xml
<dependency>
  <groupId>org.x402</groupId>
  <artifactId>x402</artifactId>
  <version>1.0.0-SNAPSHOT</version>
</dependency>
```

Requires JDK 17+.

---

## Concepts in 30 seconds

The Java module is server-side only — it never decodes Cardano CBOR. Its job is the wire protocol:

1. Sees a request → if the path is protected and there's no `PAYMENT-SIGNATURE` header, return a v2 402 with `accepts[]`.
2. Decodes a present header into a `CardanoPaymentPayload`.
3. Calls a `CardanoFacilitator` (typically the HTTP client) for `/verify`. On failure, returns 402 with the facilitator's reason code.
4. Lets the protected handler run. On success, calls `/settle` and emits a `PAYMENT-RESPONSE` header.

All chain decoding (CBOR, witnesses, nonce checks, …) is delegated to the facilitator service.

---

## Spring Boot wiring

```java
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.core.Ordered;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;
import org.springframework.web.filter.CorsFilter;
import org.x402.cardano.*;

import java.util.Map;

@SpringBootApplication
public class Application {

    @Value("${demo.payTo:}")          private String payTo;
    @Value("${demo.facilitatorUrl:}") private String facilitatorUrl;
    @Value("${demo.corsOrigin:}")     private String corsOrigin;
    @Value("${demo.network:cardano:preprod}") private String network;

    public static void main(String[] args) { SpringApplication.run(Application.class, args); }

    @Bean
    public FilterRegistrationBean<CardanoPaymentFilter> paymentFilter() {
        CardanoFacilitator facilitator = new CardanoFacilitatorClient(facilitatorUrl);
        Map<String, RouteConfig> routes = Map.of(
            "/premium",
            RouteConfig.forDefault(
                network,
                payTo,
                "5000000",                          // 5 tADA in lovelace
                CardanoConstants.LOVELACE_ASSET,
                "Premium endpoint",
                "application/json"));

        FilterRegistrationBean<CardanoPaymentFilter> reg =
                new FilterRegistrationBean<>(new CardanoPaymentFilter(facilitator, routes));
        reg.addUrlPatterns("/premium");
        reg.setOrder(0);   // runs after the CORS filter (HIGHEST_PRECEDENCE)
        return reg;
    }

    /** CORS MUST be the outermost filter so the 402 challenge inherits its headers. */
    @Bean
    public FilterRegistrationBean<CorsFilter> corsFilter() {
        CorsConfiguration cors = new CorsConfiguration();
        cors.addAllowedOriginPattern(corsOrigin);
        cors.addAllowedHeader("*");
        cors.addAllowedMethod("GET");
        cors.addAllowedMethod("OPTIONS");
        cors.addExposedHeader(CardanoPaymentFilter.HDR_PAYMENT_REQUIRED);
        cors.addExposedHeader(CardanoPaymentFilter.HDR_PAYMENT_RESPONSE);
        UrlBasedCorsConfigurationSource src = new UrlBasedCorsConfigurationSource();
        src.registerCorsConfiguration("/**", cors);
        FilterRegistrationBean<CorsFilter> bean = new FilterRegistrationBean<>(new CorsFilter(src));
        bean.setOrder(Ordered.HIGHEST_PRECEDENCE);
        return bean;
    }

    @RestController
    public static class PremiumController {
        @GetMapping("/healthz")
        Map<String, String> healthz() { return Map.of("status", "ok"); }

        @GetMapping("/premium")
        Map<String, String> premium() { return Map.of("secret", "you paid!"); }
    }
}
```

### The CORS gotcha

In a servlet chain, **lower order = outermost filter**. If you leave the auto-registered `CorsFilter` at default order (`LOWEST_PRECEDENCE`) but register the payment filter at `0`, the payment filter wraps CORS — and when it writes a 402 directly, CORS never gets a chance to add `Access-Control-Allow-Origin`. The browser shows a generic "Failed to fetch".

Always register the CORS filter **explicitly** with `Ordered.HIGHEST_PRECEDENCE` so it stays outermost.

---

## Using outside Spring Boot

The library only depends on `jakarta.servlet`, so it works in any servlet container. Wire the filter manually in `web.xml`, in a `ServletContainerInitializer`, or via Quarkus' `@ApplicationScoped @WebFilter`. The constructor is plain Java:

```java
CardanoFacilitator facilitator = new CardanoFacilitatorClient("http://localhost:8080");
Map<String, RouteConfig> routes = Map.of(
    "/premium",
    RouteConfig.forDefault(
        CardanoConstants.CARDANO_PREPROD,
        "addr_test1q...", "5000000",
        CardanoConstants.LOVELACE_ASSET,
        null, null));
Filter filter = new CardanoPaymentFilter(facilitator, routes);
```

Pair it with whatever CORS / response-headers mechanism your container uses, ensuring CORS runs first.

---

## Public API

All in package `org.x402.cardano`.

| Class | Role |
|-------|------|
| `CardanoConstants` | Network IDs, asset markers, regex patterns, error codes, default timeouts |
| `Price` | `{amount, asset}` price block |
| `ResourceInfo` | `{url, description, mimeType}` shown in 402 challenges |
| `CardanoAccepts` | One entry of `accepts[]` in a 402 challenge |
| `CardanoPaymentRequired` | The full 402 response body (`x402Version: 2`, `error`, `resource`, `accepts[]`) |
| `CardanoPaymentRequirements` | Canonical, server-supplied requirements posted to the facilitator |
| `ExactCardanoPayload` | `{transaction, nonce}` inner payload |
| `CardanoPaymentPayload` | V2 envelope; encodes/decodes the `PAYMENT-SIGNATURE` header |
| `CardanoVerifyResponse` / `CardanoSettleResponse` | Facilitator response DTOs (snake-case aliases included for Python interop) |
| `PaymentResponseHeader` | Body of the `PAYMENT-RESPONSE` response header |
| `CardanoFacilitator` (interface) | Verify / settle / supported contract |
| `CardanoFacilitatorClient` | HTTP/1.1 implementation of the contract |
| `RouteConfig` | Per-route bundle: accepts + description + MIME type |
| `CardanoPaymentFilter` | Servlet filter that owns the V2 wire flow |

### Factory shortcuts

```java
CardanoAccepts a = CardanoAccepts.forDefaultTransfer(
    CardanoConstants.CARDANO_PREPROD,
    "addr_test1q...", "5000000", CardanoConstants.LOVELACE_ASSET);

CardanoPaymentRequirements r = CardanoPaymentRequirements.forDefaultTransfer(
    CardanoConstants.CARDANO_PREPROD,
    CardanoConstants.LOVELACE_ASSET, "5000000", "addr_test1q...");

RouteConfig rc = RouteConfig.forDefault(
    CardanoConstants.CARDANO_PREPROD,
    "addr_test1q...", "5000000", CardanoConstants.LOVELACE_ASSET,
    "Premium endpoint", "application/json");
```

---

## Reading the `PAYMENT-RESPONSE` header from a Java client

```java
HttpResponse<String> response = http.send(req, HttpResponse.BodyHandlers.ofString());
String b64 = response.headers().firstValue("PAYMENT-RESPONSE").orElse(null);
byte[] json = Base64.getDecoder().decode(b64);
PaymentResponseHeader paid = Json.MAPPER.readValue(json, PaymentResponseHeader.class);

System.out.println(paid.transaction);
System.out.println(paid.extensions.get("status"));   // "confirmed" | "mempool"
```

`PaymentResponseHeader` lives in the same package and is shaped exactly like the wire format.

---

## Error reasons

The facilitator returns stable error codes in `CardanoVerifyResponse.invalidReason` and `CardanoSettleResponse.errorReason`. They are mirrored as constants in `CardanoConstants`:

```java
CardanoConstants.ERR_INVALID_PAYLOAD;                 // "invalid_exact_cardano_payload"
CardanoConstants.ERR_TRANSACTION_UNSIGNED;            // "invalid_exact_cardano_payload_unsigned"
CardanoConstants.ERR_NETWORK_ID_MISMATCH;             // ...
CardanoConstants.ERR_RECIPIENT_MISMATCH;
CardanoConstants.ERR_ASSET_MISMATCH;
CardanoConstants.ERR_AMOUNT_INSUFFICIENT;
CardanoConstants.ERR_NONCE_INVALID;
CardanoConstants.ERR_NONCE_NOT_IN_INPUTS;
CardanoConstants.ERR_NONCE_NOT_ON_CHAIN;
CardanoConstants.ERR_TTL_EXPIRED;
CardanoConstants.ERR_VALIDITY_NOT_YET_VALID;
CardanoConstants.ERR_CHAIN_LOOKUP_FAILED;
CardanoConstants.ERR_SETTLEMENT_FAILED;
CardanoConstants.ERR_SETTLEMENT_NOT_CONFIRMED;
CardanoConstants.ERR_DUPLICATE_SETTLEMENT;
CardanoConstants.ERR_SCRIPT_ADDRESS_MISMATCH;
```

These match the spec, the TypeScript constants, and the Python `x402.mechanisms.cardano.constants` module byte-for-byte.

---

## Common pitfalls

- **CORS filter ordering** — always `HIGHEST_PRECEDENCE`, see the gotcha above.
- **HTTP/1.1 enforcement** — `CardanoFacilitatorClient` forces HTTP/1.1 because uvicorn (the reference Python facilitator) does not handle JDK HttpClient's default h2c upgrade negotiation. If you supply your own `HttpClient`, ensure it uses `Version.HTTP_1_1` or the request body will be silently dropped.
- **Filter URL pattern** — `addUrlPatterns("/premium")` is exact; for multi-route apps, register the filter under `"/*"` and let the route map decide which paths are protected.
- **Tests on JDK 24** — Mockito 5 cannot mock concrete classes on JDK 24+. Mock the `CardanoFacilitator` *interface*, not the `CardanoFacilitatorClient` class.
