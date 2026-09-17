import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/execution/node/cli.ts', library: 'src/execution/node/index.ts' },
  format: ['cjs'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist/node',
  clean: true,
  sourcemap: true,
  outExtension: () => ({ js: '.cjs' }),
});
