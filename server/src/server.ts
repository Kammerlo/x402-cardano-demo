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
import { MASUMI_PAYMENT_SOURCE_TYPE } from "@x402/cardano";
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

// DUMMY: escrow address. The `masumi` assetTransferMethod locks funds into an
// escrow contract instead of paying the seller directly. A real deployment
// would point this at the actual Masumi `vested_pay` script address for the
// target network (obtained from the Masumi Payment Service). Here we default
// it to our own SERVER_CARDANO_ADDRESS — a plain, RECOVERABLE preprod address
// the operator controls — so the demo can both lock and (manually) reclaim
// the funds. A successful masumi settle therefore means the funds are LOCKED
// in this escrow, NOT delivered to the seller.
const MASUMI_ESCROW_ADDRESS = process.env.MASUMI_ESCROW_ADDRESS ?? SELLER_ADDRESS;

// DUMMY: agent identifier. Masumi's registry defines this as "policy ID + asset
// name" of the on-chain agent NFT, validated as 57-250 characters
// (`agentIdentifier` in masumi-payment-service's registry schema), so it is a
// 56-hex-character policy id concatenated with the asset name in hex — no
// separator. This one is fabricated but structurally valid; a real deployment
// gets it from the Masumi Registry once the agent is minted.
const MASUMI_AGENT_IDENTIFIER =
  "3f2c9a1b7e4d6058c1a9b3f7d2e5648a0c7b1f93e6d4a28c5b0f7e31" + // policy id (56 hex)
  "4d6173756d6944656d6f4167656e74303031"; // asset name: "MasumiDemoAgent001"

// How long the client has to get its lock on-chain. The wallet anchors the
// transaction's validity upper bound to `payByTime`, and the facilitator
// rejects a lock whose TTL could settle after it, so this doubles as the
// transaction's lifetime and must exceed the wallet's signing + submit time.
const MASUMI_PAY_BY_WINDOW_MS = 15 * 60_000;

/**
 * Regenerate the deadlines once fewer than this many ms remain on the current
 * `payByTime`. See {@link masumiDeadlines} for why they cannot simply be
 * recomputed on every request.
 */
const MASUMI_DEADLINE_REFRESH_MS = 5 * 60_000;

let deadlineCache: Record<string, string> | null = null;

/**
 * The four Masumi lock deadlines, **stable across a payment round-trip**.
 *
 * Two requirements pull against each other here:
 *
 * 1. They must not be frozen at startup. Real deadlines come from the Masumi
 *    payment request the seller creates per job, and a boot-time value silently
 *    expires while the server keeps running — every later lock then fails the
 *    facilitator's deadline rule.
 * 2. They must be **identical** in the 402 and in the client's retry. The
 *    resource server matches the client's echoed `accepted` against its own
 *    route config (`objectContainsSubset` over `extra`), so if `payByTime`
 *    changed between the two requests nothing matches and the middleware
 *    answers 402 *without ever calling the facilitator* — a silent rejection
 *    with no reason logged anywhere.
 *
 * Recomputing per request satisfies (1) and breaks (2). So the values are
 * cached and refreshed only once they near expiry: stable for minutes at a
 * time — far longer than any 402 -> sign -> retry round-trip — while never
 * going stale. A production server sidesteps this entirely: the client returns
 * its `blockchainIdentifier` and the server looks the purchase up instead of
 * regenerating anything.
 *
 * Ordering is `payByTime <= submitResultTime <= unlockTime <= externalDisputeUnlockTime`.
 *
 * @returns The four POSIX-millisecond bounds as decimal strings.
 */
function masumiDeadlines(): Record<string, string> {
  const remaining = deadlineCache ? Number(deadlineCache.payByTime) - Date.now() : 0;
  if (!deadlineCache || remaining < MASUMI_DEADLINE_REFRESH_MS) {
    const payByTime = Date.now() + MASUMI_PAY_BY_WINDOW_MS;
    deadlineCache = {
      payByTime: String(payByTime),
      submitResultTime: String(payByTime + 10 * 60_000),
      unlockTime: String(payByTime + 20 * 60_000),
      externalDisputeUnlockTime: String(payByTime + 30 * 60_000),
    };
  }
  return deadlineCache;
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
 * Builds the route payment config. Called **per request** so the masumi
 * deadlines are fresh; `paymentMiddleware` takes a static routes object, so a
 * config built once at startup would freeze `payByTime` at boot and start
 * rejecting locks as soon as that deadline passed.
 *
 * @returns The routes config for `paymentMiddleware`.
 */
function buildRoutes(): RoutesConfig {
  return {
      "GET /api/message": {
        accepts: {
          scheme: "exact",
          network: "cardano:preprod",
          payTo: SELLER_ADDRESS,
          // 2 tADA in lovelace. Comfortably above the ~1 ADA min-UTxO the
          // facilitator enforces (verification rule 7).
          price: { amount: "2000000", asset: "lovelace" },
          // Cardano blocks are slow vs EVM L2s; give the tx 10 minutes of TTL.
          maxTimeoutSeconds: 600,
          extra: { assetTransferMethod: "default" },
        },
        description: "A message you can only read after paying 2 tADA",
        mimeType: "application/json",
      },
      "GET /api/message-masumi": {
        accepts: {
          scheme: "exact",
          network: "cardano:preprod",
          payTo: MASUMI_ESCROW_ADDRESS,
          // 5 tADA in lovelace. Masumi locks ADA into an escrow UTxO that also
          // carries an inline datum, which raises the min-UTxO requirement
          // above a plain address-to-address transfer — 5 tADA stays
          // comfortably clear of that floor.
          price: { amount: "5000000", asset: "lovelace" },
          maxTimeoutSeconds: 600,
          // The server declares only the SELLER-side datum fields. A real
          // deployment gets these from the Masumi payment request it creates
          // per request (POST /payment on its Masumi Payment Service); they are
          // fabricated here for the demo. The facilitator compares the on-chain
          // lock datum against these exact values, so they must stay stable
          // constants (not randomized) — the frontend copies them verbatim.
          //
          // The BUYER-side fields (identifierFromPurchaser -> buyer_nonce,
          // inputHash, buyerReturnAddress) are deliberately absent: this 402
          // answers an unauthenticated request, so the server does not know who
          // is calling and cannot fill them. The wallet supplies them when it
          // builds the datum (frontend/src/x402/cip30Signer.ts, via
          // buildMasumiLockInline() from @x402/cardano).
          extra: {
            assetTransferMethod: "masumi", // real, required
            paymentType: MASUMI_PAYMENT_SOURCE_TYPE, // real constant from the library; advisory only (facilitator does not check it)
            contractAddress: MASUMI_ESCROW_ADDRESS, // must equal payTo
            sellerAddress: SELLER_ADDRESS, // real — the seller's own preprod address; MUST be a public-key/non-script address
            referenceKey: "a1b2c3d4", // DUMMY: hex
            referenceSignature: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", // DUMMY: hex, 32 bytes (>=16 required)
            sellerNonce: "8877665544332211", // DUMMY: hex
            agentIdentifier: MASUMI_AGENT_IDENTIFIER, // DUMMY value, real shape (policy id + asset name)
            collateralReturnLovelace: "0", // DUMMY: optional, 0
            // Refreshed as they near expiry rather than pinned at boot; see
            // masumiDeadlines() for why they cannot change per request.
            ...masumiDeadlines(),
          },
        },
        description: "A message unlocked by locking 5 tADA into the (demo) Masumi escrow",
        mimeType: "application/json",
      },
  };
}

// The middleware is rebuilt only when the masumi deadlines refresh, not per
// request: paymentMiddleware() takes a static routes object and calls
// initialize() (a GET /supported round-trip) once per construction, so building
// one per request would re-fetch that every time. Memoizing on the deadline
// object also keeps the advertised requirements byte-identical across a
// payment's 402 and retry, which is what makes them match.
let cachedMiddleware: {
  deadlines: Record<string, string>;
  handler: ReturnType<typeof paymentMiddleware>;
} | null = null;

app.use((req, res, next) => {
  const deadlines = masumiDeadlines();
  if (!cachedMiddleware || cachedMiddleware.deadlines !== deadlines) {
    cachedMiddleware = { deadlines, handler: paymentMiddleware(buildRoutes(), resourceServer) };
  }
  return cachedMiddleware.handler(req, res, next);
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

app.listen(PORT, () => console.log(`Resource server listening on :${PORT} (facilitator: ${FACILITATOR_URL})`));
