import { AlertDialog as Primitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { buttonVariants } from './button';

interface ConfirmProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}

/** A confirmation dialog for destructive actions. */
export function ConfirmDialog({ open, title, description, confirmLabel, onConfirm, onOpenChange }: ConfirmProps) {
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Primitive.Content className="fixed top-1/2 left-1/2 z-50 grid w-full max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border bg-background p-6 shadow-lg">
          <Primitive.Title className="text-lg font-semibold">{title}</Primitive.Title>
          <Primitive.Description className="text-sm text-muted-foreground">{description}</Primitive.Description>
          <div className="flex justify-end gap-2">
            <Primitive.Cancel className={buttonVariants({ variant: 'outline' })}>Cancel</Primitive.Cancel>
            <Primitive.Action className={buttonVariants({ variant: 'destructive' })} onClick={onConfirm}>
              {confirmLabel}
            </Primitive.Action>
          </div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
