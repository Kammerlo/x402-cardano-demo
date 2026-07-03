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
