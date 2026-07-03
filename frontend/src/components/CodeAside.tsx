const SNIPPET = `import { wrapFetchWithPayment } from "@x402/fetch";

const pay = wrapFetchWithPayment(fetch, client);
const res = await pay(sellerUrl);`;

/**
 * Everything the timeline below unpacks step by step is, in production
 * client code, this one call. Keeping it visible nearby is the point: the
 * demo's job is to make the one-liner legible, not to replace it.
 */
export function CodeAside() {
  return (
    <aside className="code-aside">
      <p className="code-aside__eyebrow">In production, this is one line</p>
      <pre className="artifact artifact--code">
        <code>{SNIPPET}</code>
      </pre>
      <p className="code-aside__caption">
        <code>wrapFetchWithPayment</code> probes for the 402, builds and signs the payment, retries, and waits for
        settlement — automatically, on every call. This page unpacks that single line into the five steps below so
        you can watch what your HTTP client is doing on your behalf.
      </p>
    </aside>
  );
}
