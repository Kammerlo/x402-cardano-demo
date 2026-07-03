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
