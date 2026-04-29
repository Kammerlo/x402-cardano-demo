import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useWallet, useWalletList } from "@meshsdk/react";

import {
  CIP30CardanoSigner,
  createX402Client,
  type PaymentRequirements,
  type WalletLike,
  type x402HTTPClient,
} from "./payment";

const BACKENDS: Record<string, string> = {
  ts: import.meta.env.VITE_TS_BACKEND ?? "http://localhost:8002",
  py: import.meta.env.VITE_PY_BACKEND ?? "http://localhost:8001",
  java: import.meta.env.VITE_JAVA_BACKEND ?? "http://localhost:8003",
  go: import.meta.env.VITE_GO_BACKEND ?? "http://localhost:8004",
};

type StatusKind = "info" | "success" | "error";
type Status = { msg: string; kind: StatusKind } | null;

/**
 * Render a long bech32 address as a short prefix…suffix.
 *
 * @param addr - The bech32 address.
 * @returns Truncated form.
 */
function shortAddr(addr: string): string {
  return `${addr.slice(0, 12)}…${addr.slice(-8)}`;
}

/**
 * Truncate any string for display while keeping the head and tail.
 *
 * @param s - The string to abbreviate.
 * @param head - Characters to keep at the start.
 * @param tail - Characters to keep at the end.
 * @returns Truncated representation, or the original string if short.
 */
function abbreviate(s: string, head = 80, tail = 24): string {
  if (s.length <= head + tail + 8) return s;
  return `${s.slice(0, head)}… (${s.length} bytes total) …${s.slice(-tail)}`;
}

/**
 * Format a list of headers (object) as a transcript block.
 *
 * @param headers - Header name → value map.
 * @returns Indented block of "Name: value" lines.
 */
function formatHeaders(headers: Record<string, string>): string {
  const keys = Object.keys(headers);
  if (keys.length === 0) return "  (none)";
  return keys.map(k => `  ${k}: ${abbreviate(headers[k] ?? "")}`).join("\n");
}

/**
 * Decode the named header on a Response object as base64 JSON.
 *
 * @param response - The Response whose header to read.
 * @param name - Header name (case-insensitive).
 * @returns Parsed JSON value, or null when missing/un-decodable.
 */
function decodeHeaderJson(response: Response, name: string): unknown {
  const v = response.headers.get(name);
  if (!v) return null;
  try {
    return JSON.parse(atob(v));
  } catch {
    return null;
  }
}

/**
 * Pretty-print a JSON value for the transcript.
 *
 * @param value - The value to render.
 * @returns Indented string, or "(empty)" when there is nothing to show.
 */
function pretty(value: unknown): string {
  if (value === null || value === undefined) return "(none)";
  if (typeof value === "string" && value.length === 0) return "(empty string)";
  if (typeof value === "object" && Object.keys(value as object).length === 0) return "{}";
  return JSON.stringify(value, null, 2);
}

function errorMessage(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Read the body of a Response and try to parse it as JSON.
 *
 * @param response - The Response to read.
 * @returns Parsed JSON, or the raw text if not JSON, or null on error.
 */
async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Subset of x402-related headers we want to show in transcripts.
 *
 * @param response - The Response to inspect.
 * @returns A small object with the headers worth printing.
 */
function relevantHeaders(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [
    "content-type",
    "PAYMENT-REQUIRED",
    "PAYMENT-RESPONSE",
    "vary",
    "access-control-expose-headers",
  ]) {
    const v = response.headers.get(name);
    if (v) out[name] = v;
  }
  return out;
}

/**
 * Build a "→ request / ← response" transcript block for display.
 *
 * @param info - Request and response details to include.
 * @returns Plain-text transcript suitable for a <pre>.
 */
function renderTranscript(info: {
  method: string;
  url: string;
  requestHeaders?: Record<string, string>;
  status: number;
  statusText: string;
  responseHeaders?: Record<string, string>;
  paymentRequired?: unknown;
  paymentResponse?: unknown;
  body?: unknown;
  notes?: string[];
}): string {
  const lines: string[] = [];
  lines.push(`→ ${info.method} ${info.url}`);
  lines.push("  Request headers:");
  lines.push(formatHeaders(info.requestHeaders ?? {}));
  lines.push("");
  lines.push(`← HTTP ${info.status} ${info.statusText}`);
  if (info.responseHeaders) {
    lines.push("  Response headers (relevant):");
    lines.push(formatHeaders(info.responseHeaders));
  }
  if (info.paymentRequired !== undefined) {
    lines.push("");
    lines.push("  PAYMENT-REQUIRED (decoded):");
    lines.push(pretty(info.paymentRequired).split("\n").map(l => `  ${l}`).join("\n"));
  }
  if (info.paymentResponse !== undefined) {
    lines.push("");
    lines.push("  PAYMENT-RESPONSE (decoded):");
    lines.push(pretty(info.paymentResponse).split("\n").map(l => `  ${l}`).join("\n"));
  }
  if (info.body !== undefined) {
    lines.push("");
    lines.push("  Body:");
    lines.push(pretty(info.body).split("\n").map(l => `  ${l}`).join("\n"));
  }
  if (info.notes && info.notes.length) {
    lines.push("");
    for (const note of info.notes) lines.push(`# ${note}`);
  }
  return lines.join("\n");
}

// ─── Terminal component ────────────────────────────────────────────────────
interface TerminalProps {
  title?: string;
  content: string;
}

function Terminal({ title = "Wire Transcript", content }: TerminalProps): ReactElement {
  return (
    <div className="terminal">
      <div className="terminal-bar">
        <span className="terminal-dot" />
        <span className="terminal-dot" />
        <span className="terminal-dot" />
        <span className="terminal-title">{title}</span>
      </div>
      <pre className="terminal-body">{content}</pre>
    </div>
  );
}

// ─── Spinner component ─────────────────────────────────────────────────────
function Spinner({ dark = false }: { dark?: boolean }): ReactElement {
  return <span className={`spinner${dark ? " spinner-dark" : ""}`} />;
}

// ─── Protocol diagram ──────────────────────────────────────────────────────
type DiagramPhase = "idle" | "challenge" | "sign" | "submit" | "done";

interface DiagramNode {
  icon: string;
  name: string;
  sub: string;
}

const DIAGRAM_NODES: DiagramNode[] = [
  { icon: "🌐", name: "Browser",     sub: "CIP-30 Wallet"       },
  { icon: "⚡", name: "Server",      sub: "x402 middleware"     },
  { icon: "🔐", name: "Facilitator", sub: "verify · settle"     },
  { icon: "⛓",  name: "Cardano",     sub: "Preprod"             },
];

function ProtocolDiagram({ phase }: { phase: DiagramPhase }): ReactElement {
  // Which nodes are "active" (pulsing) or "done" (green) for each phase
  const nodeActive = (i: number): boolean => {
    if (phase === "sign" && i === 0) return true;
    return false;
  };

  const nodeDone = (i: number): boolean => {
    if (phase === "done") return true;
    if (phase === "submit" && i <= 2) return false;
    return false;
  };

  const allDone = phase === "done";

  return (
    <div className={`protocol-diagram phase-${phase}`}>
      <p className="protocol-diagram-title">x402 Protocol Flow</p>
      <div className="diagram-nodes">
        {DIAGRAM_NODES.map((node, i) => (
          <div key={i} style={{ display: "contents" }}>
            <div
              className={`diagram-node${nodeActive(i) ? " node-active" : ""}${allDone || nodeDone(i) ? " node-done" : ""}`}
            >
              <div className="diagram-node-icon">{node.icon}</div>
              <div className="diagram-node-label">
                <span className="diagram-node-name">{node.name}</span>
                <span className="diagram-node-sub">{node.sub}</span>
              </div>
            </div>
            {i < DIAGRAM_NODES.length - 1 && (
              <div className={`diagram-connector seg-${i}`}>
                <div className="diagram-track diagram-track-fwd">
                  <span className="packet packet-fwd" />
                </div>
                <div className="diagram-track diagram-track-rev">
                  <span className="packet packet-rev" />
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Wallet picker built on MeshJS hooks. Lists installed CIP-30 wallets via
 * `useWalletList`, connects with `useWallet().connect`, and shows a simple
 * disconnect button once a wallet is connected.
 */
function WalletPicker(): ReactElement {
  const { connect, disconnect, connected, connecting, name: walletName } = useWallet();
  const wallets = useWalletList();
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  if (connected) {
    return (
      <div className="wallet-row">
        <span style={{ fontSize: "0.85rem", color: "var(--subtle)" }}>
          Connected: <strong style={{ color: "var(--fg)" }}>{walletName ?? "wallet"}</strong>
        </span>
        <button onClick={disconnect}>Disconnect</button>
      </div>
    );
  }

  return (
    <div ref={dropdownRef} className="wallet-picker-wrap">
      <button onClick={() => setOpen(o => !o)} disabled={connecting}>
        {connecting ? <><Spinner dark />&nbsp;Connecting…</> : "Connect Wallet"}
      </button>
      {open && (
        <div className="wallet-dropdown">
          {wallets.length === 0 ? (
            <div className="wallet-dropdown-empty">No CIP-30 wallets detected.</div>
          ) : wallets.map(w => (
            <button
              key={w.id}
              className="wallet-item"
              onClick={async () => {
                setOpen(false);
                await connect(w.id);
              }}
            >
              <img src={w.icon} alt={w.name} width={22} height={22} style={{ borderRadius: 4 }} />
              {w.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── StatusBar component ──────────────────────────────────────────────────
function StatusBar({ status, explorerLink }: {
  status: Status;
  explorerLink?: { url: string; label: string } | null;
}): ReactElement | null {
  if (!status) return null;
  return (
    <div className={`status-bar ${status.kind}`}>
      <span>{status.msg}</span>
      {explorerLink && (
        <a href={explorerLink.url} target="_blank" rel="noopener noreferrer">
          &nbsp;{explorerLink.label} ↗
        </a>
      )}
    </div>
  );
}

/**
 * The demo page. `<WalletPicker />` (using MeshJS hooks inside the
 * `<MeshProvider>` from main.tsx) handles wallet selection and enable.
 * Once connected, `useWallet()` gives us the wallet object which we
 * wrap in a `CIP30CardanoSigner` adapter for the x402 flow.
 *
 * @returns The page React tree.
 */
export default function App(): ReactElement {
  const { wallet, connected } = useWallet();
  const [backend, setBackend] = useState<"ts" | "py" | "java" | "go">("ts");
  const [signer, setSigner] = useState<CIP30CardanoSigner | null>(null);
  const [signerError, setSignerError] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);

  // Status + output for each step
  const [probeStatus, setProbeStatus] = useState<Status>(null);
  const [probeOutput, setProbeOutput] = useState<string>("");
  const [payStatus, setPayStatus] = useState<Status>(null);
  const [payOutput, setPayOutput] = useState<string>("");
  const [explorerLink, setExplorerLink] = useState<{ url: string; label: string } | null>(null);
  const [replayStatus, setReplayStatus] = useState<Status>(null);
  const [replayOutput, setReplayOutput] = useState<string>("");

  const [busy, setBusy] = useState<{ probe?: boolean; pay?: boolean; replay?: boolean }>({});
  // Holds the secret returned by the premium endpoint after a successful payment.
  const [unlockedSecret, setUnlockedSecret] = useState<string | null>(null);
  // The PAYMENT-SIGNATURE header from the most recent payment, kept for the replay test.
  const lastPaymentHeader = useRef<{ name: string; value: string } | null>(null);

  // Visual step tracker for the pay() flow.
  type FlowStepStatus = "idle" | "active" | "done" | "error";
  type FlowStep = { title: string; detail: string; status: FlowStepStatus };
  const FLOW_INIT: FlowStep[] = [
    { title: "Challenge", detail: "GET /premium → expect 402 + PAYMENT-REQUIRED", status: "idle" },
    { title: "Sign",      detail: "Build & sign Cardano tx via CIP-30 wallet",     status: "idle" },
    { title: "Submit",    detail: "Retry GET /premium with PAYMENT-SIGNATURE",      status: "idle" },
    { title: "Confirmed", detail: "Read PAYMENT-RESPONSE + unlocked body",          status: "idle" },
  ];
  const [flowSteps, setFlowSteps] = useState<FlowStep[]>(FLOW_INIT);
  const setStep = (i: number, patch: Partial<FlowStep>) =>
    setFlowSteps(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s));

  const httpClient: x402HTTPClient | null = useMemo(() => {
    if (!signer) return null;
    return createX402Client(signer);
  }, [signer]);

  const backendUrl = BACKENDS[backend];
  const backendLabel =
    backend === "ts"
      ? "TS server"
      : backend === "py"
      ? "Python server"
      : backend === "java"
      ? "Java server"
      : "Go server";

  // Derive the diagram phase from current flow step states
  const diagramPhase: DiagramPhase = useMemo((): DiagramPhase => {
    const statuses = flowSteps.map(s => s.status);
    if (statuses.every(s => s === "idle")) return "idle";
    if (statuses[3] === "done") return "done";
    if (statuses[2] === "active" || statuses[2] === "done") return "submit";
    if (statuses[1] === "active" || statuses[1] === "done") return "sign";
    return "challenge";
  }, [flowSteps]);

  // When Mesh's <CardanoWallet /> connects, build our signer adapter once.
  useEffect(() => {
    let cancelled = false;
    setSignerError(null);
    if (!connected || !wallet) {
      setSigner(null);
      setWalletAddress(null);
      setUnlockedSecret(null);
      lastPaymentHeader.current = null;
      return;
    }
    (async () => {
      try {
        // `useWallet()` returns Mesh's React-flavored wallet; the
        // structural `WalletLike` cast lets us reuse the same signer that
        // accepts a vanilla `BrowserWallet` from `@meshsdk/core`. Both
        // shapes implement the same CIP-30 surface.
        const s = await CIP30CardanoSigner.create(wallet as unknown as WalletLike);
        if (cancelled) return;
        setSigner(s);
        setWalletAddress(s.getAddress());
      } catch (err) {
        if (cancelled) return;
        setSigner(null);
        setSignerError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connected, wallet]);

  const probe = async (): Promise<void> => {
    setBusy(b => ({ ...b, probe: true }));
    setProbeStatus({ msg: `Probing ${backendLabel} /premium with no header…`, kind: "info" });
    try {
      const url = `${backendUrl}/premium`;
      const response = await fetch(url, { method: "GET" });
      const body = await readBody(response);
      const paymentRequired = decodeHeaderJson(response, "PAYMENT-REQUIRED");
      const transcript = renderTranscript({
        method: "GET",
        url,
        requestHeaders: {},
        status: response.status,
        statusText: response.statusText,
        responseHeaders: relevantHeaders(response),
        paymentRequired: paymentRequired ?? undefined,
        body,
        notes: [
          response.status === 402
            ? "402 + PAYMENT-REQUIRED is the spec challenge — the client now has the recipe to pay."
            : "Non-402 response means the middleware short-circuited or is misconfigured.",
        ],
      });
      setProbeOutput(transcript);
      setProbeStatus({
        msg:
          response.status === 402
            ? `Got the spec 402 challenge from ${backendLabel}.`
            : `Unexpected status ${response.status} from ${backendLabel}.`,
        kind: response.status === 402 ? "success" : "error",
      });
    } catch (err) {
      setProbeStatus({ msg: `Probe failed: ${(err as Error).message}`, kind: "error" });
    } finally {
      setBusy(b => ({ ...b, probe: false }));
    }
  };

  const pay = async (): Promise<void> => {
    if (!httpClient) {
      setPayStatus({ msg: "Connect a wallet first.", kind: "error" });
      return;
    }
    setBusy(b => ({ ...b, pay: true }));
    setExplorerLink(null);
    setUnlockedSecret(null);
    setFlowSteps(FLOW_INIT);
    setPayStatus({ msg: "Running payment flow…", kind: "info" });
    const transcript: string[] = [];
    try {
      const url = `${backendUrl}/premium`;

      // ─── Step ①: Challenge ────────────────────────────────────────────────
      // Hit the endpoint with no auth. The x402 middleware intercepts the
      // request before it reaches the handler and responds with 402 +
      // PAYMENT-REQUIRED header containing the payment recipe (amount, payTo,
      // network, scheme).
      setStep(0, { status: "active", detail: `GET ${url}` });
      const initial = await fetch(url, { method: "GET" });
      if (initial.status !== 402) {
        const txt = await initial.text();
        setStep(0, { status: "error" });
        throw new Error(`Expected 402 from /premium, got ${initial.status}: ${txt}`);
      }
      const initialBody = await readBody(initial);

      // Parse PAYMENT-REQUIRED into a typed PaymentRequired object. The library
      // validates the header structure and throws if it is malformed.
      const paymentRequired = httpClient.getPaymentRequiredResponse(
        name => initial.headers.get(name),
        initialBody,
      );
      // accepts[0] is the scheme+network the server offered.
      const accepted: PaymentRequirements = paymentRequired.accepts[0];
      setStep(0, {
        status: "done",
        detail: `402 — pay ${accepted.amount} lovelace → ${shortAddr(accepted.payTo)} on ${accepted.network}`,
      });
      transcript.push(
        "─── ① challenge ─────────────────────────────────────────",
        renderTranscript({
          method: "GET", url, requestHeaders: {},
          status: initial.status, statusText: initial.statusText,
          responseHeaders: relevantHeaders(initial),
          paymentRequired: decodeHeaderJson(initial, "PAYMENT-REQUIRED") ?? undefined,
          body: initialBody,
        }),
      );

      // ─── Step ②: Sign ────────────────────────────────────────────────────
      // createPaymentPayload selects the matching client scheme (ExactCardano),
      // calls CIP30CardanoSigner.signPaymentTransaction, and returns a PaymentPayload
      // containing the signed tx (base64) and the nonce (first input UTXO ref).
      setStep(1, { status: "active", detail: "Waiting for wallet signature…" });
      const payload = await httpClient.createPaymentPayload(paymentRequired);

      // encodePaymentSignatureHeader serialises the payload into the single
      // PAYMENT-SIGNATURE header the server expects. We capture both key and
      // value so the replay test can re-send the exact same header later.
      const sigHeaders = httpClient.encodePaymentSignatureHeader(payload);
      const sigHeaderName = Object.keys(sigHeaders)[0];
      const sigHeaderValue = sigHeaders[sigHeaderName];
      lastPaymentHeader.current = { name: sigHeaderName, value: sigHeaderValue };

      // payload.payload is Record<string,unknown> (scheme-generic in the library
      // type). At runtime it is ExactCardanoPayload { transaction, nonce }.
      // Use explicit runtime checks instead of a blind cast.
      const inner = payload.payload as Record<string, unknown>;
      const nonce = typeof inner.nonce === "string" ? inner.nonce : "(missing)";
      const txBase64 = typeof inner.transaction === "string" ? inner.transaction : "";
      setStep(1, { status: "done", detail: `nonce: ${nonce}` });
      transcript.push(
        "",
        "─── ② sign via CIP-30 wallet ────────────────────────────",
        "# Mesh built and the wallet signed a Cardano tx.",
        "# CIP30CardanoSigner extracted the first input UTXO ref as the nonce.",
        `nonce (UTXO ref):  ${nonce}`,
        `transaction (base64, abbreviated): ${abbreviate(txBase64)}`,
      );

      // ─── Step ③: Authorised retry ────────────────────────────────────────
      // Re-send the request with the PAYMENT-SIGNATURE header. The middleware
      // validates the signature, calls the facilitator to settle the tx on-chain,
      // and — if everything checks out — forwards the request to the handler.
      setStep(2, { status: "active", detail: `GET ${url} with ${sigHeaderName}` });
      const response = await fetch(url, {
        method: "GET",
        headers: { [sigHeaderName]: sigHeaderValue },
      });
      const body = await readBody(response);
      transcript.push(
        "",
        "─── ③ authorized retry ──────────────────────────────────",
        renderTranscript({
          method: "GET", url,
          requestHeaders: { [sigHeaderName]: sigHeaderValue },
          status: response.status, statusText: response.statusText,
          responseHeaders: relevantHeaders(response),
          paymentRequired: response.status === 402
            ? decodeHeaderJson(response, "PAYMENT-REQUIRED") ?? undefined : undefined,
          paymentResponse: response.status === 200
            ? decodeHeaderJson(response, "PAYMENT-RESPONSE") ?? undefined : undefined,
          body,
        }),
      );

      if (response.status !== 200) {
        setStep(2, { status: "error", detail: `HTTP ${response.status}` });
        setPayOutput(transcript.join("\n"));
        setPayStatus({ msg: `${backendLabel} responded ${response.status}.`, kind: "error" });
        return;
      }
      setStep(2, { status: "done", detail: "200 OK — middleware accepted the payment" });

      // ─── Step ④: Read settle receipt + unlocked body ─────────────────────
      // The 200 response carries a PAYMENT-RESPONSE header with the tx hash
      // that the facilitator submitted on-chain. transaction is a required
      // field on SettleResponse; null only when the header was absent/malformed.
      setStep(3, { status: "active", detail: "Reading PAYMENT-RESPONSE…" });
      let txHash = "";
      try {
        const settle = httpClient.getPaymentSettleResponse(name => response.headers.get(name));
        txHash = settle.transaction;
      } catch {
        // PAYMENT-RESPONSE header missing or malformed — proceed without tx hash.
      }

      // The premium endpoint returns { secret: "..." } as proof the handler ran.
      const secret = (body as { secret?: string } | null)?.secret ?? null;
      const explorer = txHash ? `https://preprod.cardanoscan.io/transaction/${txHash}` : "";
      setStep(3, {
        status: "done",
        detail: txHash ? `tx: ${txHash.slice(0, 16)}…` : "no tx hash in PAYMENT-RESPONSE",
      });
      transcript.push(
        "",
        "─── ✓ unlocked ──────────────────────────────────────────",
        `secret: ${secret ?? "(none)"}`,
        `tx hash: ${txHash || "(none)"}`,
        explorer ? `cardanoscan: ${explorer}` : "",
      );
      setPayOutput(transcript.join("\n"));
      if (secret) setUnlockedSecret(secret);
      setPayStatus({ msg: `${backendLabel} unlocked the resource.`, kind: "success" });
      if (explorer) setExplorerLink({ url: explorer, label: `${txHash.slice(0, 10)}… (Cardanoscan)` });
    } catch (err) {
      setPayStatus({ msg: `Payment failed: ${(err as Error).message}`, kind: "error" });
    } finally {
      setBusy(b => ({ ...b, pay: false }));
    }
  };

  const replay = async (): Promise<void> => {
    if (!lastPaymentHeader.current) {
      setReplayStatus({ msg: "No previous payment to replay yet.", kind: "error" });
      return;
    }
    if (!httpClient) {
      setReplayStatus({ msg: "Connect a wallet first.", kind: "error" });
      return;
    }
    const { name: sigHeaderName, value: sigHeaderValue } = lastPaymentHeader.current;
    setBusy(b => ({ ...b, replay: true }));
    setReplayStatus({ msg: `Replaying the captured ${sigHeaderName} header…`, kind: "info" });
    try {
      const url = `${backendUrl}/premium`;
      // Re-send the exact same PAYMENT-SIGNATURE that was used in the pay() step.
      // The facilitator must reject it: the nonce (UTXO ref) is already spent
      // on-chain, so any replay attempt should return 402 with an error field.
      const response = await fetch(url, {
        method: "GET",
        headers: { [sigHeaderName]: sigHeaderValue },
      });
      const body = await readBody(response);
      setReplayOutput(renderTranscript({
        method: "GET",
        url,
        requestHeaders: { [sigHeaderName]: sigHeaderValue },
        status: response.status,
        statusText: response.statusText,
        responseHeaders: relevantHeaders(response),
        paymentRequired:
          response.status === 402
            ? decodeHeaderJson(response, "PAYMENT-REQUIRED") ?? undefined
            : undefined,
        paymentResponse:
          response.status === 200
            ? decodeHeaderJson(response, "PAYMENT-RESPONSE") ?? undefined
            : undefined,
        body,
      }));

      if (response.status === 200) {
        setReplayStatus({
          msg: "Replay was accepted — this should never happen. Check facilitator logs.",
          kind: "error",
        });
        return;
      }

      // Extract the rejection reason. For 402 responses the middleware echoes
      // a PAYMENT-REQUIRED header with an `error` field explaining why the
      // payment was rejected (spent nonce, duplicate, etc.). For unexpected
      // status codes (e.g. 500), fall back to the raw body error field.
      let reason = `${backendLabel} returned HTTP ${response.status}`;
      if (response.status === 402) {
        try {
          const required = httpClient.getPaymentRequiredResponse(
            name => response.headers.get(name),
            body,
          );
          reason = required.error ?? reason;
        } catch {
          const bodyError = (body as { error?: string } | null)?.error;
          if (bodyError) reason = bodyError;
        }
      } else {
        const bodyError = (body as { error?: string } | null)?.error;
        if (bodyError) reason = bodyError;
      }
      setReplayStatus({ msg: `Replay rejected as expected: ${reason}`, kind: "success" });
    } catch (err) {
      setReplayStatus({ msg: `Replay errored: ${(err as Error).message}`, kind: "error" });
    } finally {
      setBusy(b => ({ ...b, replay: false }));
    }
  };

  // Step descriptions (extra explanatory text per step)
  const STEP_DESCRIPTIONS: string[] = [
    "Browser makes an unauthenticated GET. The x402 middleware responds 402 with a PAYMENT-REQUIRED header containing the payment recipe — amount, recipient, network, and scheme.",
    "The client library builds a Cardano transaction for the exact amount, then asks the CIP-30 wallet to sign it. The first UTXO input ref becomes the replay-proof nonce.",
    "Browser retries the request with a PAYMENT-SIGNATURE header (base64 payload). The middleware asks the Facilitator to verify the signature and submit the tx on-chain.",
    "The Facilitator settles the transaction on Cardano Preprod and returns the on-chain tx hash in a PAYMENT-RESPONSE header. The server forwards the unlocked resource.",
  ];

  const anyStepNotIdle = flowSteps.some(s => s.status !== "idle");

  return (
    <main className="page">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="site-header">
        <div className="brand">
          <span className="brand-badge">x402</span>
          <span className="brand-desc">HTTP-native payments for Cardano</span>
        </div>
        <div className="network-pill">Cardano Preprod</div>
      </header>

      {/* ── Hero ───────────────────────────────────────────────────────────── */}
      <section className="hero">
        <p className="hero-eyebrow">Open Protocol</p>
        <h1 className="hero-title">
          Pay-per-request APIs,<br />no subscriptions needed
        </h1>
        <p className="hero-body">
          x402 extends HTTP with a payment layer. A server responds 402 with a
          payment recipe; the client signs a Cardano transaction and retries.
          No accounts, no API keys — just a wallet and a standard HTTP header.
        </p>
      </section>

      {/* ── Protocol diagram ───────────────────────────────────────────────── */}
      <ProtocolDiagram phase={diagramPhase} />

      {/* ── Setup grid ─────────────────────────────────────────────────────── */}
      <div className="setup-grid">

        {/* Backend selector */}
        <div className="setup-card">
          <div className="setup-card-num">01</div>
          <h3>Choose Backend</h3>
          <p>
            Four servers, one spec — TypeScript with Hono, Python with FastAPI,
            Java with Spring Boot, and Go with net/http. Switch freely; the
            wallet flow is identical.
          </p>
          <div className="backend-toggle">
            <button
              className={`backend-opt${backend === "ts" ? " active" : ""}`}
              onClick={() => setBackend("ts")}
            >
              TypeScript · Hono
            </button>
            <button
              className={`backend-opt${backend === "py" ? " active" : ""}`}
              onClick={() => setBackend("py")}
            >
              Python · FastAPI
            </button>
            <button
              className={`backend-opt${backend === "java" ? " active" : ""}`}
              onClick={() => setBackend("java")}
            >
              Java · Spring Boot
            </button>
            <button
              className={`backend-opt${backend === "go" ? " active" : ""}`}
              onClick={() => setBackend("go")}
            >
              Go · net/http
            </button>
          </div>
        </div>

        {/* Wallet connect */}
        <div className="setup-card">
          <div className="setup-card-num">02</div>
          <h3>Connect Wallet</h3>
          <p>
            Connect a CIP-30 compatible wallet (e.g. Eternl, Lace) running on
            Cardano preprod with at least 5 tADA available.
          </p>
          <WalletPicker />
          {walletAddress && (
            <div className="addr-pill">{shortAddr(walletAddress)}</div>
          )}
          {signerError && (
            <div className="signer-error">{signerError}</div>
          )}
        </div>
      </div>

      {/* ── Probe card ─────────────────────────────────────────────────────── */}
      <details className="probe-card">
        <summary>
          <span className="probe-summary-num">03</span>
          Probe{" "}
          <code>/premium</code>
          {" "}without payment
          <span className="probe-chevron">▼</span>
        </summary>
        <div className="probe-body">
          <p>
            Calls <code>GET /premium</code> with no{" "}
            <code>PAYMENT-SIGNATURE</code> header. The x402 middleware
            intercepts the request and returns{" "}
            <strong style={{ color: "var(--fg-bright)" }}>HTTP 402</strong> with
            a <code>PAYMENT-REQUIRED</code> header — the challenge that tells
            the client exactly what to pay and where.
          </p>
          <div className="probe-row">
            <button onClick={probe} disabled={busy.probe}>
              {busy.probe ? <><Spinner dark />&nbsp;Probing…</> : <>Call GET /premium</>}
            </button>
          </div>
          {probeStatus && <StatusBar status={probeStatus} />}
          {probeOutput && <Terminal title="Probe Response" content={probeOutput} />}
        </div>
      </details>

      {/* ── Pay card ───────────────────────────────────────────────────────── */}
      <div className="pay-card">
        <div className="pay-card-header">
          <div className="pay-card-num">04</div>
          <div>
            <h2>Pay &amp; Access <code>/premium</code></h2>
            <p>
              Runs the complete x402 round-trip automatically — challenge,
              sign, submit, and confirmation — all in a single button press.
            </p>
          </div>
        </div>

        <div className="pay-card-body">
          <button
            className="pay-btn"
            onClick={pay}
            disabled={!httpClient || busy.pay}
          >
            {busy.pay ? <Spinner /> : null}
            Pay 5 tADA &amp; Access
          </button>

          {/* Flow steps — only shown when any step is active/done/error */}
          {anyStepNotIdle && (
            <div className="flow-steps">
              {flowSteps.map((step, i) => (
                <div
                  key={i}
                  className="flow-step"
                  data-status={step.status}
                >
                  <div className="flow-step-left">
                    <div className="flow-step-circle">
                      {step.status === "done"
                        ? "✓"
                        : step.status === "error"
                        ? "✗"
                        : i + 1}
                    </div>
                    {i < 3 && <div className="flow-step-track" />}
                  </div>
                  <div className="flow-step-body">
                    <div className="flow-step-label">{step.title}</div>
                    <div className="flow-step-detail">
                      {step.status === "idle"
                        ? STEP_DESCRIPTIONS[i]
                        : step.detail}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Unlock box */}
          {unlockedSecret && (
            <div className="unlock-box">
              <div className="unlock-icon">🔓</div>
              <div className="unlock-content">
                <div className="unlock-label">Resource Unlocked</div>
                <code className="unlock-secret">{unlockedSecret}</code>
                {explorerLink && (
                  <a
                    className="unlock-link"
                    href={explorerLink.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View on Cardanoscan ↗
                  </a>
                )}
              </div>
            </div>
          )}

          {/* Status bar */}
          {payStatus && payStatus.kind !== "info" && (
            <StatusBar status={payStatus} explorerLink={explorerLink} />
          )}

          {/* Wire transcript */}
          {payOutput && (
            <details className="transcript-details">
              <summary className="transcript-summary">
                ▶ Wire transcript
              </summary>
              <Terminal title="Wire Transcript" content={payOutput} />
            </details>
          )}
        </div>
      </div>

      {/* ── Replay card ────────────────────────────────────────────────────── */}
      <div className="replay-card">
        <div className="replay-card-header">
          <div className="replay-card-num">05</div>
          <div>
            <h2>Replay Test</h2>
            <p>
              Re-issues the captured <code>PAYMENT-SIGNATURE</code> header
              verbatim. The Facilitator must reject it:{" "}
              the nonce (UTXO ref) is already spent on-chain, so this proves
              the protocol is replay-proof. Expected error:{" "}
              <code>invalid_exact_cardano_payload_nonce_not_on_chain</code>.
            </p>
          </div>
        </div>
        <div className="replay-row">
          <button
            onClick={replay}
            disabled={!httpClient || busy.replay || !lastPaymentHeader.current}
          >
            {busy.replay
              ? <><Spinner dark />&nbsp;Replaying…</>
              : "Replay last payment"}
          </button>
        </div>
        {replayStatus && <StatusBar status={replayStatus} />}
        {replayOutput && (
          <details className="transcript-details">
            <summary className="transcript-summary">
              ▶ Wire transcript
            </summary>
            <Terminal title="Replay Response" content={replayOutput} />
          </details>
        )}
      </div>

    </main>
  );
}
