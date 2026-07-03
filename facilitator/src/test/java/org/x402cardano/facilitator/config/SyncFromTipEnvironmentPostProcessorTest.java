package org.x402cardano.facilitator.config;

import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.mock.env.MockEnvironment;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

class SyncFromTipEnvironmentPostProcessorTest {
    private final SyncFromTipEnvironmentPostProcessor processor = new SyncFromTipEnvironmentPostProcessor();
    private final SpringApplication app = new SpringApplication();

    /**
     * A non-numeric blocks-behind override must NOT crash startup: the parse falls
     * back to the default and the (here unreachable) Blockfrost call fails safely,
     * so nothing is injected and no exception escapes postProcessEnvironment.
     */
    @Test void nonNumericBlocksBehindDoesNotThrow() {
        MockEnvironment env = new MockEnvironment();
        env.setProperty("x402.sync-from-tip.enabled", "true");
        env.setProperty("x402.blockfrost.project-id", "dummy-project-id");
        // Closed port => the HTTP fetch fails fast and is caught (keeps the test hermetic).
        env.setProperty("x402.blockfrost.base-url", "http://127.0.0.1:1");
        env.setProperty("x402.sync-from-tip.blocks-behind", "not-a-number");

        assertThatCode(() -> processor.postProcessEnvironment(env, app)).doesNotThrowAnyException();
        assertThat(env.getPropertySources().contains("syncFromTip")).isFalse();
        assertThat(env.getProperty("store.cardano.sync-start-slot")).isNull();
    }

    @Test void disabledIsInertAndNeverThrows() {
        MockEnvironment env = new MockEnvironment();
        env.setProperty("x402.sync-from-tip.enabled", "false");
        env.setProperty("x402.blockfrost.project-id", "dummy-project-id");

        assertThatCode(() -> processor.postProcessEnvironment(env, app)).doesNotThrowAnyException();
        assertThat(env.getPropertySources().contains("syncFromTip")).isFalse();
    }

    @Test void blankProjectIdIsInertAndNeverThrows() {
        MockEnvironment env = new MockEnvironment();
        env.setProperty("x402.sync-from-tip.enabled", "true");
        env.setProperty("x402.blockfrost.project-id", "");

        assertThatCode(() -> processor.postProcessEnvironment(env, app)).doesNotThrowAnyException();
        assertThat(env.getPropertySources().contains("syncFromTip")).isFalse();
    }
}
