import { describe, expect, it } from 'vitest';
import type { Card, Column } from '../src/api';
import { byRank, expiresIn, findColumn, groupCards, rankAfter, rankAt } from '../src/board/order';

const NOW = Date.parse('2026-11-01T00:00:00Z');
const MINUTE = 60;
const HOUR = 3600;
const DAY = 24 * HOUR;
/** expiresAt (epoch seconds) for a card that expires `seconds` after NOW. */
const at = (seconds: number) => NOW / 1000 + seconds;

const column = (id: string): Column => ({ id, projectId: 'p', name: id, rank: 'a0', isDone: false });
const card = (id: string, columnId: string, rank: string): Card => ({
  id,
  projectId: 'p',
  columnId,
  rank,
  title: id,
  description: '',
  labelIds: [],
});

describe('expiresIn', () => {
  it('shows 7 days for a card that just entered the done column', () => {
    expect(expiresIn(at(7 * DAY), NOW)).toBe('Expires in 7 days');
    expect(expiresIn(at(7 * DAY - MINUTE), NOW)).toBe('Expires in 7 days');
  });

  it('rounds partial days up', () => {
    expect(expiresIn(at(DAY + HOUR), NOW)).toBe('Expires in 2 days');
    expect(expiresIn(at(DAY), NOW)).toBe('Expires in 1 day');
    expect(expiresIn(at(HOUR), NOW)).toBe('Expires in 1 day');
  });

  it('says today once the time is up', () => {
    expect(expiresIn(at(0), NOW)).toBe('Expires today');
    expect(expiresIn(at(-DAY), NOW)).toBe('Expires today');
  });
});

describe('byRank', () => {
  it('sorts by rank, then id, like the server', () => {
    const items = [
      { rank: 'a1', id: 'a' },
      { rank: 'a0', id: 'b' },
      { rank: 'a0', id: 'a' },
    ];
    expect(items.sort(byRank)).toEqual([
      { rank: 'a0', id: 'a' },
      { rank: 'a0', id: 'b' },
      { rank: 'a1', id: 'a' },
    ]);
  });
});

describe('groupCards and findColumn', () => {
  const columns = [column('todo'), column('done')];

  it('lists every column, with its cards in rank order', () => {
    const cards = [card('x', 'todo', 'a2'), card('y', 'todo', 'a0'), card('z', 'todo', 'a1')];
    expect(groupCards(columns, cards)).toEqual({ todo: ['y', 'z', 'x'], done: [] });
  });

  it('drops cards whose column is unknown', () => {
    expect(groupCards(columns, [card('x', 'gone', 'a0')])).toEqual({ todo: [], done: [] });
  });

  it('finds the column holding a card', () => {
    const order = { todo: ['x'], done: ['y'] };
    expect(findColumn(order, 'y')).toBe('done');
    expect(findColumn(order, 'nope')).toBeUndefined();
  });
});

describe('ranks', () => {
  const ranks: Record<string, string> = { a: 'a0', b: 'a1' };
  const rankOf = (id: string) => ranks[id]!;

  it('places an item between its neighbours', () => {
    const rank = rankAt(['a', 'new', 'b'], 1, rankOf)!;
    expect(rank > 'a0' && rank < 'a1').toBe(true);
  });

  it('places an item before the first or after the last', () => {
    expect(rankAt(['new', 'a'], 0, rankOf)! < 'a0').toBe(true);
    expect(rankAt(['b', 'new'], 1, rankOf)! > 'a1').toBe(true);
  });

  it('gives up when no rank fits', () => {
    expect(rankAt(['a', 'new', 'a'], 1, rankOf)).toBeUndefined();
    const long = 'a0' + 'V'.repeat(62);
    const tight: Record<string, string> = { p: long, n: long + 'V' };
    expect(rankAt(['p', 'new', 'n'], 1, (id) => tight[id]!)).toBeUndefined();
  });

  it('appends after the last rank, or starts a list', () => {
    expect(rankAfter(undefined)).toBe('a0');
    expect(rankAfter('a0')).toBe('a1');
  });
});
