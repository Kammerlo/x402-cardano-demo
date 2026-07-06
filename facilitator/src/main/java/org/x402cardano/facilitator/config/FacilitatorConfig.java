package org.x402cardano.facilitator.config;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.x402cardano.facilitator.cardano.CardanoTransactionDecoder;
import org.x402cardano.facilitator.cardano.ExactCardanoFacilitatorScheme;
import org.x402cardano.facilitator.chain.BlockfrostChainService;
import org.x402cardano.facilitator.chain.CompositeChainService;
import org.x402cardano.facilitator.chain.FacilitatorChainService;
import org.x402cardano.facilitator.chain.yaci.ChainTipTracker;
import org.x402cardano.facilitator.chain.yaci.TxInclusionTracker;
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

    // Division of chain authority: Blockfrost for full-UTxO-set queries, protocol
    // params, and submission; embedded yaci-store trackers for the facilitator's
    // own tip-slot and tx-inclusion view (see CompositeChainService).
    @Bean
    FacilitatorChainService chainService(X402Properties props, ChainTipTracker tip, TxInclusionTracker inclusion) {
        var blockfrost = new BlockfrostChainService(props.blockfrost().baseUrl(), props.blockfrost().projectId());
        return new CompositeChainService(blockfrost, tip, inclusion, props.settle().pollInterval());
    }
}
