# Getting Started — From Zero to Paying 5 tADA

A guided walkthrough that takes you from an empty machine to a successful payment in the demo UI. Plan on **20–30 minutes** the first time (most of it waiting for the Cardano preprod faucet).

For library-level docs see [`docs/`](./docs/). For non-Docker dev see [`docs/running-without-docker.md`](./docs/running-without-docker.md). For error explanations see [`docs/troubleshooting.md`](./docs/troubleshooting.md).

---

## 1 · Install Docker

You need **Docker Engine 23+** / **Docker Desktop 4.19+** with `docker compose` v2.17+ (BuildKit `additional_contexts` is required). Verify:

```bash
docker --version
docker compose version
```

You do **not** need Node, pnpm, Python, Java, or Maven — Docker builds every library inside its container.

---

## 2 · Get a Cardano preprod wallet + tADA

Install **Eternl** (<https://eternl.io>) or **Lace** (<https://lace.io>) as a browser extension.

Switch the wallet to **preprod**:

| Wallet | Path |
|--------|------|
| Eternl | Settings ⚙ → Network → **Preprod testnet** |
| Lace | Settings → Network → **Preprod** |

Create a fresh testnet wallet, copy your `addr_test1...` address, and request tADA from the [Cardano Testnet Faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/) (pick "Preprod Testnet"). Funds arrive in ~60 s. You need at least **6 tADA**.

---

## 3 · Get a Blockfrost preprod project ID

1. Sign up at <https://blockfrost.io>
2. Click **+ Add Project** → Network: **Cardano Preprod** → save
3. Copy the project ID (`preprodAbc123...`)

---

## 4 · Clone both repos as siblings

```bash
mkdir -p ~/projects && cd ~/projects
git clone https://github.com/cardano-foundation/x402.git
git clone https://github.com/Kammerlo/x402-cardano-demo.git
```

---

## 5 · Configure

```bash
cd ~/projects/x402-cardano-demo
cp .env.example .env
```

Edit `.env`:

```dotenv
BLOCKFROST_PROJECT_ID_PREPROD=preprodAbc123...    # from step 3
DEMO_PAYTO_ADDRESS=addr_test1qx...                # from step 2
```

---

## 6 · Start

```bash
docker compose --env-file .env up --build
```

First build takes 3–5 minutes. When healthy you'll see:

```text
facilitator-1   |  Uvicorn running on http://0.0.0.0:8080
server-py-1     |  Uvicorn running on http://0.0.0.0:8001
server-ts-1     |  x402 Cardano demo (TS server) listening on http://0.0.0.0:8002
server-java-1   |  Tomcat started on port 8003 (http)
server-go-1     |  x402 Cardano demo (Go server) listening on http://0.0.0.0:8004
frontend-1      |  Local: http://localhost:5173/
```

---

## 7 · Make a payment

Open <http://localhost:5173>:

1. **Choose Backend** — TypeScript / Python / Java / Go (all behave identically)
2. **Connect Wallet** — pick your CIP-30 wallet, approve the prompt
3. **Probe `/premium`** — should return a 402 with the spec's `accepts[]` block
4. **Pay 5 tADA** — wallet pops up to sign; on success the demo shows the unlocked secret and the on-chain tx hash
5. **Replay test** (optional) — re-sending the same `PAYMENT-SIGNATURE` hits the facilitator's idempotency cache and is rejected

Switch backends in step 1 to verify all four runtimes produce byte-identical wire traffic. That's the point of the demo.

---

## Stopping

`Ctrl + C` in the compose terminal stops containers. `docker compose down` removes them.

---

## Hitting an error?

See [`docs/troubleshooting.md`](./docs/troubleshooting.md) — covers `Failed to fetch`, `chain_lookup_failed`, `nonce_not_on_chain`, port conflicts, and the most common wallet / Blockfrost misconfigurations.
