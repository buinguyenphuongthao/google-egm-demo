import { Dialog as Primitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export const Sheet = Primitive.Root;
export const SheetTrigger = Primitive.Trigger;
export const SheetTitle = Primitive.Title;

/** A dialog that slides in from the left. */
export function SheetContent({ className, children, ...props }: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
      <Primitive.Content
        aria-describedby={undefined}
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r bg-background shadow-lg data-[state=open]:animate-in data-[state=open]:slide-in-from-left',
          className,
        )}
        {...props}
      >
        {children}
      </Primitive.Content>
    </Primitive.Portal>
  );
}
