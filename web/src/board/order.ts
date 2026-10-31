import { generateKeyBetween } from 'fractional-indexing';
import type { Card, Column } from '../api';

/** Same order as the server: rank, then id. Plain string comparison matches the rank alphabet. */
export function byRank(a: { rank: string; id: string }, b: { rank: string; id: string }): number {
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Card ids per column id, in rank order. */
export type Order = Record<string, string[]>;

export function groupCards(columns: Column[], cards: Card[]): Order {
  const order: Order = Object.fromEntries(columns.map((c) => [c.id, []]));
  for (const card of [...cards].sort(byRank)) order[card.columnId]?.push(card.id);
  return order;
}

export function findColumn(order: Order, cardId: string): string | undefined {
  return Object.keys(order).find((columnId) => order[columnId]!.includes(cardId));
}

const MAX_RANK = 64;

/**
 * A rank for the item at `index` of `ids`, between its neighbours. Undefined when none
 * fits (equal neighbour ranks, or longer than the server accepts): the move then fails.
 */
export function rankAt(ids: string[], index: number, rankOf: (id: string) => string): string | undefined {
  const prev = ids[index - 1];
  const next = ids[index + 1];
  try {
    const rank = generateKeyBetween(prev ? rankOf(prev) : null, next ? rankOf(next) : null);
    return rank.length <= MAX_RANK ? rank : undefined;
  } catch {
    return undefined;
  }
}

export const rankAfter = (last: string | undefined) => generateKeyBetween(last ?? null, null);

const HOUR_MS = 3600 * 1000;

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** "Expires in N days", or in hours on the last day so the final countdown is visible. */
export function expiresIn(expiresAt: number, now = Date.now()): string {
  const hours = Math.floor(Math.max(0, expiresAt * 1000 - now) / HOUR_MS);
  if (hours === 0) return 'Expires within the hour';
  if (hours < 24) return `Expires in ${plural(hours, 'hour')}`;
  return `Expires in ${plural(Math.floor(hours / 24), 'day')}`;
}
