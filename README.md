# x402 Cardano Demo

An end-to-end demo of the [x402 payment protocol](https://x402.org) on Cardano preprod.

A browser wallet (Eternl, Lace, etc.) pays 5 tADA to unlock a protected REST endpoint.  
The full flow — 402 challenge → wallet signs transaction → facilitator verifies & submits → 200 response — runs in the browser, with four interchangeable resource servers (TypeScript / Python / Java / Go).

> **First time here?** Follow [GETTING_STARTED.md](./GETTING_STARTED.md) for a step-by-step walkthrough from a clean machine to a successful payment.

---

## Repository layout

This demo references the library source from a **sibling checkout** of the x402 repository:

```
<parent>/
├── x402/                  ← https://github.com/cardano-foundation/x402  (library source)
└── x402-cardano-demo/     ← https://github.com/Kammerlo/x402-cardano-demo  (this repo)
```

| Path | Description |
|------|-------------|
| `frontend/` | React + Vite UI — connects a CIP-30 wallet and drives the payment flow |
| `server-ts/` | Hono resource server (TypeScript) |
| `server-py/` | FastAPI resource server (Python) |
| `server-java/` | Spring Boot resource server (Java) |
| `server-go/` | net/http resource server (Go) |
| `facilitator/` | Standalone x402 facilitator backed by Blockfrost (Python) |

---

## Quick start (Docker)

```bash
# 1. Clone both repos as siblings
mkdir -p ~/projects && cd ~/projects
git clone https://github.com/cardano-foundation/x402.git
git clone https://github.com/Kammerlo/x402-cardano-demo.git

# 2. Configure
cd x402-cardano-demo
cp .env.example .env
#   then edit .env to set BLOCKFROST_PROJECT_ID_PREPROD + DEMO_PAYTO_ADDRESS

# 3. Start
docker compose --env-file .env up --build
```

Open <http://localhost:5173>.

> Requires **Docker Engine 23+ / Docker Desktop 4.19+** (BuildKit `additional_contexts`). No Node, pnpm, Python, Java, or Maven needed on the host — Docker builds every library inside its container.

---

## How it works

```
Browser (CIP-30 wallet)
  │
  ├─ GET /premium ─────────────────► Resource server (TS, Py, Java, or Go)
  │                                    │
  │  ◄─ 402 + accepts[] ─────────────  │   (x402 middleware)
  │
  ├─ wallet.signTx(5 tADA → payTo)
  │
  ├─ GET /premium + PAYMENT-SIGNATURE ▶ Resource server
  │                                    ├─ POST /verify ─► Facilitator
  │                                    ├─ POST /settle ─► Facilitator
  │  ◄─ 200 + PAYMENT-RESPONSE ──────  │
```

The x402 library handles the wire protocol. Your code only needs to:

1. Wrap the protected route with the payment middleware (one line)
2. Implement `ClientCardanoSigner` in the browser (build + sign a transaction)

---

## Further reading

- [`GETTING_STARTED.md`](./GETTING_STARTED.md) — step-by-step onboarding, from "empty machine" to "5 tADA paid"
- Per-language developer guides in [`docs/`](./docs/):
  - [`docs/typescript-guide.md`](./docs/typescript-guide.md) — `@x402/cardano` (server + browser CIP-30 signer)
  - [`docs/python-guide.md`](./docs/python-guide.md) — `x402[cardano]` (FastAPI / Flask resource server, plus running your own facilitator)
  - [`docs/java-guide.md`](./docs/java-guide.md) — `org.x402.cardano` (Spring Boot or any servlet container)
  - [`docs/go-guide.md`](./docs/go-guide.md) — `mechanisms/cardano` (net/http, Echo, or Gin)
- [`docs/running-without-docker.md`](./docs/running-without-docker.md) — local dev recipes for each runtime
- [`docs/troubleshooting.md`](./docs/troubleshooting.md) — common failure modes and fixes
- [Cardano spec](https://github.com/cardano-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_cardano_TESTING.md) — the canonical protocol description

---

## License

Apache-2.0
