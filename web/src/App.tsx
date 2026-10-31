import { useEffect, useState, type FormEvent } from 'react';
import { MAX_TEXT_LENGTH, createNote, deleteNote, listNotes, type Note } from './api';

export function App() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listNotes()
      .then(setNotes)
      .catch(() => setError('Could not load notes'))
      .finally(() => setLoading(false));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const note = await createNote(text);
      setNotes((prev) => [note, ...prev]);
      setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save note');
    }
  }

  async function onDelete(id: string) {
    setError(null);
    try {
      await deleteNote(id);
      setNotes((prev) => prev.filter((n) => n.id !== id));
    } catch {
      setError('Could not delete note');
    }
  }

  return (
    <main>
      <h1>Notes</h1>
      <form onSubmit={onSubmit}>
        <label htmlFor="note-text">New note</label>
        <textarea
          id="note-text"
          value={text}
          maxLength={MAX_TEXT_LENGTH}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" disabled={text.trim().length === 0}>
          Save
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <p>Loading…</p>
      ) : (
        <ul aria-label="Notes">
          {notes.map((note) => (
            <li key={note.id}>
              <span>{note.text}</span>
              <button type="button" aria-label={`Delete note: ${note.text}`} onClick={() => onDelete(note.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
