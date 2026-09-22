const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const result = spawnSync(process.execPath, [
  path.join(root, 'node_modules/@playwright/test/cli.js'),
  'test', 'tests/integration/cache.spec.mjs', '--project=development',
], { cwd: root, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
