# x402 Cardano Demo

An end-to-end demo of the [x402 payment protocol](https://x402.org) on Cardano preprod.

A browser wallet (Eternl, Lace, etc.) pays 5 tADA to unlock a protected REST endpoint.  
The full flow — 402 challenge → wallet signs transaction → facilitator verifies & submits → 200 response — runs in the browser with no custom backend plumbing beyond filling in a `.env`.

---

## Repository structure

This demo references the library source from a **sibling checkout** of the x402 repository.  
Both repos must sit in the same parent directory:

```
<parent>/
├── x402/                  ← https://github.com/Kammerlo/x402  (library source)
└── x402-cardano-demo/     ← https://github.com/Kammerlo/x402-cardano-demo  (this repo)
```

| Path (this repo) | Description |
|------------------|-------------|
| `frontend/` | React + Vite demo UI — connects a CIP-30 wallet and drives the payment flow |
| `server-ts/` | Hono resource server (TypeScript) — one protected endpoint (`GET /premium`) |
| `server-py/` | FastAPI resource server (Python) — same endpoint, different runtime |
| `facilitator/` | Standalone x402 facilitator backed by Blockfrost (Python) |

The library packages (`@x402/cardano`, `@x402/core`, `@x402/hono`, `python/x402`) live in the `x402/` sibling and are never duplicated here.

---

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) + [Docker Compose](https://docs.docker.com/compose/)
- [Node.js 20+](https://nodejs.org/) and [pnpm](https://pnpm.io/) (for the one-time library build)
- A Cardano **preprod** wallet (Eternl, Lace, etc.) with some tADA — get free tADA at the [Cardano Testnet Faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/)
- A [Blockfrost](https://blockfrost.io) account with a **preprod** project ID

---

## Setup

### Step 1 — Clone both repos as siblings

```bash
# Pick any parent directory
mkdir -p ~/projects && cd ~/projects

git clone https://github.com/Kammerlo/x402.git
git clone https://github.com/Kammerlo/x402-cardano-demo.git
```

### Step 2 — Build the x402 library packages

The demo references built `dist/` artifacts from the library. Do this once (and again after pulling updates to `x402/`):

```bash
cd x402/typescript
pnpm install
pnpm --filter @x402/core build
pnpm --filter @x402/extensions build
pnpm --filter @x402/cardano build
pnpm --filter @x402/hono build
```

### Step 3 — Configure the demo

```bash
cd ../x402-cardano-demo
cp .env.example .env
```

Open `.env` and fill in:

```dotenv
BLOCKFROST_PROJECT_ID_PREPROD=preprodXXXXXXXXXXXX   # your Blockfrost preprod key
DEMO_PAYTO_ADDRESS=addr_test1qx...                   # any preprod address you control
```

### Step 4 — Start everything

> **Docker version requirement**: `docker compose` must be v2.17+ (Docker Desktop 4.19+ or Docker Engine 23+) because the Dockerfiles use BuildKit `additional_contexts` to pull library source from the sibling `x402/` repo without including it in the main build context.

```bash
# Still inside x402-cardano-demo/
docker compose --env-file .env up --build
```

Open [http://localhost:5173](http://localhost:5173).

---

## How the demo works

```
Browser (CIP-30 wallet)
  │
  ├─ GET /premium ──────────────────────────────► Resource server (TS or Py)
  │                                                │
  │  ◄─── 402 Payment Required ─────────────────── │  (x402 middleware)
  │        (payTo, amount, network, ...)
  │
  ├─ wallet.signTx(lovelace payment to payTo)
  │
  ├─ GET /premium  ─────────────────────────────► Resource server
  │   + X-PAYMENT header (base64 signed tx)        │
  │                                                ├─ POST /verify ──► Facilitator
  │                                                │                    (validates tx)
  │                                                ├─ POST /settle ──► Facilitator
  │                                                │                    (submits tx)
  │  ◄─── 200 OK + secret payload ─────────────── │
```

The x402 library handles all wire-protocol details. Your code only needs to:
1. Wrap your route with the payment middleware (one line)
2. Implement `ClientCardanoSigner` in the browser (build + sign a transaction)

---

## Using the libraries in your own project

### TypeScript — `@x402/cardano`

Until `@x402/cardano` is published on npm, reference it as a local file dependency pointing at the `x402/` checkout:

```json
{
  "dependencies": {
    "@x402/cardano": "file:../../x402/typescript/packages/mechanisms/cardano",
    "@x402/core":    "file:../../x402/typescript/packages/core"
  }
}
```

**Browser / client side** — implement `ClientCardanoSigner` and register it:

```typescript
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { CARDANO_PREPROD_CAIP2 } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";

// Your CIP-30 wallet adapter (see frontend/src/payment.ts for a full Mesh example)
const signer: ClientCardanoSigner = { ... };

const client = new x402Client();
client.register(CARDANO_PREPROD_CAIP2, new ExactCardanoScheme(signer));
const http = new x402HTTPClient(client);

// x402HTTPClient handles the 402 → sign → retry loop automatically
const response = await http.fetch("http://localhost:8002/premium");
```

**Server side** (Hono):

```typescript
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer } from "@x402/core";
import { HTTPFacilitatorClient } from "@x402/core/http";
import { CARDANO_PREPROD_CAIP2, LOVELACE_ASSET, SCHEME_EXACT } from "@x402/cardano";
import { register as registerExactCardanoServer } from "@x402/cardano/exact/server";

const facilitator = new HTTPFacilitatorClient({ url: "http://localhost:8080" });
const server = new x402ResourceServer(facilitator);
registerExactCardanoServer(server, { networks: [CARDANO_PREPROD_CAIP2] });

app.use(
  "/premium",
  paymentMiddleware(server, {
    "GET /premium": {
      accepts: {
        scheme: SCHEME_EXACT,
        payTo: process.env.DEMO_PAYTO_ADDRESS!,
        price: { amount: "5000000", asset: LOVELACE_ASSET },
        network: CARDANO_PREPROD_CAIP2,
        extra: { assetTransferMethod: "default" },
      },
    },
  })
);
```

---

### Python — `x402` (with Cardano extra)

Install directly from the sibling repo checkout:

```bash
pip install "../../x402/python/x402[cardano,fastapi,httpx]"
```

**FastAPI resource server**:

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from x402 import x402ResourceServer
from x402.http import HTTPFacilitatorClient
from x402.http.middleware.fastapi import PaymentMiddlewareASGI
from x402.mechanisms.cardano import CARDANO_PREPROD_CAIP2, LOVELACE_ASSET, SCHEME_EXACT
from x402.mechanisms.cardano.exact import register_exact_cardano_server
from x402.schemas import FacilitatorConfig

facilitator = HTTPFacilitatorClient(FacilitatorConfig(url="http://localhost:8080"))
server = x402ResourceServer(facilitator)
register_exact_cardano_server(server, networks=[CARDANO_PREPROD_CAIP2])

ROUTES = {
    "GET /premium": {
        "accepts": {
            "scheme": SCHEME_EXACT,
            "payTo": "addr_test1q...",
            "price": {"amount": "5000000", "asset": LOVELACE_ASSET},
            "network": CARDANO_PREPROD_CAIP2,
            "extra": {"assetTransferMethod": "default"},
        },
    }
}

app = FastAPI()
# IMPORTANT: add_middleware stacks in reverse — CORSMiddleware must be added LAST
# so it becomes the outermost layer and adds CORS headers to 402 responses too.
app.add_middleware(PaymentMiddlewareASGI, routes=ROUTES, server=server)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["PAYMENT-RESPONSE", "PAYMENT-REQUIRED"],
)

@app.get("/premium")
def premium():
    return {"secret": "you paid!"}
```

---

## Running services without Docker

### Facilitator

```bash
cd x402-cardano-demo/facilitator
pip install "../../x402/python/x402[cardano,fastapi,httpx]" pycardano
BLOCKFROST_PROJECT_ID_PREPROD=preprodXXX uvicorn main:app --port 8080
```

### Python server

```bash
cd x402-cardano-demo/server-py
pip install "../../x402/python/x402[cardano,fastapi,httpx]"
DEMO_PAYTO_ADDRESS=addr_test1q... FACILITATOR_URL=http://localhost:8080 uvicorn main:app --port 8001
```

### TypeScript server

```bash
cd x402-cardano-demo/server-ts
npm install
DEMO_PAYTO_ADDRESS=addr_test1q... FACILITATOR_URL=http://localhost:8080 node --import tsx/esm src/server.ts
```

### Frontend

```bash
cd x402-cardano-demo/frontend
npm install
VITE_TS_BACKEND=http://localhost:8002 VITE_PY_BACKEND=http://localhost:8001 npm run dev
```

---

## Architecture notes

- **Facilitator** is the trust anchor — it verifies the transaction structure against the x402 `PaymentRequirements` (recipient, amount, asset, network) and submits to Cardano via Blockfrost.
- **Resource servers** never touch the blockchain themselves; they delegate all payment logic to the facilitator via HTTP.
- The browser wallet builds and signs a raw Cardano transaction. The x402 client wraps it in a CBOR-encoded header. No smart contracts or custom tokens — it's a plain lovelace transfer.
- `network_id` is an optional field in Cardano CBOR transactions. Many wallets omit it. The library validates the network via address prefix (`addr_test1...` vs `addr1...`) rather than rejecting absent `network_id` fields.

---

## License

Apache-2.0
