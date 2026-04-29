FROM node:20-alpine

# Build context  : x402-cardano-demo/
# Named context  : x402  →  ../x402

WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@10.7.0 --activate

COPY --from=x402 typescript/package.json typescript/pnpm-workspace.yaml typescript/pnpm-lock.yaml typescript/tsconfig.base.json /workspace/x402/typescript/
COPY --from=x402 typescript/packages /workspace/x402/typescript/packages

WORKDIR /workspace/x402/typescript
RUN pnpm install --no-frozen-lockfile --ignore-scripts \
    --filter @x402/core --filter @x402/cardano \
    --filter @x402/extensions --filter @x402/hono

RUN pnpm --filter @x402/core build
RUN pnpm --filter @x402/extensions build
RUN pnpm --filter @x402/cardano build
RUN pnpm --filter @x402/hono build

COPY server-ts /workspace/x402-cardano-demo/server-ts
WORKDIR /workspace/x402-cardano-demo/server-ts
RUN npm install --no-audit --no-fund --no-package-lock

EXPOSE 8002
CMD ["node", "--import", "tsx/esm", "src/server.ts"]
