# Multi-stage build: stage 1 builds the Go binary against the sibling x402
# library; stage 2 packages it in a minimal runtime image.
#
# Build context : x402-cardano-demo/         (this repo)
# Named context : x402  →  ../x402            (Kammerlo/x402 fork)

# ---------------------------------------------------------------------------
# Stage 1 — compile the demo binary statically.
# ---------------------------------------------------------------------------
FROM golang:1.24-alpine AS build

# The server's go.mod uses `replace github.com/x402-foundation/x402/go => ../../x402/go`
# so we lay out the workspace identically inside the image: x402-cardano-demo
# alongside x402.
WORKDIR /workspace
COPY --from=x402 go /workspace/x402/go
COPY server-go /workspace/x402-cardano-demo/server-go

WORKDIR /workspace/x402-cardano-demo/server-go
RUN go mod tidy
RUN CGO_ENABLED=0 go build -o /out/server-go .

# ---------------------------------------------------------------------------
# Stage 2 — tiny runtime image.
# ---------------------------------------------------------------------------
FROM alpine:3.20

# CA roots so the binary can hit a TLS facilitator if you ever switch to one.
RUN apk add --no-cache ca-certificates

COPY --from=build /out/server-go /usr/local/bin/server-go

EXPOSE 8004
ENTRYPOINT ["/usr/local/bin/server-go"]
