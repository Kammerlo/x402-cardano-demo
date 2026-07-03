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
