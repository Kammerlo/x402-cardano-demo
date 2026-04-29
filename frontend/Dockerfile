FROM node:20-alpine

# Build context  : x402-cardano-demo/ (this repo)
# Named context  : x402  →  ../x402  (Kammerlo/x402 fork, library source)
# Plain COPY pulls from the demo context; COPY --from=x402 pulls from the library.

WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@10.7.0 --activate

# Pull the workspace metadata + packages from the library repo.
COPY --from=x402 typescript/package.json typescript/pnpm-workspace.yaml typescript/pnpm-lock.yaml typescript/tsconfig.base.json /workspace/x402/typescript/
COPY --from=x402 typescript/packages /workspace/x402/typescript/packages

WORKDIR /workspace/x402/typescript
RUN pnpm install --no-frozen-lockfile --ignore-scripts \
    --filter @x402/core --filter @x402/cardano

RUN pnpm --filter @x402/core build
RUN pnpm --filter @x402/cardano build

# Install the frontend. The file: references in package.json resolve to
# /workspace/x402/typescript/packages/... built above.
COPY frontend /workspace/x402-cardano-demo/frontend
WORKDIR /workspace/x402-cardano-demo/frontend
RUN npm install --no-audit --no-fund --no-package-lock

EXPOSE 5173
CMD ["npm", "run", "dev"]
