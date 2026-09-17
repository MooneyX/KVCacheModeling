import { hwPresets } from "../core/presets.js";

export function applyParamVal(s, ov, key, val) {
  if (val == null) return;
  switch (key) {
    // ---- 策略对象: 阈值类均为百分比输入, 引擎内是 0~1 小数 ----
    // (hbm_threshold 已删 2026-09-03: 准入收敛为 always, "HBM 水位决定新 KV 落层"无 sglang 对应)
    case 'evict_threshold':    s.eviction.hbm_evict_threshold = val / 100; break;
    case 'max_batch_size':     s.batching.max_batch_size = val; break;
    // ---- overrides: 负载与硬件 ----
    case 'prefix_hit':  ov.prefixHit = val / 100; break;
    case 'prefix_warm_l2': ov.prefixWarmL2 = val / 100; break;
    case 'ssd_bw':      ov.ssdBW = val; break;
    case 'input_len':   ov.inputLen = val; break;
    case 'qps':         ov.qps = val; break;
    case 'concurrency': ov.nreq = val; break;   // 单批Prefill基准的 batch 规模
    case 'gpu_preset':  ov.hwPreset = val; break; // runSimulation 内套字段并重算 a/b
  }
}

export function sortedJson(o) {
  return JSON.stringify(o, function (k, v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      let out = {};
      Object.keys(v).sort().forEach(function (kk) { out[kk] = v[kk]; });
      return out;
    }
    return v;
  });
}

export function buildSensPoints(flatCurves, values, param, compareParam, shapeDim, hasPf, shapeList, baseVals) {
  let pts = [];
  (flatCurves || []).forEach(function (fc) {
    (fc.recs || []).forEach(function (rec, idx) {
      if (!rec) return;   // 未完成/被取消的点直接跳过(不塞 null 进点云)
      let ps = {};
      // 先铺基准值, 再让被扫描的维度覆盖 —— 顺序不能反, 否则扫描值会被基准值盖掉
      Object.keys(baseVals || {}).forEach(function (k) { ps[k] = baseVals[k]; });
      ps[param] = values[idx];
      if (compareParam) ps[compareParam] = (fc.cmpVal !== undefined) ? fc.cmpVal : null;
      if (hasPf && shapeDim) ps[shapeDim] = (fc.shapeVal !== undefined) ? fc.shapeVal : null;
      pts.push({ params: ps, rec: rec });
    });
  });
  return pts;
}

export function parseRangeOrList(str, param) {
  if (param === 'gpu_preset') {
    return String(str).split(/[,，\s]+/).map(s => s.trim())
      .filter(s => s && typeof hwPresets !== 'undefined' && hwPresets[s]);
  }
  let nums = String(str).split(/[,，\s]+/).map(s => parseFloat(s)).filter(v => isFinite(v));
  if (nums.length === 3 && nums[2] !== 0) {
    let [s0, e0, st] = nums;
    let out = [], eps = Math.abs(st) * 1e-6;
    for (let v = s0, guard = 0; (st > 0 ? v <= e0 + eps : v >= e0 - eps) && guard < 200; v += st, guard++) {
      out.push(Math.round(v * 1e6) / 1e6);
    }
    return out;
  }
  return nums;
}
