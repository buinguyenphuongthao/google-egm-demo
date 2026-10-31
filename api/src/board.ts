// Kanban board model: input parsing and the rules for expiry, caps, and the done column.
// See docs/plans/2026-10-31-kanban-board-design.md.

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  /** Set once at creation from the name; renaming never changes it. */
  isSmoke: boolean;
  expiresAt?: number;
}

export interface Column {
  id: string;
  projectId: string;
  name: string;
  rank: string;
  isDone: boolean;
  expiresAt?: number;
}

export interface Card {
  id: string;
  projectId: string;
  columnId: string;
  rank: string;
  title: string;
  description: string;
  labelIds: string[];
  doneAt?: string;
  expiresAt?: number;
}

export interface Label {
  id: string;
  projectId: string;
  name: string;
  color: LabelColor;
  expiresAt?: number;
}

export type BoardItem =
  | ({ kind: 'column' } & Column)
  | ({ kind: 'card' } & Card)
  | ({ kind: 'label' } & Label);

export const BOARD_MAX_BODY_BYTES = 16 * 1024;
export const DONE_TTL_SECONDS = 7 * 24 * 3600;
// Smoke projects expire soon in case a smoke run dies before cleaning up.
export const SMOKE_TTL_SECONDS = 3600;
export const SMOKE_PREFIX = 'smoke-';
export const CAPS = { projects: 50, columns: 20, cards: 1000, labels: 30 } as const;
export const LABEL_COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

const LIMITS = {
  projectName: [1, 80],
  columnName: [1, 40],
  title: [1, 200],
  description: [0, 2000],
  labelName: [1, 30],
} as const;
// The fractional-indexing package's base-62 alphabet.
const RANK = /^[0-9A-Za-z]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const DEFAULT_COLUMNS = [
  { name: 'To do', rank: 'a0', isDone: false },
  { name: 'Doing', rank: 'a1', isDone: false },
  { name: 'Done', rank: 'a2', isDone: true },
] as const;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

type Fields = Record<string, unknown>;
type Check = (fields: Fields, out: Fields) => string | undefined;

function asObject(body: unknown): Fields | undefined {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Fields) : undefined;
}

/** Lengths count Unicode code points, after trimming. */
function text(key: string, [min, max]: readonly [number, number]): Check {
  return (fields, out) => {
    const v = fields[key];
    if (typeof v !== 'string') return `${key} must be a string`;
    const trimmed = v.trim();
    const length = [...trimmed].length;
    if (length < min || length > max) return `${key} must be ${min}-${max} characters`;
    out[key] = trimmed;
  };
}

function rank(): Check {
  return (fields, out) => {
    const v = fields.rank;
    if (typeof v !== 'string' || !RANK.test(v)) return 'rank must be 1-64 characters of [0-9A-Za-z]';
    out.rank = v;
  };
}

function id(key: string): Check {
  return (fields, out) => {
    const v = fields[key];
    if (typeof v !== 'string' || !UUID.test(v)) return `${key} must be an id`;
    out[key] = v;
  };
}

function labelIds(): Check {
  return (fields, out) => {
    const v = fields.labelIds;
    if (!Array.isArray(v) || v.length > CAPS.labels) return `labelIds must be an array of at most ${CAPS.labels} ids`;
    if (!v.every((x) => typeof x === 'string' && UUID.test(x))) return 'labelIds must be an array of ids';
    if (new Set(v).size !== v.length) return 'labelIds must be unique';
    out.labelIds = v;
  };
}

function color(): Check {
  return (fields, out) => {
    const v = fields.color;
    if (typeof v !== 'string' || !(LABEL_COLORS as readonly string[]).includes(v)) {
      return `color must be one of ${LABEL_COLORS.join(', ')}`;
    }
    out.color = v;
  };
}

/**
 * Parses a body against named field checks. Required fields must be present; optional
 * ones are checked when present. Unknown fields are rejected so clients cannot set
 * server-owned fields such as expiresAt. An update must change at least one field.
 */
function parse<T>(body: unknown, required: Record<string, Check>, optional: Record<string, Check> = {}): ParseResult<T> {
  const fields = asObject(body);
  if (!fields) return { ok: false, error: 'body must be a JSON object' };
  for (const key of Object.keys(fields)) {
    if (!(key in required) && !(key in optional)) return { ok: false, error: `unknown field: ${key}` };
  }
  const out: Fields = {};
  for (const [key, check] of Object.entries(required)) {
    if (fields[key] === undefined) return { ok: false, error: `${key} is required` };
    const error = check(fields, out);
    if (error) return { ok: false, error };
  }
  for (const [key, check] of Object.entries(optional)) {
    if (fields[key] === undefined) continue;
    const error = check(fields, out);
    if (error) return { ok: false, error };
  }
  if (Object.keys(out).length === 0) return { ok: false, error: 'nothing to update' };
  return { ok: true, value: out as T };
}

export const parseProjectInput = (body: unknown) =>
  parse<{ name: string }>(body, { name: text('name', LIMITS.projectName) });

export const parseColumnCreate = (body: unknown) =>
  parse<{ name: string; rank: string }>(body, { name: text('name', LIMITS.columnName), rank: rank() });

export const parseColumnUpdate = (body: unknown) =>
  parse<{ name?: string; rank?: string }>(body, {}, { name: text('name', LIMITS.columnName), rank: rank() });

export const parseCardCreate = (body: unknown) =>
  parse<{ columnId: string; rank: string; title: string; description?: string; labelIds?: string[] }>(
    body,
    { columnId: id('columnId'), rank: rank(), title: text('title', LIMITS.title) },
    { description: text('description', LIMITS.description), labelIds: labelIds() },
  );

export const parseCardUpdate = (body: unknown) =>
  parse<{ columnId?: string; rank?: string; title?: string; description?: string; labelIds?: string[] }>(
    body,
    {},
    {
      columnId: id('columnId'),
      rank: rank(),
      title: text('title', LIMITS.title),
      description: text('description', LIMITS.description),
      labelIds: labelIds(),
    },
  );

export const parseLabelCreate = (body: unknown) =>
  parse<{ name: string; color: LabelColor }>(body, { name: text('name', LIMITS.labelName), color: color() });

export const parseLabelUpdate = (body: unknown) =>
  parse<{ name?: string; color?: LabelColor }>(body, {}, { name: text('name', LIMITS.labelName), color: color() });

const epoch = (now: Date) => Math.floor(now.getTime() / 1000);

export function buildProject(name: string, now: Date, id: string): Project {
  const isSmoke = name.startsWith(SMOKE_PREFIX);
  const project: Project = { id, name, createdAt: now.toISOString(), isSmoke };
  if (isSmoke) project.expiresAt = epoch(now) + SMOKE_TTL_SECONDS;
  return project;
}

/** Items in a smoke project share the project's expiry, which nothing else changes. */
export function smokeExpiry(project: Project): { expiresAt?: number } {
  return project.isSmoke ? { expiresAt: project.expiresAt } : {};
}

/**
 * A card's doneAt and expiresAt after it is written into `column`. In a normal project a
 * card entering the done column gets 7 days; staying there keeps its clock; leaving it
 * clears both. Smoke project items keep the project's expiry.
 */
export function cardExpiry(
  project: Project,
  column: Column,
  previous: Pick<Card, 'columnId' | 'doneAt' | 'expiresAt'> | undefined,
  now: Date,
): { doneAt?: string; expiresAt?: number } {
  if (project.isSmoke) return smokeExpiry(project);
  if (!column.isDone) return {};
  if (previous?.columnId === column.id && previous.doneAt) {
    return { doneAt: previous.doneAt, expiresAt: previous.expiresAt };
  }
  return { doneAt: now.toISOString(), expiresAt: epoch(now) + DONE_TTL_SECONDS };
}

/** DynamoDB TTL deletes lazily, so anything past expiresAt is treated as gone. */
export function isLive(item: { expiresAt?: number }, now: Date): boolean {
  return item.expiresAt === undefined || item.expiresAt > epoch(now);
}

export function byRank(a: { rank: string; id: string }, b: { rank: string; id: string }): number {
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
