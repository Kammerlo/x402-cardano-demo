/**
 * Drives one x402 payment step by step. Each stage reports a FlowStep so the
 * UI can display the actual protocol artifacts (decoded headers, payloads).
 * The auto-retry alternative is a one-liner: wrapFetchWithPayment(fetch, client).
 */
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import type { ClientCardanoSigner } from "@x402/cardano";
import { pickCardanoRequirements } from "../lib/x402Types";

export type FlowStep =
  | { id: "request"; title: string; detail: { url: string; status: number } }
  | { id: "required"; title: string; detail: unknown } // decoded PaymentRequired
  | {
      id: "build";
      title: string;
      detail: { nonce: string; submissionMode?: string; transactionBase64: string };
    }
  | { id: "pay"; title: string; detail: unknown } // full PaymentPayload sent
  | { id: "settled"; title: string; detail: unknown }; // decoded SettleResponse + body

/** Which route to pay for — purely a config choice, not a protocol detail:
 * both routes speak the exact same x402 handshake below, they just carry a
 * different `accepted.extra.assetTransferMethod` (see the server route
 * definitions), which the signer branches on to build a plain output vs. a
 * masumi escrow-lock datum. */
export type PaymentMethod = "default" | "masumi" | "usdm" | "masumi-usdm";

const METHOD_PATHS: Record<PaymentMethod, string> = {
  default: "/api/message",
  masumi: "/api/message-masumi",
  // Same `default` assetTransferMethod as the first route — the only
  // difference is the asset: a native token (tUSDM) instead of lovelace.
  usdm: "/api/message-usdm",
  // Masumi escrow lock, but priced in a native token instead of ADA.
  "masumi-usdm": "/api/message-masumi-usdm",
};

export async function runPaymentFlow(
  serverUrl: string,
  signer: ClientCardanoSigner,
  onStep: (step: FlowStep) => void,
  method: PaymentMethod = "default",
  preferredSubmissionMode: "server" | "client" = "server",
): Promise<void> {
  const path = METHOD_PATHS[method];
  const url = `${serverUrl}${path}`;

  // 1. Plain request -> expect 402 + PAYMENT-REQUIRED header.
  const first = await fetch(url);
  onStep({ id: "request", title: `GET ${path} without payment`, detail: { url, status: first.status } });
  if (first.status !== 402) throw new Error(`Expected 402, got ${first.status}`);
  const requiredHeader = first.headers.get("PAYMENT-REQUIRED");
  if (!requiredHeader) throw new Error("402 without PAYMENT-REQUIRED header (check server CORS exposedHeaders)");
  const paymentRequired = decodePaymentRequiredHeader(requiredHeader);
  onStep({ id: "required", title: "Server describes the price (decoded PAYMENT-REQUIRED)", detail: paymentRequired });

  // 2. Pick the cardano:preprod exact option and build+sign the payment tx.
  const accepted = pickCardanoRequirements(paymentRequired);
  if (!accepted) throw new Error("Server offered no exact/cardano:preprod option");
  // The second argument only matters when the server's `submissionPolicy` is
  // `either`: the client then picks which side broadcasts. With a policy of
  // `server` or `client` the scheme uses that and ignores the preference.
  const scheme = new ExactCardanoScheme(signer, preferredSubmissionMode);
  const result = await scheme.createPaymentPayload(2, accepted);
  onStep({
    id: "build",
    title: "Wallet built and signed the payment transaction",
    detail: {
      nonce: (result.payload as { nonce: string }).nonce,
      submissionMode: (result.payload as { submissionMode?: string }).submissionMode,
      transactionBase64: (result.payload as { transaction: string }).transaction,
    },
  });

  // 3. Retry with the PAYMENT-SIGNATURE header (base64 JSON PaymentPayload).
  const paymentPayload = {
    x402Version: 2,
    resource: paymentRequired.resource,
    accepted,
    payload: result.payload,
    // Echoes the server's `cardanoReplayProtection` challenge. The server binds
    // it to this request and these requirements, and rejects a paid retry that
    // drops it.
    extensions: paymentRequired.extensions,
  };
  onStep({ id: "pay", title: "Retrying with PAYMENT-SIGNATURE (facilitator verifies, then settles on-chain)", detail: paymentPayload });
  const header = encodePaymentSignatureHeader(paymentPayload);
  const clientSubmitted =
    (result.payload as { submissionMode?: string }).submissionMode === "client";
  const paid = await payWithRetry(url, header, clientSubmitted);
  if (paid.status !== 200) {
    throw new Error(`Payment failed: HTTP ${paid.status} — ${await paid.text()}`);
  }

  // 4. Read the settlement receipt + the paid-for resource.
  // (see payWithRetry below for why step 3 may take several attempts)
  const responseHeader = paid.headers.get("PAYMENT-RESPONSE");
  const settle = responseHeader ? decodePaymentResponseHeader(responseHeader) : null;
  onStep({ id: "settled", title: "Paid! Settlement receipt + resource", detail: { settle, body: await paid.json() } });
}

/** How long a client-submitted payment keeps retrying before giving up. */
const CLIENT_SUBMIT_RETRY_MS = 90_000;
/** Gap between retries — roughly propagation time, well under a block. */
const CLIENT_SUBMIT_RETRY_INTERVAL_MS = 2_000;

/**
 * Sends the paid request, retrying while the facilitator cannot yet see a
 * client-submitted transaction.
 *
 * The client does NOT check the chain itself. It broadcast the transaction
 * through its wallet and handed the server the signed bytes; deciding whether
 * that transaction is really on the network is the facilitator's job, and it
 * holds the provider credentials to answer it. All the client knows is that a
 * 402 came back and it has a payment outstanding, so it asks again.
 *
 * Why the retry lives here rather than in the facilitator: `/verify` performs a
 * single evidence lookup and never polls, because it cannot distinguish "sent a
 * moment ago, still propagating" from "never sent" — polling on every claim
 * would let a fabricated payment hold a facilitator request open for minutes.
 * The party that knows a transaction was broadcast is the one that broadcast
 * it, so the waiting belongs on this side. Confirmation *depth* is a different
 * question and the facilitator does wait for that, during `/settle`.
 *
 * Retrying is safe: a failed verification releases the server's claim on the
 * request and the fresh 402 reuses the same replay challenge while it is valid,
 * so the identical payment can be presented again.
 *
 * @param url - The resource URL.
 * @param header - The encoded PAYMENT-SIGNATURE value.
 * @param clientSubmitted - Whether the wallet already broadcast the payment.
 * @returns The first non-402 response, or the last 402 once time runs out.
 */
async function payWithRetry(
  url: string,
  header: string,
  clientSubmitted: boolean,
): Promise<Response> {
  const deadline = Date.now() + CLIENT_SUBMIT_RETRY_MS;
  for (;;) {
    const response = await fetch(url, { headers: { "PAYMENT-SIGNATURE": header } });
    // Only a client-submitted payment has a reason to succeed later: the
    // facilitator is waiting to see a transaction that is already on its way.
    // In server mode a 402 is a verdict, so retrying would only repeat it.
    if (response.status !== 402 || !clientSubmitted || Date.now() > deadline) return response;
    await new Promise(resolve => setTimeout(resolve, CLIENT_SUBMIT_RETRY_INTERVAL_MS));
  }
}
