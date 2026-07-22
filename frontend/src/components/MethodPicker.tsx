import type { PaymentMethod } from "../x402/flow";

interface MethodOption {
  id: PaymentMethod;
  label: string;
  price: string;
}

const OPTIONS: MethodOption[] = [
  { id: "default", label: "Address-to-address", price: "2 tADA" },
  { id: "masumi", label: "Masumi escrow-lock", price: "5 tADA" },
  { id: "usdm", label: "Native token", price: "0.10 tUSDM" },
];

interface MethodPickerProps {
  method: PaymentMethod;
  onChange: (method: PaymentMethod) => void;
  disabled?: boolean;
}

/** Which route Step B pays: the plain `default` address-to-address transfer,
 * or `masumi`, which locks funds into an escrow contract instead. Both speak
 * identical x402 wire protocol — this only picks which server route (and
 * therefore which `assetTransferMethod`) gets exercised. */
export function MethodPicker({ method, onChange, disabled }: MethodPickerProps) {
  return (
    <div className="method-picker">
      <div className="method-picker__control" role="radiogroup" aria-label="Payment method">
        {OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={method === option.id}
            className="method-picker__option"
            data-selected={method === option.id}
            onClick={() => onChange(option.id)}
            disabled={disabled}
          >
            <span className="method-picker__option-label">{option.label}</span>
            <span className="method-picker__option-price mono-tag">{option.price}</span>
          </button>
        ))}
      </div>
      {method === "masumi" && (
        <p className="step-note">
          <strong>This locks funds — it doesn&rsquo;t pay the seller.</strong> The 5 tADA goes into an escrow
          contract (the <code>vested_pay</code> script) carrying a 19-field on-chain datum, not straight to the
          seller&rsquo;s address. In this demo the escrow is a <strong>recoverable stand-in</strong> address, and the
          datum&rsquo;s purchase identifiers are <strong>dummy values</strong> — a real deployment gets them from the
          Masumi Payment Service.
        </p>
      )}
    </div>
  );
}
