# Python — `x402[cardano]` developer guide

How to consume the x402 Cardano scheme from Python — both as a resource server (FastAPI / Flask) and as a facilitator. The Python SDK is the canonical implementation of the facilitator side, so this guide doubles as the reference for anyone running their own facilitator.

Reference services in this demo:

- Resource server: [`server-py/main.py`](../server-py/main.py)
- Facilitator: [`facilitator/main.py`](../facilitator/main.py) + [`facilitator/blockfrost_signer.py`](../facilitator/blockfrost_signer.py)

---

## Install

The Python SDK lives in the sibling [x402 repo](https://github.com/cardano-foundation/x402). Install with the `cardano` extra (and a server framework):

```bash
# FastAPI server
pip install "../../x402/python/x402[cardano,fastapi,httpx]"

# or Flask server
pip install "../../x402/python/x402[cardano,flask,httpx]"
```

`cardano` pulls in `pycardano` for CBOR transaction decoding (facilitator side).

> **Pin `cbor2 < 6.0`** alongside `pycardano`. The 6.x release removed `CBORDecodeValueError`, which `cbor2pure` (a transitive dependency) imports. See [`docs/troubleshooting.md`](./troubleshooting.md).

---

## Concepts in 30 seconds

Same as the TypeScript guide: server issues 402 → browser signs tx → server forwards to facilitator → facilitator verifies + submits → 200 with `PAYMENT-RESPONSE`. The Python SDK provides:

- An ASGI / WSGI **payment middleware** to plug onto a route
- An **`x402ResourceServer`** that owns scheme registration and dispatch to the facilitator
- An **`HTTPFacilitatorClient`** to talk to a remote facilitator
- A pluggable **`ExactCardanoScheme`** for both server-side requirements building and full facilitator verification

---

## Resource server — FastAPI

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from x402 import x402ResourceServer
from x402.http import HTTPFacilitatorClient
from x402.http.middleware.fastapi import PaymentMiddlewareASGI
from x402.mechanisms.cardano import (
    CARDANO_PREPROD_CAIP2,
    LOVELACE_ASSET,
    SCHEME_EXACT,
)
from x402.mechanisms.cardano.exact import register_exact_cardano_server
from x402.schemas import FacilitatorConfig

facilitator = HTTPFacilitatorClient(FacilitatorConfig(url="http://localhost:8080"))
server = x402ResourceServer(facilitator)
register_exact_cardano_server(server, networks=[CARDANO_PREPROD_CAIP2])

ROUTES = {
    "GET /premium": {
        "accepts": {
            "scheme":  SCHEME_EXACT,
            "payTo":   "addr_test1q...",
            "price":   {"amount": "5000000", "asset": LOVELACE_ASSET},
            "network": CARDANO_PREPROD_CAIP2,
            "extra":   {"assetTransferMethod": "default"},
        },
        "description": "Premium endpoint",
        "mimeType":    "application/json",
    }
}

app = FastAPI()

# IMPORTANT: Starlette stacks middleware in REVERSE insertion order — the
# last add_middleware call becomes the outermost layer (first to see the
# request). CORS must be outermost so its headers appear on every response,
# including 402 challenges, before the browser evaluates them.
app.add_middleware(PaymentMiddlewareASGI, routes=ROUTES, server=server)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "*"],
    allow_credentials=False,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["PAYMENT-RESPONSE", "PAYMENT-REQUIRED"],
)

@app.get("/premium")
def premium() -> dict[str, str]:
    # Reaching here means the middleware verified the payment with the facilitator.
    return {"secret": "you paid!"}
```

Run with:

```bash
DEMO_PAYTO_ADDRESS=addr_test1q... \
FACILITATOR_URL=http://localhost:8080 \
uvicorn main:app --host 0.0.0.0 --port 8001
```

### The CORS gotcha

Starlette's `add_middleware` stacks **in reverse**: the **last** call added is the **outermost** layer. If you add `CORSMiddleware` before `PaymentMiddlewareASGI`, the 402 challenge is written by the inner CORS-less layer and the browser blocks the response with a generic "Failed to fetch". Always add CORS last.

---

## Resource server — Flask

```python
from flask import Flask
from x402 import x402ResourceServer
from x402.http import HTTPFacilitatorClient
from x402.http.middleware.flask import PaymentMiddlewareWSGI
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

app = Flask(__name__)
app.wsgi_app = PaymentMiddlewareWSGI(app.wsgi_app, routes=ROUTES, server=server)

@app.get("/premium")
def premium():
    return {"secret": "you paid!"}
```

For Flask CORS use `flask-cors`; same rule — wrap CORS *outside* the payment middleware.

---

## Reading payments + payers

Inside your protected handler the verified payer is exposed in the request scope:

```python
from x402.http import get_x402_request_state

@app.get("/premium")
def premium(request):
    state = get_x402_request_state(request)
    payer = state.verify_response.payer  # bech32 addr_test1...
    return {"secret": "you paid!", "payer": payer}
```

The `PAYMENT-RESPONSE` header is added automatically after the handler returns; clients decode it like:

```python
import base64, json
header = response.headers["PAYMENT-RESPONSE"]
settled = json.loads(base64.b64decode(header))
print(settled["transaction"])                    # on-chain tx hash
print(settled["extensions"]["status"])           # "confirmed" | "mempool"
```

---

## Running a facilitator

The Cardano facilitator is the part that talks to the chain. The reference implementation uses Blockfrost — see [`facilitator/blockfrost_signer.py`](../facilitator/blockfrost_signer.py) for a complete adapter.

Wire it up:

```python
from fastapi import FastAPI
from pydantic import BaseModel
from typing import Any

from x402.mechanisms.cardano.exact import ExactCardanoFacilitatorScheme
from x402.schemas import (
    PaymentPayload, PaymentRequirements,
    SettleResponse, SupportedKind, SupportedResponse, VerifyResponse,
)

# Your own implementation of FacilitatorCardanoSigner — must implement:
#   get_utxo(ref, network)       -> CardanoUtxoSnapshot
#   get_current_slot(network)    -> int
#   submit_transaction(b64, net) -> CardanoSubmissionResult
# and optionally evaluate_transaction(b64, net) for a node-side dry-run.
signer  = BlockfrostFacilitatorSigner(project_id=os.environ["BLOCKFROST_PROJECT_ID_PREPROD"])
scheme  = ExactCardanoFacilitatorScheme(signer, accept_mempool=True)

class VerifyReq(BaseModel):
    paymentPayload:      dict[str, Any]
    paymentRequirements: dict[str, Any]
    x402Version:         int = 2

class SettleReq(VerifyReq): pass

app = FastAPI()

@app.post("/verify", response_model=VerifyResponse)
def verify(body: VerifyReq) -> VerifyResponse:
    payload = PaymentPayload.model_validate(body.paymentPayload)
    reqs    = PaymentRequirements.model_validate(body.paymentRequirements)
    return scheme.verify(payload, reqs)

@app.post("/settle", response_model=SettleResponse)
def settle(body: SettleReq) -> SettleResponse:
    payload = PaymentPayload.model_validate(body.paymentPayload)
    reqs    = PaymentRequirements.model_validate(body.paymentRequirements)
    return scheme.settle(payload, reqs)

@app.get("/supported", response_model=SupportedResponse)
def supported() -> SupportedResponse:
    return SupportedResponse(
        kinds=[
            SupportedKind(
                x402_version=2,
                scheme="exact",
                network=CARDANO_PREPROD_CAIP2,
                extra=scheme.get_extra(CARDANO_PREPROD_CAIP2),
            )
        ],
        extensions=[],
        signers={"cardano:*": scheme.get_signers(CARDANO_PREPROD_CAIP2)},
    )
```

The facilitator scheme implements the **six spec verification rules** — network match, signed tx, TTL/validity, output pays the requirement, nonce ↔ inputs, nonce on chain. You don't need to (and should not) re-implement them.

### `accept_mempool`

`accept_mempool=True` treats Blockfrost's "submitted" status as a successful settlement. Cardano has probabilistic finality, and Blockfrost only confirms mempool inclusion synchronously. For real economic value you want `accept_mempool=False` and a polling layer that watches for chain inclusion.

---

## Errors you may surface to the user

The `invalidReason` / `errorReason` fields use stable codes from `x402.mechanisms.cardano.constants`:

| Code | Meaning |
|------|---------|
| `invalid_exact_cardano_payload` | Header is malformed (not base64 / not JSON / missing fields) |
| `invalid_exact_cardano_payload_unsigned` | Tx has no witnesses |
| `invalid_exact_cardano_payload_network_id_mismatch` | Tx body's `network_id` disagrees with the requirements |
| `invalid_exact_cardano_payload_recipient_mismatch` | No output pays the required `payTo` |
| `invalid_exact_cardano_payload_asset_mismatch` | Recipient output exists but lacks the required asset |
| `invalid_exact_cardano_payload_amount_insufficient` | Recipient + asset matched, but amount < requirement |
| `invalid_exact_cardano_payload_nonce_invalid` | Nonce isn't a valid `txHashHex#index` |
| `invalid_exact_cardano_payload_nonce_not_in_inputs` | Nonce doesn't appear among the tx inputs |
| `invalid_exact_cardano_payload_nonce_not_on_chain` | Nonce UTXO is unknown / already spent |
| `invalid_exact_cardano_payload_ttl_expired` | Tx TTL slot is in the past |
| `exact_cardano_facilitator_chain_lookup_failed` | Facilitator couldn't reach the chain |
| `exact_cardano_settlement_failed` | Submission rejected (insufficient inputs, wrong fees, …) |
| `exact_cardano_settlement_not_confirmed` | Tx accepted to mempool but not confirmed within the window |
| `duplicate_settlement` | Same `PAYMENT-SIGNATURE` was already settled within the cache window |
| `exact_cardano_sdk_missing` | The optional `pycardano` import failed |

---

## Common pitfalls

- **`pycardano` import failure** masquerading as `chain_lookup_failed` — pin `cbor2 < 6.0`.
- **CORS middleware ordering** — must be added **after** the payment middleware so it ends up *outside* it.
- **`assetTransferMethod` is required** — `default`, `masumi`, or `script`. Missing it makes the facilitator reject the requirements with `script_address_mismatch` (default-method fallthrough).
- **Mainnet vs preprod address prefixes** — the facilitator does not validate `network_id` if the tx body omits it (most wallets do). It validates indirectly via the `payTo` prefix (`addr1...` vs `addr_test1...`).
