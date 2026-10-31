import { Monitor, Moon, Plus, Sun } from 'lucide-react';
import { useState } from 'react';
import type { Project } from './api';
import { InlineInput } from './components/InlineInput';
import { Button } from './components/ui/button';
import { cn } from './lib/utils';
import type { Theme } from './theme';

interface Props {
  projects: Project[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<boolean>;
  theme: Theme;
  onTheme: (theme: Theme) => void;
}

const THEMES = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
] as const;

export function Sidebar({ projects, activeId, onSelect, onCreate, theme, onTheme }: Props) {
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <p className="px-2 pt-1 text-base font-semibold">Kanban</p>

      <nav aria-label="Projects" className="flex min-h-0 flex-col gap-1">
        <p className="px-2 text-xs font-medium text-muted-foreground">Projects</p>
        <ul className="flex flex-col gap-0.5 overflow-y-auto">
          {projects.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                aria-current={p.id === activeId ? 'page' : undefined}
                onClick={() => onSelect(p.id)}
                className={cn(
                  'w-full truncate rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  p.id === activeId && 'bg-accent font-medium',
                )}
              >
                {p.name}
              </button>
            </li>
          ))}
        </ul>
        {creating ? (
          <InlineInput
            label="New project name"
            placeholder="Project name"
            maxLength={80}
            onSubmit={async (name) => {
              const saved = await onCreate(name);
              if (saved) setCreating(false);
              return saved;
            }}
            onCancel={() => setCreating(false)}
          />
        ) : (
          <Button variant="ghost" size="sm" className="justify-start text-muted-foreground" onClick={() => setCreating(true)}>
            <Plus /> New project
          </Button>
        )}
      </nav>

      <div role="group" aria-label="Theme" className="mt-auto flex gap-1 rounded-md border p-1">
        {THEMES.map(({ value, label, Icon }) => (
          <Button
            key={value}
            variant="ghost"
            size="sm"
            aria-pressed={theme === value}
            className={cn('min-w-0 flex-1 gap-1 px-1 text-xs', theme === value && 'bg-accent')}
            onClick={() => onTheme(value)}
          >
            <Icon /> {label}
          </Button>
        ))}
      </div>
    </div>
  );
}
