# Go — `mechanisms/cardano` developer guide

How to consume the x402 Cardano scheme from Go. The Go SDK is server-side only — it never decodes Cardano CBOR. Its job is the wire protocol; chain inspection lives in a remote facilitator (the Python reference, or any V2-compatible facilitator).

Reference service in this demo: [`server-go/main.go`](../server-go/main.go).

---

## Install

The Cardano support lives in the same `github.com/x402-foundation/x402/go` module as the existing EVM/SVM mechanisms, under the `mechanisms/cardano` subtree. Until the module is published to a stable release, reference your sibling [x402](https://github.com/cardano-foundation/x402) checkout via `replace`:

```go
// go.mod
module example.com/your-server

go 1.24

replace github.com/x402-foundation/x402/go => ../../x402/go

require github.com/x402-foundation/x402/go v0.0.0-00010101000000-000000000000
```

Then `go mod tidy`.

Requires Go 1.24+.

---

## Concepts in 30 seconds

The Go SDK already has the framework you need:

- `x402.X402ResourceServer` owns scheme registration + dispatch
- `x402http.HTTPFacilitatorClient` talks to `/verify`, `/settle`, `/supported`
- `nethttp.PaymentMiddleware` (and Echo / Gin variants) wrap your routes

To enable Cardano you only register one extra scheme:

```go
import (
    "github.com/x402-foundation/x402/go/mechanisms/cardano"
    cardanoServer "github.com/x402-foundation/x402/go/mechanisms/cardano/exact/server"
)

resourceServer.Register(cardano.CardanoPreprod, cardanoServer.NewExactCardanoScheme())
```

Everything else is identical to the SDK's existing EVM / SVM examples.

---

## Resource server (net/http)

```go
package main

import (
    "encoding/json"
    "log"
    "net/http"
    "os"

    x402 "github.com/x402-foundation/x402/go"
    x402http "github.com/x402-foundation/x402/go/http"
    "github.com/x402-foundation/x402/go/http/nethttp"
    "github.com/x402-foundation/x402/go/mechanisms/cardano"
    cardanoServer "github.com/x402-foundation/x402/go/mechanisms/cardano/exact/server"
)

func main() {
    payTo := os.Getenv("DEMO_PAYTO_ADDRESS")
    facilitatorURL := os.Getenv("FACILITATOR_URL")

    facilitator := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{URL: facilitatorURL})
    server := x402.Newx402ResourceServer(x402.WithFacilitatorClient(facilitator))
    server.Register(cardano.CardanoPreprod, cardanoServer.NewExactCardanoScheme())

    routes := x402http.RoutesConfig{
        "GET /premium": {
            Accepts: x402http.PaymentOptions{{
                Scheme:            cardano.SchemeExact,
                PayTo:             payTo,
                Price:             map[string]interface{}{"amount": "5000000", "asset": cardano.LovelaceAsset},
                Network:           cardano.CardanoPreprod,
                MaxTimeoutSeconds: cardano.DefaultMaxTimeoutSeconds,
                Extra: map[string]interface{}{
                    "assetTransferMethod": cardano.AssetTransferMethodDefault,
                },
            }},
            Description: "Premium endpoint",
            MimeType:    "application/json",
        },
    }

    mux := http.NewServeMux()
    mux.HandleFunc("/premium", func(w http.ResponseWriter, _ *http.Request) {
        // Reaching here means the payment has been verified.
        w.Header().Set("Content-Type", "application/json")
        _ = json.NewEncoder(w).Encode(map[string]string{"secret": "you paid!"})
    })

    handler := nethttp.PaymentMiddleware(routes, server)(mux)

    log.Fatal(http.ListenAndServe(":8004", handler))
}
```

### CORS

Wrap your final handler with a CORS middleware that exposes `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE`. CORS must be the **outermost** layer so the 402 challenge inherits its headers — see [`server-go/main.go`](../server-go/main.go) for a self-contained `corsMiddleware` example.

### Echo / Gin

The SDK ships per-framework adapters in `github.com/x402-foundation/x402/go/http/echo` and `…/http/gin`. Drop them in instead of `nethttp.PaymentMiddleware`; the rest of the wiring is identical.

---

## Public API surface

All in package `github.com/x402-foundation/x402/go/mechanisms/cardano` (and `…/exact/server`).

### Constants

| Constant | Meaning |
|----------|---------|
| `cardano.SchemeExact` | Scheme identifier (`"exact"`) |
| `cardano.CardanoMainnet` / `CardanoPreprod` / `CardanoPreview` | x402 network identifiers |
| `cardano.NetworkIDMainnet` / `NetworkIDTestnet` | Cardano body `network_id` values |
| `cardano.LovelaceAsset` | `"lovelace"` — native ADA marker |
| `cardano.USDMMainnetAsset` / `USDMPreprodAsset` | Default USDM asset units |
| `cardano.USDMDefaultDecimals` | 6 — used by the default money parser |
| `cardano.AssetTransferMethodDefault` / `Masumi` / `Script` | `extra.assetTransferMethod` markers |
| `cardano.DefaultMaxTimeoutSeconds` | 300 — challenge validity window |
| `cardano.SettlementTTL` | 120 s — duplicate-settlement cache window |
| `cardano.CardanoAssetRegex` / `CardanoAddressRegex` / `CardanoUTXORefRegex` | Validation regexes |
| `cardano.Err…` (many) | Stable error code strings; identical across SDKs |

### Types

```go
type ExactCardanoPayload struct {
    Transaction string `json:"transaction"` // base64 CBOR
    Nonce       string `json:"nonce"`       // txHashHex#index
}

type PaymentResponseHeader struct {
    Success     bool                   `json:"success"`
    Transaction string                 `json:"transaction,omitempty"`
    Network     string                 `json:"network,omitempty"`
    Extensions  map[string]interface{} `json:"extensions,omitempty"`
    ErrorReason string                 `json:"errorReason,omitempty"`
}

type NetworkConfig struct {
    CAIP2        string
    NetworkID    int
    DefaultAsset string
}
```

### Helpers

```go
cardano.IsCardanoNetwork("cardano:preprod")       // bool
cardano.GetNetworkConfig("cardano:preprod")       // (NetworkConfig, error)

cardano.ValidateAssetUnit("lovelace")             // error
cardano.ValidateAddress("addr_test1q...")         // error
cardano.ValidateUTXORef("…#3")                    // error
cardano.ParseUTXORef("…#3")                       // (txHashLower, index, error)
cardano.ParseAssetUnit("lovelace")                // ("", "", nil)

cardano.ConvertToTokenAmount("1.50", 6)           // ("1500000", nil)
cardano.ParseMoneyToDecimal("$1.50 USDM")         // ("1.50", nil)

ExactCardanoPayloadFromMap(rawJSONMap)            // typed payload
payload.ToMap()                                   // round-trip back
header.EncodeHeader()                             // base64 PAYMENT-RESPONSE
```

### Server scheme

```go
import cardanoServer "github.com/x402-foundation/x402/go/mechanisms/cardano/exact/server"

s := cardanoServer.NewExactCardanoScheme()
// optional: register a custom Money parser as a fallback chain element
s.RegisterMoneyParser(func(amount float64, n x402.Network) (*x402.AssetAmount, error) {
    if amount > 100 {
        return &x402.AssetAmount{Amount: lovelace(amount), Asset: cardano.LovelaceAsset}, nil
    }
    return nil, nil // defer to next parser, ultimately falling back to USDM
})

resourceServer.Register(cardano.CardanoPreprod, s)
```

`*ExactCardanoScheme` implements both `x402.SchemeNetworkServer` and `x402.AssetDecimalsProvider` (returns 6 — override by wrapping if you have a custom-decimal asset).

---

## Reading the `PAYMENT-RESPONSE` header from a Go client

```go
import "encoding/base64"
import "encoding/json"
import "github.com/x402-foundation/x402/go/mechanisms/cardano"

resp, _ := http.Get("http://localhost:8004/premium")
hdrB64 := resp.Header.Get("PAYMENT-RESPONSE")

raw, _ := base64.StdEncoding.DecodeString(hdrB64)
var paid cardano.PaymentResponseHeader
_ = json.Unmarshal(raw, &paid)

fmt.Println(paid.Transaction)                    // tx hash
fmt.Println(paid.Extensions["status"])           // "confirmed" | "mempool"
```

---

## Error reasons

The facilitator returns stable error codes in `VerifyResponse.InvalidReason` and `SettleResponse.ErrorReason`. They are mirrored as constants in the Cardano package and match the spec, the TS, the Python and the Java SDKs byte-for-byte:

```go
cardano.ErrInvalidPayload                  // "invalid_exact_cardano_payload"
cardano.ErrTransactionUnsigned             // "invalid_exact_cardano_payload_unsigned"
cardano.ErrNetworkIDMismatch
cardano.ErrRecipientMismatch
cardano.ErrAssetMismatch
cardano.ErrAmountInsufficient
cardano.ErrNonceInvalid
cardano.ErrNonceNotInInputs
cardano.ErrNonceNotOnChain
cardano.ErrTTLExpired
cardano.ErrValidityNotYetValid
cardano.ErrChainLookupFailed
cardano.ErrSettlementFailed
cardano.ErrSettlementNotConfirmed
cardano.ErrDuplicateSettlement
cardano.ErrScriptAddressMismatch
```

---

## Common pitfalls

- **CORS** — `Access-Control-Expose-Headers: PAYMENT-REQUIRED, PAYMENT-RESPONSE` on every response, including 402s. Easiest is to wrap the whole handler chain with a CORS middleware as the outermost layer.
- **`MaxTimeoutSeconds`** — default in `x402http.PaymentOption` is 60 seconds when unset. Set it to `cardano.DefaultMaxTimeoutSeconds` (300) to match the spec / other SDKs.
- **Network identifier** — Cardano uses `cardano:mainnet|preprod|preview` (NOT canonical CAIP-2). Use the package constants, never hand-typed strings.
- **`assetTransferMethod`** — must always be set in `Extra`. The Cardano server scheme defaults it to `"default"` if missing in `EnhancePaymentRequirements`, but be explicit in your route config to match the wire format the other SDKs emit.
- **`replace` directive** — when running outside Docker, the `go.mod` `replace` must point at the actual `x402/go` checkout. The demo expects `../../x402/go`.
