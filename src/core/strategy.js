export function parseDSL(text) {
  let s = {
    name: '', dsl: text,
    admission: { type: 'always' },
    eviction: { type: 'lru', hbm_evict_threshold: 0.9 },
    prefetch: { type: 'none' },
    placement: { type: 'hbm_first' },
    batching: { type: 'continuous', max_batch_size: 8 },
    // 路由(S3, 2026-08-20): null = DSL 未写 ROUTE 行 ⇒ 回退 UI 下拉(向后兼容,
    // 既有全部预设 DSL 都没有 ROUTE 行, 行为不变)
    routing: null
  };
  let lines = text.split('\n').filter(l => l.trim());
  for (let line of lines) {
    let l = line.trim();
    if (l.startsWith('ADMIT:')) {
      // 准入(2026-09-03 第4批收敛): 恒 always(新请求 KV 落在 HBM/device pool)。
      // 原 threshold(hbm=)/priority(<2K:hbm)/cost_based 三档决定的是"新请求 KV 直接落到
      // DRAM/SSD"——sglang 里不存在: 新 KV 只能在 device pool 分配(alloc_token_slots/
      // alloc_paged_token_slots_extend), HBM 紧张时由 radix cache 把 LRU 叶子写回 host
      // (write_through/write_back), 请求本身在 waiting_queue 等待(available_size/
      // new_token_ratio 判据, 见主循环 kvInFlight 容量门)。写了旧档位一律按 always 执行。
      s.admission = {type:'always'};
    }
    else if (l.startsWith('EVICT:')) {
      let body = l.substring(7).trim();
      let parts = body.split(',').map(p=>p.trim());
      let p0 = parts[0];
      let m0 = p0.match(/(\w+)\s+from\s+(\w+)\s+when\s+(\d+\.?\d*)%\s*->\s*(\w+)/);
      // 淘汰算法(2026-09-02): sglang RadixCache 只有 LRU —— evict() 用 last_access_time
      // 建最小堆逐个弹出最久未访问的叶子(radix_cache.py:568-590), host 侧同理。
      // lfu/fifo 无对应实现, 已从 DSL 移除; 写了也一律按 lru 执行(不静默产出假机制的曲线)。
      if (m0) {
        s.eviction = {type: 'lru', from_tier: m0[2], hbm_evict_threshold: parseFloat(m0[3])/100, target_tier: m0[4]};
      }
      if (parts.length > 1) {
        let m1 = parts[1].match(/(\w+)\s+from\s+(\w+)\s+when\s+(\d+\.?\d*)%\s*->\s*(\w+)/);
        if (m1) s.eviction.second = {type: 'lru', from_tier: m1[2], threshold: parseFloat(m1[3])/100, target_tier: m1[4]};
      }
    }
    else if (l.startsWith('PREFETCH:')) {
      // 预取策略(2026-09-02 收敛): sglang 的 hicache_storage_prefetch_policy 只有四档 ——
      //   none(=wait_complete) / best_effort / timeout / race(=suffix_race)
      // 四者都只决定「何时停止 L3→host 预取」(hiradix_cache.py can_terminate_prefetch),
      // 之后统一走 chunked-prefill。原 on_demand/eager(按 HBM 水位线做 DRAM→HBM 后台预取)
      // 在 sglang 里不存在: host→device 只在命中时 load_back, 无水位触发的搬运。
      let body = l.substring(10).trim();
      let m = body.match(/^(\w+)/);
      let t = m ? m[1] : 'none';
      const OK = ['none', 'best_effort', 'timeout', 'race'];
      s.prefetch = { type: OK.indexOf(t) >= 0 ? t : 'none' };
    }
    else if (l.startsWith('BATCH:')) {
      // 批处理(2026-09-02): sglang 只有 continuous batching —— 每轮 event loop 由
      // PrefillAdder 按 token 预算重组 batch, decode 逐 pass 推进, 无 static/dynamic/priority
      // 波次语义。故 type 恒 continuous, 只保留 max(N) 作为 decode 并发上限。
      let body = l.substring(7).trim();
      let m = body.match(/\w+\s+max\((\d+)\)/);
      if (m) s.batching = { type: 'continuous', max_batch_size: parseInt(m[1]) };
    }
    else if (l.startsWith('PLACE:')) {
      // 放置(2026-09-03 第4批收敛): 恒 hbm_first。原 tiered(长请求直接落 DRAM)/
      // adaptive(按 HBM 水位选层)两档同样是"新请求 KV 直接落慢层"的非 sglang 机制
      // (理由同 ADMIT 收敛注释)。分层驻留由 EVICT 的写回链(hbm→dram→ssd)表达。
      s.placement = {type:'hbm_first'};
    }
    // 路由策略(S3, 2026-08-20): 多实例下请求到达时如何选实例。第 6 个策略维度。
    // 语法: ROUTE: round_robin | power_of_two | hash_prefix | random
    // (least_queue/least_kv 已删 2026-09-03: sgl-router(sgl-model-gateway/src/policies/)只有
    //  random/round_robin/cache_aware/power_of_two/prefix_hash/consistent_hashing/bucket,
    //  无"全局扫描取最空"的 least-connection 实现 —— 生产 router 为避免全局扫描开销,
    //  用 power_of_two(随机两选优)逼近同等均衡度。写了旧档一律落到 power_of_two。)
    else if (l.startsWith('ROUTE:')) {
      let body = l.substring(6).trim();
      if (body === 'least_queue' || body === 'least_kv') body = 'power_of_two';  // 旧档收敛
      const OK = ['round_robin','power_of_two','hash_prefix','random'];
      if (OK.indexOf(body) >= 0) s.routing = { type: body };
    }
  }
  return s;
}

export function dslToText(s) {
  let lines = [];
  // 准入恒 always(2026-09-03 第4批收敛, 见 parseDSL 的 ADMIT 注释)
  lines.push('ADMIT: always');
  let e = s.eviction;
  // 淘汰恒 lru(sglang RadixCache 唯一实现), 见 parseDSL 的 EVICT 注释
  let eLine = 'EVICT: lru from '+(e.from_tier||'hbm')+' when '+Math.round((e.hbm_evict_threshold||0.9)*100)+'% -> '+(e.target_tier||'dram');
  if (e.second) eLine += ', lru from '+e.second.from_tier+' when '+Math.round(e.second.threshold*100)+'% -> '+e.second.target_tier;
  lines.push(eLine);
  // 预取四档均为裸关键字(无 from/when 子句) —— 它们描述"何时停止 L3 预取", 不是水位线搬运
  let p = s.prefetch;
  const PF_OK = ['none', 'best_effort', 'timeout', 'race'];
  lines.push('PREFETCH: ' + (PF_OK.indexOf(p.type) >= 0 ? p.type : 'none'));
  // 批处理恒 continuous(sglang 唯一形态), 见 parseDSL 的 BATCH 注释
  let b = s.batching;
  lines.push('BATCH: continuous max('+(b.max_batch_size||8)+')');
  // 放置恒 hbm_first(2026-09-03 第4批收敛, 见 parseDSL 的 PLACE 注释)
  lines.push('PLACE: hbm_first');
  return lines.join('\n');
}

export function autoNameStrategy(s) {
  // 准入恒 always、淘汰恒 LRU、批处理恒 continuous ⇒ 唯一真实自由度是预取策略
  let pf = { none:'WC', best_effort:'BE', timeout:'TO', race:'RC' }[s.prefetch.type] || 'WC';
  return 'AH-LRU-' + pf;
}
