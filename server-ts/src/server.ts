// Demo TypeScript resource server — uses @x402/cardano + @x402/hono.
//
// The 402 challenge, PAYMENT-SIGNATURE header decoding, /verify and
// /settle dispatch, and PAYMENT-RESPONSE encoding are all owned by the
// library's `paymentMiddleware`. The endpoint handler below is the
// minimum a developer would write in a real app — that's the point of
// the demo.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";

import {
  HTTPFacilitatorClient,
  x402ResourceServer,
  type RoutesConfig,
} from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { paymentMiddleware } from "@x402/hono";
import {
  CARDANO_PREPROD_CAIP2,
  LOVELACE_ASSET,
  SCHEME_EXACT,
} from "@x402/cardano";
import { ExactCardanoScheme as ExactCardanoServerScheme } from "@x402/cardano/exact/server";

// ---------------------------------------------------------------------------
// Demo configuration (env-driven so docker-compose can override)
// ---------------------------------------------------------------------------

const PAY_TO = process.env.DEMO_PAYTO_ADDRESS ?? "";
const FACILITATOR_URL = (process.env.FACILITATOR_URL ?? "http://facilitator:8080").replace(
  /\/$/,
  "",
);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173";
const PORT = parseInt(process.env.PORT ?? "8002", 10);
const NETWORK: Network = (process.env.X402_NETWORK ?? CARDANO_PREPROD_CAIP2) as Network;

const SECRET = "x402-cardano-demo: thanks for paying 5 tADA. The eagle has landed.";

if (!PAY_TO) {
  console.error("DEMO_PAYTO_ADDRESS is not set; refusing to start");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Wire up the library — one HTTP-backed FacilitatorClient + one
// x402ResourceServer + the Cardano server scheme.
// ---------------------------------------------------------------------------

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const server = new x402ResourceServer(facilitator);
server.register(NETWORK, new ExactCardanoServerScheme());

const routes: RoutesConfig = {
  "GET /premium": {
    accepts: {
      scheme: SCHEME_EXACT,
      payTo: PAY_TO,
      price: { amount: "5000000", asset: LOVELACE_ASSET },
      network: NETWORK,
      extra: { assetTransferMethod: "default" },
    },
    description: "Cardano demo premium endpoint (5 tADA)",
    mimeType: "application/json",
  },
};

const app = new Hono();

app.use(
  "*",
  cors({
    origin: [CORS_ORIGIN, "*"],
    allowHeaders: ["Content-Type", "PAYMENT-SIGNATURE"],
    exposeHeaders: ["PAYMENT-RESPONSE", "PAYMENT-REQUIRED"],
    allowMethods: ["GET", "OPTIONS"],
  }),
);

// Mount the library's payment middleware. It owns the 402 challenge,
// header decoding, verify+settle dispatch through `server`, and
// PAYMENT-RESPONSE encoding.
//
// The `as never` cast works around a TypeScript-only quirk: @x402/hono
// ships bundled `.d.ts` that reference the workspace's `hono` package
// directly. When the demo installs its own `hono` (same version,
// different node_modules path), structural type identity fails. Runtime
// is identical; only the type-checker sees two copies. In a published-
// package setting (npm dedupes hono) this cast is unnecessary.
app.use("*", paymentMiddleware(routes, server) as never);

app.get("/healthz", c => c.json({ status: "ok" }));

app.get("/premium", c => c.json({ secret: SECRET }));

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, info => {
  console.log(`x402 Cardano demo (TS server) listening on http://0.0.0.0:${info.port}`);
  console.log(`  facilitator: ${FACILITATOR_URL}`);
  console.log(`  payTo: ${PAY_TO}`);
  console.log(`  cors: ${CORS_ORIGIN}`);
});
