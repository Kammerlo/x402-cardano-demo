import { useEffect, useRef, useState } from "react";
import { createCip30Signer } from "./x402/cip30Signer";
import { runPaymentFlow, type FlowStep, type PaymentMethod } from "./x402/flow";
import type { ClientCardanoSigner } from "@x402/cardano";
import { listWallets, type WalletInfo } from "./lib/cip30";
import { STEP_COPY, STEP_ORDER, type StepId } from "./lib/stepCopy";
import type { Actor } from "./lib/actors";
import type { RailPhase } from "./components/ActorRail";
import { Hero } from "./components/Hero";
import { ControlPanel, type RunState } from "./components/ControlPanel";
import type { DemoSettlement, FacilitatorOptions } from "./components/SettlementOptions";
import type { WalletConnection } from "./components/WalletPicker";
import { Timeline } from "./components/Timeline";
import { Footer } from "./components/Footer";

const BLOCKFROST_BASE_URL = "https://cardano-preprod.blockfrost.io/api/v0";
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:4021";

export default function App() {
  const [wallets, setWallets] = useState<WalletInfo[]>(() => listWallets());
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connection, setConnection] = useState<WalletConnection | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const signerRef = useRef<ClientCardanoSigner | null>(null);

  const [method, setMethod] = useState<PaymentMethod>("default");
  const [steps, setSteps] = useState<FlowStep[]>([]);
  const [runState, setRunState] = useState<RunState>("idle");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [payStartedAt, setPayStartedAt] = useState<number | null>(null);

  // The two shared policies the 402 advertises. They live on the SERVER (they
  // are `PaymentRequirements.extra` fields), so changing them here PUTs the new
  // value to the demo-config endpoint and the next 402 carries it.
  const [settlement, setSettlement] = useState<DemoSettlement>({
    // Overwritten by the server's own config below. The server derives its
    // default from the facilitator's advertised capabilities, so guessing one
    // here would only be right by luck — `either` just matches the usual answer.
    submissionPolicy: "either",
    preferredMode: "server",
    l1Confirmations: 1,
  });
  // Null until the server answers; the controls offer the full spec matrix
  // until then, and narrow to what this facilitator advertised once it does.
  const [facilitatorOptions, setFacilitatorOptions] = useState<FacilitatorOptions | null>(null);
  const [settlementSyncing, setSettlementSyncing] = useState(false);
  const [settlementError, setSettlementError] = useState<string | null>(null);

  // Adopt whatever the server is already configured with, so the UI starts in
  // sync rather than asserting defaults it never sent.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${SERVER_URL}/demo/config`);
        if (!res.ok) return;
        const cfg = (await res.json()) as {
          submissionPolicy?: string;
          l1Confirmations?: number;
          facilitator?: FacilitatorOptions;
        };
        setSettlement((prev) => ({
          ...prev,
          submissionPolicy: (cfg.submissionPolicy as DemoSettlement["submissionPolicy"]) ?? prev.submissionPolicy,
          l1Confirmations: cfg.l1Confirmations ?? prev.l1Confirmations,
        }));
        if (cfg.facilitator) setFacilitatorOptions(cfg.facilitator);
      } catch {
        // Server not up yet — the picker still works and syncs on first change.
      }
    })();
  }, []);

  async function handleSettlementChange(next: DemoSettlement) {
    const previous = settlement;
    setSettlement(next);
    if (runState !== "idle") handleReset();
    // `preferredMode` is purely a client-side choice; only the two policy
    // fields belong to the server's 402.
    setSettlementSyncing(true);
    setSettlementError(null);
    try {
      const res = await fetch(`${SERVER_URL}/demo/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          submissionPolicy: next.submissionPolicy,
          l1Confirmations: next.l1Confirmations,
        }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        setSettlementError(detail?.error ?? `HTTP ${res.status}`);
        // The 402 still advertises the old pair, so the controls have to as
        // well — showing a setting the server refused would misdescribe the
        // next payment.
        setSettlement(previous);
      }
    } catch (e) {
      setSettlementError(describeError(e));
      setSettlement(previous);
    } finally {
      setSettlementSyncing(false);
    }
  }

  // Some wallet extensions inject into window.cardano a beat after the page
  // script runs; one delayed re-scan catches those without polling forever.
  useEffect(() => {
    const id = window.setTimeout(() => setWallets(listWallets()), 300);
    return () => window.clearTimeout(id);
  }, []);

  async function handleSelectWallet(key: string) {
    setConnecting(key);
    setConnectError(null);
    try {
      const api = await window.cardano![key].enable();
      const networkId = await api.getNetworkId();
      const signer = await createCip30Signer(api, {
        baseUrl: BLOCKFROST_BASE_URL,
        projectId: import.meta.env.VITE_BLOCKFROST_PROJECT_ID,
      });
      signerRef.current = signer;
      setConnection({ key, address: signer.getAddress(), networkId });
    } catch (e) {
      setConnectError(describeError(e));
    } finally {
      setConnecting(null);
    }
  }

  async function handleBegin() {
    const signer = signerRef.current;
    if (!signer) return;
    setSteps([]);
    setErrorMessage(undefined);
    setPayStartedAt(null);
    setRunState("running");
    try {
      await runPaymentFlow(
        SERVER_URL,
        signer,
        (step) => {
          setSteps((prev) => [...prev, step]);
          if (step.id === "pay") setPayStartedAt(Date.now());
        },
        method,
        settlement.preferredMode,
      );
      setRunState("done");
    } catch (e) {
      setErrorMessage(describeError(e));
      setRunState("error");
    }
  }

  function handleReset() {
    setSteps([]);
    setErrorMessage(undefined);
    setPayStartedAt(null);
    setRunState("idle");
  }

  function handleMethodChange(next: PaymentMethod) {
    setMethod(next);
    // A prior run's timeline describes the *other* route (different price,
    // different `extra`) — clear it so Step B doesn't show stale artifacts
    // next to a freshly-picked method.
    if (runState !== "idle") handleReset();
  }

  const errorStepId: StepId | undefined =
    runState === "error" ? STEP_ORDER[Math.min(steps.length, STEP_ORDER.length - 1)] : undefined;

  const { railPhase, errorActor } = computeRailPhase(steps, runState, errorStepId);

  return (
    <div className="page">
      <div className="page__atmosphere" aria-hidden="true" />
      <main className="stage">
        <Hero railPhase={railPhase} errorActor={errorActor} />

        <ControlPanel
          wallets={wallets}
          connecting={connecting}
          connection={connection}
          connectError={connectError}
          onSelectWallet={handleSelectWallet}
          method={method}
          onMethodChange={handleMethodChange}
          runState={runState}
          onBegin={handleBegin}
          onReset={handleReset}
          settlement={settlement}
          onSettlementChange={handleSettlementChange}
          facilitatorOptions={facilitatorOptions}
          settlementSyncing={settlementSyncing}
          settlementError={settlementError}
        />

        {(steps.length > 0 || runState !== "idle") && (
          <Timeline
            steps={steps}
            method={method}
            runState={runState}
            errorStepId={errorStepId}
            errorMessage={errorMessage}
            payStartedAt={payStartedAt}
          />
        )}
      </main>
      <Footer />
    </div>
  );
}

function computeRailPhase(
  steps: FlowStep[],
  runState: RunState,
  errorStepId: StepId | undefined,
): { railPhase: RailPhase; errorActor?: Actor } {
  if (errorStepId) return { railPhase: "idle", errorActor: STEP_COPY[errorStepId].actor };
  const last = steps[steps.length - 1];
  if (!last) return { railPhase: "idle" };
  if (last.id === "pay" && runState === "running") return { railPhase: "waiting" };
  return { railPhase: last.id };
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
