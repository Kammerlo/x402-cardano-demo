# Running services without Docker

For Docker-based development, use the recipe in the [main README](../README.md) — Docker builds every library inside its container, so the host needs nothing beyond Docker itself.

This page covers running each service directly on the host (faster iteration, easier breakpoints).

You'll need the matching toolchain for each service you run:

| Service | Toolchain |
|---------|-----------|
| `frontend` / `server-ts` | Node.js 20+, pnpm (for the library workspace) |
| `server-py` / `facilitator` | Python 3.11+ |
| `server-java` | JDK 17+, Maven 3.9+ |
| `server-go` | Go 1.24+ |

Both repos must be cloned as siblings (see the main README).

---

## Step 1 — Build / install the libraries from `x402/`

This needs to happen once per language stack. Re-run after pulling fresh code in `x402/`.

### TypeScript

```bash
cd ../x402/typescript
pnpm install
pnpm --filter @x402/core         build
pnpm --filter @x402/extensions   build
pnpm --filter @x402/cardano      build
pnpm --filter @x402/hono         build
```

### Python — nothing to build

The Python package is installed directly from source by each service (see below).

### Java

```bash
cd ../x402/java
mvn -DskipTests -Dcheckstyle.skip=true -Dspotbugs.skip=true install
```

### Go — nothing to build separately

The Go server consumes the library directly via `replace` in `server-go/go.mod`. `go run .` from `server-go/` resolves it from the sibling `x402/go/` checkout.

---

## Step 2 — Start the facilitator

```bash
cd x402-cardano-demo/facilitator
pip install "../../x402/python/x402[cardano,fastapi,httpx]" pycardano "cbor2<6.0"
BLOCKFROST_PROJECT_ID_PREPROD=preprodXXX uvicorn main:app --port 8080
```

> The `cbor2<6.0` pin avoids an upstream `pycardano` import error — see [`docs/troubleshooting.md`](./troubleshooting.md).

---

## Step 3 — Start one (or more) resource servers

### Python server

```bash
cd x402-cardano-demo/server-py
pip install "../../x402/python/x402[cardano,fastapi,httpx]"
DEMO_PAYTO_ADDRESS=addr_test1q... \
FACILITATOR_URL=http://localhost:8080 \
uvicorn main:app --port 8001
```

### TypeScript server

```bash
cd x402-cardano-demo/server-ts
npm install
DEMO_PAYTO_ADDRESS=addr_test1q... \
FACILITATOR_URL=http://localhost:8080 \
node --import tsx/esm src/server.ts
```

### Java (Spring Boot) server

```bash
cd x402-cardano-demo/server-java
mvn -DskipTests package
DEMO_PAYTO_ADDRESS=addr_test1q... \
FACILITATOR_URL=http://localhost:8080 \
PORT=8003 \
java -jar target/x402-cardano-demo-server-java-0.1.0.jar
```

### Go server

```bash
cd x402-cardano-demo/server-go
DEMO_PAYTO_ADDRESS=addr_test1q... \
FACILITATOR_URL=http://localhost:8080 \
PORT=8004 \
go run .
```

---

## Step 4 — Start the frontend

```bash
cd x402-cardano-demo/frontend
npm install
VITE_TS_BACKEND=http://localhost:8002 \
VITE_PY_BACKEND=http://localhost:8001 \
VITE_JAVA_BACKEND=http://localhost:8003 \
VITE_GO_BACKEND=http://localhost:8004 \
npm run dev
```

Open <http://localhost:5173>.

---

## Mixing Docker and local

You can run a subset under Docker and the rest on the host. For example, keep the facilitator + Python server in Docker but iterate on the Java server locally:

```bash
docker compose --env-file .env up -d facilitator server-py server-ts frontend
# then run server-java on the host as in Step 3 above
```

Just make sure the host service binds the right port and points its `FACILITATOR_URL` at `http://localhost:8080` (or wherever the dockerised facilitator is exposed).
