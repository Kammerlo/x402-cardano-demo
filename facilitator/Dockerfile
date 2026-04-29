FROM python:3.11-slim

# Build context  : x402-cardano-demo/
# Named context  : x402  →  ../x402

WORKDIR /app

# pycardano needs build tooling for the cbor2 / cryptography wheels on slim.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libffi-dev libssl-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*

COPY --from=x402 python/x402 /opt/x402
RUN pip install --no-cache-dir "/opt/x402[cardano,fastapi,httpx]"

# cbor2 6.x removed CBORDecodeValueError; cbor2pure (a pycardano dep) needs <6.
RUN pip install --no-cache-dir "cbor2<6.0.0" "pycardano>=0.10.0"

COPY facilitator/main.py /app/main.py
COPY facilitator/blockfrost_signer.py /app/blockfrost_signer.py

EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
