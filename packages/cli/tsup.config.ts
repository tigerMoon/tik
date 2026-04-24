import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  banner: { js: '#!/usr/bin/env node' },
  external: [
    '@tik/shared',
    '@tik/kernel',
    '@tik/sight',
    '@tik/ace',
    '@anthropic-ai/sdk',
  ],
});
