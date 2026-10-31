import { useEffect, useRef, useState, type FormEvent } from 'react';
import { cn } from '../lib/utils';
import { Input } from './ui/input';

interface Props {
  label: string;
  initial?: string;
  placeholder?: string;
  maxLength: number;
  /** Resolves true when saved. With keepOpen the input clears for the next entry. */
  onSubmit: (value: string) => Promise<boolean>;
  onCancel: () => void;
  keepOpen?: boolean;
  className?: string;
}

/** A one-line editor: Enter saves, Escape cancels, leaving it empty or unchanged cancels. */
export function InlineInput({ label, initial = '', placeholder, maxLength, onSubmit, onCancel, keepOpen, className }: Props) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (busy) return;
    if (!trimmed || trimmed === initial.trim()) return onCancel();
    setBusy(true);
    const saved = await onSubmit(trimmed);
    setBusy(false);
    if (saved && keepOpen) {
      setValue('');
      ref.current?.focus();
    }
  }

  return (
    <form onSubmit={submit} className={cn('w-full', className)}>
      <Input
        ref={ref}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        maxLength={maxLength}
        readOnly={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          if (!busy && (!value.trim() || value.trim() === initial.trim())) onCancel();
        }}
      />
    </form>
  );
}
