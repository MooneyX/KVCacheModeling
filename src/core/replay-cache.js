import { iterateReplayBlocks, ReplayValidationError } from './replay.js';

export function replayPageKey(instance, blockId, tokens = 64) {
  return `s${instance}:64:${blockId}${tokens === 64 ? '' : `:tail:${tokens}`}`;
}

export function createReplayCache({ pool, blockBytes, add, remove, maxBlockReferences }) {
  let inputPages = 0, outputPages = 0, deduplicatedPages = 0;
  function ensureSpace(pages) {
    if (pool.used + pages * blockBytes > pool.cap) {
      throw new ReplayValidationError('replay.capacity', 'HBM pressure requires eviction/retract support (S12/S13); result not produced');
    }
    if (pool.blocks.length + pages > maxBlockReferences) {
      throw new ReplayValidationError('replay.cache', 'physical block resource limit exceeded');
    }
  }
  function block(id, tokens, req, output = false) {
    return { id, tokens, size: blockBytes, refcount: 1, available: true, ready: false,
      arriveAt: 0, shared: !output, groupId: null, reqId: req.id, lastTouch: req.admitTime, output };
  }
  return {
    place(req, now) {
      const pages = Math.ceil(req.inputLen / 64);
      if (pages * blockBytes > pool.cap) return null;
      const slots = [];
      let position = 0, hitTokens = 0, matching = true;
      for (const id of iterateReplayBlocks(req.replayTemplate.blockRuns)) {
        const tokens = Math.min(64, req.inputLen - position * 64);
        const key = replayPageKey(req.sessionInstanceKey, id, tokens);
        const cached = pool.blockIndex[key];
        const hit = matching && cached?.available && cached.ready;
        if (hit) hitTokens += tokens;
        else matching = false;
        slots.push({ key, tokens, hit: !!hit });
        position++;
      }
      ensureSpace(slots.filter(slot => !slot.hit).length);
      req._replayPrivate = [];
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if (slot.hit) {
          const cached = pool.blockIndex[slot.key];
          cached.refcount++;
          cached.lastTouch = now;
          req.prefixBlkIds.push(slot.key);
        } else {
          const id = `private:${req.sessionInstanceKey}:${req.requestIndex}:${i}`;
          const item = block(id, slot.tokens, req);
          item.canonicalKey = slot.key;
          item.lastTouch = now;
          add('hbm', item);
          inputPages++;
          req.ownBlkIds.push(id);
          req._replayPrivate.push(id);
        }
      }
      req.prefillTokens = req.inputLen - hitTokens;
      req._pfStartPos = hitTokens;
      req.fetchTime = 0;
      req._fetchDone = 0;
      req._fetchedIds = null;
      req._l2HitTok = 0;
      req._race = req._be = req._to = false;
      req._outMerge = 1;
      req.placedTier = 'hbm';
      return { inputTokens: req.inputLen, hitL1Tokens: hitTokens, hitL2Tokens: 0, hitL3Tokens: 0, missTokens: req.prefillTokens };
    },
    publish(req, now) {
      for (const id of req._replayPrivate || []) {
        const item = pool.blockIndex[id];
        if (!item) throw new Error('Replay cache invariant: missing private input page');
        const key = item.canonicalKey;
        const existing = pool.blockIndex[key];
        remove('hbm', id);
        if (existing) {
          if (!existing.ready || !existing.available) throw new Error('Replay cache invariant: canonical page is not ready');
          existing.refcount++;
          existing.lastTouch = now;
          inputPages--;
          deduplicatedPages++;
        } else {
          item.id = key;
          item.ready = true;
          item.lastTouch = now;
          delete item.canonicalKey;
          add('hbm', item);
        }
        req.prefixBlkIds.push(key);
      }
      req.ownBlkIds = req.ownBlkIds.filter(id => pool.blockIndex[id]);
      req._replayPrivate = null;
    },
    output(req, generatedTokens, now) {
      const want = Math.min(req.outputLen, Math.floor(generatedTokens));
      const pages = Math.ceil(want / 64);
      ensureSpace(Math.max(0, pages - req._outSeq));
      while (req._outSeq < pages) {
        const index = req._outSeq++;
        const id = `output:${req.sessionInstanceKey}:${req.requestIndex}:${index}`;
        const item = block(id, Math.min(64, want - index * 64), req, true);
        item.ready = true;
        item.lastTouch = now;
        add('hbm', item);
        req.ownBlkIds.push(id);
        outputPages++;
      }
      if (pages) {
        const last = pool.blockIndex[`output:${req.sessionInstanceKey}:${req.requestIndex}:${pages - 1}`];
        last.tokens = want - (pages - 1) * 64;
      }
      req._outAllocTok = want;
    },
    release(req, now) {
      for (const id of req.prefixBlkIds.concat(req.ownBlkIds)) {
        const item = pool.blockIndex[id];
        if (!item || item.refcount < 1) throw new Error('Replay cache invariant: invalid running reference');
        item.refcount--;
        item.lastTouch = now;
      }
      req.prefixBlkIds = [];
      req.ownBlkIds = [];
      req._replayPrivate = null;
      req.replayTemplate = null;
    },
    snapshot() {
      return { hbmBytes: pool.used, hbmCapacityBytes: pool.cap, inputPages, outputPages, deduplicatedPages };
    },
  };
}
