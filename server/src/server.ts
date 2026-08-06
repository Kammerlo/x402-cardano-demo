/**
 * x402 resource server — the "seller".
 *
 * The x402 flow, from this server's point of view:
 *   1. A request to GET /api/message without payment gets HTTP 402 + a
 *      PAYMENT-REQUIRED header describing what to pay (built by the middleware).
 *   2. The client retries with a PAYMENT-SIGNATURE header carrying a signed
 *      Cardano transaction.
 *   3. The middleware sends it to the FACILITATOR's /verify endpoint; when the
 *      payment checks out, our handler runs.
 *   4. After the handler succeeds, the middleware calls the facilitator's
 *      /settle — the facilitator submits the tx to preprod and waits for a
 *      block to include it (~20-60 s).
 *   5. The response goes out with a PAYMENT-RESPONSE header containing the
 *      settlement result (tx hash, status).
 */
import "dotenv/config";
import cors from "cors";
import express from "express";
// NOTE: HTTPFacilitatorClient and x402ResourceServer live under the
// "./server" subpath export of @x402/core, not the package root (the root
// only re-exports x402Version) — confirmed against the built .d.ts files.
import {
  HTTPFacilitatorClient,
  x402ResourceServer,
  type RoutesConfig,
} from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { ExactCardanoScheme } from "@x402/cardano/exact/server";
import {
  issueMasumiRequirements,
  masumiEscrowAddress,
  toMasumiSellerSigner,
  USDM_PREPROD_ASSET,
  type CardanoSubmissionPolicy,
} from "@x402/cardano";
import { LoggingFacilitatorClient } from "./facilitatorLogging.js";

const PAY_TO = process.env.SERVER_CARDANO_ADDRESS; // preprod address that receives the 2 tADA
// This demo ships no facilitator of its own — point FACILITATOR_URL at an x402
// facilitator that advertises the `exact` scheme on `cardano:preprod` via its
// GET /supported endpoint. The middleware calls /supported at startup and
// refuses to serve the paid routes if that kind is missing, so a wrong or
// unreachable URL fails fast here rather than mid-payment.
const FACILITATOR_URL = process.env.FACILITATOR_URL;
const PORT = Number(process.env.PORT ?? 4021);
if (!PAY_TO) throw new Error("SERVER_CARDANO_ADDRESS is required (addr_test1...)");
// Re-bound after the guard: control-flow narrowing does not reach inside
// buildRoutes(), which is called per request rather than inline.
const SELLER_ADDRESS: string = PAY_TO;
if (!FACILITATOR_URL) {
  throw new Error(
    "FACILITATOR_URL is required — point it at an x402 facilitator that supports " +
      "the `exact` scheme on `cardano:preprod` (see README: 'Bring your own facilitator').",
  );
}

// The escrow address is NOT a free choice any more. Under the current spec the
// facilitator applies the deployment parameters to the canonical `vested_pay`
// blueprint, derives the script address itself, and requires `payTo` to equal
// it — a look-alike escrow with different admins is a different trust domain,
// so a stand-in address is rejected outright.
//
// ⚠️  This means the masumi routes lock into the REAL preprod `vested_pay`
// script. Those funds are governed by the Masumi escrow lifecycle (result
// submission, refund, dispute) and are NOT recoverable by simply spending the
// UTxO. Keep the amounts small.
const MASUMI_ESCROW_ADDRESS = masumiEscrowAddress("cardano:preprod");

// The seller signs the Masumi terms (CIP-8 over `termsDigest`), and the escrow
// pays this address, so a real deployment MUST supply its selling wallet. The
// well-known test phrase only keeps the demo self-contained; the key needs no
// funds — it only authorizes the terms.
const MASUMI_SELLER = toMasumiSellerSigner({
  mnemonic:
    process.env.MASUMI_SELLER_MNEMONIC ??
    "test test test test test test test test test test test junk",
  network: "cardano:preprod",
});

// The native token the tUSDM route charges in, as x402 names assets:
// `policyId.assetNameHex`. Defaults to @x402/cardano's preprod tUSDM constant
// (policy e675b46e…, asset name hex of "tUSDM" behind the CIP-68 (333) prefix,
// 6 decimals) so it matches what the library's own Money-price fallback would
// pick. Overridable because more than one tUSDM-named token exists on preprod —
// set USDM_ASSET to whichever one your wallet actually holds.
const USDM_ASSET = process.env.USDM_ASSET ?? USDM_PREPROD_ASSET;

// No `agentIdentifier` is declared: a non-empty one is a Masumi V2 REGISTRY
// CLAIM, and the spec requires it to be validated independently on-chain
// (asset, seller authorization, metadata, endpoint, price). @x402/cardano
// refuses a claim it cannot validate, so a fabricated identifier would now be
// rejected rather than waved through. Omitting it means "unregistered seller",
// which is exactly what this demo is.

// How long the client has to get its lock on-chain. The wallet anchors the
// transaction's validity upper bound to `payByTime`, and rule 7 rejects a TTL
// further ahead than `maxTimeoutSeconds`, so this must not exceed it.
const MAX_TIMEOUT_SECONDS = 600;
const MASUMI_PAY_BY_WINDOW_MS = MAX_TIMEOUT_SECONDS * 1000;

/**
 * Demo knobs the frontend can flip at runtime so every spec feature is
 * reachable from the UI. These are ordinary `PaymentRequirements.extra` fields
 * — the demo just makes them adjustable instead of hard-coding them.
 */
interface DemoConfig {
  /** Who broadcasts: `server` (default), `client`, or `either` (client picks). */
  submissionPolicy: CardanoSubmissionPolicy;
  /**
   * Minimum L1 evidence before the resource is released: `-1` authenticated
   * mempool acceptance, `0` canonical block inclusion, `1..20` that many newer
   * blocks. Defaults to the spec default of 1.
   */
  l1Confirmations: number;
}

/**
 * The subset of the spec's settlement matrix THIS facilitator can settle.
 *
 * The two policies are protocol-wide — the spec allows `server`, `client` and
 * `either`, and a confirmation range of −1..20 — but any one facilitator
 * advertises only the part of that it implements, and a facilitator's
 * capabilities change with its configuration: server submission needs a
 * phase-1 ledger validator on the signer, and `-1` needs the operator to have
 * opted into mempool evidence. `@x402/cardano` refuses to serve a 402 outside
 * what was advertised, so the demo reads `/supported` and offers only what is
 * there rather than discovering the mismatch at request time.
 */
interface FacilitatorOptions {
  /** Policies that are servable, in spec-default-first order. */
  submissionPolicies: CardanoSubmissionPolicy[];
  /** Confirmation range per policy; `either` is the intersection of both modes. */
  l1Confirmations: Record<string, { minimum: number; maximum: number }>;
}

/**
 * Reads the facilitator's advertised Cardano capabilities.
 *
 * @returns The settlement options this facilitator can actually honour.
 */
async function fetchFacilitatorOptions(): Promise<FacilitatorOptions> {
  const res = await fetch(`${FACILITATOR_URL}/supported`);
  if (!res.ok) throw new Error(`facilitator GET /supported returned HTTP ${res.status}`);
  const body = (await res.json()) as {
    kinds?: Array<{ scheme?: string; network?: string; extra?: Record<string, unknown> }>;
  };
  const kind = body.kinds?.find((k) => k.scheme === "exact" && k.network === "cardano:preprod");
  if (!kind) throw new Error("facilitator does not advertise `exact` on `cardano:preprod`");

  const full = { minimum: -1, maximum: 20 };
  // A facilitator that publishes no `extra` has told us nothing, so there is
  // nothing to narrow — the same all-or-nothing reading the library applies.
  if (!kind.extra) {
    return {
      submissionPolicies: ["server", "client", "either"],
      l1Confirmations: { server: full, client: full, either: full },
    };
  }

  const modes = Array.isArray(kind.extra.submissionModes)
    ? (kind.extra.submissionModes as unknown[]).map(String)
    : [];
  const advertised = (kind.extra.l1Confirmations ?? {}) as Record<string, unknown>;
  const rangeFor = (mode: string): { minimum: number; maximum: number } | null => {
    if (!modes.includes(mode)) return null;
    const range = advertised[mode] as { minimum?: unknown; maximum?: unknown } | undefined;
    return Number.isInteger(range?.minimum) && Number.isInteger(range?.maximum)
      ? { minimum: range!.minimum as number, maximum: range!.maximum as number }
      : null;
  };

  const server = rangeFor("server");
  const client = rangeFor("client");
  const options: FacilitatorOptions = { submissionPolicies: [], l1Confirmations: {} };
  if (server) {
    options.submissionPolicies.push("server");
    options.l1Confirmations.server = server;
  }
  if (client) {
    options.submissionPolicies.push("client");
    options.l1Confirmations.client = client;
  }
  // `either` lets the client pick, so the 402 must be settleable BOTH ways —
  // its range is the intersection, and it drops out entirely if that is empty.
  if (server && client) {
    const either = {
      minimum: Math.max(server.minimum, client.minimum),
      maximum: Math.min(server.maximum, client.maximum),
    };
    if (either.minimum <= either.maximum) {
      options.submissionPolicies.push("either");
      options.l1Confirmations.either = either;
    }
  }
  if (options.submissionPolicies.length === 0) {
    throw new Error("facilitator advertises no usable submission mode");
  }
  return options;
}

const facilitatorOptions = await fetchFacilitatorOptions();

/**
 * How long to let a facilitator call run before giving up.
 *
 * `HTTPFacilitatorClient` defaults to 30s, which is shorter than a single
 * Cardano settlement: `/settle` blocks until the payment reaches the 402's
 * confirmation depth, and one confirmation alone is ~40s on preprod. The
 * default therefore fails a payment that is settling perfectly well — and the
 * failure is *indeterminate*, because the facilitator may complete the
 * settlement moments after the client stops listening. The buyer is then told
 * the payment failed when it did not.
 *
 * So the budget is derived from the facilitator's own settle budget, which the
 * demo facilitator publishes on `/health`, plus a margin for the round-trip.
 * A facilitator that does not publish one gets a conservative default.
 *
 * @returns The timeout to apply to every facilitator request.
 */
async function facilitatorTimeoutMs(): Promise<number> {
  const override = Number(process.env.FACILITATOR_TIMEOUT_MS);
  if (Number.isSafeInteger(override) && override > 0) return override;
  const margin = 30_000;
  const fallback = 10 * 60_000;
  try {
    const res = await fetch(`${FACILITATOR_URL}/health`);
    if (!res.ok) return fallback;
    const health = (await res.json()) as { confirmationTimeoutMs?: unknown };
    return Number.isSafeInteger(health.confirmationTimeoutMs) &&
      (health.confirmationTimeoutMs as number) > 0
      ? (health.confirmationTimeoutMs as number) + margin
      : fallback;
  } catch {
    return fallback;
  }
}

const FACILITATOR_TIMEOUT_MS = await facilitatorTimeoutMs();

/**
 * Why a settlement combination cannot be served, or null when it can.
 *
 * @param submissionPolicy - The policy the 402 would advertise.
 * @param l1Confirmations - The confirmation threshold it would demand.
 * @returns A reason to show the caller, or null when the pair is servable.
 */
function optionFault(
  submissionPolicy: CardanoSubmissionPolicy,
  l1Confirmations: number,
): string | null {
  if (!facilitatorOptions.submissionPolicies.includes(submissionPolicy)) {
    return `the facilitator cannot settle \`${submissionPolicy}\` submission (it offers ${facilitatorOptions.submissionPolicies.join(", ")})`;
  }
  const { minimum, maximum } = facilitatorOptions.l1Confirmations[submissionPolicy];
  if (l1Confirmations < minimum || l1Confirmations > maximum) {
    return `the facilitator accepts l1Confirmations ${minimum}..${maximum} for \`${submissionPolicy}\` submission, not ${l1Confirmations}`;
  }
  return null;
}

// Defaults come from the facilitator, not from a constant: a facilitator
// without a phase-1 validator advertises `client` only, and hard-coding a
// policy produces a demo that 500s on its first request.
//
// `either` is preferred over the spec default of `server` because it is the one
// policy that hands the choice to the payer, which is what the frontend's
// submission-mode picker is for. Falling back in this order keeps the widest
// still-servable option selected.
const POLICY_PREFERENCE: CardanoSubmissionPolicy[] = ["either", "server", "client"];
const defaultPolicy: CardanoSubmissionPolicy =
  (process.env.SUBMISSION_POLICY as CardanoSubmissionPolicy | undefined) ??
  POLICY_PREFERENCE.find(policy => facilitatorOptions.submissionPolicies.includes(policy)) ??
  facilitatorOptions.submissionPolicies[0];
const defaultRange = facilitatorOptions.l1Confirmations[defaultPolicy];
const demoConfig: DemoConfig = {
  submissionPolicy: defaultPolicy,
  // An explicit L1_CONFIRMATIONS is honoured as given (and rejected below if it
  // cannot be served); the spec default of 1 is clamped instead, so a
  // facilitator with a narrower range still starts.
  l1Confirmations:
    process.env.L1_CONFIRMATIONS !== undefined
      ? Number(process.env.L1_CONFIRMATIONS)
      : defaultRange
        ? Math.min(Math.max(1, defaultRange.minimum), defaultRange.maximum)
        : 1,
};

const configuredFault = optionFault(demoConfig.submissionPolicy, demoConfig.l1Confirmations);
if (configuredFault) {
  throw new Error(
    `SUBMISSION_POLICY=${demoConfig.submissionPolicy} L1_CONFIRMATIONS=${demoConfig.l1Confirmations} ` +
      `cannot be served: ${configuredFault}.`,
  );
}

/**
 * The shared policy block every route advertises. Both fields live at the top
 * level of `extra` for all three assetTransferMethods, and are bound by exact
 * `accepted` matching — they are not part of the Masumi `termsDigest`.
 *
 * @returns The `submissionPolicy` / `confirmationPolicy` pair.
 */
function policyExtra(): Record<string, unknown> {
  return {
    submissionPolicy: demoConfig.submissionPolicy,
    confirmationPolicy: { l1Confirmations: demoConfig.l1Confirmations },
  };
}

/**
 * Reissue the Masumi requirements once fewer than this many ms remain on the
 * current `payByTime`. See {@link masumiRequirementsFor} for why they cannot
 * simply be regenerated on every request.
 */
const MASUMI_REFRESH_MS = 4 * 60_000;

/** One issued 402 per masumi route, reused until it nears expiry. */
interface IssuedMasumi {
  payByTime: number;
  policy: string;
  requirements: Awaited<ReturnType<typeof issueMasumiRequirements>>;
}
const masumiCache = new Map<string, IssuedMasumi>();

/**
 * A Masumi `PaymentRequirements`, **stable across a payment round-trip**.
 *
 * Two requirements pull against each other:
 *
 * 1. They must not be frozen at startup. `payByTime` is a real deadline and a
 *    boot-time value silently expires while the server keeps running; every
 *    later lock then fails the facilitator's deadline rule.
 * 2. They must be **identical** in the 402 and in the client's retry. The
 *    resource server matches the client's echoed `accepted` against its own
 *    route config, so a regenerated `sellerNonce` or deadline means nothing
 *    matches and the middleware answers 402 *without ever calling the
 *    facilitator* — a silent rejection with no reason logged anywhere. The spec
 *    says the same thing normatively: the issuer MUST store the complete
 *    requirements object and reuse it on the paid retry, and MUST NOT
 *    regenerate the nonce, deadlines, commitment or policies.
 *
 * Reissuing per request satisfies (1) and breaks (2). So each route's object is
 * cached and reissued only as it nears expiry — stable for minutes at a time,
 * far longer than any 402 -> sign -> retry round-trip. A production issuer keys
 * the stored object by the buyer's request instead of caching per route.
 *
 * @param routeKey - Cache key identifying the route.
 * @param asset - The asset unit the route charges in.
 * @param amount - The amount in the asset's smallest unit.
 * @returns The issued requirements.
 */
async function masumiRequirementsFor(
  routeKey: string,
  asset: string,
  amount: string,
): Promise<IssuedMasumi["requirements"]> {
  const policy = JSON.stringify(policyExtra());
  const cached = masumiCache.get(routeKey);
  if (
    cached &&
    cached.policy === policy &&
    cached.payByTime - Date.now() > MASUMI_REFRESH_MS
  ) {
    return cached.requirements;
  }

  const payByTime = Date.now() + MASUMI_PAY_BY_WINDOW_MS;
  // Deadlines must clear the spec's minimum intervals:
  //   pay_by + 5min <= submit_result, +15min <= unlock, +15min <= dispute.
  const requirements = await issueMasumiRequirements({
    network: "cardano:preprod",
    asset,
    amount,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    sellerAddress: MASUMI_SELLER.sellerAddress,
    signTerms: MASUMI_SELLER.signTerms,
    // What the escrow's `input_hash` binds the funds to. A real issuer commits
    // to the buyer's actual request (parameters, body); this demo answers an
    // unauthenticated GET, so it commits to the route it is pricing.
    commitment: [
      {
        name: "parameters",
        canonicalization: "jcs",
        mediaType: "application/json",
        content: { route: routeKey, asset, amount },
      },
    ],
    payByTime: String(payByTime),
    // Each deadline clears its minimum with margin. `submitResultTime` is also
    // checked against the issuer's own clock at issuance, so landing exactly on
    // the 15-minute floor fails on the milliseconds spent issuing.
    submitResultTime: String(payByTime + 10 * 60_000),
    unlockTime: String(payByTime + 30 * 60_000),
    externalDisputeUnlockTime: String(payByTime + 50 * 60_000),
    // L1 only — this demo drives no Hydra head, and the facilitator refuses a
    // Hydra payment it cannot authenticate against a verified head.
    settlementPolicy: "l1",
    submissionPolicy: demoConfig.submissionPolicy,
    confirmationPolicy: { l1Confirmations: demoConfig.l1Confirmations },
  });

  masumiCache.set(routeKey, { payByTime, policy, requirements });
  return requirements;
}

const app = express();

// CORS: a BROWSER client can only read the x402 headers when we expose them,
// and can only send its payment when PAYMENT-SIGNATURE is allowed.
app.use(
  cors({
    origin: true,
    allowedHeaders: ["Content-Type", "PAYMENT-SIGNATURE", "X-PAYMENT"],
    exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"],
  }),
);

// The resource server delegates verify/settle to the external facilitator and
// registers the Cardano "exact" scheme for building PaymentRequirements.
// On the first request it calls GET /supported on the facilitator and refuses
// to serve the route if (exact, cardano:preprod) is not advertised.
//
// The client wrapper exists purely for diagnostics: paymentMiddleware turns any
// payment failure into a bare `402 {}`, so without it the facilitator's actual
// reason code is invisible. See ./facilitatorLogging.ts.
const resourceServer = new x402ResourceServer(
  new LoggingFacilitatorClient(
    new HTTPFacilitatorClient({ url: FACILITATOR_URL, timeoutMs: FACILITATOR_TIMEOUT_MS }),
    FACILITATOR_URL,
  ),
).register(
  "cardano:preprod",
  new ExactCardanoScheme({
    // Demo scale, as above: volatile replay state, durable store in production.
    inMemoryStore: {},
    // The replay challenge is waived only for an authenticated requester, and
    // this demo has no auth — so it returns one constant identity for the
    // single local user. A real deployment MUST derive this from an
    // upstream-authenticated principal; header values alone prove nothing.
    requestBinding: () => "demo-single-local-user",
  }),
);

// Request-level tracing so a client-visible `402 {}` is explainable from the
// server log alone: this prints whether the request even carried a payment,
// and pairs the response status with the [facilitator] lines logged above it.
app.use((req, res, next) => {
  const paid = Boolean(req.get("PAYMENT-SIGNATURE") ?? req.get("X-PAYMENT"));
  res.on("finish", () => {
    if (!req.path.startsWith("/api/")) return;
    if (res.statusCode === 402 && paid) {
      console.error(
        `[server] ${req.method} ${req.path} → 402 with a payment attached: the facilitator ` +
          `REJECTED it. The reason is in the [facilitator] line logged just above.`,
      );
    } else if (res.statusCode === 402) {
      console.log(`[server] ${req.method} ${req.path} → 402 (no payment yet — this is the normal first request)`);
    } else {
      console.log(`[server] ${req.method} ${req.path} → ${res.statusCode}${paid ? " (paid)" : ""}`);
    }
  });
  next();
});

/**
 * Builds the route payment config.
 *
 * The masumi routes carry a fully issued `PaymentRequirements` — request
 * commitment, seller-signed `terms`, CIP-8 authorization over `termsDigest`
 * and the compatibility identifier — because none of that can be hand-written
 * any more. `payTo` comes from the issuer too: it is DERIVED from the
 * deployment parameters, and the facilitator re-derives it and rejects a
 * mismatch.
 *
 * @returns The routes config for `paymentMiddleware`.
 */
async function buildRoutes(): Promise<RoutesConfig> {
  const masumiAda = await masumiRequirementsFor("masumi-ada", "lovelace", "5000000");
  const masumiToken = await masumiRequirementsFor("masumi-usdm", USDM_ASSET, "250000");

  return {
    "GET /api/message": {
      accepts: {
        scheme: "exact",
        network: "cardano:preprod",
        payTo: SELLER_ADDRESS,
        // 2 tADA in lovelace. Comfortably above the ~1 ADA min-UTxO the
        // facilitator enforces (verification rule 8).
        price: { amount: "2000000", asset: "lovelace" },
        // Cardano blocks are slow vs EVM L2s; give the tx 10 minutes of TTL.
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        extra: { assetTransferMethod: "default", ...policyExtra() },
      },
      description: "A message you can only read after paying 2 tADA",
      mimeType: "application/json",
    },
    "GET /api/message-masumi": {
      accepts: {
        scheme: "exact",
        network: "cardano:preprod",
        // The DERIVED vested_pay address — see MASUMI_ESCROW_ADDRESS.
        payTo: masumiAda.payTo,
        // 5 tADA in lovelace. The escrow output also carries an inline datum,
        // which raises min-UTxO above a plain transfer; 5 tADA stays clear of
        // that floor so the client needs no collateral top-up.
        price: { amount: masumiAda.amount, asset: masumiAda.asset },
        maxTimeoutSeconds: masumiAda.maxTimeoutSeconds,
        extra: masumiAda.extra,
      },
      description: "A message unlocked by locking 5 tADA into the Masumi escrow",
      mimeType: "application/json",
    },
    "GET /api/message-usdm": {
      accepts: {
        scheme: "exact",
        network: "cardano:preprod",
        payTo: SELLER_ADDRESS,
        // Same address-to-address transfer as the first route — the only
        // difference is the asset. x402 names a native token as
        // `policyId.assetNameHex`; tUSDM has 6 decimals, so 100000 = 0.10.
        price: { amount: "100000", asset: USDM_ASSET },
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        extra: { assetTransferMethod: "default", ...policyExtra() },
      },
      description: "A message you can only read after paying 0.10 tUSDM",
      mimeType: "application/json",
    },
    "GET /api/message-masumi-usdm": {
      accepts: {
        scheme: "exact",
        network: "cardano:preprod",
        payTo: masumiToken.payTo,
        // Masumi escrow lock paid in a NATIVE TOKEN rather than ADA. The
        // requested amount is the token; the lovelace on the escrow output is
        // purely structural (post-SubmitResult min-UTxO), and the client
        // computes it as `collateral_return_lovelace` — the seller neither
        // supplies nor signs it.
        price: { amount: masumiToken.amount, asset: masumiToken.asset },
        maxTimeoutSeconds: masumiToken.maxTimeoutSeconds,
        extra: masumiToken.extra,
      },
      description: "A message unlocked by locking 0.25 tUSDM into the Masumi escrow",
      mimeType: "application/json",
    },
  };
}

/**
 * Demo control surface: read and change the policies the 402 advertises, so the
 * whole feature matrix is reachable from the UI instead of a restart. Not part
 * of x402 — a real server fixes these per resource.
 */
app.get("/demo/config", (_req, res) => {
  res.json({
    ...demoConfig,
    escrowAddress: MASUMI_ESCROW_ADDRESS,
    sellerAddress: MASUMI_SELLER.sellerAddress,
    // What the UI is allowed to offer. Sent rather than assumed so the controls
    // show the facilitator's real limits instead of the spec's full matrix.
    facilitator: facilitatorOptions,
  });
});

app.post("/demo/config", express.json(), (req, res) => {
  const { submissionPolicy, l1Confirmations } = (req.body ?? {}) as Partial<DemoConfig>;
  if (submissionPolicy !== undefined && !["server", "client", "either"].includes(submissionPolicy)) {
    return res.status(400).json({ error: "submissionPolicy must be server, client or either" });
  }
  if (
    l1Confirmations !== undefined &&
    (!Number.isInteger(l1Confirmations) || l1Confirmations < -1 || l1Confirmations > 20)
  ) {
    return res.status(400).json({ error: "l1Confirmations must be an integer from -1 to 20" });
  }
  // Both fields are checked together against the facilitator, and only applied
  // once the pair passes: a partial update could otherwise leave the server
  // advertising a combination it cannot settle, which fails as a 500 on the
  // NEXT request rather than as a 400 on this one.
  const next: DemoConfig = {
    submissionPolicy: submissionPolicy ?? demoConfig.submissionPolicy,
    l1Confirmations: l1Confirmations ?? demoConfig.l1Confirmations,
  };
  const fault = optionFault(next.submissionPolicy, next.l1Confirmations);
  if (fault) {
    return res.status(400).json({ error: `Cannot serve that combination: ${fault}.`, facilitator: facilitatorOptions });
  }
  demoConfig.submissionPolicy = next.submissionPolicy;
  demoConfig.l1Confirmations = next.l1Confirmations;
  // The advertised requirements just changed, so the memoized middleware and
  // the issued Masumi objects must be rebuilt on the next request.
  cachedMiddleware = null;
  console.log(
    `[server] demo config → submissionPolicy=${demoConfig.submissionPolicy} ` +
      `l1Confirmations=${demoConfig.l1Confirmations}`,
  );
  return res.json(demoConfig);
});

// The middleware is memoized rather than rebuilt per request: paymentMiddleware()
// takes a static routes object and calls initialize() (a GET /supported
// round-trip) once per construction. Memoizing on the issued requirements also
// keeps them byte-identical across a payment's 402 and retry, which is what
// makes the client's echoed `accepted` match.
let cachedMiddleware: {
  routes: RoutesConfig;
  handler: ReturnType<typeof paymentMiddleware>;
} | null = null;

app.use((req, res, next) => {
  void (async () => {
    try {
      const routes = await buildRoutes();
      // Reference equality is enough: buildRoutes() returns the cached issued
      // objects unchanged until they are reissued.
      const unchanged =
        cachedMiddleware &&
        JSON.stringify(cachedMiddleware.routes) === JSON.stringify(routes);
      if (!unchanged) {
        cachedMiddleware = { routes, handler: paymentMiddleware(routes, resourceServer) };
      }
      return cachedMiddleware!.handler(req, res, next);
    } catch (error) {
      return next(error);
    }
  })();
});

// Only reached AFTER the facilitator verified the payment; the middleware
// settles it after we return (status < 400).
app.get("/api/message", (_req, res) => {
  res.json({
    message: "Hello from x402 on Cardano! This response was paid for on preprod.",
    paidAt: new Date().toISOString(),
  });
});

// Only reached AFTER the facilitator verified the masumi escrow lock. Note
// that this is different from /api/message above: a masumi settle means the
// funds were LOCKED into the (demo) escrow, not delivered to the seller.
app.get("/api/message-masumi", (_req, res) => {
  res.json({
    message: "Hello from x402 on Cardano! 5 tADA was locked into the (demo) Masumi escrow to unlock this.",
    paidAt: new Date().toISOString(),
  });
});

// Only reached AFTER the facilitator verified the tUSDM payment. Same
// address-to-address transfer as /api/message — only the asset differs.
app.get("/api/message-usdm", (_req, res) => {
  res.json({
    message: "Hello from x402 on Cardano! This response was paid for with 0.10 tUSDM, a native token.",
    paidAt: new Date().toISOString(),
  });
});

// Only reached AFTER the facilitator verified the tUSDM escrow lock: the
// masumi datum plus a native-token output rather than ADA.
app.get("/api/message-masumi-usdm", (_req, res) => {
  res.json({
    message: "Hello from x402 on Cardano! 0.25 tUSDM was locked into the (demo) Masumi escrow to unlock this.",
    paidAt: new Date().toISOString(),
  });
});

// Every route in buildRoutes() needs a handler here as well: paymentMiddleware
// only gates a route, it does not serve it. A priced route with no handler
// answers 402 while unpaid (the middleware short-circuits) and then 404s the
// moment a payment succeeds — with settlement cancelled, since the middleware
// aborts /settle when the handler responds >= 400.
// The route KEYS are static even though their requirements are issued lazily,
// so this guard needs no Masumi issuance at boot.
const pricedRoutes = [
  "/api/message",
  "/api/message-masumi",
  "/api/message-usdm",
  "/api/message-masumi-usdm",
];
const servedRoutes = new Set(
  (app._router?.stack ?? [])
    .filter((l: { route?: { path?: string } }) => typeof l.route?.path === "string")
    .map((l: { route: { path: string } }) => l.route.path),
);
const unserved = pricedRoutes.filter((p) => !servedRoutes.has(p));
if (unserved.length > 0) {
  throw new Error(
    `Priced route(s) with no request handler: ${unserved.join(", ")}. ` +
      "Add an app.get(...) for each, or paying for one returns 404.",
  );
}

// Issuance failures (a capability mismatch, a Masumi signing fault) surface as
// thrown errors inside the middleware. Express's default handler renders those
// as an HTML stack trace, which is both a leak and unreadable to a fetch()
// caller — answer JSON instead.
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("[server] request failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  },
);

app.listen(PORT, () => {
  console.log(`Resource server listening on :${PORT} (facilitator: ${FACILITATOR_URL})`);
  console.log(
    `  facilitator offers: ${facilitatorOptions.submissionPolicies
      .map((p) => `${p} (${facilitatorOptions.l1Confirmations[p].minimum}..${facilitatorOptions.l1Confirmations[p].maximum})`)
      .join(", ")}`,
  );
  console.log(
    `  serving: submissionPolicy=${demoConfig.submissionPolicy} l1Confirmations=${demoConfig.l1Confirmations}`,
  );
  console.log(`  facilitator call timeout: ${Math.round(FACILITATOR_TIMEOUT_MS / 1000)}s`);
});
