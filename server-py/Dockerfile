FROM python:3.11-slim

# Build context  : x402-cardano-demo/
# Named context  : x402  →  ../x402

WORKDIR /app

COPY --from=x402 python/x402 /opt/x402
RUN pip install --no-cache-dir "/opt/x402[cardano,fastapi,httpx]"

COPY server-py/main.py /app/main.py

EXPOSE 8001
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
