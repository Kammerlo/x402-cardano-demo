/**
 * x402 resource server — the "seller".
 *
 * The x402 flow, from this server's point of view:
 *   1. A request to GET /api/message without payment gets HTTP 402 + a
 *      PAYMENT-REQUIRED header describing what to pay (built by the middleware).
 *   2. The client retries with a PAYMENT-SIGNATURE header carrying a signed
 *      Cardano transaction.
 *   3. The middleware sends it to the FACILITATOR's /verify endpoint; when the
 *      payment checks out, our handler runs.
 *   4. After the handler succeeds, the middleware calls the facilitator's
 *      /settle — the facilitator submits the tx to preprod and waits for a
 *      block to include it (~20-60 s).
 *   5. The response goes out with a PAYMENT-RESPONSE header containing the
 *      settlement result (tx hash, status).
 */
import "dotenv/config";
import cors from "cors";
import express from "express";
// NOTE: HTTPFacilitatorClient and x402ResourceServer live under the
// "./server" subpath export of @x402/core, not the package root (the root
// only re-exports x402Version) — confirmed against the built .d.ts files.
import {
  HTTPFacilitatorClient,
  x402ResourceServer,
  type RoutesConfig,
} from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { ExactCardanoScheme } from "@x402/cardano/exact/server";
import {
  issueMasumiRequirements,
  masumiEscrowAddress,
  toMasumiSellerSigner,
  USDM_PREPROD_ASSET,
  type CardanoSubmissionPolicy,
} from "@x402/cardano";
import { LoggingFacilitatorClient } from "./facilitatorLogging.js";

const PAY_TO = process.env.SERVER_CARDANO_ADDRESS; // preprod address that receives the 2 tADA
// This demo ships no facilitator of its own — point FACILITATOR_URL at an x402
// facilitator that advertises the `exact` scheme on `cardano:preprod` via its
// GET /supported endpoint. The middleware calls /supported at startup and
// refuses to serve the paid routes if that kind is missing, so a wrong or
// unreachable URL fails fast here rather than mid-payment.
const FACILITATOR_URL = process.env.FACILITATOR_URL;
const PORT = Number(process.env.PORT ?? 4021);
if (!PAY_TO) throw new Error("SERVER_CARDANO_ADDRESS is required (addr_test1...)");
// Re-bound after the guard: control-flow narrowing does not reach inside
// buildRoutes(), which is called per request rather than inline.
const SELLER_ADDRESS: string = PAY_TO;
if (!FACILITATOR_URL) {
  throw new Error(
    "FACILITATOR_URL is required — point it at an x402 facilitator that supports " +
      "the `exact` scheme on `cardano:preprod` (see README: 'Bring your own facilitator').",
  );
}

// The escrow address is NOT a free choice any more. Under the current spec the
// facilitator applies the deployment parameters to the canonical `vested_pay`
// blueprint, derives the script address itself, and requires `payTo` to equal
// it — a look-alike escrow with different admins is a different trust domain,
// so a stand-in address is rejected outright.
//
// ⚠️  This means the masumi routes lock into the REAL preprod `vested_pay`
// script. Those funds are governed by the Masumi escrow lifecycle (result
// submission, refund, dispute) and are NOT recoverable by simply spending the
// UTxO. Keep the amounts small.
const MASUMI_ESCROW_ADDRESS = masumiEscrowAddress("cardano:preprod");

// The seller signs the Masumi terms (CIP-8 over `termsDigest`), and the escrow
// pays this address, so a real deployment MUST supply its selling wallet. The
// well-known test phrase only keeps the demo self-contained; the key needs no
// funds — it only authorizes the terms.
const MASUMI_SELLER = toMasumiSellerSigner({
  mnemonic:
    process.env.MASUMI_SELLER_MNEMONIC ??
    "test test test test test test test test test test test junk",
  network: "cardano:preprod",
});

// The native token the tUSDM route charges in, as x402 names assets:
// `policyId.assetNameHex`. Defaults to @x402/cardano's preprod tUSDM constant
// (policy e675b46e…, asset name hex of "tUSDM" behind the CIP-68 (333) prefix,
// 6 decimals) so it matches what the library's own Money-price fallback would
// pick. Overridable because more than one tUSDM-named token exists on preprod —
// set USDM_ASSET to whichever one your wallet actually holds.
const USDM_ASSET = process.env.USDM_ASSET ?? USDM_PREPROD_ASSET;

// No `agentIdentifier` is declared: a non-empty one is a Masumi V2 REGISTRY
// CLAIM, and the spec requires it to be validated independently on-chain
// (asset, seller authorization, metadata, endpoint, price). @x402/cardano
// refuses a claim it cannot validate, so a fabricated identifier would now be
// rejected rather than waved through. Omitting it means "unregistered seller",
// which is exactly what this demo is.

// How long the client has to get its lock on-chain. The wallet anchors the
// transaction's validity upper bound to `payByTime`, and rule 7 rejects a TTL
// further ahead than `maxTimeoutSeconds`, so this must not exceed it.
const MAX_TIMEOUT_SECONDS = 600;
const MASUMI_PAY_BY_WINDOW_MS = MAX_TIMEOUT_SECONDS * 1000;

/**
 * Demo knobs the frontend can flip at runtime so every spec feature is
 * reachable from the UI. These are ordinary `PaymentRequirements.extra` fields
 * — the demo just makes them adjustable instead of hard-coding them.
 */
interface DemoConfig {
  /** Who broadcasts: `server` (default), `client`, or `either` (client picks). */
  submissionPolicy: CardanoSubmissionPolicy;
  /**
   * Minimum L1 evidence before the resource is released: `-1` authenticated
   * mempool acceptance, `0` canonical block inclusion, `1..20` that many newer
   * blocks. Defaults to the spec default of 1.
   */
  l1Confirmations: number;
}

const demoConfig: DemoConfig = {
  submissionPolicy: (process.env.SUBMISSION_POLICY as CardanoSubmissionPolicy) ?? "either",
  l1Confirmations: Number(process.env.L1_CONFIRMATIONS ?? 1),
};

/**
 * The shared policy block every route advertises. Both fields live at the top
 * level of `extra` for all three assetTransferMethods, and are bound by exact
 * `accepted` matching — they are not part of the Masumi `termsDigest`.
 *
 * @returns The `submissionPolicy` / `confirmationPolicy` pair.
 */
function policyExtra(): Record<string, unknown> {
  return {
    submissionPolicy: demoConfig.submissionPolicy,
    confirmationPolicy: { l1Confirmations: demoConfig.l1Confirmations },
  };
}

/**
 * Reissue the Masumi requirements once fewer than this many ms remain on the
 * current `payByTime`. See {@link masumiRequirementsFor} for why they cannot
 * simply be regenerated on every request.
 */
const MASUMI_REFRESH_MS = 4 * 60_000;

/** One issued 402 per masumi route, reused until it nears expiry. */
interface IssuedMasumi {
  payByTime: number;
  policy: string;
  requirements: Awaited<ReturnType<typeof issueMasumiRequirements>>;
}
const masumiCache = new Map<string, IssuedMasumi>();

/**
 * A Masumi `PaymentRequirements`, **stable across a payment round-trip**.
 *
 * Two requirements pull against each other:
 *
 * 1. They must not be frozen at startup. `payByTime` is a real deadline and a
 *    boot-time value silently expires while the server keeps running; every
 *    later lock then fails the facilitator's deadline rule.
 * 2. They must be **identical** in the 402 and in the client's retry. The
 *    resource server matches the client's echoed `accepted` against its own
 *    route config, so a regenerated `sellerNonce` or deadline means nothing
 *    matches and the middleware answers 402 *without ever calling the
 *    facilitator* — a silent rejection with no reason logged anywhere. The spec
 *    says the same thing normatively: the issuer MUST store the complete
 *    requirements object and reuse it on the paid retry, and MUST NOT
 *    regenerate the nonce, deadlines, commitment or policies.
 *
 * Reissuing per request satisfies (1) and breaks (2). So each route's object is
 * cached and reissued only as it nears expiry — stable for minutes at a time,
 * far longer than any 402 -> sign -> retry round-trip. A production issuer keys
 * the stored object by the buyer's request instead of caching per route.
 *
 * @param routeKey - Cache key identifying the route.
 * @param asset - The asset unit the route charges in.
 * @param amount - The amount in the asset's smallest unit.
 * @returns The issued requirements.
 */
async function masumiRequirementsFor(
  routeKey: string,
  asset: string,
  amount: string,
): Promise<IssuedMasumi["requirements"]> {
  const policy = JSON.stringify(policyExtra());
  const cached = masumiCache.get(routeKey);
  if (
    cached &&
    cached.policy === policy &&
    cached.payByTime - Date.now() > MASUMI_REFRESH_MS
  ) {
    return cached.requirements;
  }

  const payByTime = Date.now() + MASUMI_PAY_BY_WINDOW_MS;
  // Deadlines must clear the spec's minimum intervals:
  //   pay_by + 5min <= submit_result, +15min <= unlock, +15min <= dispute.
  const requirements = await issueMasumiRequirements({
    network: "cardano:preprod",
    asset,
    amount,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    sellerAddress: MASUMI_SELLER.sellerAddress,
    signTerms: MASUMI_SELLER.signTerms,
    // What the escrow's `input_hash` binds the funds to. A real issuer commits
    // to the buyer's actual request (parameters, body); this demo answers an
    // unauthenticated GET, so it commits to the route it is pricing.
    commitment: [
      {
        name: "parameters",
        canonicalization: "jcs",
        mediaType: "application/json",
        content: { route: routeKey, asset, amount },
      },
    ],
    payByTime: String(payByTime),
    submitResultTime: String(payByTime + 5 * 60_000),
    unlockTime: String(payByTime + 20 * 60_000),
    externalDisputeUnlockTime: String(payByTime + 35 * 60_000),
    // L1 only — this demo drives no Hydra head, and the facilitator refuses a
    // Hydra payment it cannot authenticate against a verified head.
    settlementPolicy: "l1",
    submissionPolicy: demoConfig.submissionPolicy,
    confirmationPolicy: { l1Confirmations: demoConfig.l1Confirmations },
  });

  masumiCache.set(routeKey, { payByTime, policy, requirements });
  return requirements;
}

const app = express();

// CORS: a BROWSER client can only read the x402 headers when we expose them,
// and can only send its payment when PAYMENT-SIGNATURE is allowed.
app.use(
  cors({
    origin: true,
    allowedHeaders: ["Content-Type", "PAYMENT-SIGNATURE", "X-PAYMENT"],
    exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"],
  }),
);

// The resource server delegates verify/settle to the external facilitator and
// registers the Cardano "exact" scheme for building PaymentRequirements.
// On the first request it calls GET /supported on the facilitator and refuses
// to serve the route if (exact, cardano:preprod) is not advertised.
//
// The client wrapper exists purely for diagnostics: paymentMiddleware turns any
// payment failure into a bare `402 {}`, so without it the facilitator's actual
// reason code is invisible. See ./facilitatorLogging.ts.
const resourceServer = new x402ResourceServer(
  new LoggingFacilitatorClient(
    new HTTPFacilitatorClient({ url: FACILITATOR_URL }),
    FACILITATOR_URL,
  ),
).register("cardano:preprod", new ExactCardanoScheme());

// Request-level tracing so a client-visible `402 {}` is explainable from the
// server log alone: this prints whether the request even carried a payment,
// and pairs the response status with the [facilitator] lines logged above it.
app.use((req, res, next) => {
  const paid = Boolean(req.get("PAYMENT-SIGNATURE") ?? req.get("X-PAYMENT"));
  res.on("finish", () => {
    if (!req.path.startsWith("/api/")) return;
    if (res.statusCode === 402 && paid) {
      console.error(
        `[server] ${req.method} ${req.path} → 402 with a payment attached: the facilitator ` +
          `REJECTED it. The reason is in the [facilitator] line logged just above.`,
      );
    } else if (res.statusCode === 402) {
      console.log(`[server] ${req.method} ${req.path} → 402 (no payment yet — this is the normal first request)`);
    } else {
      console.log(`[server] ${req.method} ${req.path} → ${res.statusCode}${paid ? " (paid)" : ""}`);
    }
  });
  next();
});

/**
 * Builds the route payment config.
 *
 * The masumi routes carry a fully issued `PaymentRequirements` — request
 * commitment, seller-signed `terms`, CIP-8 authorization over `termsDigest`
 * and the compatibility identifier — because none of that can be hand-written
 * any more. `payTo` comes from the issuer too: it is DERIVED from the
 * deployment parameters, and the facilitator re-derives it and rejects a
 * mismatch.
 *
 * @returns The routes config for `paymentMiddleware`.
 */
async function buildRoutes(): Promise<RoutesConfig> {
  const masumiAda = await masumiRequirementsFor("masumi-ada", "lovelace", "5000000");
  const masumiToken = await masumiRequirementsFor("masumi-usdm", USDM_ASSET, "250000");

  return {
    "GET /api/message": {
      accepts: {
        scheme: "exact",
        network: "cardano:preprod",
        payTo: SELLER_ADDRESS,
        // 2 tADA in lovelace. Comfortably above the ~1 ADA min-UTxO the
        // facilitator enforces (verification rule 8).
        price: { amount: "2000000", asset: "lovelace" },
        // Cardano blocks are slow vs EVM L2s; give the tx 10 minutes of TTL.
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        extra: { assetTransferMethod: "default", ...policyExtra() },
      },
      description: "A message you can only read after paying 2 tADA",
      mimeType: "application/json",
    },
    "GET /api/message-masumi": {
      accepts: {
        scheme: "exact",
        network: "cardano:preprod",
        // The DERIVED vested_pay address — see MASUMI_ESCROW_ADDRESS.
        payTo: masumiAda.payTo,
        // 5 tADA in lovelace. The escrow output also carries an inline datum,
        // which raises min-UTxO above a plain transfer; 5 tADA stays clear of
        // that floor so the client needs no collateral top-up.
        price: { amount: masumiAda.amount, asset: masumiAda.asset },
        maxTimeoutSeconds: masumiAda.maxTimeoutSeconds,
        extra: masumiAda.extra,
      },
      description: "A message unlocked by locking 5 tADA into the Masumi escrow",
      mimeType: "application/json",
    },
    "GET /api/message-usdm": {
      accepts: {
        scheme: "exact",
        network: "cardano:preprod",
        payTo: SELLER_ADDRESS,
        // Same address-to-address transfer as the first route — the only
        // difference is the asset. x402 names a native token as
        // `policyId.assetNameHex`; tUSDM has 6 decimals, so 100000 = 0.10.
        price: { amount: "100000", asset: USDM_ASSET },
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        extra: { assetTransferMethod: "default", ...policyExtra() },
      },
      description: "A message you can only read after paying 0.10 tUSDM",
      mimeType: "application/json",
    },
    "GET /api/message-masumi-usdm": {
      accepts: {
        scheme: "exact",
        network: "cardano:preprod",
        payTo: masumiToken.payTo,
        // Masumi escrow lock paid in a NATIVE TOKEN rather than ADA. The
        // requested amount is the token; the lovelace on the escrow output is
        // purely structural (post-SubmitResult min-UTxO), and the client
        // computes it as `collateral_return_lovelace` — the seller neither
        // supplies nor signs it.
        price: { amount: masumiToken.amount, asset: masumiToken.asset },
        maxTimeoutSeconds: masumiToken.maxTimeoutSeconds,
        extra: masumiToken.extra,
      },
      description: "A message unlocked by locking 0.25 tUSDM into the Masumi escrow",
      mimeType: "application/json",
    },
  };
}

/**
 * Demo control surface: read and change the policies the 402 advertises, so the
 * whole feature matrix is reachable from the UI instead of a restart. Not part
 * of x402 — a real server fixes these per resource.
 */
app.get("/demo/config", (_req, res) => {
  res.json({
    ...demoConfig,
    escrowAddress: MASUMI_ESCROW_ADDRESS,
    sellerAddress: MASUMI_SELLER.sellerAddress,
  });
});

app.post("/demo/config", express.json(), (req, res) => {
  const { submissionPolicy, l1Confirmations } = (req.body ?? {}) as Partial<DemoConfig>;
  if (submissionPolicy !== undefined) {
    if (!["server", "client", "either"].includes(submissionPolicy)) {
      return res.status(400).json({ error: "submissionPolicy must be server, client or either" });
    }
    demoConfig.submissionPolicy = submissionPolicy;
  }
  if (l1Confirmations !== undefined) {
    if (!Number.isInteger(l1Confirmations) || l1Confirmations < -1 || l1Confirmations > 20) {
      return res.status(400).json({ error: "l1Confirmations must be an integer from -1 to 20" });
    }
    demoConfig.l1Confirmations = l1Confirmations;
  }
  // The advertised requirements just changed, so the memoized middleware and
  // the issued Masumi objects must be rebuilt on the next request.
  cachedMiddleware = null;
  console.log(
    `[server] demo config → submissionPolicy=${demoConfig.submissionPolicy} ` +
      `l1Confirmations=${demoConfig.l1Confirmations}`,
  );
  return res.json(demoConfig);
});

// The middleware is memoized rather than rebuilt per request: paymentMiddleware()
// takes a static routes object and calls initialize() (a GET /supported
// round-trip) once per construction. Memoizing on the issued requirements also
// keeps them byte-identical across a payment's 402 and retry, which is what
// makes the client's echoed `accepted` match.
let cachedMiddleware: {
  routes: RoutesConfig;
  handler: ReturnType<typeof paymentMiddleware>;
} | null = null;

app.use((req, res, next) => {
  void (async () => {
    try {
      const routes = await buildRoutes();
      // Reference equality is enough: buildRoutes() returns the cached issued
      // objects unchanged until they are reissued.
      const unchanged =
        cachedMiddleware &&
        JSON.stringify(cachedMiddleware.routes) === JSON.stringify(routes);
      if (!unchanged) {
        cachedMiddleware = { routes, handler: paymentMiddleware(routes, resourceServer) };
      }
      return cachedMiddleware!.handler(req, res, next);
    } catch (error) {
      return next(error);
    }
  })();
});

// Only reached AFTER the facilitator verified the payment; the middleware
// settles it after we return (status < 400).
app.get("/api/message", (_req, res) => {
  res.json({
    message: "Hello from x402 on Cardano! This response was paid for on preprod.",
    paidAt: new Date().toISOString(),
  });
});

// Only reached AFTER the facilitator verified the masumi escrow lock. Note
// that this is different from /api/message above: a masumi settle means the
// funds were LOCKED into the (demo) escrow, not delivered to the seller.
app.get("/api/message-masumi", (_req, res) => {
  res.json({
    message: "Hello from x402 on Cardano! 5 tADA was locked into the (demo) Masumi escrow to unlock this.",
    paidAt: new Date().toISOString(),
  });
});

// Only reached AFTER the facilitator verified the tUSDM payment. Same
// address-to-address transfer as /api/message — only the asset differs.
app.get("/api/message-usdm", (_req, res) => {
  res.json({
    message: "Hello from x402 on Cardano! This response was paid for with 0.10 tUSDM, a native token.",
    paidAt: new Date().toISOString(),
  });
});

// Only reached AFTER the facilitator verified the tUSDM escrow lock: the
// masumi datum plus a native-token output rather than ADA.
app.get("/api/message-masumi-usdm", (_req, res) => {
  res.json({
    message: "Hello from x402 on Cardano! 0.25 tUSDM was locked into the (demo) Masumi escrow to unlock this.",
    paidAt: new Date().toISOString(),
  });
});

// Every route in buildRoutes() needs a handler here as well: paymentMiddleware
// only gates a route, it does not serve it. A priced route with no handler
// answers 402 while unpaid (the middleware short-circuits) and then 404s the
// moment a payment succeeds — with settlement cancelled, since the middleware
// aborts /settle when the handler responds >= 400.
// The route KEYS are static even though their requirements are issued lazily,
// so this guard needs no Masumi issuance at boot.
const pricedRoutes = [
  "/api/message",
  "/api/message-masumi",
  "/api/message-usdm",
  "/api/message-masumi-usdm",
];
const servedRoutes = new Set(
  (app._router?.stack ?? [])
    .filter((l: { route?: { path?: string } }) => typeof l.route?.path === "string")
    .map((l: { route: { path: string } }) => l.route.path),
);
const unserved = pricedRoutes.filter((p) => !servedRoutes.has(p));
if (unserved.length > 0) {
  throw new Error(
    `Priced route(s) with no request handler: ${unserved.join(", ")}. ` +
      "Add an app.get(...) for each, or paying for one returns 404.",
  );
}

app.listen(PORT, () => console.log(`Resource server listening on :${PORT} (facilitator: ${FACILITATOR_URL})`));
