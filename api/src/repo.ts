import type { Note } from './notes';

export interface NotesRepo {
  list(): Promise<Note[]>;
  create(note: Note): Promise<void>;
  /** Returns false when no note has this id. */
  delete(id: string): Promise<boolean>;
  ping(): Promise<boolean>;
}
