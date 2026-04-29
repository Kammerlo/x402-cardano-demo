package com.example.x402demo;

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

import org.x402.cardano.CardanoConstants;
import org.x402.cardano.CardanoFacilitator;
import org.x402.cardano.CardanoFacilitatorClient;
import org.x402.cardano.CardanoPaymentFilter;
import org.x402.cardano.RouteConfig;

import java.util.Map;

/**
 * Spring Boot resource server demonstrating x402 V2 Cardano payments.
 *
 * <p>The library {@code org.x402:x402} owns the entire wire-protocol surface:
 * issuing the 402 challenge, decoding the {@code PAYMENT-SIGNATURE} header,
 * dispatching {@code /verify} and {@code /settle} to the facilitator, and
 * emitting the {@code PAYMENT-RESPONSE} header on success. The handler
 * below is intentionally minimal — that is the point of the demo.
 */
@SpringBootApplication
public class Application {

    /** Bech32 address (preprod) that should receive the 5 tADA payment. */
    @Value("${demo.payTo:}")
    private String payTo;

    /** URL of the x402 Cardano facilitator. */
    @Value("${demo.facilitatorUrl:http://facilitator:8080}")
    private String facilitatorUrl;

    /** CORS origin to allow (typically the demo frontend). */
    @Value("${demo.corsOrigin:http://localhost:5173}")
    private String corsOrigin;

    /** x402 Cardano network identifier. */
    @Value("${demo.network:cardano:preprod}")
    private String network;

    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }

    /**
     * Register the {@link CardanoPaymentFilter} for {@code GET /premium}.
     *
     * @return Spring's filter registration bean
     */
    @Bean
    public FilterRegistrationBean<CardanoPaymentFilter> paymentFilter() {
        if (payTo == null || payTo.isBlank()) {
            throw new IllegalStateException(
                    "demo.payTo (DEMO_PAYTO_ADDRESS) is required");
        }
        CardanoFacilitator facilitator = new CardanoFacilitatorClient(facilitatorUrl);

        // One protected route — the same shape used by server-ts and server-py.
        Map<String, RouteConfig> routes = Map.of(
                "/premium",
                RouteConfig.forDefault(
                        network,
                        payTo,
                        "5000000",                          // 5 tADA in lovelace
                        CardanoConstants.LOVELACE_ASSET,
                        "Cardano demo premium endpoint (5 tADA)",
                        "application/json"));

        FilterRegistrationBean<CardanoPaymentFilter> registration =
                new FilterRegistrationBean<>(new CardanoPaymentFilter(facilitator, routes));
        registration.addUrlPatterns("/premium");
        // Run AFTER the CORS filter so any 402 challenge we write inherits the
        // CORS headers added by the outer filter. Lower-numbered orders run
        // first (outermost), so 0 > HIGHEST_PRECEDENCE = CORS wraps us.
        registration.setOrder(0);
        return registration;
    }

    /**
     * CORS filter — mirrors the Hono CORS setup in server-ts so the demo
     * frontend can read the {@code PAYMENT-REQUIRED} and {@code PAYMENT-RESPONSE}
     * headers across origins.
     *
     * <p>Registered as a {@link FilterRegistrationBean} with
     * {@link Ordered#HIGHEST_PRECEDENCE} so it runs <strong>before</strong>
     * the {@link CardanoPaymentFilter}. Otherwise the payment filter would
     * write a 402 response without the CORS headers and the browser would
     * report a generic "Failed to fetch".
     */
    @Bean
    public FilterRegistrationBean<CorsFilter> corsFilter() {
        CorsConfiguration cors = new CorsConfiguration();
        cors.addAllowedOriginPattern(corsOrigin);
        cors.addAllowedOriginPattern("*");
        cors.addAllowedHeader("*");
        cors.addAllowedMethod("GET");
        cors.addAllowedMethod("OPTIONS");
        cors.addExposedHeader(CardanoPaymentFilter.HDR_PAYMENT_REQUIRED);
        cors.addExposedHeader(CardanoPaymentFilter.HDR_PAYMENT_RESPONSE);
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", cors);

        FilterRegistrationBean<CorsFilter> bean =
                new FilterRegistrationBean<>(new CorsFilter(source));
        bean.setOrder(Ordered.HIGHEST_PRECEDENCE);
        return bean;
    }

    /**
     * The protected handler. By the time Spring routes a request here, the
     * {@link CardanoPaymentFilter} has already verified the payment with the
     * facilitator. Settlement happens after this method returns.
     */
    @RestController
    public static class PremiumController {

        private static final String SECRET =
                "x402-cardano-demo: thanks for paying 5 tADA. The eagle has landed.";

        /** Liveness probe used by docker-compose's healthcheck. */
        @GetMapping("/healthz")
        public Map<String, String> healthz() {
            return Map.of("status", "ok");
        }

        /** Premium content — only reachable after a valid 5 tADA payment. */
        @GetMapping("/premium")
        public Map<String, String> premium() {
            return Map.of("secret", SECRET);
        }
    }
}
