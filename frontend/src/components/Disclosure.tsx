import { useId, useState, type ReactNode } from "react";

interface DisclosureProps {
  summary: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}

/**
 * A styled, animated show/hide region. Built by hand instead of `<details>`
 * so the open/close transition can animate height smoothly (a CSS
 * grid-template-rows 0fr -> 1fr trick) — `<details>` snaps open instantly in
 * every browser.
 */
export function Disclosure({ summary, meta, children, defaultOpen = false }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();

  return (
    <div className="disclosure" data-open={open}>
      <button
        type="button"
        className="disclosure__trigger"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="disclosure__chevron" aria-hidden="true" />
        <span className="disclosure__summary">{summary}</span>
        {meta && <span className="disclosure__meta">{meta}</span>}
      </button>
      <div className="disclosure__panel" id={contentId}>
        <div className="disclosure__panel-inner">{children}</div>
      </div>
    </div>
  );
}
