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
import { createPhase1Validator } from "./phase1.js";
import { withMempoolEvidence } from "./evidence.js";

const PORT = Number(process.env.PORT ?? 4022);
// `Network` is x402's CAIP-2-shaped id (`namespace:reference`), not a bare string.
const NETWORK = (process.env.CARDANO_NETWORK ?? "cardano:preprod") as Network;
const BLOCKFROST_PROJECT_ID = process.env.BLOCKFROST_PROJECT_ID;
const BLOCKFROST_BASE_URL =
  process.env.BLOCKFROST_BASE_URL ?? "https://cardano-preprod.blockfrost.io/api/v0";
// A `confirmationPolicy` of -1 means "authenticated mempool acceptance is
// enough". Mempool inclusion can be rolled back, so the facilitator refuses it
// regardless of policy unless its OPERATOR opts in — this is that opt-in.
const ACCEPT_MEMPOOL = process.env.ACCEPT_MEMPOOL === "true";
// How long /settle waits for the payment to reach the requested block depth
// before answering `payment_pending`. Preprod blocks are ~20s, so the default
// covers the full 0..20 range the spec allows with room to spare.
const CONFIRMATION_TIMEOUT_MS = Number(process.env.CONFIRMATION_TIMEOUT_MS ?? 8 * 60_000);

if (!BLOCKFROST_PROJECT_ID) {
  throw new Error(
    "BLOCKFROST_PROJECT_ID is required — the facilitator needs a chain provider to check " +
      "UTxOs, read protocol parameters, and submit transactions. Get a free preprod project " +
      "id at https://blockfrost.io.",
  );
}

// Chain access only: no `mnemonic`, so this runs "provider-only" and
// getAddresses() is empty. awaitConfirmation makes submitTransaction wait for
// real block inclusion rather than returning at mempool acceptance.
//
// The Blockfrost-backed signer also implements getTransactionEvidence(), which
// is what lets this facilitator (a) honour a `confirmationPolicy` above 0 by
// measuring real canonical depth, and (b) advertise CLIENT submission — in that
// mode it never broadcasts, it authenticates the transaction the wallet already
// sent. Without that hook the facilitator would advertise `server` only.
const provider = { blockfrost: { baseUrl: BLOCKFROST_BASE_URL, projectId: BLOCKFROST_PROJECT_ID } };

// The phase-1 validator needs the same chain queries the signer exposes, but it
// has to be passed INTO the signer's config — so a query-only signer is built
// first and lent to it. It broadcasts nothing; only getUtxo/getCurrentSlot are
// used, and reusing them keeps input decoding identical on both paths.
const chainQueries = toFacilitatorCardanoSigner({ network: NETWORK, provider });

// The mempool wrapper is what lets `l1Confirmations: -1` mean anything: the
// stock Blockfrost evidence path reads confirmed transactions only, so an
// unconfirmed payment is reported as unknown and client mode cannot verify
// until a block lands. See ./evidence.ts.
const signer = withMempoolEvidence(
  toFacilitatorCardanoSigner({
    network: NETWORK,
    provider,
    awaitConfirmation: true,
    // Without this the facilitator advertises `client` submission only, and
    // rejects a server-submitted payment rather than broadcasting one it has
    // not proven the ledger will accept. See ./phase1.ts for what it proves.
    validatePhase1Transaction: createPhase1Validator({
      getUtxo: (ref, network) => chainQueries.getUtxo(ref, network),
      getCurrentSlot: network => chainQueries.getCurrentSlot(network),
      blockfrost: provider.blockfrost,
    }),
  }),
  provider.blockfrost,
);

// One scheme on one network. Registering another (e.g. cardano:mainnet, or a
// different scheme) is a second .register() call — the HTTP surface below is
// scheme-agnostic and needs no changes.
const facilitator = new x402Facilitator().register(
  NETWORK,
  new ExactCardanoScheme(signer, {
    acceptMempool: ACCEPT_MEMPOOL,
    confirmationTimeoutMs: CONFIRMATION_TIMEOUT_MS,
    // Demo scale: one disposable process, so the volatile store is the
    // documented fit. Production passes a durable `settlementStore` shared by
    // every worker — replay state has to survive restarts.
    inMemorySettlementStoreMaxEntries: 4096,
  }),
);

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

/**
 * Not part of x402. `confirmationTimeoutMs` is published so a resource server
 * can size its own HTTP timeout above this facilitator's settle budget —
 * a client that gives up first turns a settling payment into an indeterminate
 * failure, which is the worst outcome available.
 */
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    network: NETWORK,
    confirmationTimeoutMs: CONFIRMATION_TIMEOUT_MS,
    acceptMempool: ACCEPT_MEMPOOL,
  });
});

app.listen(PORT, () => {
  console.log(`x402 Cardano facilitator listening on :${PORT}`);
  console.log(`  network:  ${NETWORK}`);
  console.log(`  provider: ${BLOCKFROST_BASE_URL}`);
  console.log(`  mempool:  ${ACCEPT_MEMPOOL ? "accepted (l1Confirmations -1 works)" : "refused (set ACCEPT_MEMPOOL=true to allow -1)"}`);
  console.log(`  wait:     up to ${Math.round(CONFIRMATION_TIMEOUT_MS / 1000)}s for the requested block depth`);
  console.log(`  kinds:    ${JSON.stringify(facilitator.getSupported().kinds)}`);
});
