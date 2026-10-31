import { Dialog as Primitive } from 'radix-ui';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export const Dialog = Primitive.Root;

export function DialogContent({
  title,
  className,
  children,
  ...props
}: ComponentProps<typeof Primitive.Content> & { title: string }) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
      <Primitive.Content
        aria-describedby={undefined}
        className={cn(
          'fixed top-1/2 left-1/2 z-50 flex max-h-[85dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-lg border bg-background p-6 shadow-lg',
          className,
        )}
        {...props}
      >
        <Primitive.Title className="text-lg font-semibold">{title}</Primitive.Title>
        {children}
        <Primitive.Close
          aria-label="Close"
          className="absolute top-4 right-4 rounded p-1 text-muted-foreground hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <X className="size-4" />
        </Primitive.Close>
      </Primitive.Content>
    </Primitive.Portal>
  );
}
