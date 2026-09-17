import { generateRequests } from '../core/requests.js';
import { mulberry32 } from '../core/math.js';

export function createTrace(params, overrides = {}) {
  const p = JSON.parse(JSON.stringify(params));
  const rng = mulberry32((overrides.seed != null ? overrides.seed : p.seed) >>> 0);
  const { requests } = generateRequests(p, overrides, rng, {});
  return {
    p,
    requests: requests.map(r => ({
      id: r.id, arrive: r.arrive, inputLen: r.inputLen, outputLen: r.outputLen,
      groupId: r.groupId, prefixTokLen: r.prefixTokLen, isFounder: r.isFounder,
      followUp: r.followUp, multiTurn: p.multiTurn,
    })),
  };
}
