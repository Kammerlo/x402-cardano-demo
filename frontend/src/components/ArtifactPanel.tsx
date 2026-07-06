import { Disclosure } from "./Disclosure";
import { formatBytes } from "../lib/format";

interface ArtifactPanelProps {
  /** e.g. "Decoded PAYMENT-REQUIRED" */
  label: string;
  /** Rendered as pretty-printed JSON. Mutually exclusive with `text`. */
  json?: unknown;
  /** Rendered verbatim (e.g. a base64 header value). Mutually exclusive with `json`. */
  text?: string;
  defaultOpen?: boolean;
}

/**
 * The "show me the real bytes" affordance used throughout the timeline.
 * Content sits in its own horizontally-scrolling monospace box so a long
 * base64 transaction or JSON payload can never blow out the page layout.
 */
export function ArtifactPanel({ label, json, text, defaultOpen = false }: ArtifactPanelProps) {
  const content = text ?? JSON.stringify(json, null, 2);
  const byteLength = new TextEncoder().encode(content).length;

  return (
    <Disclosure
      summary={label}
      meta={<span className="mono-tag">{formatBytes(byteLength)}</span>}
      defaultOpen={defaultOpen}
    >
      <pre className="artifact">
        <code>{content}</code>
      </pre>
    </Disclosure>
  );
}
