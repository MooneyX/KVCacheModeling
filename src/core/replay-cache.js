import { ReplayValidationError } from './replay.js';

function contentPageKey(parts, resourceId) {
  return JSON.stringify(['content', resourceId, parts]);
}

export function replayPageKey(instance, blockId, tokens = 64, resourceId = 'default') {
  return contentPageKey([[JSON.stringify(['replay', instance, 'input', blockId]), 0, tokens]], resourceId);
}

export function createReplayCache({ pool, pools = { hbm: pool }, blockBytes, add, remove,
  maxBlockReferences = 200000, resourceId = 'default', tierRatio = {} }) {
  pool ??= pools.hbm;
  const resources = { ...pools, hbm: pool };
  const states = new WeakMap();
  let sequence = 0, deduplicatedPages = 0;
  const residentCount = () => [...new Set(Object.values(resources))].reduce((n, p) => n + p.blocks.length, 0);
  const checkLimit = count => {
    if (count > maxBlockReferences) {
      throw new ReplayValidationError('replay.cache', 'physical block resource limit exceeded');
    }
  };
  const ready = (item, now) => !!item && item.available && item.ready
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

  function plan(req, now) {
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
    if (existing?.refcount > 0) return id;
    if (existing) remove('hbm', key);
    remove('hbm', id);
    item.id = key;
    delete item.canonicalKey;
    add('hbm', item);
    return key;
  }

  const cache = {
    lookup(req, now = 0) {
      const { slots, response } = plan(req, now);
      return slots ? { ...response, slots } : response;
    },
    place(req, now = 0) {
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
      if (pool.used + extra * blockBytes > pool.cap) return { status: 'wait' };
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
      const state = states.get(req);
      if (!state || state.released) return;
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
      req.replayTemplate = null;
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
      return { hbmBytes: pool.used, hbmCapacityBytes: pool.cap, inputPages, outputPages, deduplicatedPages };
    },
  };
  return cache;
}
