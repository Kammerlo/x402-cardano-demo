package org.x402cardano.facilitator.config;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.x402cardano.facilitator.cardano.CardanoTransactionDecoder;
import org.x402cardano.facilitator.cardano.ExactCardanoFacilitatorScheme;
import org.x402cardano.facilitator.chain.FacilitatorChainService;
import org.x402cardano.facilitator.chain.UtxoInfo;
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

    @Bean org.springframework.boot.autoconfigure.jackson.Jackson2ObjectMapperBuilderCustomizer jsonCustomizer() {
        return builder -> builder.serializationInclusion(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
                .failOnUnknownProperties(false);
    }

    // Interim bean so the context boots before Task 12; any use fails loudly.
    // Task 12 wires the real FacilitatorChainService and deletes this bean.
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
}
