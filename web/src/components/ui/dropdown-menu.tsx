import { DropdownMenu as Primitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

// Non-modal, so a dialog opened from a menu item does not leave the page inert.
export function DropdownMenu({ modal = false, ...props }: ComponentProps<typeof Primitive.Root>) {
  return <Primitive.Root modal={modal} {...props} />;
}
export const DropdownMenuTrigger = Primitive.Trigger;

export function DropdownMenuContent({ className, sideOffset = 4, ...props }: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-36 rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=open]:fade-in-0',
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  variant,
  ...props
}: ComponentProps<typeof Primitive.Item> & { variant?: 'destructive' }) {
  return (
    <Primitive.Item
      className={cn(
        'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none focus:bg-accent focus:text-accent-foreground [&_svg]:size-4',
        variant === 'destructive' && 'text-destructive focus:text-destructive',
        className,
      )}
      {...props}
    />
  );
}
