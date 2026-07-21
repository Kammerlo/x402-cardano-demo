/**
 * Failure logging for the facilitator hand-off.
 *
 * WHY THIS EXISTS: `@x402/express`'s paymentMiddleware collapses every payment
 * failure — a facilitator `/verify` rejection, a `/settle` failure, even a
 * transport error — into a bare `HTTP 402` with an empty `{}` body. The
 * facilitator's actual reason (`invalidReason` / `errorReason`, e.g.
 * `invalid_exact_cardano_payload_nonce_not_on_chain`) never reaches the client
 * and is otherwise never printed. Wrapping the FacilitatorClient is the one
 * place we can see it, because every verify/settle call flows through here.
 *
 * The wrapper is transparent: it logs and re-returns/re-throws, changing no
 * behaviour.
 */
import type { FacilitatorClient } from "@x402/core/server";

// Derive the payload/response types from the interface itself rather than
// importing them by path — keeps this correct if upstream moves the types.
type VerifyArgs = Parameters<FacilitatorClient["verify"]>;
type VerifyResult = Awaited<ReturnType<FacilitatorClient["verify"]>>;
type SettleArgs = Parameters<FacilitatorClient["settle"]>;
type SettleResult = Awaited<ReturnType<FacilitatorClient["settle"]>>;
type SupportedResult = Awaited<ReturnType<FacilitatorClient["getSupported"]>>;

/** The bits of the payment worth seeing in a log line, without the huge tx blob. */
function summarize(paymentPayload: VerifyArgs[0], paymentRequirements: VerifyArgs[1]) {
  const req = paymentRequirements as Record<string, unknown>;
  const extra = (req.extra ?? {}) as Record<string, unknown>;
  const payload = (paymentPayload as Record<string, unknown>).payload as
    | Record<string, unknown>
    | undefined;
  const transaction = typeof payload?.transaction === "string" ? payload.transaction : undefined;

  return {
    scheme: req.scheme,
    network: req.network,
    amount: req.amount,
    asset: req.asset,
    payTo: req.payTo,
    assetTransferMethod: extra.assetTransferMethod ?? "default",
    // The nonce is the replay guard — the single most useful field when a
    // verify fails (`..._nonce_not_on_chain` means this UTxO is already spent).
    nonce: payload?.nonce,
    // Length only: the signed tx is a multi-KB base64 blob.
    txBase64Length: transaction?.length,
  };
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const chain: string[] = [];
  for (let e: unknown = err; e instanceof Error; e = (e as { cause?: unknown }).cause) {
    chain.push(e.message);
  }
  return chain.join(" | ");
}

/**
 * Wraps a FacilitatorClient so every verify/settle/getSupported call and its
 * outcome is logged. Failures are logged at `error` with the facilitator's own
 * reason codes; successes at `log`.
 */
export class LoggingFacilitatorClient implements FacilitatorClient {
  constructor(
    private readonly inner: FacilitatorClient,
    private readonly url: string,
  ) {}

  async getSupported(): Promise<SupportedResult> {
    try {
      const res = await this.inner.getSupported();
      const kinds = (res as { kinds?: unknown[] }).kinds ?? [];
      console.log(`[facilitator] GET ${this.url}/supported → ${kinds.length} kind(s):`, kinds);
      return res;
    } catch (err) {
      console.error(
        `[facilitator] GET ${this.url}/supported FAILED — the server cannot start its paid ` +
          `routes without this. Is the facilitator running and reachable?\n  ${describeError(err)}`,
      );
      throw err;
    }
  }

  async verify(...args: VerifyArgs): Promise<VerifyResult> {
    const ctx = summarize(args[0], args[1]);
    try {
      const res = await this.inner.verify(...args);
      if (res.isValid) {
        console.log(`[facilitator] verify OK — payer=${res.payer ?? "?"}`, ctx);
      } else {
        // THIS is the reason behind a client-visible `HTTP 402 {}`.
        console.error(
          `[facilitator] verify REJECTED — reason=${res.invalidReason ?? "(none given)"}` +
            (res.invalidMessage ? `\n  message: ${res.invalidMessage}` : ""),
          { ...ctx, payer: res.payer },
        );
      }
      return res;
    } catch (err) {
      console.error(
        `[facilitator] verify ERROR (could not reach/parse facilitator at ${this.url})\n  ` +
          describeError(err),
        ctx,
      );
      throw err;
    }
  }

  async settle(...args: SettleArgs): Promise<SettleResult> {
    const ctx = summarize(args[0], args[1]);
    try {
      const res = await this.inner.settle(...args);
      if (res.success) {
        console.log(
          `[facilitator] settle OK — tx=${res.transaction} status=${
            (res.extra as { status?: string } | undefined)?.status ?? "?"
          }`,
          ctx,
        );
      } else {
        // Settle failures also surface to the client as a bare 402.
        console.error(
          `[facilitator] settle FAILED — reason=${res.errorReason ?? "(none given)"}` +
            (res.errorMessage ? `\n  message: ${res.errorMessage}` : "") +
            (res.transaction ? `\n  tx: ${res.transaction}` : ""),
          { ...ctx, payer: res.payer },
        );
      }
      return res;
    } catch (err) {
      console.error(
        `[facilitator] settle ERROR (could not reach/parse facilitator at ${this.url})\n  ` +
          describeError(err),
        ctx,
      );
      throw err;
    }
  }
}
