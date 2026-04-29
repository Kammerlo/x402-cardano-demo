"""Standalone x402 Cardano facilitator service.

Exposes the three endpoints expected by an x402 facilitator client:
- POST /verify — runs `ExactCardanoFacilitatorScheme.verify()`.
- POST /settle — runs `ExactCardanoFacilitatorScheme.settle()`.
- GET /supported — reports the supported scheme/network kinds.

Backed by Blockfrost preprod; the project id comes from the
`BLOCKFROST_PROJECT_ID_PREPROD` env var.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from x402.mechanisms.cardano import CARDANO_PREPROD_CAIP2, SCHEME_EXACT
from x402.mechanisms.cardano.exact import ExactCardanoFacilitatorScheme
from x402.schemas import (
    PaymentPayload,
    PaymentRequirements,
    SettleResponse,
    SupportedKind,
    SupportedResponse,
    VerifyResponse,
)

from blockfrost_signer import BlockfrostFacilitatorSigner

PROJECT_ID = os.environ.get("BLOCKFROST_PROJECT_ID_PREPROD", "")
CORS_ORIGIN = os.environ.get("CORS_ORIGIN", "http://localhost:5173")
# `accept_mempool` is True for the demo because Blockfrost only confirms
# mempool inclusion synchronously; the spec strongly discourages this for
# real economic value, hence the loud warning in the README.
ACCEPT_MEMPOOL = os.environ.get("ACCEPT_MEMPOOL", "true").lower() in ("1", "true", "yes")


class VerifyRequestModel(BaseModel):
    """Request body for POST /verify."""

    paymentPayload: dict[str, Any]
    paymentRequirements: dict[str, Any]
    x402Version: int = 2


class SettleRequestModel(BaseModel):
    """Request body for POST /settle."""

    paymentPayload: dict[str, Any]
    paymentRequirements: dict[str, Any]
    x402Version: int = 2


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Wire up the Blockfrost-backed scheme on startup.

    Args:
        app: The FastAPI app whose state we populate.
    """
    signer = BlockfrostFacilitatorSigner(project_id=PROJECT_ID)
    scheme = ExactCardanoFacilitatorScheme(signer, accept_mempool=ACCEPT_MEMPOOL)
    app.state.scheme = scheme
    app.state.signer = signer
    yield


app = FastAPI(title="x402 Cardano facilitator (demo)", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[CORS_ORIGIN, "*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _scheme(app_: FastAPI) -> ExactCardanoFacilitatorScheme:
    """Return the registered scheme or raise a clear startup error.

    Args:
        app_: The FastAPI app holding state.

    Returns:
        The Cardano facilitator scheme.
    """
    scheme = getattr(app_.state, "scheme", None)
    if scheme is None:
        raise HTTPException(
            status_code=503,
            detail="Facilitator is not initialized; check BLOCKFROST_PROJECT_ID_PREPROD",
        )
    return scheme


@app.get("/healthz")
def healthz() -> dict[str, str]:
    """Liveness probe used by docker-compose.

    Returns:
        Static dict so docker-compose `healthcheck:` succeeds.
    """
    return {"status": "ok"}


@app.get("/supported", response_model=SupportedResponse)
def supported() -> SupportedResponse:
    """Report supported scheme/network kinds.

    Returns:
        SupportedResponse limited to `exact` on `cardano:preprod`.
    """
    scheme = _scheme(app)
    return SupportedResponse(
        kinds=[
            SupportedKind(
                x402_version=2,
                scheme=SCHEME_EXACT,
                network=CARDANO_PREPROD_CAIP2,
                extra=scheme.get_extra(CARDANO_PREPROD_CAIP2),
            )
        ],
        extensions=[],
        signers={"cardano:*": scheme.get_signers(CARDANO_PREPROD_CAIP2)},
    )


@app.post("/verify", response_model=VerifyResponse)
def verify(body: VerifyRequestModel) -> VerifyResponse:
    """Verify a payment payload.

    Args:
        body: Raw JSON envelope.

    Returns:
        Standard VerifyResponse.
    """
    scheme = _scheme(app)
    payload = PaymentPayload.model_validate(body.paymentPayload)
    requirements = PaymentRequirements.model_validate(body.paymentRequirements)
    return scheme.verify(payload, requirements)


@app.post("/settle", response_model=SettleResponse)
def settle(body: SettleRequestModel) -> SettleResponse:
    """Settle a payment payload.

    Args:
        body: Raw JSON envelope.

    Returns:
        Standard SettleResponse with the resulting tx hash on success.
    """
    scheme = _scheme(app)
    payload = PaymentPayload.model_validate(body.paymentPayload)
    requirements = PaymentRequirements.model_validate(body.paymentRequirements)
    return scheme.settle(payload, requirements)
