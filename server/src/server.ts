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
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { ExactCardanoScheme } from "@x402/cardano/exact/server";

const PAY_TO = process.env.SERVER_CARDANO_ADDRESS; // preprod address that receives the 2 tADA
// This demo ships no facilitator of its own — point FACILITATOR_URL at an x402
// facilitator that advertises the `exact` scheme on `cardano:preprod` via its
// GET /supported endpoint. The middleware calls /supported at startup and
// refuses to serve the paid routes if that kind is missing, so a wrong or
// unreachable URL fails fast here rather than mid-payment.
const FACILITATOR_URL = process.env.FACILITATOR_URL;
const PORT = Number(process.env.PORT ?? 4021);
if (!PAY_TO) throw new Error("SERVER_CARDANO_ADDRESS is required (addr_test1...)");
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
const MASUMI_ESCROW_ADDRESS = process.env.MASUMI_ESCROW_ADDRESS ?? PAY_TO;

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

// The resource server delegates verify/settle to the Java facilitator and
// registers the Cardano "exact" scheme for building PaymentRequirements.
// On the first request it calls GET /supported on the facilitator and refuses
// to serve the route if (exact, cardano:preprod) is not advertised.
const resourceServer = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: FACILITATOR_URL }),
).register("cardano:preprod", new ExactCardanoScheme());

app.use(
  paymentMiddleware(
    {
      "GET /api/message": {
        accepts: {
          scheme: "exact",
          network: "cardano:preprod",
          payTo: PAY_TO,
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
          // DUMMY: Masumi purchase identifiers — a real deployment gets these
          // from the Masumi Payment Service for a registered agent purchase;
          // fabricated here for the demo. These exact values are what the
          // facilitator compares the on-chain lock datum against, so they
          // must stay stable constants (not randomized) — the frontend
          // copies them verbatim into the datum it builds.
          extra: {
            assetTransferMethod: "masumi", // real, required
            paymentType: "Web3CardanoV2", // real constant, required by spec; advisory only (facilitator does not check it)
            contractAddress: MASUMI_ESCROW_ADDRESS, // must equal payTo
            sellerAddress: PAY_TO, // real — the seller's own preprod address; MUST be a public-key/non-script address
            referenceKey: "a1b2c3d4", // DUMMY: hex
            referenceSignature: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", // DUMMY: hex, 32 bytes (>=16 required)
            identifierFromPurchaser: "1122334455667788", // DUMMY: hex (maps to datum buyer_nonce)
            sellerNonce: "8877665544332211", // DUMMY: hex
            agentIdentifier: "deadbeefdeadbeefdeadbeefdeadbeef", // DUMMY: hex
            inputHash: "", // DUMMY: optional, empty
            collateralReturnLovelace: "0", // DUMMY: optional, 0
            payByTime: "2000000000000", // DUMMY: POSIX ms
            submitResultTime: "2000000600000", // DUMMY: POSIX ms (>= payByTime)
            unlockTime: "2000001200000", // DUMMY: POSIX ms (>= submitResultTime)
            externalDisputeUnlockTime: "2000001800000", // DUMMY: POSIX ms (>= unlockTime)
          },
        },
        description: "A message unlocked by locking 5 tADA into the (demo) Masumi escrow",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

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
