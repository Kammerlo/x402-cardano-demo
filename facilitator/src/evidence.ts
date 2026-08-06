/**
 * Mempool-aware settlement evidence.
 *
 * WHY. In client submission mode the facilitator does not broadcast — it
 * authenticates evidence that the ledger accepted the transaction the wallet
 * already sent. `@x402/cardano`'s Blockfrost evidence path reads only
 * `/txs/{hash}`, and says so plainly: "Blockfrost exposes no mempool read, so an
 * unconfirmed transaction is indistinguishable from an unknown one." That makes
 * `mempool` evidence unreachable, so `/verify` cannot pass until a block lands
 * — and the payer's browser has to sit through a full block (~20s on preprod)
 * before it can even retry. Worse, `confirmationPolicy.l1Confirmations: -1`
 * becomes unusable no matter what the operator opts into, because the evidence
 * it asks for can never be produced.
 *
 * Blockfrost does expose `/mempool/{hash}`. This wraps the signer's evidence
 * hook to consult it, which is what makes `-1` mean something and drops the
 * client's wait from a block to propagation time.
 *
 * WHAT MEMPOOL EVIDENCE IS WORTH. A node holds a transaction in its mempool
 * only after the transaction passed validation, so this is genuine evidence
 * that it exists and is spendable — not merely that someone claimed to send it.
 * It is still weaker than block inclusion: a mempool transaction can be dropped
 * or reordered away. That is exactly why the spec ranks it at `-1` and why this
 * facilitator refuses to settle on it unless its operator sets
 * `ACCEPT_MEMPOOL=true`.
 *
 * WHAT IT IS NOT. Mempool presence says nothing about phase-2 outcome: a
 * script transaction can be accepted, land on-chain invalid, consume only its
 * collateral and create none of its outputs. That hole is already closed
 * upstream — client-submitted payments carrying redeemers are refused outright
 * — so this wrapper does not need to re-solve it, and deliberately does not
 * pretend to.
 */
import { MIN_L1_CONFIRMATIONS, type FacilitatorCardanoSigner } from "@x402/cardano";

/** Guards the hash before it goes into a URL path. */
const TX_HASH = /^[0-9a-f]{64}$/;

const LOOKUP_TIMEOUT_MS = 10_000;

/**
 * Wraps a facilitator signer so unconfirmed transactions report `mempool`
 * rather than `unknown`.
 *
 * @param signer - The signer to strengthen.
 * @param blockfrost - Provider connection used for the mempool lookup.
 * @returns The signer, with a mempool-aware evidence hook when it had one.
 */
export function withMempoolEvidence<T extends FacilitatorCardanoSigner>(
  signer: T,
  blockfrost: { baseUrl: string; projectId: string },
): T {
  const base = signer.getTransactionEvidence?.bind(signer);
  // No evidence hook means no client submission and no depth measurement;
  // there is nothing to strengthen, and inventing one here would be a lie.
  if (!base) return signer;

  const baseUrl = blockfrost.baseUrl.replace(/\/$/, "");

  return {
    ...signer,
    async getTransactionEvidence(txHash: string, network: string) {
      const onChain = await base(txHash, network);
      // Block inclusion is strictly stronger than mempool presence, and it is
      // the only answer that carries a real confirmation count.
      if (onChain.status !== "unknown") return onChain;
      if (!TX_HASH.test(txHash)) return onChain;

      try {
        const response = await fetch(`${baseUrl}/mempool/${txHash}`, {
          headers: { project_id: blockfrost.projectId },
          signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
        });
        // 404 is a real answer: not in this node's mempool. Any other failure
        // is a provider fault, and reporting absence for it would let an
        // outage read as "this payment does not exist".
        if (!response.ok) return onChain;
      } catch {
        return onChain;
      }
      return { status: "mempool" as const, confirmations: MIN_L1_CONFIRMATIONS };
    },
  };
}
