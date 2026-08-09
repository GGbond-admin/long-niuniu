import { useRef } from 'react';

export default function PaymentPinInput({
  value,
  onChange,
  disabled = false,
  autoFocus = false,
  label = '六位支付密码',
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  label?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`payment-pin-control ${disabled ? 'disabled' : ''}`}
      onClick={() => inputRef.current?.focus()}
    >
      <input
        ref={inputRef}
        className="payment-pin-native"
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        maxLength={6}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-label={label}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))}
      />
      <div className="payment-pin-digits" aria-hidden>
        {Array.from({ length: 6 }, (_, index) => (
          <span
            key={index}
            className={`${index < value.length ? 'filled' : ''} ${
              index === value.length && value.length < 6 ? 'active' : ''
            }`}
          >
            {index < value.length ? <i /> : null}
          </span>
        ))}
      </div>
    </div>
  );
}
