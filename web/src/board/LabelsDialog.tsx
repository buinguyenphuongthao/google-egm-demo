import { Trash2 } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import type { Label, LabelColor } from '../api';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { LabelChip } from './LabelChip';
import { LABEL_COLORS, colorName } from './labels';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  labels: Label[];
  onCreate: (input: { name: string; color: LabelColor }) => Promise<boolean>;
  onUpdate: (label: Label, input: { name?: string; color?: LabelColor }) => Promise<boolean>;
  onDelete: (label: Label) => void;
}

const selectClass =
  'h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

function ColorSelect({ value, label, onChange }: { value: LabelColor; label: string; onChange: (c: LabelColor) => void }) {
  return (
    <select aria-label={label} className={selectClass} value={value} onChange={(e) => onChange(e.target.value as LabelColor)}>
      {LABEL_COLORS.map((c) => (
        <option key={c} value={c}>
          {colorName(c)}
        </option>
      ))}
    </select>
  );
}

function LabelRow({ label, onUpdate, onDelete }: { label: Label } & Pick<Props, 'onUpdate' | 'onDelete'>) {
  const [name, setName] = useState(label.name);

  function saveName() {
    const trimmed = name.trim();
    if (!trimmed) setName(label.name);
    else if (trimmed !== label.name) void onUpdate(label, { name: trimmed });
  }

  return (
    <li className="flex items-center gap-2">
      <LabelChip label={label} className="w-20 shrink-0 text-center" />
      <Input
        aria-label={`Name of label ${label.name}`}
        value={name}
        maxLength={30}
        onChange={(e) => setName(e.target.value)}
        onBlur={saveName}
        onKeyDown={(e) => e.key === 'Enter' && saveName()}
      />
      <ColorSelect
        label={`Color of label ${label.name}`}
        value={label.color}
        onChange={(color) => void onUpdate(label, { color })}
      />
      <Button variant="ghost" size="icon" aria-label={`Delete label ${label.name}`} onClick={() => onDelete(label)}>
        <Trash2 />
      </Button>
    </li>
  );
}

export function LabelsDialog({ open, onOpenChange, labels, onCreate, onUpdate, onDelete }: Props) {
  const [name, setName] = useState('');
  const [color, setColor] = useState<LabelColor>('blue');
  const newName = useRef<HTMLInputElement>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed && (await onCreate({ name: trimmed, color }))) setName('');
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Labels"
        className="max-w-lg"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          newName.current?.focus();
        }}
      >
        {labels.length === 0 ? (
          <p className="text-sm text-muted-foreground">No labels yet.</p>
        ) : (
          <ul aria-label="Labels" className="flex flex-col gap-2 overflow-y-auto">
            {labels.map((label) => (
              // Keyed by name too, so a rename from the server resets the input.
              <LabelRow key={`${label.id}:${label.name}`} label={label} onUpdate={onUpdate} onDelete={onDelete} />
            ))}
          </ul>
        )}
        <form onSubmit={add} className="flex items-center gap-2 border-t pt-4">
          <Input
            ref={newName}
            aria-label="New label name"
            placeholder="New label"
            value={name}
            maxLength={30}
            onChange={(e) => setName(e.target.value)}
          />
          <ColorSelect label="New label color" value={color} onChange={setColor} />
          <Button type="submit" disabled={!name.trim()}>
            Add
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
