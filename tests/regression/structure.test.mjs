import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from 'acorn';
import { legacyCode } from '../fixtures/legacy-loader.mjs';

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');
const tokenValues = text => {
  const tokens = [];
  parse(text, { ecmaVersion: 'latest', sourceType: 'module', onToken: tokens });
  return tokens.map(token => [token.type.label, token.value]);
};

test('frozen legacy input retains its original checksum', () => {
  const manifest = JSON.parse(read('../fixtures/legacy/manifest.json'));
  assert.equal(createHash('sha256').update(read('../fixtures/legacy/index.html')).digest('hex'), manifest.files['index.html']);
});

test('synthetic sampling and grouping remain token-identical behind the shared source boundary', () => {
  const ast = parse(legacyCode, { ecmaVersion: 'latest' });
  const original = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'runSimulation');
  let expected = legacyCode.slice(original.start, original.end)
    .replace('function runSimulation(strategy, overrides)', 'export function runSimulation(params, strategy, overrides, strategyMode = "dsl")')
    .replace('let p = getParams();', 'let p = JSON.parse(JSON.stringify(params));');
  const start = expected.indexOf('  let N = overrides.nreq');
  const end = expected.indexOf('    // S4: 把前缀组表分发给各实例。');
  const requests = expected.slice(start, end);
  expected = expected.slice(0, start) + '  let { N, requests } = generateRequests(p, overrides, rng, prefixGroupMap);\n  if (p.prefixHit > 0.001) {\n' + expected.slice(end);
  const source = read('../../src/core/simulation.js');
  const engine = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body.find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'runSimulation');
  assert.equal(engine.declaration.params.length, 4);
  assert.match(source, /const source = replay \|\| createSyntheticRuntime\(p, overrides, rng, prefixGroupMap,/);
  assert.match(source, /createReplayRuntime\(overrides\.replay/);
  for (const call of ['drainEvents', 'complete', 'fail', 'counts']) assert.ok(source.includes(`source.${call}(`));
  assert.match(source, /let _allDone = source\.done/);
  assert.doesNotMatch(source, /pending\.push\(fu\)|followUpCount\+\+|rng\(\) < p\.multiTurn/);
  const requestSource = read('../../src/core/requests.js');
  const generator = parse(requestSource, { ecmaVersion: 'latest', sourceType: 'module' }).body.find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'generateRequests');
  const oldInitializer = requests.match(/requests\.push\(\{ id: i,[\s\S]*?_recomputeTok: 0 \}\);/)[0];
  const sharedInitializer = 'requests.push(createRequest(i, t, inLen, outLen, { sessionId, routingKey: sessionId }));';
  const generated = requestSource.slice(generator.start, generator.end);
  assert.ok(generated.includes(sharedInitializer));
  const normalized = generated.replace('const sessionId = `synthetic:${i}`;', '')
    .replace(sharedInitializer, oldInitializer).replace('requests.forEach(req => setSyntheticContent(req));', '');
  assert.deepEqual(tokenValues(normalized), tokenValues('export function generateRequests(p, overrides, rng, prefixGroupMap) {\n' + requests + '}\nreturn {N, requests};\n}'));
});

test('all calculation and DSL expressions are token-identical to baseline', () => {
  const ast = parse(legacyCode, { ecmaVersion: 'latest' });
  const originals = new Map(ast.body.filter(n => n.type === 'FunctionDeclaration').map(n => [n.id.name, legacyCode.slice(n.start, n.end)]));
  for (const file of ['calculations.js', 'math.js', 'strategy.js']) {
    const source = read('../../src/core/' + file);
    for (const node of parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body) {
      if (node.type !== 'ExportNamedDeclaration' || node.declaration?.type !== 'FunctionDeclaration') continue;
      const fn = node.declaration;
      assert.deepEqual(tokenValues(source.slice(fn.start, fn.end)), tokenValues(originals.get(fn.id.name)), fn.id.name);
    }
  }
});

test('browser execution cannot load the simulation engine or create calculation Workers', () => {
  for (const folder of ['../../src/ui/', '../../src/execution/browser/', '../../src/adapters/browser/']) {
    for (const file of readdirSync(new URL(folder, import.meta.url)).filter(f => /\.(js|ts)$/.test(f))) {
      assert.doesNotMatch(read(folder + file), /from\s+['"][^'"]*core\/simulation|new Worker\(/, folder + file);
    }
  }
});

test('runtime core imports no browser adapters and sim scripts no longer scrape HTML', () => {
  for (const file of readdirSync(new URL('../../src/core/', import.meta.url))) {
    const source = read('../../src/core/' + file);
    assert.doesNotMatch(source, /from\s+['"][^'"]*(?:ui|adapters|execution)\//);
  }
  for (const file of readdirSync(new URL('../../scripts/legacy/sim/', import.meta.url)).filter(file => file.endsWith('.js'))) {
    const source = read('../../scripts/legacy/sim/' + file);
    assert.doesNotMatch(source, /matchAll\(\/<script>|eval\(js\)|eval\)\(code|global\.document\s*=|scripts\.length/, file);
  }
});
