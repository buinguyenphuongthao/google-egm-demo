import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AlignLeft, MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import type { Card, Label } from '../api';
import { InlineInput } from '../components/InlineInput';
import { Button } from '../components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { cn } from '../lib/utils';
import { LabelChip } from './LabelChip';
import { expiresIn } from './order';

interface Props {
  card: Card;
  /** The card's labels, in display order. */
  labels: Label[];
  inDoneColumn: boolean;
  /** True while a column is dragged, so cards are not drop targets. */
  dropDisabled: boolean;
  onOpen: () => void;
  onRename: (title: string) => Promise<boolean>;
  onDelete: () => void;
}

export function CardItem({ card, labels, inDoneColumn, dropDisabled, onOpen, onRename, onDelete }: Props) {
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
          {/* Click or Enter opens the card; drag with mouse or touch, or Space then arrow keys. */}
          <button
            ref={setActivatorNodeRef}
            type="button"
            onClick={onOpen}
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
              <DropdownMenuItem onSelect={onOpen}>Open</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setEditing(true)}>Rename</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {(labels.length > 0 || card.description) && (
        <div className="flex flex-wrap items-center gap-1 px-3 pb-2">
          {labels.map((label) => (
            <LabelChip key={label.id} label={label} />
          ))}
          {card.description && <AlignLeft className="size-3.5 text-muted-foreground" role="img" aria-label="Has description" />}
        </div>
      )}
      {inDoneColumn && card.expiresAt !== undefined && (
        <p className="px-3 pb-2 text-xs text-muted-foreground">{expiresIn(card.expiresAt)}</p>
      )}
    </li>
  );
}
