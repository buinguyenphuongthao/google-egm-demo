import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import {
  BOARD_MAX_BODY_BYTES,
  CAPS,
  DEFAULT_COLUMNS,
  buildProject,
  byRank,
  cardExpiry,
  isLive,
  parseCardCreate,
  parseCardUpdate,
  parseColumnCreate,
  parseColumnUpdate,
  parseLabelCreate,
  parseLabelUpdate,
  parseProjectInput,
  smokeExpiry,
  type BoardItem,
  type Card,
  type Column,
  type Label,
  type ParseResult,
  type Project,
} from './board';
import type { BoardRepo } from './board-repo';
import { json, noContent, readJson, type Result, type Route } from './http';

export interface BoardDeps {
  repo: BoardRepo;
  now: () => Date;
  newId: () => string;
}

const ID = '([0-9a-f-]{36})';
const path = (suffix: string) => new RegExp(`^/api/projects${suffix}$`);

const notFound = (what: string) => json(404, { error: `${what} not found` });
const conflict = (error: string) => json(409, { error });
const badRequest = (error: string) => json(400, { error });

type Kind = BoardItem['kind'];
type Of<K extends Kind> = Extract<BoardItem, { kind: K }>;

/** The live items of one project, split by kind. */
class Loaded {
  constructor(readonly items: BoardItem[]) {}
  of<K extends Kind>(kind: K): Of<K>[] {
    return this.items.filter((i): i is Of<K> => i.kind === kind);
  }
  find<K extends Kind>(kind: K, id: string): Of<K> | undefined {
    return this.of(kind).find((i) => i.id === id);
  }
}

function strip<T extends { kind: Kind }>(item: T): Omit<T, 'kind'> {
  const copy: Partial<T> = { ...item };
  delete copy.kind;
  return copy as Omit<T, 'kind'>;
}

export function boardRoutes({ repo, now, newId }: BoardDeps): Route[] {
  async function liveProject(id: string): Promise<Project | undefined> {
    const project = await repo.getProject(id);
    return project && isLive(project, now()) ? project : undefined;
  }

  async function load(projectId: string): Promise<Loaded> {
    const t = now();
    return new Loaded((await repo.listItems(projectId)).filter((i) => isLive(i, t)));
  }

  /** Runs a route for a live project with a parsed body, handling 404/413/400 first. */
  function withBody<T>(
    parse: (body: unknown) => ParseResult<T>,
    run: (project: Project, input: T, params: string[]) => Promise<Result>,
  ) {
    return async (params: string[], event: APIGatewayProxyEventV2) => {
      const project = await liveProject(params[0]!);
      if (!project) return notFound('project');
      const body = readJson(event, BOARD_MAX_BODY_BYTES);
      if (!body.ok) return body.result;
      const parsed = parse(body.value);
      if (!parsed.ok) return badRequest(parsed.error);
      return run(project, parsed.value, params);
    };
  }

  /** Label ids must name live labels of the same project. */
  function checkLabels(board: Loaded, ids: string[] | undefined): string | undefined {
    if (ids?.some((id) => !board.find('label', id))) return 'labelIds must name labels in this project';
  }

  return [
    {
      method: 'GET',
      pattern: path(''),
      async run() {
        const t = now();
        const projects = (await repo.listProjects())
          .filter((p) => isLive(p, t))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return json(200, { projects });
      },
    },
    {
      method: 'POST',
      pattern: path(''),
      async run(_params, event) {
        const body = readJson(event, BOARD_MAX_BODY_BYTES);
        if (!body.ok) return body.result;
        const parsed = parseProjectInput(body.value);
        if (!parsed.ok) return badRequest(parsed.error);
        const t = now();
        const project = buildProject(parsed.value.name, t, newId());
        // Smoke projects are not counted, so a full board cannot fail a deploy's smoke test.
        if (!project.isSmoke) {
          const counted = (await repo.listProjects()).filter((p) => !p.isSmoke && isLive(p, t));
          if (counted.length >= CAPS.projects) return conflict(`at most ${CAPS.projects} projects`);
        }
        const columns: Column[] = DEFAULT_COLUMNS.map((c) => ({
          id: newId(),
          projectId: project.id,
          ...c,
          ...smokeExpiry(project),
        }));
        await repo.createProject(project, columns);
        return json(201, { project });
      },
    },
    {
      method: 'PATCH',
      pattern: path(`/${ID}`),
      run: withBody(parseProjectInput, async (project, { name }) => {
        const updated = { ...project, name };
        return (await repo.updateProject(updated)) ? json(200, { project: updated }) : notFound('project');
      }),
    },
    {
      method: 'DELETE',
      pattern: path(`/${ID}`),
      async run([projectId]) {
        const project = await repo.getProject(projectId!);
        if (!project) return notFound('project');
        // Children first, the project item last: a delete that fails partway leaves a
        // visible project, and deleting it again finishes the job.
        await repo.deleteItems(await repo.listItems(projectId!));
        await repo.deleteProject(projectId!);
        return noContent;
      },
    },
    {
      method: 'GET',
      pattern: path(`/${ID}/board`),
      async run([projectId]) {
        const project = await liveProject(projectId!);
        if (!project) return notFound('project');
        const board = await load(projectId!);
        const labels = board.of('label').map(strip);
        const labelIds = new Set(labels.map((l) => l.id));
        return json(200, {
          project,
          columns: board.of('column').map(strip).sort(byRank),
          // A deleted label's id stays on cards until their next write.
          cards: board
            .of('card')
            .map((c) => ({ ...strip(c), labelIds: c.labelIds.filter((id) => labelIds.has(id)) }))
            .sort(byRank),
          labels: labels.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
        });
      },
    },

    // Columns
    {
      method: 'POST',
      pattern: path(`/${ID}/columns`),
      run: withBody(parseColumnCreate, async (project, input) => {
        const board = await load(project.id);
        if (board.of('column').length >= CAPS.columns) return conflict(`at most ${CAPS.columns} columns`);
        const column: Column = { id: newId(), projectId: project.id, ...input, isDone: false, ...smokeExpiry(project) };
        await repo.createItem({ kind: 'column', ...column });
        return json(201, { column });
      }),
    },
    {
      method: 'PATCH',
      pattern: path(`/${ID}/columns/${ID}`),
      run: withBody(parseColumnUpdate, async (project, input, [, columnId]) => {
        const existing = (await load(project.id)).find('column', columnId!);
        if (!existing) return notFound('column');
        const updated = { ...existing, ...input };
        if (!(await repo.updateItem(updated))) return notFound('column');
        return json(200, { column: strip(updated) });
      }),
    },
    {
      method: 'DELETE',
      pattern: path(`/${ID}/columns/${ID}`),
      async run([projectId, columnId]) {
        if (!(await liveProject(projectId!))) return notFound('project');
        const board = await load(projectId!);
        const column = board.find('column', columnId!);
        if (!column) return notFound('column');
        if (column.isDone) return conflict('the done column cannot be deleted');
        if (board.of('card').some((c) => c.columnId === column.id)) return conflict('column still has cards');
        await repo.deleteItems([column]);
        return noContent;
      },
    },

    // Cards
    {
      method: 'POST',
      pattern: path(`/${ID}/cards`),
      run: withBody(parseCardCreate, async (project, input) => {
        const board = await load(project.id);
        const column = board.find('column', input.columnId);
        if (!column) return badRequest('columnId must name a column in this project');
        const labelError = checkLabels(board, input.labelIds);
        if (labelError) return badRequest(labelError);
        if (board.of('card').length >= CAPS.cards) return conflict(`at most ${CAPS.cards} cards`);
        const card: Card = {
          id: newId(),
          projectId: project.id,
          columnId: column.id,
          rank: input.rank,
          title: input.title,
          description: input.description ?? '',
          labelIds: input.labelIds ?? [],
          ...cardExpiry(project, column, undefined, now()),
        };
        await repo.createItem({ kind: 'card', ...card });
        return json(201, { card });
      }),
    },
    {
      method: 'PATCH',
      pattern: path(`/${ID}/cards/${ID}`),
      run: withBody(parseCardUpdate, async (project, input, [, cardId]) => {
        const board = await load(project.id);
        const existing = board.find('card', cardId!);
        if (!existing) return notFound('card');
        const column = board.find('column', input.columnId ?? existing.columnId);
        if (!column) return badRequest('columnId must name a column in this project');
        const labelError = checkLabels(board, input.labelIds);
        if (labelError) return badRequest(labelError);
        const updated: Of<'card'> = {
          ...existing,
          ...input,
          columnId: column.id,
          // Drop ids of deleted labels on every write.
          labelIds: (input.labelIds ?? existing.labelIds).filter((id) => board.find('label', id)),
        };
        delete updated.doneAt;
        delete updated.expiresAt;
        Object.assign(updated, cardExpiry(project, column, existing, now()));
        if (!(await repo.updateItem(updated))) return notFound('card');
        return json(200, { card: strip(updated) });
      }),
    },
    {
      method: 'DELETE',
      pattern: path(`/${ID}/cards/${ID}`),
      async run([projectId, cardId]) {
        if (!(await liveProject(projectId!))) return notFound('project');
        const card = (await load(projectId!)).find('card', cardId!);
        if (!card) return notFound('card');
        await repo.deleteItems([card]);
        return noContent;
      },
    },

    // Labels
    {
      method: 'POST',
      pattern: path(`/${ID}/labels`),
      run: withBody(parseLabelCreate, async (project, input) => {
        const board = await load(project.id);
        if (board.of('label').length >= CAPS.labels) return conflict(`at most ${CAPS.labels} labels`);
        const label: Label = { id: newId(), projectId: project.id, ...input, ...smokeExpiry(project) };
        await repo.createItem({ kind: 'label', ...label });
        return json(201, { label });
      }),
    },
    {
      method: 'PATCH',
      pattern: path(`/${ID}/labels/${ID}`),
      run: withBody(parseLabelUpdate, async (project, input, [, labelId]) => {
        const existing = (await load(project.id)).find('label', labelId!);
        if (!existing) return notFound('label');
        const updated = { ...existing, ...input };
        if (!(await repo.updateItem(updated))) return notFound('label');
        return json(200, { label: strip(updated) });
      }),
    },
    {
      method: 'DELETE',
      pattern: path(`/${ID}/labels/${ID}`),
      async run([projectId, labelId]) {
        if (!(await liveProject(projectId!))) return notFound('project');
        const label = (await load(projectId!)).find('label', labelId!);
        if (!label) return notFound('label');
        // No cascade: cards keep the id until their next write, and reads drop it.
        await repo.deleteItems([label]);
        return noContent;
      },
    },
  ];
}
