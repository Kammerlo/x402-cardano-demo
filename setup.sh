#!/usr/bin/env bash
# Builds the sibling x402 TypeScript workspace so this demo's npm `file:` links
# resolve to compiled packages. Run once before `npm install` in server/ or frontend/.
set -euo pipefail
X402_TS="$(cd "$(dirname "$0")/../x402/typescript" && pwd)"
echo "Building x402 TypeScript workspace at $X402_TS"
cd "$X402_TS"
pnpm install
pnpm build
echo "Done. Packages with dist/:"
ls -d packages/core/dist packages/http/express/dist packages/http/fetch/dist packages/mechanisms/cardano/dist
