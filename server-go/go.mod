module github.com/cardano-foundation/x402-cardano-demo/server-go

go 1.24.0

toolchain go1.24.1

// Resolved at build time via Docker (the x402/ sibling repo is mounted via
// `additional_contexts: x402: ../x402` in docker-compose). For local-dev
// outside Docker, run from x402-cardano-demo/server-go and ensure the
// replace target points at your sibling x402 checkout.
replace github.com/x402-foundation/x402/go => ../../x402/go

require github.com/x402-foundation/x402/go v0.0.0-00010101000000-000000000000

require (
	github.com/xeipuuv/gojsonpointer v0.0.0-20180127040702-4e3ac2762d5f // indirect
	github.com/xeipuuv/gojsonreference v0.0.0-20180127040603-bd5ef7bd5415 // indirect
	github.com/xeipuuv/gojsonschema v1.2.0 // indirect
)
