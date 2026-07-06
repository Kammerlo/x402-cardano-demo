import type { FlowStep } from "../x402/flow";

export type StepId = FlowStep["id"];

/** Canonical protocol order — used to size the timeline and to locate the
 * step an in-flight error interrupted (see App.tsx). */
export const STEP_ORDER: StepId[] = ["request", "required", "build", "pay", "settled"];

export interface StepCopy {
  /** Short name for the rail/timeline marker. */
  label: string;
  /** Which actor performs this step — colors the timeline marker. */
  actor: "you" | "seller" | "facilitator" | "chain";
  /** 2-3 sentences: what this step accomplishes in the protocol, and why it exists. */
  why: string;
}

export const STEP_COPY: Record<StepId, StepCopy> = {
  request: {
    label: "The unpaid request",
    actor: "you",
    why: "The client asks for the resource exactly like any HTTP client would — no special headers, no payment attached yet. The server can't demand money before saying what it wants, so it first responds the way HTTP has always let it: with a status code.",
  },
  required: {
    label: "Server names its price",
    actor: "seller",
    why: "402 Payment Required carries a PAYMENT-REQUIRED header: a signed, machine-readable menu of exactly what the seller will accept — scheme, network, amount, and the address to pay. Nothing here is negotiable; the client either meets these terms or doesn't get the resource.",
  },
  build: {
    label: "Wallet builds and signs",
    actor: "you",
    why: "This is the only step your wallet does real work. It picks one of its own UTxOs to spend as an unforgeable nonce — spending it is what proves this exact payment can never be replayed — builds a transaction paying the seller, and asks you to approve the signature. Nothing is broadcast yet.",
  },
  pay: {
    label: "Retried with proof of payment",
    actor: "you",
    why: "The identical GET fires again, this time carrying a PAYMENT-SIGNATURE header with the signed transaction. The seller doesn't verify Cardano signatures itself — it hands the header to a facilitator, a specialist that checks the signature and can broadcast the transaction on its behalf.",
  },
  settled: {
    label: "Confirmed on-chain",
    actor: "facilitator",
    why: "The facilitator submits the transaction to preprod and waits for a block to include it — this is real settlement, not a promise. Once confirmed, the seller's response finally carries the resource, along with a PAYMENT-RESPONSE receipt: the transaction hash your wallet just paid with.",
  },
};
