import { Check } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Card, Column, Label } from '../api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Sheet, SheetContent, SheetTitle } from '../components/ui/sheet';
import { Textarea } from '../components/ui/textarea';
import { cn } from '../lib/utils';
import { LabelChip } from './LabelChip';
import { expiresIn } from './order';

type CardInput = { title?: string; description?: string; labelIds?: string[] };

interface Props {
  card: Card | undefined;
  column: Column | undefined;
  labels: Label[];
  onSave: (card: Card, input: CardInput) => Promise<boolean>;
  onDelete: (card: Card) => void;
  onClose: () => void;
}

/** The side panel for one card. Title and description save on blur or when the panel closes. */
export function CardPanel({ card, column, labels, onSave, onDelete, onClose }: Props) {
  return (
    <Sheet open={card !== undefined} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-md gap-5 overflow-y-auto p-6">
        <SheetTitle className="text-lg font-semibold">Card</SheetTitle>
        {card && (
          <CardForm
            key={card.id}
            card={card}
            column={column}
            labels={labels}
            onSave={(input) => onSave(card, input)}
            onDelete={() => onDelete(card)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function CardForm({
  card,
  column,
  labels,
  onSave,
  onDelete,
}: {
  card: Card;
  column: Column | undefined;
  labels: Label[];
  onSave: (input: CardInput) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);

  // Closing the panel unmounts the form without a blur, so unsaved text is saved here.
  const latest = useRef({ card, title, description, onSave });
  latest.current = { card, title, description, onSave };
  useEffect(
    () => () => {
      const { card, title, description, onSave } = latest.current;
      const input: CardInput = {};
      if (title.trim() && title.trim() !== card.title) input.title = title.trim();
      if (description.trim() !== card.description) input.description = description;
      if (Object.keys(input).length > 0) void onSave(input);
    },
    [],
  );

  function saveTitle() {
    const trimmed = title.trim();
    if (!trimmed) setTitle(card.title);
    else if (trimmed !== card.title) void onSave({ title: trimmed });
  }

  function saveDescription() {
    if (description.trim() !== card.description) void onSave({ description });
  }

  function toggle(label: Label) {
    const labelIds = card.labelIds.includes(label.id)
      ? card.labelIds.filter((id) => id !== label.id)
      : [...card.labelIds, label.id];
    void onSave({ labelIds });
  }

  return (
    <>
      {column && (
        <p className="-mt-3 text-sm text-muted-foreground">
          In {column.name}
          {column.isDone && card.expiresAt !== undefined && ` · ${expiresIn(card.expiresAt)}`}
        </p>
      )}
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Title
        <Input
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => e.key === 'Enter' && saveTitle()}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Description
        <Textarea
          value={description}
          maxLength={2000}
          placeholder="Add more detail"
          onChange={(e) => setDescription(e.target.value)}
          onBlur={saveDescription}
        />
      </label>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-sm font-medium">Labels</legend>
        {labels.length === 0 ? (
          <p className="text-sm text-muted-foreground">No labels yet. Add them from the project menu.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {labels.map((label) => {
              const on = card.labelIds.includes(label.id);
              return (
                <button
                  key={label.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(label)}
                  className={cn(
                    'flex items-center gap-1 rounded border px-1 py-0.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    on ? 'border-foreground/60' : 'border-transparent hover:border-border',
                  )}
                >
                  {on && <Check className="size-3.5" aria-hidden />}
                  <LabelChip label={label} />
                </button>
              );
            })}
          </div>
        )}
      </fieldset>
      <Button variant="destructive" className="mt-auto self-start" onClick={onDelete}>
        Delete card
      </Button>
    </>
  );
}
