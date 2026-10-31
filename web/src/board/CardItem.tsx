import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import type { Card } from '../api';
import { InlineInput } from '../components/InlineInput';
import { Button } from '../components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { cn } from '../lib/utils';
import { expiresIn } from './order';

interface Props {
  card: Card;
  inDoneColumn: boolean;
  /** True while a column is dragged, so cards are not drop targets. */
  dropDisabled: boolean;
  onRename: (title: string) => Promise<boolean>;
  onDelete: () => void;
}

export function CardItem({ card, inDoneColumn, dropDisabled, onRename, onDelete }: Props) {
  const [editing, setEditing] = useState(false);
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { kind: 'card' },
    disabled: { draggable: editing, droppable: dropDisabled },
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('rounded-md border bg-card text-card-foreground', isDragging && 'opacity-40')}
    >
      {editing ? (
        <InlineInput
          className="p-1"
          label="Card title"
          initial={card.title}
          maxLength={200}
          onSubmit={async (title) => {
            const saved = await onRename(title);
            if (saved) setEditing(false);
            return saved;
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="flex items-start gap-1 p-1">
          {/* The drag handle: mouse, touch, or Space/Enter then arrow keys. */}
          <button
            ref={setActivatorNodeRef}
            type="button"
            className="min-w-0 flex-1 cursor-grab rounded px-2 py-1.5 text-left text-sm break-words outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            {...attributes}
            {...listeners}
          >
            {card.title}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7" aria-label={`Card actions: ${card.title}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
              <DropdownMenuItem onSelect={() => setEditing(true)}>Rename</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {inDoneColumn && card.expiresAt !== undefined && (
        <p className="px-3 pb-2 text-xs text-muted-foreground">{expiresIn(card.expiresAt)}</p>
      )}
    </li>
  );
}
