import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, horizontalListSortingStrategy, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { ListFilter, MoreHorizontal, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import * as api from '../api';
import type { Board, Card, Column, Label, LabelColor, Project } from '../api';
import { InlineInput } from '../components/InlineInput';
import { ConfirmDialog } from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { CardPanel } from './CardPanel';
import { ColumnView } from './ColumnView';
import { LabelChip } from './LabelChip';
import { LabelsDialog } from './LabelsDialog';
import { byRank, findColumn, groupCards, rankAfter, rankAt, type Order } from './order';

interface Props {
  projectId: string;
  /** Rendered first in the header (the mobile menu button). */
  leading: ReactNode;
  onRenamed: (project: Project) => void;
  onDeleted: (id: string) => void;
}

interface Confirm {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  run: () => void;
}

type Dragging = { kind: 'card' | 'column'; id: string };

const message = (err: unknown) => (err instanceof Error ? err.message : 'something went wrong');

// Enter is left to the handle's click, which opens the card.
const keyboardCodes = { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] };
const screenReaderInstructions = {
  draggable:
    'To pick up this item, press Space. While dragging, use the arrow keys to move it, Space or Enter to drop it, or Escape to cancel.',
};

export function BoardView({ projectId, leading, onRenamed, onDeleted }: Props) {
  const [board, setBoard] = useState<Board | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [addingColumn, setAddingColumn] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [dragging, setDragging] = useState<Dragging | null>(null);
  // Card order while a card is dragged between columns; null otherwise.
  const [dragOrder, setDragOrder] = useState<Order | null>(null);
  const [managingLabels, setManagingLabels] = useState(false);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  // Label ids to filter by; a card shows when it has any of them. Empty shows all cards.
  const [filter, setFilter] = useState<string[]>([]);

  useEffect(() => {
    let current = true;
    setBoard(null);
    setLoadFailed(false);
    api.getBoard(projectId).then(
      (b) => current && setBoard(b),
      () => current && setLoadFailed(true),
    );
    return () => {
      current = false;
    };
  }, [projectId]);

  const reload = useCallback(async () => {
    try {
      setBoard(await api.getBoard(projectId));
    } catch {
      setLoadFailed(true);
    }
  }, [projectId]);

  /** Runs a save. On failure: toast, then reload, which undoes any optimistic change. */
  const attempt = useCallback(
    async (what: string, save: () => Promise<void>): Promise<boolean> => {
      try {
        await save();
        return true;
      } catch (err) {
        toast.error(`${what}: ${message(err)}`);
        await reload();
        return false;
      }
    },
    [reload],
  );

  // The API saves a card by reading it and writing it back whole, so two saves to one card
  // in flight at once (a title on blur, then a label click) could undo each other on the
  // server. Saves to each card therefore run one at a time.
  const cardSaves = useRef(new Map<string, Promise<boolean>>());
  // Cards deleted in this session; their delete is queued like a save.
  const deletedCards = useRef(new Set<string>());
  const queueCardSave = useCallback(
    (id: string, what: string, save: () => Promise<void>): Promise<boolean> => {
      const run = (cardSaves.current.get(id) ?? Promise.resolve(true)).then(() => attempt(what, save));
      cardSaves.current.set(id, run);
      void run.then(() => cardSaves.current.get(id) === run && cardSaves.current.delete(id));
      return run;
    },
    [attempt],
  );

  const update =(change: (b: Board) => Board) => setBoard((b) => b && change(b));
  const replaceCard = (card: Card) => update((b) => ({ ...b, cards: b.cards.map((c) => (c.id === card.id ? card : c)) }));
  const replaceColumn = (column: Column) =>
    update((b) => ({ ...b, columns: b.columns.map((c) => (c.id === column.id ? column : c)) }));

  const columns = useMemo(() => (board ? [...board.columns].sort(byRank) : []), [board]);
  const cardsById = useMemo(() => new Map(board?.cards.map((c) => [c.id, c])), [board]);
  const columnIds = useMemo(() => new Set(columns.map((c) => c.id)), [columns]);
  const labels = useMemo(
    () => (board ? [...board.labels].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) : []),
    [board],
  );
  const activeFilter = filter.filter((id) => labels.some((l) => l.id === id));
  const shown = (card: Card) => activeFilter.length === 0 || card.labelIds.some((id) => activeFilter.includes(id));
  const order = useMemo(() => dragOrder ?? groupCards(columns, board?.cards ?? []), [dragOrder, columns, board]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes }),
  );

  // Columns collide only with columns. A card prefers the card under the pointer, then the
  // column (so empty columns accept drops); the keyboard has no pointer and uses corners.
  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      if (columnIds.has(String(args.active.id))) {
        return closestCenter({
          ...args,
          droppableContainers: args.droppableContainers.filter((c) => columnIds.has(String(c.id))),
        });
      }
      const within = pointerWithin(args);
      if (within.length > 0) {
        const cards = within.filter((c) => !columnIds.has(String(c.id)));
        return cards.length > 0 ? cards : within;
      }
      return closestCorners(args);
    },
    [columnIds],
  );

  const nameOf = (id: string | number) =>
    cardsById.get(String(id))?.title ?? columns.find((c) => c.id === id)?.name ?? 'item';
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${nameOf(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over ? `${nameOf(active.id)} is over ${nameOf(over.id)}.` : `${nameOf(active.id)} is not over a drop area.`,
    onDragEnd: ({ active, over }) =>
      over ? `Dropped ${nameOf(active.id)} at ${nameOf(over.id)}.` : `Dropped ${nameOf(active.id)}.`,
    onDragCancel: ({ active }) => `Cancelled. ${nameOf(active.id)} went back.`,
  };

  if (!board) {
    return (
      <>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">{leading}</header>
        <p role={loadFailed ? 'alert' : undefined} className="p-4 text-sm text-muted-foreground">
          {loadFailed ? 'Could not load this project.' : 'Loading…'}
        </p>
      </>
    );
  }

  const pid = board.project.id;

  function onDragStart({ active }: DragStartEvent) {
    const id = String(active.id);
    const kind = columnIds.has(id) ? 'column' : 'card';
    setDragging({ kind, id });
    if (kind === 'card') setDragOrder(groupCards(columns, board!.cards));
  }

  function onDragOver({ active, over }: DragOverEvent) {
    if (!over || !dragOrder || columnIds.has(String(active.id))) return;
    const id = String(active.id);
    const overId = String(over.id);
    const from = findColumn(dragOrder, id);
    const to = columnIds.has(overId) ? overId : findColumn(dragOrder, overId);
    if (!from || !to || from === to) return;
    const target = dragOrder[to]!;
    let index = columnIds.has(overId) ? target.length : target.indexOf(overId);
    const dragged = active.rect.current.translated;
    if (!columnIds.has(overId) && dragged && dragged.top > over.rect.top + over.rect.height / 2) index += 1;
    setDragOrder({
      ...dragOrder,
      [from]: dragOrder[from]!.filter((c) => c !== id),
      [to]: [...target.slice(0, index), id, ...target.slice(index)],
    });
  }

  function endDrag() {
    setDragging(null);
    setDragOrder(null);
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    const id = String(active.id);
    const overId = over ? String(over.id) : undefined;
    if (columnIds.has(id)) {
      endDrag();
      const ids = columns.map((c) => c.id);
      if (!overId || overId === id || !columnIds.has(overId)) return;
      const moved = arrayMove(ids, ids.indexOf(id), ids.indexOf(overId));
      const rank = rankAt(moved, moved.indexOf(id), (c) => columns.find((x) => x.id === c)!.rank);
      const column = columns.find((c) => c.id === id)!;
      if (!rank) return failMove('column');
      replaceColumn({ ...column, rank });
      void attempt('Could not move column', async () => replaceColumn(await api.updateColumn(pid, id, { rank })));
      return;
    }

    const current = dragOrder ?? groupCards(columns, board!.cards);
    endDrag();
    const columnId = findColumn(current, id);
    const card = cardsById.get(id);
    if (!columnId || !card) return;
    let ids = current[columnId]!;
    if (overId && overId !== id && ids.includes(overId)) ids = arrayMove(ids, ids.indexOf(id), ids.indexOf(overId));
    const before = groupCards(columns, board!.cards)[card.columnId]!;
    if (columnId === card.columnId && ids.join() === before.join()) return;
    const rank = rankAt(ids, ids.indexOf(id), (c) => cardsById.get(c)!.rank);
    if (!rank) return failMove('card');
    replaceCard({ ...card, columnId, rank });
    void queueCardSave(id, 'Could not move card', async () =>
      replaceCard(await api.updateCard(pid, id, { columnId, rank })),
    );
  }

  function failMove(what: string) {
    toast.error(`Could not move ${what}: no room between its neighbours`);
    void reload();
  }

  function ask(c: Confirm) {
    setConfirm(c);
  }

  const replaceLabel = (label: Label) =>
    update((b) => ({ ...b, labels: b.labels.map((l) => (l.id === label.id ? label : l)) }));

  type CardEdit = { title?: string; description?: string; labelIds?: string[] };
  // Edits only the given fields of the card as it is now, so a server reply does not undo
  // a newer local edit that is still waiting in the queue.
  const patchCard = (id: string, fields: CardEdit) =>
    update((b) => ({ ...b, cards: b.cards.map((c) => (c.id === id ? { ...c, ...fields } : c)) }));

  const saveCard = (card: Card, input: CardEdit) => {
    // Closing the panel of a card just deleted from it flushes unsaved text; drop that save.
    if (deletedCards.current.has(card.id)) return Promise.resolve(true);
    patchCard(card.id, input);
    return queueCardSave(card.id, 'Could not save card', async () => {
      const saved = await api.updateCard(pid, card.id, input);
      patchCard(card.id, Object.fromEntries(Object.keys(input).map((k) => [k, saved[k as keyof CardEdit]])));
    });
  };

  const confirmDeleteCard = (card: Card) =>
    ask({
      title: 'Delete card?',
      description: `This deletes the card "${card.title}". It cannot be undone.`,
      confirmLabel: 'Delete card',
      run: () => {
        deletedCards.current.add(card.id);
        update((b) => ({ ...b, cards: b.cards.filter((c) => c.id !== card.id) }));
        void queueCardSave(card.id, 'Could not delete card', async () => {
          try {
            await api.deleteCard(pid, card.id);
          } catch (err) {
            deletedCards.current.delete(card.id);
            throw err;
          }
        });
      },
    });

  const openCard = openCardId ? cardsById.get(openCardId) : undefined;
  const activeCard = dragging?.kind === 'card' ? cardsById.get(dragging.id) : undefined;
  const activeColumn = dragging?.kind === 'column' ? columns.find((c) => c.id === dragging.id) : undefined;

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        {leading}
        {renaming ? (
          <InlineInput
            className="max-w-sm"
            label="Project name"
            initial={board.project.name}
            maxLength={80}
            onSubmit={(name) =>
              attempt('Could not rename project', async () => {
                const project = await api.renameProject(pid, name);
                update((b) => ({ ...b, project }));
                onRenamed(project);
                setRenaming(false);
              })
            }
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <h1 className="min-w-0 truncate text-lg font-semibold">
            <button
              type="button"
              title="Rename project"
              className="max-w-full truncate rounded px-1 hover:bg-accent"
              onClick={() => setRenaming(true)}
            >
              {board.project.name}
            </button>
          </h1>
        )}
        {labels.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant={activeFilter.length > 0 ? 'outline' : 'ghost'} size="sm" className="ml-auto">
                <ListFilter /> Filter{activeFilter.length > 0 && ` (${activeFilter.length})`}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {labels.map((label) => (
                <DropdownMenuCheckboxItem
                  key={label.id}
                  checked={activeFilter.includes(label.id)}
                  onCheckedChange={(on) =>
                    setFilter(on ? [...activeFilter, label.id] : activeFilter.filter((id) => id !== label.id))
                  }
                  onSelect={(e) => e.preventDefault()}
                >
                  <LabelChip label={label} />
                </DropdownMenuCheckboxItem>
              ))}
              {activeFilter.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setFilter([])}>Clear filter</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Project actions" className={labels.length > 0 ? '' : 'ml-auto'}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
            <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename project</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setManagingLabels(true)}>Manage labels</DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={() =>
                ask({
                  title: 'Delete project?',
                  description: (
                    <>
                      This deletes <strong className="break-words">{board.project.name}</strong> and all its columns and
                      cards. It cannot be undone.
                    </>
                  ),
                  confirmLabel: 'Delete project',
                  run: () =>
                    void attempt('Could not delete project', async () => {
                      await api.deleteProject(pid);
                      onDeleted(pid);
                    }),
                })
              }
            >
              Delete project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="min-h-0 flex-1 overflow-x-auto">
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          accessibility={{ announcements, screenReaderInstructions }}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={endDrag}
        >
          <div className="flex h-full items-start gap-3 p-4">
            <SortableContext items={columns.map((c) => c.id)} strategy={horizontalListSortingStrategy}>
              {columns.map((column) => (
                <ColumnView
                  key={column.id}
                  column={column}
                  cards={(order[column.id] ?? []).flatMap((id) => cardsById.get(id) ?? []).filter(shown)}
                  labels={labels}
                  draggingColumn={dragging?.kind === 'column'}
                  onRename={(name) =>
                    attempt('Could not rename column', async () => {
                      replaceColumn({ ...column, name });
                      replaceColumn(await api.updateColumn(pid, column.id, { name }));
                    })
                  }
                  onDelete={() =>
                    ask({
                      title: 'Delete column?',
                      description: `This deletes the column "${column.name}". Only empty columns can be deleted.`,
                      confirmLabel: 'Delete column',
                      run: () =>
                        void attempt('Could not delete column', async () => {
                          update((b) => ({ ...b, columns: b.columns.filter((c) => c.id !== column.id) }));
                          await api.deleteColumn(pid, column.id);
                        }),
                    })
                  }
                  onAddCard={(title) =>
                    attempt('Could not add card', async () => {
                      const last = (order[column.id] ?? []).at(-1);
                      const rank = rankAfter(last ? cardsById.get(last)?.rank : undefined);
                      const card = await api.createCard(pid, { columnId: column.id, rank, title });
                      update((b) => ({ ...b, cards: [...b.cards, card] }));
                    })
                  }
                  onOpenCard={(card) => setOpenCardId(card.id)}
                  onRenameCard={(card, title) => saveCard(card, { title })}
                  onDeleteCard={confirmDeleteCard}
                />
              ))}
            </SortableContext>

            <div className="w-72 shrink-0">
              {addingColumn ? (
                <InlineInput
                  label="New column name"
                  placeholder="Column name"
                  maxLength={40}
                  onSubmit={(name) =>
                    attempt('Could not add column', async () => {
                      const column = await api.createColumn(pid, { name, rank: rankAfter(columns.at(-1)?.rank) });
                      update((b) => ({ ...b, columns: [...b.columns, column] }));
                      setAddingColumn(false);
                    })
                  }
                  onCancel={() => setAddingColumn(false)}
                />
              ) : (
                <Button variant="outline" className="w-full justify-start" onClick={() => setAddingColumn(true)}>
                  <Plus /> Add column
                </Button>
              )}
            </div>
          </div>

          <DragOverlay>
            {activeCard && (
              <div className="w-68 cursor-grabbing rounded-md border bg-card px-3 py-2 text-sm break-words text-card-foreground shadow-lg">
                {activeCard.title}
              </div>
            )}
            {activeColumn && (
              <div className="w-72 cursor-grabbing rounded-lg border bg-muted p-3 shadow-lg">
                <p className="text-sm font-semibold">{activeColumn.name}</p>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </div>

      <CardPanel
        card={openCard}
        column={columns.find((c) => c.id === openCard?.columnId)}
        labels={labels}
        onSave={saveCard}
        onDelete={confirmDeleteCard}
        onClose={() => setOpenCardId(null)}
      />

      <LabelsDialog
        open={managingLabels}
        onOpenChange={setManagingLabels}
        labels={labels}
        onCreate={(input: { name: string; color: LabelColor }) =>
          attempt('Could not add label', async () => {
            const label = await api.createLabel(pid, input);
            update((b) => ({ ...b, labels: [...b.labels, label] }));
          })
        }
        onUpdate={(label, input) =>
          attempt('Could not save label', async () => {
            replaceLabel({ ...label, ...input });
            replaceLabel(await api.updateLabel(pid, label.id, input));
          })
        }
        onDelete={(label) =>
          ask({
            title: 'Delete label?',
            description: `This removes the label "${label.name}" from the project and from every card.`,
            confirmLabel: 'Delete label',
            run: () =>
              void attempt('Could not delete label', async () => {
                // The server drops the id from cards on read; mirror that here.
                update((b) => ({
                  ...b,
                  labels: b.labels.filter((l) => l.id !== label.id),
                  cards: b.cards.map((c) => ({ ...c, labelIds: c.labelIds.filter((id) => id !== label.id) })),
                }));
                await api.deleteLabel(pid, label.id);
              }),
          })
        }
      />

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ''}
        description={confirm?.description ?? ''}
        confirmLabel={confirm?.confirmLabel ?? ''}
        onConfirm={() => confirm?.run()}
        onOpenChange={(open) => !open && setConfirm(null)}
      />
    </>
  );
}
