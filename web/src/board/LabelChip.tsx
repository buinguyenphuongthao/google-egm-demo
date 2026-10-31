import type { Label } from '../api';
import { cn } from '../lib/utils';
import { CHIP_CLASSES } from './labels';

export function LabelChip({ label, className }: { label: Label; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block max-w-full truncate rounded px-1.5 py-0.5 text-xs font-medium',
        CHIP_CLASSES[label.color],
        className,
      )}
    >
      {label.name}
    </span>
  );
}
