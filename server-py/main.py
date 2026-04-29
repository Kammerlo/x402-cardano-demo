"""Demo Python resource server — uses x402.mechanisms.cardano end-to-end.

The whole HTTP-protocol flow (the 402 challenge, PAYMENT-SIGNATURE header
parsing, /verify + /settle dispatch, PAYMENT-RESPONSE encoding) is handled
by the library: `x402.http.middleware.fastapi.PaymentMiddlewareASGI` wraps
an `x402ResourceServer` configured with the Cardano server scheme and an
HTTP-backed facilitator client. The endpoint code below is intentionally
minimal — that's the point of the demo.
"""

from __future__ import annotations

import os

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

# ---------------------------------------------------------------------------
# Demo configuration (env-driven so docker-compose can override)
# ---------------------------------------------------------------------------

PAY_TO = os.environ.get("DEMO_PAYTO_ADDRESS", "")
FACILITATOR_URL = os.environ.get("FACILITATOR_URL", "http://facilitator:8080").rstrip("/")
CORS_ORIGIN = os.environ.get("CORS_ORIGIN", "http://localhost:5173")
NETWORK = os.environ.get("X402_NETWORK", CARDANO_PREPROD_CAIP2)

if not PAY_TO:
    raise RuntimeError("DEMO_PAYTO_ADDRESS is not set")

SECRET = "x402-cardano-demo: thanks for paying 5 tADA. The eagle has landed."

# ---------------------------------------------------------------------------
# Wire up the library — one HTTP-backed FacilitatorClient + one
# x402ResourceServer + the Cardano server scheme.
# ---------------------------------------------------------------------------

facilitator = HTTPFacilitatorClient(FacilitatorConfig(url=FACILITATOR_URL))
server = x402ResourceServer(facilitator)
register_exact_cardano_server(server, networks=[NETWORK])

# Routes the middleware will protect. The library accepts a Cardano-shaped
# `accepts` block here; it builds the spec PaymentRequired envelope itself.
ROUTES = {
    "GET /premium": {
        "accepts": {
            "scheme": SCHEME_EXACT,
            "payTo": PAY_TO,
            "price": {
                "amount": "5000000",  # 5 tADA in lovelace
                "asset": LOVELACE_ASSET,
            },
            "network": NETWORK,
            "extra": {"assetTransferMethod": "default"},
        },
        "description": "Cardano demo premium endpoint (5 tADA)",
        "mimeType": "application/json",
    }
}

app = FastAPI(title="x402 Cardano demo (python server)")
# In Starlette, add_middleware stacks in reverse insertion order: the last
# call added becomes the outermost layer (first to see requests). CORS must
# be outermost so its headers appear on every response — including 402s —
# before the browser evaluates them. PaymentMiddlewareASGI is added first so
# it runs inside CORS.
app.add_middleware(PaymentMiddlewareASGI, routes=ROUTES, server=server)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[CORS_ORIGIN, "*"],
    allow_credentials=False,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["PAYMENT-RESPONSE", "PAYMENT-REQUIRED"],
)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    """Liveness probe used by docker-compose's healthcheck.

    Returns:
        Static dict so docker-compose `healthcheck:` succeeds.
    """
    return {"status": "ok"}


@app.get("/premium")
def premium() -> dict[str, str]:
    """Demo premium endpoint.

    The x402 middleware fronts this handler: by the time we get here, the
    request has already been verified and settled by the library. We just
    return the secret.

    Returns:
        The unlocked resource payload.
    """
    return {"secret": SECRET}
