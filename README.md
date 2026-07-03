# x402 Cardano Demo

An x402 payment-protocol demo on Cardano preprod.

This README is a skeleton for now; the full write-up lands in a later task.
See `docs/superpowers/plans/` and `docs/superpowers/specs/` for the design and implementation plan.

## Consuming the x402 packages

Run `./setup.sh` once to build the sibling `../x402/typescript` workspace, then
consume the packages via npm `file:` links pointing at the built package dirs, e.g.:

```
npm install --save \
  "@x402/core@file:../x402/typescript/packages/core" \
  "@x402/cardano@file:../x402/typescript/packages/mechanisms/cardano" \
  "@x402/express@file:../x402/typescript/packages/http/express" \
  "@x402/fetch@file:../x402/typescript/packages/http/fetch"
```

npm symlinks each `file:` dependency to its source package dir, so it never
processes the packages' internal `workspace:~` specs. Node resolves the transitive
deps (`@x402/core`, `@evolution-sdk/evolution`, `@x402/extensions`) through pnpm's
node_modules inside the monorepo — which is why `./setup.sh` (`pnpm install`) must
run first. The direct `file:` link path works; no tarball fallback is needed.
