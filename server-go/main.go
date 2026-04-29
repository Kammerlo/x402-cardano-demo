// Demo Go resource server — uses x402's Cardano `exact` server scheme
// end-to-end.
//
// The library owns every step of the V2 wire protocol: the 402 challenge,
// PAYMENT-SIGNATURE header decoding, /verify + /settle dispatch to the
// facilitator, and PAYMENT-RESPONSE encoding. The handler code below is
// intentionally minimal — that is the point of the demo.
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
	"github.com/x402-foundation/x402/go/http/nethttp"
	"github.com/x402-foundation/x402/go/mechanisms/cardano"
	cardanoServer "github.com/x402-foundation/x402/go/mechanisms/cardano/exact/server"
)

const secret = "x402-cardano-demo: thanks for paying 5 tADA. The eagle has landed."

func env(key, def string) string {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	return v
}

func main() {
	payTo := env("DEMO_PAYTO_ADDRESS", "")
	if payTo == "" {
		log.Fatal("DEMO_PAYTO_ADDRESS is not set; refusing to start")
	}
	facilitatorURL := strings.TrimRight(
		env("FACILITATOR_URL", "http://facilitator:8080"), "/")
	corsOrigin := env("CORS_ORIGIN", "http://localhost:5173")
	port := env("PORT", "8004")
	network := env("X402_NETWORK", cardano.CardanoPreprod)

	// One HTTP-backed FacilitatorClient + one resource server + the Cardano
	// server scheme registered for the requested network.
	facilitator := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{URL: facilitatorURL})
	resourceServer := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(facilitator),
	)
	resourceServer.Register(x402.Network(network), cardanoServer.NewExactCardanoScheme())

	routes := x402http.RoutesConfig{
		"GET /premium": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:            cardano.SchemeExact,
					PayTo:             payTo,
					Price:             map[string]interface{}{"amount": "5000000", "asset": cardano.LovelaceAsset},
					Network:           x402.Network(network),
					MaxTimeoutSeconds: cardano.DefaultMaxTimeoutSeconds,
					Extra: map[string]interface{}{
						"assetTransferMethod": cardano.AssetTransferMethodDefault,
					},
				},
			},
			Description: "Cardano demo premium endpoint (5 tADA)",
			MimeType:    "application/json",
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/premium", func(w http.ResponseWriter, _ *http.Request) {
		// By the time this handler runs, the payment has been verified.
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"secret": secret})
	})

	// Wrap with the x402 payment middleware first, then CORS. Order matters:
	// in net/http "outer wraps inner". CORS must be the outermost handler so
	// the 402 challenge body inherits its Access-Control headers.
	protected := nethttp.PaymentMiddleware(routes, resourceServer)(mux)
	handler := corsMiddleware(corsOrigin)(protected)

	addr := ":" + port
	log.Printf("x402 Cardano demo (Go server) listening on http://0.0.0.0%s", addr)
	log.Printf("  facilitator: %s", facilitatorURL)
	log.Printf("  payTo: %s", payTo)
	log.Printf("  cors: %s", corsOrigin)

	srv := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// PaymentMiddleware already calls /supported on startup (sync hook), so
	// we don't need to ping the facilitator from main.
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server failed: %v", err)
	}
}

// corsMiddleware emits the same set of CORS headers the TS / Py / Java
// servers produce, including expose-headers for PAYMENT-REQUIRED and
// PAYMENT-RESPONSE so the browser can read them from across the demo's
// http://localhost:5173 origin.
func corsMiddleware(origin string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, PAYMENT-SIGNATURE")
			appendExposed(w, "PAYMENT-REQUIRED")
			appendExposed(w, "PAYMENT-RESPONSE")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// appendExposed adds a header name to the Access-Control-Expose-Headers list
// without clobbering existing values.
func appendExposed(w http.ResponseWriter, headerName string) {
	existing := w.Header().Get("Access-Control-Expose-Headers")
	if existing == "" {
		w.Header().Set("Access-Control-Expose-Headers", headerName)
		return
	}
	for _, tok := range strings.Split(existing, ",") {
		if strings.EqualFold(strings.TrimSpace(tok), headerName) {
			return
		}
	}
	w.Header().Set("Access-Control-Expose-Headers", existing+", "+headerName)
}

