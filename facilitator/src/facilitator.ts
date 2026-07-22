/**
 * x402 facilitator for Cardano — the smallest spec-compatible implementation.
 *
 * The facilitator is the third x402 role: the resource server can't validate a
 * Cardano transaction itself, so it delegates to this service, which
 *   /verify  — decodes the signed transaction and checks it really pays the
 *              seller (and hasn't been replayed), and
 *   /settle  — submits it to the chain and waits for a block to include it.
 *
 * WHY THIS IS SO SHORT: none of the protocol logic lives here. `@x402/cardano`
 * already ships the reference facilitator-role implementation of the `exact`
 * Cardano scheme — all seven verification rules, the nonce/replay guard, the
 * duplicate-settlement cache, and the masumi escrow-lock checks. This file is
 * just the HTTP surface the x402 spec defines (`POST /verify`, `POST /settle`,
 * `GET /supported`) wired to it. Spec compatibility comes from reusing the
 * reference implementation rather than re-deriving it.
 *
 * IT HOLDS NO FUNDS AND SIGNS NOTHING. The client's wallet builds, signs, and
 * pays the fee for the whole transaction; this service only reads chain state
 * (via Blockfrost) and broadcasts. That's why no mnemonic is needed.
 */
import "dotenv/config";
import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import type { Network, PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { toFacilitatorCardanoSigner } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/facilitator";

const PORT = Number(process.env.PORT ?? 4022);
// `Network` is x402's CAIP-2-shaped id (`namespace:reference`), not a bare string.
const NETWORK = (process.env.CARDANO_NETWORK ?? "cardano:preprod") as Network;
const BLOCKFROST_PROJECT_ID = process.env.BLOCKFROST_PROJECT_ID;
const BLOCKFROST_BASE_URL =
  process.env.BLOCKFROST_BASE_URL ?? "https://cardano-preprod.blockfrost.io/api/v0";

if (!BLOCKFROST_PROJECT_ID) {
  throw new Error(
    "BLOCKFROST_PROJECT_ID is required — the facilitator needs a chain provider to check " +
      "UTxOs, read protocol parameters, and submit transactions. Get a free preprod project " +
      "id at https://blockfrost.io.",
  );
}

// Chain access only: no `mnemonic`, so this runs "provider-only" and
// getAddresses() is empty. awaitConfirmation makes /settle wait for real block
// inclusion (status "confirmed") instead of returning at mempool acceptance,
// which the spec strongly recommends before granting access to a resource.
const signer = toFacilitatorCardanoSigner({
  network: NETWORK,
  provider: { blockfrost: { baseUrl: BLOCKFROST_BASE_URL, projectId: BLOCKFROST_PROJECT_ID } },
  awaitConfirmation: true,
});

// One scheme on one network. Registering another (e.g. cardano:mainnet, or a
// different scheme) is a second .register() call — the HTTP surface below is
// scheme-agnostic and needs no changes.
const facilitator = new x402Facilitator().register(NETWORK, new ExactCardanoScheme(signer));

const app = express();
app.use(express.json({ limit: "1mb" })); // signed Cardano txs are multi-KB base64

/**
 * Reads the {paymentPayload, paymentRequirements} body both x402 facilitator
 * endpoints take, returning null (after replying 400) if either is missing.
 *
 * @param req - The Express request.
 * @param res - The Express response, used to send the 400 on bad input.
 * @returns The two payloads, or null when the body was incomplete.
 */
function readPaymentBody(
  req: express.Request,
  res: express.Response,
): { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements } | null {
  const { paymentPayload, paymentRequirements } = (req.body ?? {}) as {
    paymentPayload?: PaymentPayload;
    paymentRequirements?: PaymentRequirements;
  };
  if (!paymentPayload || !paymentRequirements) {
    res.status(400).json({ error: "Missing paymentPayload or paymentRequirements" });
    return null;
  }
  return { paymentPayload, paymentRequirements };
}

/**
 * POST /verify — is this signed transaction a valid payment for these
 * requirements? A *rejected* payment is still HTTP 200 with `isValid: false`
 * and a reason code; 4xx/5xx are reserved for malformed requests and faults.
 */
app.post("/verify", async (req, res) => {
  const body = readPaymentBody(req, res);
  if (!body) return;
  try {
    const response = await facilitator.verify(body.paymentPayload, body.paymentRequirements);
    if (!response.isValid) {
      console.warn(`[verify] rejected — ${response.invalidReason ?? "(no reason)"}`);
    }
    res.json(response);
  } catch (error) {
    console.error("[verify] error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

/**
 * POST /settle — submit the transaction and wait for block inclusion. Same
 * convention: a failed settlement is HTTP 200 with `success: false`.
 */
app.post("/settle", async (req, res) => {
  const body = readPaymentBody(req, res);
  if (!body) return;
  try {
    const response = await facilitator.settle(body.paymentPayload, body.paymentRequirements);
    console.log(
      response.success
        ? `[settle] ok — tx ${response.transaction}`
        : `[settle] failed — ${response.errorReason ?? "(no reason)"}`,
    );
    res.json(response);
  } catch (error) {
    console.error("[settle] error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

/**
 * GET /supported — the (x402Version, scheme, network) kinds this facilitator
 * accepts. Resource servers call this at startup and refuse to advertise a
 * paid route whose kind is missing here.
 */
app.get("/supported", (_req, res) => {
  res.json(facilitator.getSupported());
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", network: NETWORK });
});

app.listen(PORT, () => {
  console.log(`x402 Cardano facilitator listening on :${PORT}`);
  console.log(`  network:  ${NETWORK}`);
  console.log(`  provider: ${BLOCKFROST_BASE_URL}`);
  console.log(`  kinds:    ${JSON.stringify(facilitator.getSupported().kinds)}`);
});
