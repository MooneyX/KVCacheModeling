import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runSimulation } from '../../src/core/simulation.js';

const require = createRequire(import.meta.url);
const library = require('../../dist/node/library.cjs');
const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'dist/node/cli.cjs');
const fixtures = JSON.parse(readFileSync(new URL('../fixtures/simulation-baseline.json', import.meta.url), 'utf8'));

for (const fixture of fixtures) {
  test(`built Node library equals source: ${fixture.name}`, () => {
    assert.deepEqual(library.executeJob(fixture), runSimulation(fixture.params, fixture.strategy, fixture.overrides, fixture.mode));
  });
}

test('CLI supports batches, rejects accidental JS execution and protects output files', () => {
  const dir = mkdtempSync(join(root, 'test-results-cli-'));
  try {
    const input = join(dir, 'input.json'), output = join(dir, 'result.json');
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 30_000 });
    writeFileSync(input, JSON.stringify(fixtures.slice(0, 2)));
    const batch = run('--input', input);
    assert.equal(batch.status, 0, batch.stderr);
    assert.deepEqual(JSON.parse(batch.stdout), fixtures.slice(0, 2).map(library.executeJob));
    const saved = run('--input', input, '--output', output);
    assert.equal(saved.status, 0, saved.stderr);
    const before = readFileSync(output, 'utf8');
    assert.equal(run('--input', input, '--output', output).status, 1);
    assert.equal(readFileSync(output, 'utf8'), before);
    writeFileSync(input, JSON.stringify(fixtures.find(f => f.mode === 'js')));
    assert.equal(run('--input', input).status, 1);
    assert.equal(run('--input', input, '--allow-js').status, 0);
    for (const nreq of ['Infinity', -1, 1.5, null]) {
      writeFileSync(input, JSON.stringify({ ...fixtures[0], overrides: { nreq } }));
      assert.equal(run('--input', input).status, 1, `invalid nreq: ${nreq}`);
    }
    writeFileSync(input, '{"params":{},"strategy":{}}');
    assert.equal(run('--input', input).status, 1);
    writeFileSync(input, '{broken json');
    assert.equal(run('--input', input).status, 1);
    assert.equal(run('--help').status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
