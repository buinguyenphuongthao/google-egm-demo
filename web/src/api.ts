export interface Note {
  id: string;
  text: string;
  createdAt: string;
}

export const MAX_TEXT_LENGTH = 500;

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

export const listNotes = () => request<{ notes: Note[] }>('/api/notes').then((r) => r.notes);

export const createNote = (text: string) =>
  request<{ note: Note }>('/api/notes', { method: 'POST', body: JSON.stringify({ text }) }).then((r) => r.note);

export const deleteNote = (id: string) =>
  request<void>(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' });
