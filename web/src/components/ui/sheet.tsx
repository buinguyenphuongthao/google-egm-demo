import { Dialog as Primitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export const Sheet = Primitive.Root;
export const SheetTrigger = Primitive.Trigger;
export const SheetTitle = Primitive.Title;

/** A dialog that slides in from one side. */
export function SheetContent({
  side = 'left',
  className,
  children,
  ...props
}: ComponentProps<typeof Primitive.Content> & { side?: 'left' | 'right' }) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
      <Primitive.Content
        aria-describedby={undefined}
        className={cn(
          'fixed inset-y-0 z-50 flex w-72 max-w-[85vw] flex-col bg-background shadow-lg data-[state=open]:animate-in',
          side === 'left'
            ? 'left-0 border-r data-[state=open]:slide-in-from-left'
            : 'right-0 border-l data-[state=open]:slide-in-from-right',
          className,
        )}
        {...props}
      >
        {children}
      </Primitive.Content>
    </Primitive.Portal>
  );
}
