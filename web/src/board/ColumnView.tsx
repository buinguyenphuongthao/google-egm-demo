import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CircleCheck, GripVertical, MoreHorizontal, Plus } from 'lucide-react';
import { useState } from 'react';
import type { Card, Column } from '../api';
import { InlineInput } from '../components/InlineInput';
import { Button } from '../components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { cn } from '../lib/utils';
import { CardItem } from './CardItem';

interface Props {
  column: Column;
  cards: Card[];
  /** True while a column is dragged. */
  draggingColumn: boolean;
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => void;
  onAddCard: (title: string) => Promise<boolean>;
  onRenameCard: (card: Card, title: string) => Promise<boolean>;
  onDeleteCard: (card: Card) => void;
}

export function ColumnView(props: Props) {
  const { column, cards, draggingColumn } = props;
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: column.id,
    data: { kind: 'column' },
    disabled: { draggable: renaming },
  });

  return (
    <section
      ref={setNodeRef}
      aria-label={column.name}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('flex max-h-full w-72 shrink-0 flex-col rounded-lg border bg-muted', isDragging && 'opacity-40')}
    >
      <header className="flex items-center gap-1 p-2">
        <button
          ref={setActivatorNodeRef}
          type="button"
          aria-label={`Move column ${column.name}`}
          className="cursor-grab rounded p-1 text-muted-foreground outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
        {renaming ? (
          <InlineInput
            label="Column name"
            initial={column.name}
            maxLength={40}
            onSubmit={async (name) => {
              const saved = await props.onRename(name);
              if (saved) setRenaming(false);
              return saved;
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{column.name}</h2>
        )}
        {column.isDone && (
          <CircleCheck className="size-4 shrink-0 text-muted-foreground" role="img" aria-label="Done column" />
        )}
        <span className="text-xs text-muted-foreground">
          {cards.length}
          <span className="sr-only"> cards</span>
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7" aria-label={`Column actions: ${column.name}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
            <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename</DropdownMenuItem>
            {!column.isDone && (
              <DropdownMenuItem variant="destructive" onSelect={props.onDelete}>
                Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <ul aria-label={`${column.name} cards`} className="flex min-h-2 flex-col gap-2 overflow-y-auto px-2">
          {cards.map((card) => (
            <CardItem
              key={card.id}
              card={card}
              inDoneColumn={column.isDone}
              dropDisabled={draggingColumn}
              onRename={(title) => props.onRenameCard(card, title)}
              onDelete={() => props.onDeleteCard(card)}
            />
          ))}
        </ul>
      </SortableContext>

      <div className="p-2">
        {adding ? (
          <InlineInput
            label={`New card in ${column.name}`}
            placeholder="Card title"
            maxLength={200}
            keepOpen
            onSubmit={props.onAddCard}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <Button variant="ghost" size="sm" className="w-full justify-start text-muted-foreground" onClick={() => setAdding(true)}>
            <Plus /> Add card
          </Button>
        )}
      </div>
    </section>
  );
}
