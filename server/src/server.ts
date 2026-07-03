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
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://localhost:4022";
const PORT = Number(process.env.PORT ?? 4021);
if (!PAY_TO) throw new Error("SERVER_CARDANO_ADDRESS is required (addr_test1...)");

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

app.listen(PORT, () => console.log(`Resource server listening on :${PORT} (facilitator: ${FACILITATOR_URL})`));
