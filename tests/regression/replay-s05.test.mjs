import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createReplayLauncher, createReplayRandomStreams, ReplayEventHeap } from '../../src/core/replay.js';

const { bundle } = JSON.parse(readFileSync(new URL('../fixtures/replay/runtime-prefix.json', import.meta.url)));
const options = { qps: 6, durationSeconds: 5, seed: 42 };
const plan = launcher => {
  const events = [];
  while (launcher.peek()) { const { sessionInstanceKey, ...event } = launcher.take(); events.push(event); }
  return events;
};

test('S05: seeded Poisson launches are lazy, reproducible and independent of routing', () => {
  const before = JSON.stringify(bundle);
  const a = createReplayLauncher(bundle, options);
  const b = createReplayLauncher(bundle, options);
  assert.equal(a.lambdaSession, 2);
  assert.equal(a.launches, 0);
  assert.ok(a.peek().time > 0);
  assert.strictEqual(a.peek(), a.peek());
  for (let i = 0; i < 100; i++) b.routeRandom();
  const actual = plan(a);
  assert.deepEqual(actual, plan(b));
  assert.notDeepEqual(actual, plan(createReplayLauncher(bundle, { ...options, seed: 43 })));
  assert.ok(actual.length > 1);
  assert.ok(actual.every((e, i) => e.time < options.durationSeconds && (!i || e.time > actual[i - 1].time)));
  assert.equal(a.plannedRequests, a.launches * 3);
  assert.equal(a.take(), null);
  assert.equal(JSON.stringify(bundle), before);
});

test('S05: templates cycle and cache namespaces isolate launches and runs', () => {
  const two = structuredClone(bundle);
  two.sessions.push({ req: [{ in: 64, out: 0, blockRuns: [[10, 1]], timing: { kind: 'origin', anchorReq: null, offsetMs: 0 } }] });
  const a = createReplayLauncher(two, options);
  const b = createReplayLauncher(two, options);
  const events = [];
  while (a.peek()) events.push(a.take());
  assert.ok(events.length > 2);
  assert.deepEqual(events.map(e => e.templateIndex), events.map((_, i) => i % 2));
  assert.equal(new Set(events.map(e => e.sessionInstanceKey)).size, events.length);
  assert.notEqual(events[0].sessionInstanceKey, b.take().sessionInstanceKey);
});

test('S05: [0,T) boundary, zero launches, invalid inputs and cumulative limits', () => {
  const first = createReplayLauncher(bundle, options).peek().time;
  assert.equal(createReplayLauncher(bundle, { ...options, durationSeconds: first }).peek(), null);
  assert.equal(createReplayLauncher(bundle, { ...options, qps: 1e-12 }).peek(), null);
  for (const bad of [{ qps: 0 }, { qps: Infinity }, { durationSeconds: 0 }, { seed: -1 }, { seed: 2 ** 32 }, { limits: { maxEvents: 0 } }, { limits: { wat: 1 } }]) {
    assert.throws(() => createReplayLauncher(bundle, { ...options, ...bad }));
  }
  for (const limits of [{ maxSessions: 1 }, { maxRequests: 3 }, { maxBlockReferences: 7 }]) {
    const launcher = createReplayLauncher(bundle, { ...options, limits });
    assert.ok(launcher.take());
    assert.throws(() => launcher.take(), /resource limit/);
    assert.equal(launcher.launches, 1);
    assert.equal(launcher.plannedRequests, 3);
  }
  assert.throws(() => createReplayLauncher(bundle, { ...options, limits: { maxRequests: 2 } }).take(), /plannedRequests/);
});

test('S05: minimum heap preserves timestamp/sequence order including zero-offset insertion', () => {
  const heap = new ReplayEventHeap(1000);
  const random = createReplayRandomStreams(9).launch;
  const expected = [];
  for (let i = 0; i < 1000; i++) expected.push(heap.push(Math.floor(random() * 20), i % 2 ? 'request-arrival' : 'session-launch', i));
  expected.sort((a, b) => a.time - b.time || a.sequence - b.sequence);
  assert.equal(heap.size, 1000);
  assert.throws(() => heap.push(0, 'overflow'), /resource limit/);
  assert.strictEqual(heap.peek(), expected[0]);
  for (const event of expected) assert.deepEqual(heap.pop(), event);
  assert.equal(heap.size, 0);
  assert.equal(heap.pop(), undefined);
  heap.push(0, 'a'); heap.push(0, 'b');
  assert.equal(heap.pop().kind, 'a');
  heap.push(0, 'c');
  assert.equal(heap.pop().kind, 'b');
  assert.equal(heap.pop().kind, 'c');
  assert.throws(() => heap.push(NaN, 'bad'), /finite/);
});
