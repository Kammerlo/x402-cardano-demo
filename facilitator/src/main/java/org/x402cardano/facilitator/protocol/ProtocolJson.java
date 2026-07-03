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
