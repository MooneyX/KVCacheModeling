import { ReplayValidationError } from './replay.js';

function contentPageKey(parts, resourceId) {
  return JSON.stringify(['content', resourceId, parts]);
}

export function replayPageKey(instance, blockId, tokens = 64, resourceId = 'default') {
  return contentPageKey([[JSON.stringify(['replay', instance, 'input', blockId]), 0, tokens]], resourceId);
}

export function createReplayCache({ pool, pools = { hbm: pool }, blockBytes, add, remove,
  maxBlockReferences = 200000, resourceId = 'default', tierRatio = {},
  finiteCapacity = false, links = {}, l3Bandwidth = null, canSchedule = () => true, onEvent = () => {} }) {
  pool ??= pools.hbm;
  const resources = { ...pools, hbm: pool };
  const states = new WeakMap();
  const prefetches = new WeakMap(), pulls = new Map(), transfers = new Set();
  const bindings = new Map(), fetchInitialized = new WeakSet();
  let sequence = 0, deduplicatedPages = 0, transferSequence = 0, clock = 0;
  const tiers = ['hbm', 'dram', 'ssd'];
  const sizeAt = (item, tier) => item.size * (tierRatio[tier] ?? 1);
  const emit = (type, time, details = {}) => onEvent({ type, time, resourceId, ...details });
  const accessible = (item, now) => !!item && item.available && item.ready
    && item._published && !item._moving && (item.arriveAt ?? 0) <= now;
  const lock = item => {
    if (!item._cacheLocks) item._cacheWasLocked = !!item.transferLocked;
    item._cacheLocks = (item._cacheLocks || 0) + 1;
    item.transferLocked = true;
  };
  const unlock = item => {
    item._cacheLocks = Math.max(0, (item._cacheLocks || 0) - 1);
    item.transferLocked = item._cacheLocks > 0 || !!item._cacheWasLocked;
  };
  const residentCount = () => [...new Set(Object.values(resources))].reduce((n, p) => n + p.blocks.length, 0);
  const checkLimit = count => {
    if (count > maxBlockReferences) {
      throw new ReplayValidationError('replay.cache', 'physical block resource limit exceeded');
    }
  };
  const ready = (item, now) => !!item && item.available && item.ready
    && (!finiteCapacity || !item._moving)
    && (item.arriveAt ?? 0) <= now && (!item.tier || item.tier === 'hbm');
  const result = (inputTokens, hitL1Tokens) => ({ status: 'admitted', inputTokens, hitL1Tokens,
    hitL2Tokens: 0, hitL3Tokens: 0, missTokens: inputTokens - hitL1Tokens });

  function* pages(content) {
    let parts = [], tokens = 0, position = 0, count = 0, expected;
    for (const segment of content) {
      if (typeof segment.pathId !== 'string' || !Number.isSafeInteger(segment.tokens) || segment.tokens <= 0
        || !Number.isSafeInteger(segment.position) || segment.position < 0
        || (expected !== undefined && segment.position !== expected)) {
        throw new ReplayValidationError('replay.cache', 'invalid content segment');
      }
      expected = segment.position + segment.tokens;
      let offset = 0;
      while (offset < segment.tokens) {
        const take = Math.min(64 - tokens, segment.tokens - offset);
        parts.push([segment.pathId, offset, take]);
        offset += take;
        tokens += take;
        if (tokens === 64) {
          checkLimit(++count);
          yield { key: contentPageKey(parts, resourceId), tokens, position };
          position += tokens;
          parts = []; tokens = 0;
        }
      }
    }
    if (tokens) {
      checkLimit(++count);
      yield { key: contentPageKey(parts, resourceId), tokens, position };
    }
  }

  function finitePlan(req, now) {
    const count = Math.ceil(req.inputLen / 64), slots = [];
    if (count * blockBytes > pool.cap) return { response: { status: 'infeasible' } };
    checkLimit(count);
    const response = result(0, 0);
    let matching = true;
    for (const description of pages(req.inputContent)) {
      let tier = null, item = null;
      if (matching) {
        for (const candidate of tiers) {
          const found = resources[candidate]?.blockIndex[description.key];
          if (accessible(found, now)) { tier = candidate; item = found; break; }
        }
      }
      if (!item) matching = false;
      const slot = { ...description, tier, hit: !!item, version: item?.version ?? 0 };
      slots.push(slot);
      response.inputTokens += slot.tokens;
      if (tier) response[`hitL${tiers.indexOf(tier) + 1}Tokens`] += slot.tokens;
      else response.missTokens += slot.tokens;
    }
    if (response.inputTokens !== req.inputLen) throw new ReplayValidationError('replay.cache', 'content length does not match input length');
    const missing = slots.filter(slot => !ready(pool.blockIndex[slot.key], now)).length;
    if (pool.used + missing * blockBytes > pool.cap) response.status = 'wait';
    return { slots, response };
  }

  function plan(req, now) {
    if (finiteCapacity) return finitePlan(req, now);
    const count = Math.ceil(req.inputLen / 64);
    if (count * blockBytes > pool.cap) return { response: { status: 'infeasible' } };
    checkLimit(count);
    const slots = [];
    let matching = true, hitTokens = 0, inputTokens = 0, missing = 0;
    for (const slot of pages(req.inputContent)) {
      slot.hit = matching && ready(pool.blockIndex[slot.key], now);
      if (slot.hit) hitTokens += slot.tokens;
      else { matching = false; missing++; }
      inputTokens += slot.tokens;
      slots.push(slot);
    }
    if (inputTokens !== req.inputLen) throw new ReplayValidationError('replay.cache', 'content length does not match input length');
    const response = result(inputTokens, hitTokens);
    if (pool.used + missing * blockBytes > pool.cap) return { slots, response: { ...response, status: 'wait' } };
    checkLimit(residentCount() + missing);
    return { slots, response };
  }

  function block(id, tokens, req, now, output = false) {
    return { id, tokens, size: blockBytes, refcount: 1, available: true, ready: false,
      arriveAt: 0, shared: !output, groupId: null, reqId: req?.id ?? null, lastTouch: now,
      output, _contentResource: resourceId, _published: false };
  }

  function publishPage(id, now) {
    const item = pool.blockIndex[id];
    if (!item) throw new Error('Replay cache invariant: missing private page');
    const key = item.canonicalKey;
    const existing = key && pool.blockIndex[key];
    item.ready = true;
    item._published = true;
    item.lastTouch = now;
    if (!key) return id;
    if (ready(existing, now)) {
      existing.refcount += item.refcount;
      existing.lastTouch = now;
      remove('hbm', id);
      deduplicatedPages++;
      return key;
    }
    if (existing?.refcount > 0 || (finiteCapacity && existing?.transferLocked)) return id;
    if (existing) remove('hbm', key);
    remove('hbm', id);
    item.id = key;
    delete item.canonicalKey;
    add('hbm', item);
    return key;
  }

  function publishInput(id, now) {
    const item = pool.blockIndex[id], key = publishPage(id, now), target = pool.blockIndex[key];
    const refs = bindings.get(item) || new Set();
    for (const binding of refs) {
      binding.entry.id = key;
      binding.req.ownBlkIds = binding.req.ownBlkIds.filter(oldId => oldId !== id);
      if (!binding.req.prefixBlkIds.includes(key)) binding.req.prefixBlkIds.push(key);
      binding.state.privateIds = binding.state.privateIds.filter(oldId => oldId !== id);
    }
    if (target !== item) {
      if (!bindings.has(target)) bindings.set(target, new Set());
      for (const binding of refs) bindings.get(target).add(binding);
      bindings.delete(item);
    }
    for (const pull of pulls.values()) for (const task of pull.tasks) {
      if (task.target !== item) continue;
      if (target !== item && task.targetHeld) { unlock(item); lock(target); }
      task.target = target;
    }
    return target;
  }

  function transferEvent(record) {
    return { transferId: record.id, from: record.from, to: record.to, move: record.move,
      prefetch: record.prefetch, layer: record.from === 'hbm' || record.to === 'hbm' ? 'l2' : 'l3', key: record.source.id };
  }

  function account(record, now) {
    const fraction = record.end === record.start ? Number(now >= record.end)
      : Math.max(0, Math.min(1, (now - record.start) / (record.end - record.start)));
    const bytes = record.bytes * fraction;
    const delta = bytes - record.accounted;
    if (delta > 0) {
      record.accounted = bytes;
      emit('transfer-progress', now, { ...transferEvent(record), bytes: delta });
    }
  }

  function privatize(target, tier) {
    if (target.canonicalKey || target.ready) return;
    const oldId = target.id;
    remove(tier, oldId);
    target.id = JSON.stringify(['cancelled-pull', resourceId, sequence++]);
    target.canonicalKey = oldId;
    target._published = false;
    target.arriveAt = 0;
    add(tier, target);
    for (const { req, state, entry } of bindings.get(target) || []) {
      entry.id = target.id;
      req.prefixBlkIds = req.prefixBlkIds.filter(id => id !== oldId);
      if (!req.ownBlkIds.includes(target.id)) req.ownBlkIds.push(target.id);
      if (!state.privateIds.includes(target.id)) state.privateIds.push(target.id);
    }
  }

  function retire(record, now, cancelled = false) {
    if (!transfers.has(record)) return;
    account(record, now);
    transfers.delete(record);
    unlock(record.source);
    unlock(record.target);
    if (record.move) record.source._moving = false;
    record.cancelled = cancelled;
    record.completed = !cancelled;
    if (cancelled) {
      if (!record.target.ready) {
        if (record.target.refcount === 0) remove(record.to, record.target.id);
        else privatize(record.target, record.to);
      }
    } else {
      record.target.ready = true;
      record.target.available = true;
      record.target.arriveAt = record.end;
      record.target.lastTouch = record.end;
      record.target._published = record.source._published;
      if (record.prefetch && record.to === 'hbm' && record.target.canonicalKey)
        record.target = publishInput(record.target.id, record.end);
      if (record.move && record.fromPool.blockIndex[record.source.id] === record.source) remove(record.from, record.source.id);
    }
    emit(cancelled ? 'transfer-cancel' : 'transfer-complete', now, transferEvent(record));
  }

  function transfer(item, from, to, now, { move = false, target = null, fixedSeconds = 0, prefetch = false } = {}) {
    if (!canSchedule(now)) return null;
    const fromPool = resources[from], toPool = resources[to], link = links[`${from}>${to}`];
    if (!fromPool || !toPool || !link || !(link.bw > 0) || !Number.isFinite(link.bw)) return null;
    if (fromPool.blockIndex[item.id] !== item || !item.ready || !item.available) return null;
    if (move && (item.refcount > 0 || item.pinned || item.transferLocked)) return null;
    const existing = toPool.blockIndex[item.id];
    if (target) {
      const inFlight = [...transfers].find(record => record.target === target);
      if (inFlight) return inFlight;
    }
    if (!target && existing) {
      if (accessible(existing, now)) {
        if (move) remove(from, item.id);
        return { completed: true, end: now, target: existing };
      }
      return [...transfers].find(record => record.target === existing) || null;
    }
    if (!target) {
      if (toPool.used + sizeAt(item, to) > toPool.cap) return null;
      checkLimit(residentCount() + 1);
      target = { ...item, refcount: 0, tier: to, ready: false, available: true,
        transferLocked: false, _cacheLocks: 0, _cacheWasLocked: false };
      add(to, target);
    }
    const queueStart = Math.max(now, link.busyUntil || 0, link.shared?.busyUntil || 0);
    const start = queueStart + fixedSeconds;
    const bandwidth = prefetch && from === 'ssd' && l3Bandwidth > 0 ? l3Bandwidth : link.bw;
    const bytes = sizeAt(item, from) * Math.min(1, (item.tokens ?? 64) / 64), end = start + bytes / bandwidth;
    link.busyUntil = end;
    if (link.shared) link.shared.busyUntil = end;
    target.arriveAt = end;
    lock(item); lock(target);
    if (move) item._moving = true;
    const record = { id: transferSequence++, from, to, fromPool, toPool, source: item, target,
      reservation: sizeAt(target, to), queueStart, start, end, bytes, accounted: 0, move, prefetch, bandwidth, link };
    transfers.add(record);
    emit('transfer-start', now, { ...transferEvent(record), start, end, bytes, reservation: record.reservation });
    return record;
  }

  function ensureSpace(tier, bytes, now, protectedPages = new Set()) {
    const target = resources[tier];
    if (!target || bytes > target.cap) return 'infeasible';
    if (target.used + bytes <= target.cap) return 'admitted';
    const promised = () => [...transfers].reduce((sum, record) => sum
      + (record.move && record.fromPool === target ? sizeAt(record.source, tier) : 0), 0);
    const candidates = target.blocks.filter(item => item.available && item.ready && !item.refcount
      && !item.pinned && !item.transferLocked && !protectedPages.has(item))
      .sort((a, b) => (a.lastTouch || 0) - (b.lastTouch || 0) || String(a.id).localeCompare(String(b.id)));
    for (const item of candidates) {
      if (target.used + bytes <= target.cap) return 'admitted';
      if (target.used - promised() + bytes <= target.cap) return 'wait';
      const next = tiers[tiers.indexOf(tier) + 1];
      const moved = next && transfer(item, tier, next, now, { move: true });
      if (moved) emit('evict', now, { key: item.id, from: tier, to: next, bytes: sizeAt(item, tier) });
      else {
        remove(tier, item.id);
        emit('drop', now, { key: item.id, tier, bytes: sizeAt(item, tier) });
      }
    }
    return target.used + bytes <= target.cap ? 'admitted' : 'wait';
  }

  function finishFetch(subscription, now) {
    if (subscription.pull.tasks.every(task => task.done || task.cancelled || !task.subscribers.has(subscription))) {
      subscription.finishedAt ??= now;
      if (subscription.req._ft0 != null) subscription.req._ft1 ??= now;
    }
  }

  function finishIntermediate(task) {
    const item = task.intermediate, target = resources.dram;
    if (!item || !item.ready || item.transferLocked || target.blockIndex[item.id] !== item) return;
    const key = item.canonicalKey, existing = target.blockIndex[key];
    if (!key || (existing && !existing.ready)) return;
    remove('dram', item.id);
    if (!existing) { item.id = key; delete item.canonicalKey; add('dram', item); }
    task.intermediate = null;
  }

  function pullTarget(source, key, tier, independent) {
    const target = { ...source, id: independent ? JSON.stringify(['pull', resourceId, sequence++, tier]) : key,
      refcount: 0, tier, ready: false, available: true, _published: false,
      transferLocked: false, _cacheLocks: 0, _cacheWasLocked: false };
    if (independent) target.canonicalKey = key;
    else delete target.canonicalKey;
    add(tier, target);
    return target;
  }

  function progressPull(pull, now) {
    if (!pull.subscribers.size) return;
    for (const task of pull.tasks) {
      if (task.cancelled || task.done) continue;
      if (task.record && transfers.has(task.record)) continue;
      if (task.record?.cancelled) { task.cancelled = true; continue; }
      if (task.record?.completed) {
        task.record.owners?.delete(task);
        if (task.sourceHeld) { unlock(task.originalSource); task.sourceHeld = false; }
        if (task.record.to === 'hbm') { task.done = true; finishIntermediate(task); continue; }
        task.source = task.record.target;
        task.from = task.record.to;
        task.record = null;
      }
      if (accessible(task.target, now)) { task.done = true; continue; }
      if (!canSchedule(now)) continue;
      if (task.from === 'ssd' && pull.policy.coalesce) {
        const intermediate = resources.dram?.blockIndex[task.slot.key];
        if (accessible(intermediate, now)) { task.source = intermediate; task.from = 'dram'; }
      }
      const to = task.from === 'ssd' ? 'dram' : 'hbm', link = links[`${task.from}>${to}`];
      if (!link || !(link.bw > 0) || !Number.isFinite(link.bw)) { task.cancelled = true; continue; }
      let target = to === 'hbm' ? task.target : null;
      if (to === 'dram' && !pull.policy.coalesce) {
        if (!task.intermediate) {
          const status = ensureSpace('dram', sizeAt(task.source, 'dram'), now, new Set([task.source]));
          if (status !== 'admitted') {
            if (status === 'infeasible' || !transfers.size) task.cancelled = true;
            continue;
          }
          checkLimit(residentCount() + 1);
          task.intermediate = pullTarget(task.source, task.slot.key, 'dram', true);
        }
        target = task.intermediate;
      }
      const options = { target, prefetch: true, fixedSeconds: task.from === 'ssd' ? pull.policy.fixedSeconds : 0 };
      task.record = transfer(task.source, task.from, to, now, options);
      if (!task.record && to === 'dram' && pull.policy.coalesce) {
        const status = ensureSpace('dram', sizeAt(task.source, 'dram'), now, new Set([task.source]));
        if (status === 'admitted') task.record = transfer(task.source, task.from, to, now, options);
        if (status === 'infeasible' || (status === 'wait' && !transfers.size)) task.cancelled = true;
      }
      if (task.record) {
        task.record.owners ??= new Set();
        task.record.owners.add(task);
        task.record.reservedTargets ??= new Map();
        task.record.reservedTargets.set(task.target, { pool, tier: 'hbm', page: task.target, bytes: sizeAt(task.target, 'hbm') });
        for (const subscription of task.subscribers) subscription.req._ft0 ??= now;
      } else if (!links[`${task.from}>${to}`]?.bw) task.cancelled = true;
    }
    for (const subscription of pull.subscribers) finishFetch(subscription, now);
  }

  function advance(now = 0) {
    // Complete in chronological order: a large time jump must preserve two-hop timing.
    for (;;) {
      let next = null;
      for (const record of transfers) if (record.end <= now && (!next || record.end < next.end)) next = record;
      if (!next) break;
      const time = next.end;
      retire(next, time);
      for (const pull of pulls.values()) progressPull(pull, time);
    }
    for (const record of transfers) account(record, now);
    for (const pull of pulls.values()) progressPull(pull, now);
    clock = Math.max(clock, now);
  }

  function releaseBus(records, now) {
    const buses = new Set(records.map(record => record.link));
    for (const link of buses) {
      const cancelledEnd = Math.max(...records.filter(record => record.link === link || record.link === link.shared).map(record => record.end));
      const currentEnd = Math.max(link.busyUntil || 0, link.shared?.busyUntil || 0);
      // Never rewind a reservation made by another user of the shared links.
      if (currentEnd > cancelledEnd) continue;
      let end = now;
      for (const record of transfers) if (record.link === link || record.link === link.shared) end = Math.max(end, record.end);
      link.busyUntil = end;
      if (link.shared) link.shared.busyUntil = end;
    }
  }

  function stopTasks(subscription, predicate, now) {
    if (!subscription?.pull) return;
    const pull = subscription.pull, cancelled = [];
    for (const task of pull.tasks) {
      if (!predicate(task.slot)) continue;
      task.subscribers.delete(subscription);
      if (task.subscribers.size || task.done) continue;
      task.cancelled = true;
      task.record?.owners?.delete(task);
      if (task.record && transfers.has(task.record) && !task.record.owners?.size) {
        cancelled.push(task.record); retire(task.record, now, true);
      }
      if (task.targetHeld) { unlock(task.target); task.targetHeld = false; }
      if (!task.target.ready && task.target.refcount && !task.target.transferLocked) privatize(task.target, 'hbm');
      if (!task.target.ready && !task.target.refcount && !task.target.transferLocked
        && pool.blockIndex[task.target.id] === task.target) remove('hbm', task.target.id);
      if (task.sourceHeld) { unlock(task.originalSource); task.sourceHeld = false; }
      finishIntermediate(task);
    }
    finishFetch(subscription, now);
    releaseBus(cancelled, now);
  }

  function cancel(req, now) {
    advance(now);
    const subscription = prefetches.get(req);
    if (!subscription || subscription.stopped) return;
    stopTasks(subscription, () => true, now);
    subscription.stopped = true;
    subscription.pull?.subscribers.delete(subscription);
    if (subscription.pull && !subscription.pull.subscribers.size) {
      for (const task of subscription.pull.tasks) {
        if (task.sourceHeld) { unlock(task.originalSource); task.sourceHeld = false; }
        if (task.targetHeld) { unlock(task.target); task.targetHeld = false; }
      }
      pulls.delete(subscription.pull.key);
    }
  }

  function prefetch(req, now = 0, policy = {}) {
    if (!finiteCapacity) return { status: 'admitted' };
    advance(now);
    let subscription = prefetches.get(req);
    if (subscription) return { status: 'admitted' };
    const planned = plan(req, now);
    if (!planned.slots) return planned.response;
    const restoredPages = Math.ceil(Math.max(0, Math.floor(req.tokensGen || 0)) / 64);
    if ((planned.slots.length + restoredPages) * blockBytes > pool.cap) return { status: 'infeasible' };
    const lower = planned.slots.filter(slot => slot.hit && slot.tier !== 'hbm');
    if (!lower.length) return { status: 'admitted' };
    if (!canSchedule(now)) return { status: 'wait' };
    const normalized = { type: policy.type || 'none', fixedSeconds: Math.max(0, policy.fixedSeconds || 0),
      timeoutSeconds: Math.max(0, policy.timeoutSeconds || 0), coalesce: !!policy.coalesce };
    if (normalized.type === 'race') lower.reverse();
    const groupKey = JSON.stringify([resourceId, lower.map(slot => [slot.position, slot.tokens, slot.key, slot.version, slot.tier]),
      normalized.coalesce ? null : sequence++]);
    let pull = pulls.get(groupKey);
    const reused = new Map(pull?.tasks.filter(task => !task.cancelled).map(task => [task.slot.position, task.target]) || []);
    if (normalized.coalesce) for (const slot of lower) {
      if (!reused.has(slot.position) && pool.blockIndex[slot.key]) reused.set(slot.position, pool.blockIndex[slot.key]);
    }
    const protectedPages = new Set([...planned.slots.map(slot => resources[slot.tier]?.blockIndex[slot.key]), ...reused.values()].filter(Boolean));
    const needed = planned.slots.filter(slot => !(slot.hit && (slot.tier === 'hbm'
      ? pool.blockIndex[slot.key] : reused.has(slot.position)))).length + restoredPages;
    const space = ensureSpace('hbm', needed * blockBytes, now, protectedPages);
    if (space !== 'admitted') return { status: space };
    const intermediates = lower.filter(slot => slot.tier === 'ssd' && resources.dram
      && (!normalized.coalesce || !resources.dram.blockIndex[slot.key])).length;
    checkLimit(residentCount() + needed + intermediates);
    subscription = { req, planned, policy: normalized, created: now, stopped: false, started: false, pull };
    if (!pull) {
      pull = { key: groupKey, tasks: [], subscribers: new Set(), policy: normalized };
      for (const slot of lower) {
        const source = resources[slot.tier].blockIndex[slot.key];
        const target = reused.get(slot.position) || pullTarget(source, slot.key, 'hbm', !normalized.coalesce);
        lock(source); lock(target);
        pull.tasks.push({ slot, source, originalSource: source, sourceHeld: true, targetHeld: true,
          from: slot.tier, target, subscribers: new Set(), done: accessible(target, now), cancelled: false, record: null });
      }
      pulls.set(groupKey, pull);
    }
    subscription.pull = pull;
    pull.subscribers.add(subscription);
    for (const task of pull.tasks) if (!task.cancelled) task.subscribers.add(subscription);
    prefetches.set(req, subscription);
    if (!fetchInitialized.has(req)) {
      req.fetchTime = lower.reduce((sum, slot) => {
        const fraction = slot.tokens / 64;
        const l2 = blockBytes * (tierRatio.dram ?? 1) * fraction / (links['dram>hbm']?.bw || Infinity);
        const l3 = slot.tier === 'ssd' ? normalized.fixedSeconds
          + blockBytes * (tierRatio.ssd ?? 1) * fraction / (l3Bandwidth || links['ssd>dram']?.bw || Infinity) : 0;
        return sum + l2 + l3;
      }, 0);
      fetchInitialized.add(req);
    }
    if (pull.tasks.some(task => task.record)) req._ft0 ??= now;
    progressPull(pull, now);
    return { status: 'admitted' };
  }

  function uncovered(entry, includeClaimed = true) {
    const end = entry.position + entry.tokens;
    const covered = [...entry.completed, ...(includeClaimed ? entry.claimed : [])]
      .sort((a, b) => a.position - b.position);
    const ranges = [];
    let cursor = entry.position;
    for (const range of covered) {
      if (range.position > cursor) ranges.push({ position: cursor, tokens: Math.min(end, range.position) - cursor });
      cursor = Math.max(cursor, range.position + range.tokens);
    }
    if (cursor < end) ranges.push({ position: cursor, tokens: end - cursor });
    return ranges.filter(range => range.tokens > 0);
  }

  function entriesFor(req) {
    const state = states.get(req);
    return state && !state.released ? state.entries || [] : [];
  }

  function computeRanges(req, now) {
    advance(now);
    const ranges = [];
    for (const entry of entriesFor(req)) {
      if (pool.blockIndex[entry.id]?.ready) entry.completed = [{ position: entry.position, tokens: entry.tokens }];
      for (const range of uncovered(entry)) {
        const tail = ranges.at(-1);
        if (tail && tail.position + tail.tokens === range.position) tail.tokens += range.tokens;
        else ranges.push({ ...range });
      }
    }
    return ranges;
  }

  function forRanges(req, ranges, callback) {
    for (const range of ranges) {
      if (!Number.isSafeInteger(range.position) || !Number.isSafeInteger(range.tokens) || range.tokens <= 0)
        throw new ReplayValidationError('replay.cache', 'invalid compute range');
      for (const entry of entriesFor(req)) {
        const position = Math.max(entry.position, range.position);
        const end = Math.min(entry.position + entry.tokens, range.position + range.tokens);
        if (end > position) callback(entry, { position, tokens: end - position });
      }
    }
  }

  function finitePlace(req, now) {
    advance(now);
    const previous = states.get(req);
    if (previous && !previous.released) return previous.response;
    const restored = Math.max(0, Math.floor(req.tokensGen || 0));
    if (!Number.isSafeInteger(restored) || restored > req.outputLen)
      throw new ReplayValidationError('replay.cache', 'invalid generated output length');
    if ((Math.ceil(req.inputLen / 64) + Math.ceil(restored / 64)) * blockBytes > pool.cap) return { status: 'infeasible' };
    if (!prefetches.has(req)) {
      const initial = plan(req, now);
      if (!initial.slots) return initial.response;
      const protectedPages = new Set(initial.slots.filter(slot => slot.hit)
        .map(slot => resources[slot.tier]?.blockIndex[slot.key]).filter(Boolean));
      const needed = initial.slots.filter(slot => !slot.hit || !pool.blockIndex[slot.key]).length + Math.ceil(restored / 64);
      const status = ensureSpace('hbm', needed * blockBytes, now, protectedPages);
      if (status !== 'admitted') return { status };
      prefetch(req, now, { type: 'none' });
    }
    const subscription = prefetches.get(req);
    const { slots, response: original } = subscription?.planned || plan(req, now);
    if (!slots) return original;
    const targets = new Map(subscription?.pull.tasks.map(task => [task.slot.position, task.target]) || []);
    const existing = slots.map(slot => {
      if (!slot.hit) return null;
      const target = targets.get(slot.position);
      const item = target && pool.blockIndex[target.id] === target ? target : pool.blockIndex[slot.key];
      return item?._moving ? null : item;
    });
    const extra = existing.filter(item => !item).length + Math.ceil(restored / 64);
    const protectedPages = new Set([...existing, ...slots.map(slot => resources[slot.tier]?.blockIndex[slot.key])].filter(Boolean));
    const space = ensureSpace('hbm', extra * blockBytes, now, protectedPages);
    if (space !== 'admitted') return { status: space };
    checkLimit(residentCount() + extra);
    const response = { ...original, status: 'admitted' };
    const state = { id: sequence++, privateIds: [], outputIds: [], response, entries: [], released: false };
    states.set(req, state);
    req.prefixBlkIds = []; req.ownBlkIds = [];
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      let item = existing[i];
      if (item) {
        item.refcount++; item.lastTouch = now;
        if (item.canonicalKey) { req.ownBlkIds.push(item.id); state.privateIds.push(item.id); }
        else req.prefixBlkIds.push(item.id);
      } else {
        item = block(JSON.stringify(['private', resourceId, state.id, i]), slot.tokens, req, now);
        item.canonicalKey = slot.key;
        add('hbm', item); req.ownBlkIds.push(item.id); state.privateIds.push(item.id);
      }
      const entry = { ...slot, id: item.id, completed: item.ready ? [{ position: slot.position, tokens: slot.tokens }] : [], claimed: [] };
      state.entries.push(entry);
      if (!bindings.has(item)) bindings.set(item, new Set());
      bindings.get(item).add({ req, state, entry });
    }
    for (let i = 0; i < Math.ceil(restored / 64); i++) {
      const tokens = Math.min(64, restored - i * 64), position = req.inputLen + i * 64;
      const item = block(JSON.stringify(['output', resourceId, state.id, i]), tokens, req, now, true);
      if (req.outputIdentity) item.canonicalKey = contentPageKey([[req.outputIdentity.pathId, i * 64, tokens]], resourceId);
      add('hbm', item); state.outputIds.push(item.id); req.ownBlkIds.push(item.id);
      state.entries.push({ id: item.id, position, tokens, output: true, completed: [], claimed: [] });
    }
    req._replayPrivate = state.privateIds;
    req.prefillTokens = state.entries.reduce((sum, entry) => sum + (entry.completed.length ? 0 : entry.tokens), 0);
    req._pfStartPos = state.entries.find(entry => !entry.completed.length)?.position ?? req.inputLen;
    req._pfTotal = req.prefillTokens;
    req._outAllocTok = restored; req._outSeq = state.outputIds.length;
    if (!fetchInitialized.has(req)) { req.fetchTime = 0; fetchInitialized.add(req); }
    req._fetchDone = 0; req._fetchedIds = null; req._l2HitTok = response.hitL2Tokens;
    req._race = req._be = req._to = false;
    req._outMerge = 1; req.placedTier = 'hbm';
    return response;
  }

  const cache = {
    advance,
    get nextTime() {
      let next = Infinity;
      for (const record of transfers) next = Math.min(next, record.end);
      for (const pull of pulls.values()) for (const subscription of pull.subscribers) {
        const deadline = subscription.created + subscription.policy.timeoutSeconds;
        if (!subscription.started && !subscription.stopped && subscription.policy.type === 'timeout' && deadline > clock)
          next = Math.min(next, deadline);
      }
      return next;
    },
    get pending() { return transfers.size; },
    get ledger() { return [...transfers]; },
    scheduleTransfer(item, from, to, now = 0, options = {}) {
      advance(now);
      return transfer(item, from, to, now, options);
    },
    prefetch,
    cancel,
    startPrefill(req, now = 0) {
      advance(now);
      const subscription = prefetches.get(req);
      if (!subscription || subscription.stopped) return true;
      const pending = subscription.pull.tasks.some(task => !task.done && !task.cancelled && task.subscribers.has(subscription));
      const policy = subscription.policy;
      if (policy.type === 'none' && pending) return false;
      if (policy.type === 'timeout' && pending && now < subscription.created + policy.timeoutSeconds) return false;
      if (policy.type === 'best_effort' || policy.type === 'timeout') cancel(req, now);
      subscription.started = true;
      return true;
    },
    computeRanges,
    claimCompute(req, ranges, now = 0) {
      advance(now);
      const subscription = prefetches.get(req);
      stopTasks(subscription, slot => ranges.some(range => range.position < slot.position + slot.tokens
        && range.position + range.tokens > slot.position), now);
      forRanges(req, ranges, (entry, range) => { entry.claimed.push(range); });
    },
    completeCompute(req, ranges, now = 0) {
      advance(now);
      forRanges(req, ranges, (entry, range) => {
        entry.claimed = entry.claimed.filter(claim => claim.position !== range.position || claim.tokens !== range.tokens);
        entry.completed.push(range);
        if (!uncovered(entry, false).length) {
          const item = pool.blockIndex[entry.id];
          if (item) { item.ready = true; item.arriveAt = now; }
        }
      });
    },
    prefillReady(req, now = 0) {
      computeRanges(req, now);
      return entriesFor(req).every(entry => !uncovered(entry, false).length);
    },
    ensureSpace,
    lookup(req, now = 0) {
      const { slots, response } = plan(req, now);
      return slots ? { ...response, slots } : response;
    },
    place(req, now = 0) {
      if (finiteCapacity) return finitePlace(req, now);
      const previous = states.get(req);
      if (previous && !previous.released) return previous.response;
      const { slots, response } = plan(req, now);
      if (response.status !== 'admitted') return { status: response.status };
      const state = { id: sequence++, privateIds: [], outputIds: [], response, released: false };
      states.set(req, state);
      req.prefixBlkIds = [];
      req.ownBlkIds = [];
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if (slot.hit) {
          const cached = pool.blockIndex[slot.key];
          cached.refcount++;
          cached.lastTouch = now;
          req.prefixBlkIds.push(slot.key);
        } else {
          const id = JSON.stringify(['private', resourceId, state.id, i]);
          const item = block(id, slot.tokens, req, now);
          item.canonicalKey = slot.key;
          add('hbm', item);
          req.ownBlkIds.push(id);
          state.privateIds.push(id);
        }
      }
      req._replayPrivate = state.privateIds;
      req.prefillTokens = response.missTokens;
      req._pfStartPos = response.hitL1Tokens;
      req.fetchTime = 0;
      req._fetchDone = 0;
      req._fetchedIds = null;
      req._l2HitTok = 0;
      req._race = req._be = req._to = false;
      req._outMerge = 1;
      req.placedTier = 'hbm';
      return response;
    },
    publish(req, now = 0) {
      const state = states.get(req);
      if (!state || state.released) return;
      if (finiteCapacity) {
        if (!cache.prefillReady(req, now)) throw new Error('Replay cache invariant: publication before KV readiness');
        cancel(req, now);
        for (const id of [...state.privateIds]) publishInput(id, now);
        req._replayPrivate = null;
        return;
      }
      const privateIds = new Set(state.privateIds);
      for (const id of state.privateIds) req.prefixBlkIds.push(publishPage(id, now));
      req.ownBlkIds = req.ownBlkIds.filter(id => !privateIds.has(id));
      state.privateIds = [];
      req._replayPrivate = null;
    },
    output(req, generatedTokens, now = 0) {
      const state = states.get(req);
      if (!state || state.released) throw new Error('Replay cache invariant: output without admission');
      const want = Math.min(req.outputLen, Math.max(req._outAllocTok || 0, Math.floor(generatedTokens)));
      if (!Number.isSafeInteger(want) || want < 0) throw new ReplayValidationError('replay.cache', 'invalid output length');
      const count = Math.ceil(want / 64);
      if ((Math.ceil(req.inputLen / 64) + count) * blockBytes > pool.cap) return { status: 'infeasible' };
      const extra = count - state.outputIds.length;
      if (finiteCapacity) {
        advance(now);
        if (pool.used + extra * blockBytes > pool.cap) {
          for (const pull of [...pulls.values()]) for (const subscription of [...pull.subscribers]) {
            const pendingState = states.get(subscription.req);
            if (!pendingState || pendingState.released) cancel(subscription.req, now);
          }
        }
        const status = ensureSpace('hbm', extra * blockBytes, now);
        if (status !== 'admitted') return { status };
      } else if (pool.used + extra * blockBytes > pool.cap) return { status: 'wait' };
      checkLimit(residentCount() + extra);
      while (state.outputIds.length < count) {
        const index = state.outputIds.length;
        const id = JSON.stringify(['output', resourceId, state.id, index]);
        const item = block(id, Math.min(64, want - index * 64), req, now, true);
        item.ready = true;
        add('hbm', item);
        state.outputIds.push(id);
        req.ownBlkIds.push(id);
      }
      for (let i = 0; i < state.outputIds.length; i++) {
        const item = pool.blockIndex[state.outputIds[i]];
        item.tokens = Math.min(64, want - i * 64);
        item.lastTouch = now;
        if (req.outputIdentity) item.canonicalKey = contentPageKey([[req.outputIdentity.pathId, i * 64, item.tokens]], resourceId);
      }
      req._outSeq = count;
      req._outAllocTok = want;
      return { status: 'admitted' };
    },
    release(req, now = 0, reason = null) {
      if (finiteCapacity) cancel(req, now);
      const state = states.get(req);
      if (!state || state.released) { if (finiteCapacity) prefetches.delete(req); return; }
      if (finiteCapacity) {
        for (const [item, refs] of bindings) {
          for (const binding of refs) if (binding.req === req) refs.delete(binding);
          if (!refs.size) bindings.delete(item);
        }
        prefetches.delete(req);
      }
      if (reason === null) {
        if (state.privateIds.length) throw new Error('Replay cache invariant: successful release before input publication');
        const outputs = new Map(state.outputIds.map(id => [id, publishPage(id, now)]));
        req.ownBlkIds = req.ownBlkIds.map(id => outputs.get(id) ?? id);
      }
      for (const id of [...req.prefixBlkIds, ...req.ownBlkIds]) {
        const item = pool.blockIndex[id];
        if (!item || item.refcount < 1) throw new Error('Replay cache invariant: invalid running reference');
        item.refcount--;
        item.lastTouch = now;
        if (reason !== null && !item._published && item.refcount === 0) remove('hbm', id);
      }
      state.released = true;
      state.privateIds = [];
      state.outputIds = [];
      req.prefixBlkIds = [];
      req.ownBlkIds = [];
      req._replayPrivate = null;
      if (!finiteCapacity || reason !== 'retract') req.replayTemplate = null;
    },
    warm(description, now = 0) {
      const descriptions = Array.isArray(description) ? description : [description];
      const planned = [], keys = new Set(), used = new Map();
      for (const entry of descriptions) {
        for (const slot of pages(entry.content)) {
          const placement = entry.placements.find(p => p.position <= slot.position
            && p.position + p.tokens >= slot.position + slot.tokens);
          if (!placement || !resources[placement.tier]) continue;
          const { tier } = placement, target = resources[tier];
          const size = blockBytes * (tierRatio[tier] ?? 1);
          const key = JSON.stringify([tier, slot.key]);
          if (target.blockIndex[slot.key] || keys.has(key)) continue;
          if ((used.get(target) ?? target.used) + size > target.cap) continue;
          checkLimit(residentCount() + planned.length + 1);
          used.set(target, (used.get(target) ?? target.used) + size);
          keys.add(key);
          planned.push({ slot, tier });
        }
      }
      for (const { slot, tier } of planned) {
        const item = block(slot.key, slot.tokens, null, now);
        item.ready = true; item._published = true; item.refcount = 0; item.tier = tier;
        add(tier, item);
      }
      return { status: 'admitted', pages: planned.length };
    },
    snapshot() {
      let inputPages = 0, outputPages = 0;
      for (const target of new Set(Object.values(resources))) {
        for (const item of target.blocks) {
          if (item._contentResource !== resourceId) continue;
          if (item.output) outputPages++;
          else inputPages++;
        }
      }
      const value = { hbmBytes: pool.used, hbmCapacityBytes: pool.cap, inputPages, outputPages, deduplicatedPages };
      if (finiteCapacity) {
        value.tiers = Object.fromEntries(tiers.filter(tier => resources[tier]).map(tier => [tier, {
          used: resources[tier].used, capacity: resources[tier].cap,
          reserved: resources[tier].blocks.filter(item => !item.ready && item.transferLocked)
            .reduce((sum, item) => sum + sizeAt(item, tier), 0),
        }]));
        for (const tier of tiers) {
          value[`${tier}Bytes`] = resources[tier]?.used || 0;
          value[`${tier}CapacityBytes`] = resources[tier]?.cap || 0;
          value[`${tier}ReservedBytes`] = value.tiers[tier]?.reserved || 0;
        }
        value.hbmResidentBytes = value.hbmBytes - value.hbmReservedBytes;
        value.pendingTransfers = transfers.size;
      }
      return value;
    },
  };
  return cache;
}
