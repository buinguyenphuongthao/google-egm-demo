import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';

const KEY = 'theme';
const media = () => window.matchMedia('(prefers-color-scheme: dark)');

function stored(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    // Storage can be blocked; fall back to the system setting.
  }
  return 'system';
}

function apply(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && media().matches);
  document.documentElement.classList.toggle('dark', dark);
}

/** Applies the saved theme before first render, so the page does not flash. */
export function initTheme() {
  apply(stored());
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(stored);

  useEffect(() => {
    apply(theme);
    try {
      if (theme === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    } catch {
      // Not saved; the choice still applies to this page.
    }
    if (theme !== 'system') return;
    const query = media();
    const onChange = () => apply('system');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [theme]);

  return [theme, setTheme];
}
