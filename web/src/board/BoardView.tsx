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
import { MoreHorizontal, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import * as api from '../api';
import type { Board, Card, Column, Project } from '../api';
import { InlineInput } from '../components/InlineInput';
import { ConfirmDialog } from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { ColumnView } from './ColumnView';
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

export function BoardView({ projectId, leading, onRenamed, onDeleted }: Props) {
  const [board, setBoard] = useState<Board | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [addingColumn, setAddingColumn] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [dragging, setDragging] = useState<Dragging | null>(null);
  // Card order while a card is dragged between columns; null otherwise.
  const [dragOrder, setDragOrder] = useState<Order | null>(null);

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

  const update = (change: (b: Board) => Board) => setBoard((b) => b && change(b));
  const replaceCard = (card: Card) => update((b) => ({ ...b, cards: b.cards.map((c) => (c.id === card.id ? card : c)) }));
  const replaceColumn = (column: Column) =>
    update((b) => ({ ...b, columns: b.columns.map((c) => (c.id === column.id ? column : c)) }));

  const columns = useMemo(() => (board ? [...board.columns].sort(byRank) : []), [board]);
  const cardsById = useMemo(() => new Map(board?.cards.map((c) => [c.id, c])), [board]);
  const columnIds = useMemo(() => new Set(columns.map((c) => c.id)), [columns]);
  const order = useMemo(() => dragOrder ?? groupCards(columns, board?.cards ?? []), [dragOrder, columns, board]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
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
    void attempt('Could not move card', async () => replaceCard(await api.updateCard(pid, id, { columnId, rank })));
  }

  function failMove(what: string) {
    toast.error(`Could not move ${what}: no room between its neighbours`);
    void reload();
  }

  function ask(c: Confirm) {
    setConfirm(c);
  }

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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Project actions">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
            <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename project</DropdownMenuItem>
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
          accessibility={{ announcements }}
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
                  cards={(order[column.id] ?? []).flatMap((id) => cardsById.get(id) ?? [])}
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
                  onRenameCard={(card, title) =>
                    attempt('Could not rename card', async () => {
                      replaceCard({ ...card, title });
                      replaceCard(await api.updateCard(pid, card.id, { title }));
                    })
                  }
                  onDeleteCard={(card) =>
                    ask({
                      title: 'Delete card?',
                      description: `This deletes the card "${card.title}". It cannot be undone.`,
                      confirmLabel: 'Delete card',
                      run: () =>
                        void attempt('Could not delete card', async () => {
                          update((b) => ({ ...b, cards: b.cards.filter((c) => c.id !== card.id) }));
                          await api.deleteCard(pid, card.id);
                        }),
                    })
                  }
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
