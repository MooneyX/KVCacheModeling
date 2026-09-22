import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/execution/node/cli.ts', library: 'src/execution/node/index.ts',
    replay: 'src/execution/node/replay-cli.ts',
    server: 'src/execution/server/main.ts', runner: 'src/execution/server/runner.ts',
    'server-library': 'src/execution/server/http.ts',
  },
  format: ['cjs'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist/node',
  clean: true,
  sourcemap: true,
  outExtension: () => ({ js: '.cjs' }),
});
