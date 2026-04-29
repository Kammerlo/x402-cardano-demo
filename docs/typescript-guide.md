# TypeScript — `@x402/cardano` developer guide

Everything you need to consume the x402 Cardano scheme from a TypeScript project: the browser-side signer, the resource-server middleware, and the facilitator-side scheme (if you run your own facilitator).

The reference servers used by this demo:

- Resource server: [`server-ts/src/server.ts`](../server-ts/src/server.ts)
- Browser signer: [`frontend/src/payment.ts`](../frontend/src/payment.ts)

---

## Install

The Cardano package isn't on npm yet — reference it as a local file dependency from a sibling checkout of the [x402](https://github.com/cardano-foundation/x402) repo:

```json
{
  "dependencies": {
    "@x402/cardano": "file:../../x402/typescript/packages/mechanisms/cardano",
    "@x402/core":    "file:../../x402/typescript/packages/core"
  }
}
```

Build the workspace once before installing:

```bash
cd ../x402/typescript
pnpm install
pnpm --filter @x402/core         build
pnpm --filter @x402/extensions   build
pnpm --filter @x402/cardano      build
pnpm --filter @x402/hono         build   # only if you use the Hono adapter
```

The `file:` reference resolves to the built `dist/`, so re-run `pnpm --filter @x402/cardano build` after pulling fresh changes.

---

## Concepts in 30 seconds

1. **Resource server** issues a 402 challenge with one or more `accepts[]` blocks describing the price.
2. **Browser** decodes the challenge, builds + signs a Cardano transaction with the user's CIP-30 wallet, packs `{transaction, nonce}` into the `PAYMENT-SIGNATURE` header, and re-sends the request.
3. **Resource server** forwards the payload + the canonical requirements to the **facilitator**, which decodes the CBOR, verifies the spec's six rules, and submits the tx.
4. On success the resource server emits a `PAYMENT-RESPONSE` header with the on-chain tx hash and lets the request through.

The resource server never decodes a Cardano transaction itself. All chain knowledge lives in the facilitator.

---

## Server side — Hono

```ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import {
  CARDANO_PREPROD_CAIP2,
  LOVELACE_ASSET,
  SCHEME_EXACT,
} from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/server";

const facilitator = new HTTPFacilitatorClient({ url: "http://localhost:8080" });
const server = new x402ResourceServer(facilitator);
server.register(CARDANO_PREPROD_CAIP2, new ExactCardanoScheme());

const app = new Hono();

// CORS first — the 402 response carries PAYMENT-REQUIRED and the eventual
// 200 carries PAYMENT-RESPONSE; both must be exposed to the browser.
app.use("*", cors({
  origin: "*",
  allowHeaders: ["Content-Type", "PAYMENT-SIGNATURE"],
  exposeHeaders: ["PAYMENT-RESPONSE", "PAYMENT-REQUIRED"],
  allowMethods: ["GET", "OPTIONS"],
}));

app.use("*", paymentMiddleware({
  "GET /premium": {
    accepts: {
      scheme:  SCHEME_EXACT,
      payTo:   "addr_test1q...",
      price:   { amount: "5000000", asset: LOVELACE_ASSET }, // 5 tADA
      network: CARDANO_PREPROD_CAIP2,
      extra:   { assetTransferMethod: "default" },
    },
    description: "Premium endpoint",
    mimeType: "application/json",
  },
}, server));

app.get("/premium", c => c.json({ secret: "you paid!" }));

serve({ fetch: app.fetch, port: 8002 });
```

### Tips

- `accepts.price` accepts either `{amount, asset}` or a plain number for default-asset money parsing.
- For native ADA use `LOVELACE_ASSET` as the asset and the lovelace amount (1 ADA = 1 000 000 lovelace).
- For native tokens use `policyId.assetNameHex` (e.g. `USDM_PREPROD_ASSET`).
- `extra.assetTransferMethod` is always required and must be one of `default`, `masumi`, or `script`.

---

## Browser side — implement `ClientCardanoSigner`

The library defines:

```ts
interface ClientCardanoSigner {
  getAddress(): string;
  signPaymentTransaction(input: ClientCardanoSignInput): Promise<ClientCardanoSignResult>;
}

type ClientCardanoSignResult = { transaction: string /* base64 CBOR */; nonce: string };
```

A minimal CIP-30 implementation using [Mesh](https://meshjs.dev):

```ts
import { Transaction } from "@meshsdk/core";
import { Decoder } from "cbor-x";
import {
  CARDANO_PREPROD_CAIP2,
  type ClientCardanoSigner,
  type ClientCardanoSignInput,
  type ClientCardanoSignResult,
} from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";

// mapsAsObjects: false handles change outputs that include native tokens
// (their map keys are byte strings, which the default decoder rejects).
const cborDecoder = new Decoder({ mapsAsObjects: false });

class CIP30CardanoSigner implements ClientCardanoSigner {
  private constructor(private readonly wallet: BrowserWallet,
                      private readonly address: string) {}

  static async create(wallet: BrowserWallet) {
    if ((await wallet.getNetworkId()) !== 0) {
      throw new Error("Wallet must be on a Cardano testnet");
    }
    const used = await wallet.getUsedAddresses();
    return new CIP30CardanoSigner(wallet, used[0]);
  }

  getAddress(): string { return this.address; }

  async signPaymentTransaction(input: ClientCardanoSignInput): Promise<ClientCardanoSignResult> {
    if (input.asset !== "lovelace")
      throw new Error("This signer only handles lovelace");

    const tx = new Transaction({ initiator: this.wallet });
    tx.sendLovelace(input.payTo, input.amount);
    const unsigned = await tx.build();
    const signedHex = await this.wallet.signTx(unsigned, false);

    // Extract the first input UTXO ref → x402 nonce.
    const bytes = hexToBytes(signedHex);
    const decoded = cborDecoder.decode(bytes) as unknown[];
    const inputs = readInputs(decoded[0]);
    const [txHashBytes, idx] = inputs[0];
    const nonce = `${bytesToHex(txHashBytes)}#${idx}`;

    return { transaction: base64FromBytes(bytes), nonce };
  }
}
```

See [`frontend/src/payment.ts`](../frontend/src/payment.ts) for the full helper functions (`hexToBytes`, `readInputs`, `base64FromBytes`).

### Driving the flow

```ts
const signer = await CIP30CardanoSigner.create(wallet);

const client = new x402Client();
client.register(CARDANO_PREPROD_CAIP2, new ExactCardanoScheme(signer));
const http = new x402HTTPClient(client);

// One call. The HTTP client owns the 402 → sign → retry loop.
const response = await http.fetch("http://localhost:8002/premium");
const { secret } = await response.json();
```

If you need fine-grained control (showing each stage to the user, custom UI prompts, etc.), call the steps yourself:

```ts
const required = await client.getPaymentRequiredResponse(response);   // parse 402
const payload  = await client.createPaymentPayload(required.accepts[0]);
const header   = client.encodePaymentSignatureHeader(payload);
const retried  = await fetch(url, { headers: { "PAYMENT-SIGNATURE": header } });
```

---

## Reading the `PAYMENT-RESPONSE` header

After a successful payment the server returns a `PAYMENT-RESPONSE` header with base64 JSON:

```ts
const headerB64 = response.headers.get("PAYMENT-RESPONSE")!;
const settled = JSON.parse(atob(headerB64));
console.log(settled.transaction);                   // tx hash
console.log(settled.extensions?.status);            // "confirmed" | "mempool"
```

For preprod the [Cardanoscan preprod explorer](https://preprod.cardanoscan.io) is convenient:

```ts
const explorerUrl = `https://preprod.cardanoscan.io/transaction/${settled.transaction}`;
```

---

## Errors you may surface to the user

The `error` field of the 402 challenge body (and `invalidReason` from the facilitator) uses these stable codes:

| Code | Meaning |
|------|---------|
| `invalid_exact_cardano_payload` | Header is malformed (not base64 / not JSON / missing fields) |
| `invalid_exact_cardano_payload_unsigned` | Tx has no witnesses |
| `invalid_exact_cardano_payload_network_id_mismatch` | Tx body's `network_id` disagrees with the requirements |
| `invalid_exact_cardano_payload_recipient_mismatch` | No output pays the required `payTo` |
| `invalid_exact_cardano_payload_asset_mismatch` | Recipient output exists but lacks the required asset |
| `invalid_exact_cardano_payload_amount_insufficient` | Recipient + asset matched, but amount < requirement |
| `invalid_exact_cardano_payload_nonce_invalid` | Nonce isn't a valid `txHashHex#index` |
| `invalid_exact_cardano_payload_nonce_not_in_inputs` | Nonce doesn't appear among the tx inputs |
| `invalid_exact_cardano_payload_nonce_not_on_chain` | Nonce UTXO is unknown / already spent |
| `invalid_exact_cardano_payload_ttl_expired` | Tx TTL slot is in the past |
| `exact_cardano_facilitator_chain_lookup_failed` | Facilitator couldn't reach the chain (Blockfrost down, etc.) |
| `exact_cardano_settlement_failed` | Submission rejected (insufficient inputs, wrong fees, …) |
| `exact_cardano_settlement_not_confirmed` | Tx accepted to mempool but not confirmed within the window |
| `duplicate_settlement` | Same `PAYMENT-SIGNATURE` was already settled within the cache window |

Display the matching prose to the user — the codes are stable enough to drive an error map.

---

## Running your own facilitator

If you don't want to run the demo's Python facilitator, you can host the verifier in-process:

```ts
import { ExactCardanoScheme as Facilitator } from "@x402/cardano/exact/facilitator";
import { x402Facilitator } from "@x402/core/facilitator";

const fac = new x402Facilitator();
fac.register(CARDANO_PREPROD_CAIP2, new Facilitator(yourCardanoSigner));
// expose fac.handleVerify / fac.handleSettle on /verify and /settle
```

`yourCardanoSigner` is a `FacilitatorCardanoSigner` — must implement `getUtxo`, `getCurrentSlot`, `submitTransaction` (and optionally `evaluateTransaction`). See the Python facilitator's [`blockfrost_signer.py`](../facilitator/blockfrost_signer.py) for a reference using Blockfrost.

---

## Common pitfalls

- **CORS** — your server must `expose` `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE` headers. The browser cannot read them otherwise.
- **CIP-30 address scope** — fall through `getUsedAddresses` → `getUnusedAddresses` → `getChangeAddress`. Freshly funded testnet wallets have no "used" addresses yet.
- **`mapsAsObjects: false`** when decoding signed tx CBOR. The default decoder throws on byte-string map keys, which appear in any change output that includes native tokens.
- **Mainnet check** — refuse to start the flow if `wallet.getNetworkId()` returns `1`. The facilitator will reject mainnet txs anyway, but the error message is friendlier client-side.
