// Client for the board API (/api/projects/...). Shapes match api/src/board.ts.

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  isSmoke: boolean;
}

export interface Column {
  id: string;
  projectId: string;
  name: string;
  rank: string;
  isDone: boolean;
}

export interface Card {
  id: string;
  projectId: string;
  columnId: string;
  rank: string;
  title: string;
  description: string;
  labelIds: string[];
  /** Epoch seconds; set by the server for cards in the done column. */
  expiresAt?: number;
}

export type LabelColor = 'gray' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink';

export interface Label {
  id: string;
  projectId: string;
  name: string;
  color: LabelColor;
}

export interface Board {
  project: Project;
  columns: Column[];
  cards: Card[];
  labels: Label[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const send = <T>(method: string, path: string, body?: unknown) =>
  request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

const projectPath = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

export const listProjects = () => request<{ projects: Project[] }>('/api/projects').then((r) => r.projects);
export const createProject = (name: string) =>
  send<{ project: Project }>('POST', '/api/projects', { name }).then((r) => r.project);
export const renameProject = (id: string, name: string) =>
  send<{ project: Project }>('PATCH', projectPath(id), { name }).then((r) => r.project);
export const deleteProject = (id: string) => send<void>('DELETE', projectPath(id));

export const getBoard = (projectId: string) => request<Board>(`${projectPath(projectId)}/board`);

export const createColumn = (projectId: string, input: { name: string; rank: string }) =>
  send<{ column: Column }>('POST', `${projectPath(projectId)}/columns`, input).then((r) => r.column);
export const updateColumn = (projectId: string, id: string, input: { name?: string; rank?: string }) =>
  send<{ column: Column }>('PATCH', `${projectPath(projectId)}/columns/${id}`, input).then((r) => r.column);
export const deleteColumn = (projectId: string, id: string) =>
  send<void>('DELETE', `${projectPath(projectId)}/columns/${id}`);

export const createCard = (projectId: string, input: { columnId: string; rank: string; title: string }) =>
  send<{ card: Card }>('POST', `${projectPath(projectId)}/cards`, input).then((r) => r.card);
export const updateCard = (
  projectId: string,
  id: string,
  input: { columnId?: string; rank?: string; title?: string; description?: string; labelIds?: string[] },
) => send<{ card: Card }>('PATCH', `${projectPath(projectId)}/cards/${id}`, input).then((r) => r.card);
export const deleteCard = (projectId: string, id: string) =>
  send<void>('DELETE', `${projectPath(projectId)}/cards/${id}`);

export const createLabel = (projectId: string, input: { name: string; color: LabelColor }) =>
  send<{ label: Label }>('POST', `${projectPath(projectId)}/labels`, input).then((r) => r.label);
export const updateLabel = (projectId: string, id: string, input: { name?: string; color?: LabelColor }) =>
  send<{ label: Label }>('PATCH', `${projectPath(projectId)}/labels/${id}`, input).then((r) => r.label);
export const deleteLabel = (projectId: string, id: string) =>
  send<void>('DELETE', `${projectPath(projectId)}/labels/${id}`);
