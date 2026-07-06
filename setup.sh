#!/usr/bin/env bash
# Builds the sibling x402 TypeScript workspace so this demo's npm `file:` links
# resolve to compiled packages. Run once before `npm install` in server/ or frontend/.
set -euo pipefail
X402_TS="$(cd "$(dirname "$0")/../x402/typescript" && pwd)"
echo "Building x402 TypeScript workspace at $X402_TS"
cd "$X402_TS"
pnpm install
# Build only the packages this demo consumes (+ their deps), NOT the whole
# workspace: the upstream `site` docs package has a pre-existing build failure
# that is unrelated to the demo and would abort a full `pnpm build`.
npx turbo run build \
  --filter=@x402/core \
  --filter=@x402/cardano \
  --filter=@x402/express \
  --filter=@x402/fetch
echo "Done. Packages with dist/:"
ls -d packages/core/dist packages/http/express/dist packages/http/fetch/dist packages/mechanisms/cardano/dist
