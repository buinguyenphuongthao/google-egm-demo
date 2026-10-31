import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cdk.out/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '.claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', fetch: 'readonly', process: 'readonly' } },
  },
  {
    // CloudFront Functions: the runtime calls the top-level `handler`, and the JS 2.0
    // runtime does not document optional catch binding, so `catch (e)` stays.
    files: ['infra/edge/**/*.js'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^handler$', caughtErrors: 'none' }],
    },
  },
);
