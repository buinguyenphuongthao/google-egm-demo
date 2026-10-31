import type { LabelColor } from '../api';

export const LABEL_COLORS: LabelColor[] = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];

// Fixed class names (never raw CSS from the API); each pair meets WCAG AA in both themes.
export const CHIP_CLASSES: Record<LabelColor, string> = {
  gray: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-100',
  red: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
  orange: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200',
  yellow: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-200',
  green: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200',
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  purple: 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200',
  pink: 'bg-pink-100 text-pink-800 dark:bg-pink-950 dark:text-pink-200',
};

export const colorName = (c: LabelColor) => c[0]!.toUpperCase() + c.slice(1);
