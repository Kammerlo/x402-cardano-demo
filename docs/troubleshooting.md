# Troubleshooting

Common failure modes when running the demo. If your issue is not covered here, check the relevant container's logs:

```bash
docker compose ps
docker compose logs facilitator   # or server-ts / server-py / server-java / frontend
```

---

## `docker compose` complains about `additional_contexts`

Your Docker is older than 23 / Compose older than v2.17. Update Docker Desktop, or upgrade your Linux Docker Engine + the `compose` plugin.

---

## Browser shows `Probe failed: Failed to fetch`

The selected backend isn't reachable, or its CORS headers are wrong. Check:

```bash
docker compose ps                       # all five containers should be Up
docker compose logs server-java         # or server-ts / server-py
```

If only one backend is broken, look at its logs specifically.

---

## Wallet popup says "wrong network" / payment never arrives

The wallet is on mainnet. Switch it to **preprod**, reload the page, and reconnect.

---

## Payment fails with `chain_lookup_failed`

The facilitator can't reach Blockfrost. Re-check `.env`:

- `BLOCKFROST_PROJECT_ID_PREPROD` is the **preprod** key (not mainnet, not preview)
- The key is not expired or rate-limited (free tier = 50k req/day)

Force-rebuild the facilitator if the error persists:

```bash
docker compose --env-file .env up -d --build --no-deps facilitator
```

---

## Payment fails with `nonce_not_on_chain`

The wallet built the tx using a UTXO that has been spent or doesn't exist on chain yet. Wait ~30 s for the wallet's UTXO list to refresh and try again.

---

## Java server returns `422` from facilitator with "Field required" / "input: null"

The Java JDK `HttpClient` defaults to HTTP/2 with `h2c` upgrade negotiation, which uvicorn doesn't speak — uvicorn drops the request body and FastAPI rejects it with a Pydantic 422.

The library forces HTTP/1.1 in `CardanoFacilitatorClient`, so this should not happen with current code. If you see it, you may have built against an older snapshot of the library; rebuild:

```bash
cd ../x402/java && mvn -DskipTests -Dcheckstyle.skip=true -Dspotbugs.skip=true install
cd -
docker compose --env-file .env up -d --build --no-deps server-java
```

---

## Tx submitted but the demo shows `settlement_not_confirmed`

Cardano has probabilistic finality. The demo defaults to `ACCEPT_MEMPOOL=true` so mempool acceptance is treated as success — if you've turned that off, expect 20–60 seconds before the next block confirms the tx.

---

## Port conflict (`bind: address already in use`)

Something else on your machine owns 5173 / 8001 / 8002 / 8003 / 8080. Either stop it, or override the port mapping in `.env`:

```dotenv
FRONTEND_PORT=5174
SERVER_PY_PORT=9001
SERVER_TS_PORT=9002
SERVER_JAVA_PORT=9003
FACILITATOR_PORT=9080
```

The frontend reads its backend URLs from `VITE_TS_BACKEND` / `VITE_PY_BACKEND` / `VITE_JAVA_BACKEND`, which default to the standard ports — set those too if you change the port mapping.

---

## `pycardano` import error (`cbor2.CBORDecodeValueError`)

`cbor2` 6.x removed `CBORDecodeValueError`, which `cbor2pure` (a `pycardano` dependency) imports. The facilitator Dockerfile pins `cbor2<6.0` to dodge this. If you see this error after pulling new code or running locally, force the pin:

```bash
pip install "cbor2<6.0"      # local-dev fix
# or
docker compose --env-file .env up -d --build --no-deps facilitator
```
