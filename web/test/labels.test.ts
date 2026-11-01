import { describe, expect, it } from 'vitest';
import { CHIP_CLASSES, LABEL_COLORS, colorName, matchesFilter } from '../src/board/labels';

describe('matchesFilter', () => {
  it('shows every card when the filter is empty', () => {
    expect(matchesFilter([], [])).toBe(true);
    expect(matchesFilter(['bug'], [])).toBe(true);
  });

  it('shows a card that has any of the filter labels', () => {
    expect(matchesFilter(['bug'], ['bug', 'ui'])).toBe(true);
    expect(matchesFilter(['ui', 'docs'], ['bug', 'ui'])).toBe(true);
  });

  it('hides a card with none of the filter labels', () => {
    expect(matchesFilter([], ['bug'])).toBe(false);
    expect(matchesFilter(['docs'], ['bug', 'ui'])).toBe(false);
  });
});

describe('label colors', () => {
  it('has fixed classes for every palette color', () => {
    expect(Object.keys(CHIP_CLASSES).sort()).toEqual([...LABEL_COLORS].sort());
  });

  it('names colors for display', () => {
    expect(colorName('purple')).toBe('Purple');
  });
});
