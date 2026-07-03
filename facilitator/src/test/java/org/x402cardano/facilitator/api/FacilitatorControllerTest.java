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
