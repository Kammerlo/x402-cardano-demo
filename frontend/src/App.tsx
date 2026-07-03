// Minimal harness: connect wallet, run flow, dump steps as JSON.
// Task 15 replaces this with the real UI.
import { useState } from "react";
import { createCip30Signer } from "./x402/cip30Signer";
import { runPaymentFlow, type FlowStep } from "./x402/flow";

declare global {
  interface Window {
    cardano?: Record<string, { name?: string; enable(): Promise<unknown> }>;
  }
}

export default function App() {
  const [steps, setSteps] = useState<FlowStep[]>([]);
  const [error, setError] = useState<string>();

  async function payWith(walletKey: string) {
    setSteps([]);
    setError(undefined);
    try {
      const api = await window.cardano![walletKey].enable();
      const signer = await createCip30Signer(api, {
        baseUrl: "https://cardano-preprod.blockfrost.io/api/v0",
        projectId: import.meta.env.VITE_BLOCKFROST_PROJECT_ID,
      });
      await runPaymentFlow(
        import.meta.env.VITE_SERVER_URL ?? "http://localhost:4021",
        signer,
        (step) => setSteps((prev) => [...prev, step]),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const wallets = Object.keys(window.cardano ?? {}).filter((k) => window.cardano![k]?.enable);

  return (
    <main>
      <h1>x402 on Cardano (preprod)</h1>
      {wallets.map((w) => (
        <button key={w} onClick={() => payWith(w)}>
          Pay 2 tADA via {w}
        </button>
      ))}
      {wallets.length === 0 && <p>No CIP-30 wallet found — install Eternl or Lace and enable preprod.</p>}
      {error && <pre style={{ color: "red" }}>{error}</pre>}
      {steps.map((s, i) => (
        <details key={i} open>
          <summary>
            {i + 1}. {s.title}
          </summary>
          <pre>{JSON.stringify(s.detail, null, 2)}</pre>
        </details>
      ))}
    </main>
  );
}
