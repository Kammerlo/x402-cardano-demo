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

export type FlowStep =
  | { id: "request"; title: string; detail: { url: string; status: number } }
  | { id: "required"; title: string; detail: unknown } // decoded PaymentRequired
  | { id: "build"; title: string; detail: { nonce: string; transactionBase64: string } }
  | { id: "pay"; title: string; detail: unknown } // full PaymentPayload sent
  | { id: "settled"; title: string; detail: unknown }; // decoded SettleResponse + body

export async function runPaymentFlow(
  serverUrl: string,
  signer: ClientCardanoSigner,
  onStep: (step: FlowStep) => void,
): Promise<void> {
  const url = `${serverUrl}/api/message`;

  // 1. Plain request -> expect 402 + PAYMENT-REQUIRED header.
  const first = await fetch(url);
  onStep({ id: "request", title: "GET /api/message without payment", detail: { url, status: first.status } });
  if (first.status !== 402) throw new Error(`Expected 402, got ${first.status}`);
  const requiredHeader = first.headers.get("PAYMENT-REQUIRED");
  if (!requiredHeader) throw new Error("402 without PAYMENT-REQUIRED header (check server CORS exposedHeaders)");
  const paymentRequired = decodePaymentRequiredHeader(requiredHeader);
  onStep({ id: "required", title: "Server describes the price (decoded PAYMENT-REQUIRED)", detail: paymentRequired });

  // 2. Pick the cardano:preprod exact option and build+sign the payment tx.
  const accepted = paymentRequired.accepts.find(
    (a: { scheme: string; network: string }) => a.scheme === "exact" && a.network === "cardano:preprod",
  );
  if (!accepted) throw new Error("Server offered no exact/cardano:preprod option");
  const scheme = new ExactCardanoScheme(signer);
  const result = await scheme.createPaymentPayload(2, accepted);
  onStep({
    id: "build",
    title: "Wallet built and signed the payment transaction",
    detail: {
      nonce: (result.payload as { nonce: string }).nonce,
      transactionBase64: (result.payload as { transaction: string }).transaction,
    },
  });

  // 3. Retry with the PAYMENT-SIGNATURE header (base64 JSON PaymentPayload).
  const paymentPayload = {
    x402Version: 2,
    resource: paymentRequired.resource,
    accepted,
    payload: result.payload,
  };
  onStep({ id: "pay", title: "Retrying with PAYMENT-SIGNATURE (facilitator verifies, then settles on-chain)", detail: paymentPayload });
  const paid = await fetch(url, {
    headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(paymentPayload) },
  });
  if (paid.status !== 200) {
    throw new Error(`Payment failed: HTTP ${paid.status} — ${await paid.text()}`);
  }

  // 4. Read the settlement receipt + the paid-for resource.
  const responseHeader = paid.headers.get("PAYMENT-RESPONSE");
  const settle = responseHeader ? decodePaymentResponseHeader(responseHeader) : null;
  onStep({ id: "settled", title: "Paid! Settlement receipt + resource", detail: { settle, body: await paid.json() } });
}
