import { defineConfig } from 'vitest/config';

// Synth bundles the Lambda with esbuild, which takes a few seconds per stack.
export default defineConfig({ test: { testTimeout: 60_000 } });
