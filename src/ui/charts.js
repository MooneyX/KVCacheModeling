import { $ } from "../adapters/browser/dom.js";
import { echarts } from "./echarts.js";
import { state } from "./state.js";
import { getParams } from "../adapters/browser/params.js";
import { calcAll, effL2LinkBW, l2AttnTp, calcKvPerToken, perReqMs, prefillIntegral } from "../core/calculations.js";
import { models } from "../core/presets.js";
import { formatNum, formatBytes, formatRate } from "./format.js";
import { mulberry32 } from "../core/math.js";

function resultInputs() {
  if (!state.simResults.length || !state.simInput?.params || !state.simInput?.controls) return null;
  const read = id => state.simInput.controls[id];
  return {
    control: read,
    gv: id => Number.parseFloat(read(id)?.value) || 0,
    gi: id => Number.parseInt(read(id)?.value) || 0,
    params: state.simInput.params,
  };
}

const ganttPages = new WeakMap();
const GANTT_PAGE_SIZE = 100;
const numberText = (value, digits = 3, unit = '') => Number.isFinite(value) ? value.toFixed(digits) + unit : '无样本';
const chartNumber = (value, digits = 1) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function resultCaption(r, input) {
  const strategy = escapeHtml(input?.strategies?.[0]?.name || r.name || '当前策略');
  const range = '全程 [0, ' + numberText(r.simEnd) + '] s · ' + (r.truncated ? '截断' : '未截断');
  if (!r.replay) return '来源：合成负载 · 策略 ' + strategy + ' · ' + range;
  const c = r.replay.configuration;
  return '来源：Replay · 策略 ' + strategy + ' · T=' + numberText(c.durationSeconds) + 's / W=' + numberText(c.warmupSeconds) +
    's / D=' + numberText(c.hardCutoff - c.durationSeconds) + 's · ' + range;
}

function truncationNotice(r) {
  if (!r.truncated) return '';
  if (r.replay) {
    const c = r.replay.configuration, n = r.replay.counts;
    return '硬截止截断：T=' + numberText(c.durationSeconds) + 's，D=' + numberText(c.hardCutoff - c.durationSeconds) +
      's，截止 ' + numberText(c.hardCutoff) + 's；已到达未完成 ' + n.arrivedUnfinished + '，全部未完成 ' + n.unfinished +
      '。延迟仅含成功样本，未完成请求不计入延迟分布。';
  }
  return '仿真窗口截断：完成请求数不足，TTFT/P99 基于不完整样本。' + (Number.isFinite(r.drainEst)
    ? '排水估计 ' + r.drainEst.toFixed(0) + 's，建议将「仿真窗口上限」调大至 ≥' + (r.drainEst * 1.5).toFixed(0) + 's。'
    : '排水估计无样本。');
}

function showChartMessage(id, message) {
  const el = $(id);
  if (!el) return;
  disposeChart(el);
  el.textContent = message;
}

function replayTheoryUnavailable(chartId, formulaId) {
  if (!state.simResults[0]?.replay) return false;
  const message = '不适用：此理论估算依赖合成负载假设，不代表本次 Replay 运行。';
  showChartMessage(chartId, message);
  setFormula(formulaId, message);
  return true;
}

function disposeChart(el) {
  const old = echarts.getInstanceByDom(el);
  if (!old) return;
  old.dispose();
  state.chartRegistry = state.chartRegistry.filter(chart => chart !== old);
}

function showRunPlaceholder(chartIds, formulaIds = []) {
  chartIds.forEach(id => {
    const el = $(id);
    if (!el) return;
    disposeChart(el);
    el.textContent = '请先运行';
  });
  formulaIds.forEach(id => setFormula(id, '请先运行'));
}

export function initChart(domId){
  let el=$(domId);
  disposeChart(el);
  el.textContent = '';
  let ch = echarts.init(el);
  state.chartRegistry.push(ch);
  return ch;
}



export function setFormula(id, html){
  let el=$(id); if(el) el.innerHTML=html;
}



// 与仿真引擎一致的前缀组模型：4组差异化前缀比例的均值
export const PREFIX_RATIOS = [0.12, 0.22, 0.35, 0.48];


export const AVG_PREFIX_RATIO = PREFIX_RATIOS.reduce((s, x) => s + x, 0) / PREFIX_RATIOS.length;



// ======================== TAB 2: STORAGE ========================
export function refreshStorageTab(){
  drawTierOverview();
  drawKvCurve();
  drawConcurrency();
}



export function drawTierOverview(){
  let p=getParams(), r=calcAll(p);
  let ch=initChart('chartTierOverview');
  ch.setOption({
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'}},
    legend:{data:['容量(GB)','读带宽(GB/s)','写带宽(GB/s)','延迟(μs)'],top:0,textStyle:{color:'#9ca0b0'}},
    grid:{left:80,right:20,top:40,bottom:20},
    xAxis:{type:'value',axisLabel:{color:'#9ca0b0'}},
    yAxis:{type:'category',data:['L1: HBM\n(GPU显存)','L2: DRAM\n(CPU内存)','L3: NVMe SSD\n(本地盘)'],axisLabel:{color:'#e4e4e7',fontSize:11}},
    series:[
      {name:'容量(GB)',type:'bar',data:[
        {value:p.gpus*p.hbmPerGpu,itemStyle:{color:'#f87171'}},
        {value:p.dram,itemStyle:{color:'#fb923c'}},
        {value:p.ssd*1000,itemStyle:{color:'#6c63ff'}},
      ],label:{show:true,position:'right',color:'#9ca0b0',formatter:p=>p.value+' GB'}},
      {name:'读带宽(GB/s)',type:'bar',data:[
        {value:p.hbmBW*p.gpus*1000,itemStyle:{color:'rgba(248,113,113,.4)'}},
        {value:effL2LinkBW(p),itemStyle:{color:'rgba(251,146,60,.4)'}}, // GPU 视角有效 = min(链路单卡×f,介质)
        {value:p.ssdBW,itemStyle:{color:'rgba(108,99,255,.4)'}},
      ]},
      {name:'写带宽(GB/s)',type:'bar',data:[
        {value:p.hbmBW*p.gpus*1000*0.7,itemStyle:{color:'rgba(248,113,113,.2)'}},
        {value:p.dramBW*0.8,itemStyle:{color:'rgba(251,146,60,.2)'}},
        {value:p.ssdBW*0.9,itemStyle:{color:'rgba(108,99,255,.2)'}},
      ]},
      {name:'延迟(μs)',type:'bar',data:[
        {value:0.1,itemStyle:{color:'rgba(52,211,153,.5)'}},
        {value:1,itemStyle:{color:'rgba(52,211,153,.5)'}},
        {value:80,itemStyle:{color:'rgba(52,211,153,.5)'}},
      ],label:{show:true,position:'right',color:'var(--accent2)',formatter:p=>p.value+' μs'}},
    ]
  });
  setFormula('formulaTier',
    '<b>📐 计算方式</b><br>'+
    '• <b>容量</b>: HBM = <code>'+p.gpus+'×'+p.hbmPerGpu+'='+(p.gpus*p.hbmPerGpu)+' GB</code> · DRAM & SSD 为设定值<br>'+
    '• <b>读带宽</b>: HBM聚合 = <code>'+p.gpus+'×'+p.hbmBW+'='+(p.gpus*p.hbmBW).toFixed(1)+' TB/s</code> · L2(DRAM) 为 GPU 视角有效带宽 <code>min(PCIe/C2C '+p.pcieBW+'×f='+(p.gpus/l2AttnTp(p))+', DRAM介质 '+p.dramBW+') = '+effL2LinkBW(p)+' GB/s</code>'+((p.epSize||1)>1?'（EP='+p.epSize+' ⇒ DP-attention, 读复制消失, f='+p.gpus+'）':'')+'<br>'+
    '• <b>跨层链路</b>: HBM↔DRAM 有效 = <code>min('+p.pcieBW+'×f, '+p.dramBW+') = '+effL2LinkBW(p)+' GB/s</code>（搬 1GB KV ≈ '+(1e9/(effL2LinkBW(p)*1e9)*1000).toFixed(1)+'ms）· DRAM↔SSD 走 NVMe = <code>'+p.ssdBW+' GB/s</code>（搬 1GB ≈ '+(1e9/(p.ssdBW*1e9)*1000).toFixed(0)+'ms）<br>'+
    '• <b>下沉层量化比</b>: DRAM/SSD 中 KV 存储体积 × '+p.tierQuant+'（当前设置）<br>'+
    '• 写带宽为经验系数 70%~90%；延迟为典型值 HBM ~0.1μs · DRAM ~1μs · NVMe ~80μs'
  );
}



export function drawKvCurve(){
  let p=getParams();
  let seqLens=[512,1024,2048,4096,8192,16384,32768,65536,131072];
  let ch=initChart('chartKvCurve');
  let series=[];
  let kvPerTok=calcKvPerToken(p);
  let totalHbmGB = p.gpus*p.hbmPerGpu;
  series.push({name:'当前模型 ('+state.currentModel+')',type:'line',smooth:true,data:seqLens.map(s=>kvPerTok*s/1e9),
    lineStyle:{color:'#6c63ff',width:2},areaStyle:{color:'rgba(108,99,255,.1)'},
    markLine:{silent:true,data:[{yAxis:totalHbmGB,label:{formatter:'当前硬件 HBM总量\n'+totalHbmGB+'GB',color:'#f87171'}}],lineStyle:{color:'#f87171',type:'dashed'}}});
  ['Llama-3-70B','Qwen3-30B-A3B','DeepSeek-V3','Llama-3-8B'].forEach((mn,i)=>{
    let mm=models[mn];
    let pp = {attn:mm.attn, layers:mm.layers, kvHeads:mm.kvHeads||8, headDim:mm.headDim||128,
      kvLora:mm.kvLora||512, ropeDim:mm.ropeDim||64, dtypeBytes:p.dtypeBytes};
    let k = calcKvPerToken(pp);
    let colors=['#fb923c','#34d399','#f87171','#60a5fa'];
    series.push({name:mn,type:'line',smooth:true,data:seqLens.map(s=>k*s/1e9),
      lineStyle:{color:colors[i],width:1.5,type:'dashed'}});
  });
  ch.setOption({
    tooltip:{trigger:'axis',valueFormatter:v=>v.toFixed(2)+' GB'},
    legend:{top:0,textStyle:{color:'#9ca0b0'}},
    grid:{left:80,right:20,top:40,bottom:30},
    xAxis:{type:'category',data:seqLens.map(s=>formatNum(s)),name:'序列长度(tokens)',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'}},
    yAxis:{type:'value',name:'KV Cache (GB)',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'}},
    series:series
  });
  setFormula('formulaKvCurve',
    '<b>📐 计算方式</b><br>'+
    'GQA: <code>S<sub>kv/tok</sub> = 2 × layers × kv_heads × head_dim × dtype</code> · MLA: <code>S<sub>kv/tok</sub> = layers × (kv_lora_rank + rope_dim) × dtype</code><br>'+
    '当前模型: <code>'+formatBytes(kvPerTok)+' / token</code> · DeepSeek-V3(MLA): <code>61×576×'+p.dtypeBytes+' = '+formatBytes(61*576*p.dtypeBytes)+' / token</code>（压缩 ~23×）<br>'+
    '虚线 = 当前硬件 HBM 总容量 '+totalHbmGB+'GB（随硬件参数联动）'
  );
}



export function drawConcurrency(){
  if (replayTheoryUnavailable('chartConcurrency', 'formulaConcurrency')) return;
  let p=getParams(), r=calcAll(p);
  let levels=[],hbmVals=[],dramVals=[],ssdVals=[];
  let step=Math.max(1,Math.floor(p.concurrency/8));
  // 前缀共享抵扣（与引擎同模型的期望值近似）：每请求期望复用 prefixHit × inputLen
  let savedPerReq = r.prefixSavedPerReq;
  for(let n=step;n<=p.concurrency*2;n+=step){
    levels.push(n);
    let demand=Math.max(0, n*(r.avgLifetimeKv - savedPerReq));
    let h=Math.min(demand,r.availHbm);
    let d=Math.max(0,Math.min((demand-h)*p.tierQuant,r.dramTotal));
    let ssd=Math.max(0,(demand-h)*p.tierQuant-d);
    hbmVals.push(h/1e9); dramVals.push(d/1e9); ssdVals.push(ssd/1e9);
  }
  let ch=initChart('chartConcurrency');
  ch.setOption({
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:v=>v.toFixed(1)+' GB'},
    legend:{data:['HBM占用','DRAM占用','SSD占用'],top:0,textStyle:{color:'#9ca0b0'}},
    grid:{left:60,right:20,top:40,bottom:40},
    xAxis:{type:'category',data:levels,name:'并发数',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'}},
    yAxis:{type:'value',name:'存储占用(GB)',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'}},
    series:[
      {name:'HBM占用',type:'bar',stack:'total',data:hbmVals,itemStyle:{color:'#f87171'},
        markLine:{silent:true,data:[{yAxis:r.availHbm/1e9}],label:{formatter:'HBM可用(KV)',color:'#f87171'},lineStyle:{color:'#f87171',type:'dashed'}}},
      {name:'DRAM占用',type:'bar',stack:'total',data:dramVals,itemStyle:{color:'#fb923c'},
        markLine:{silent:true,data:[{yAxis:(r.availHbm+r.dramTotal)/1e9}],label:{formatter:'HBM+DRAM上限',color:'#fb923c'},lineStyle:{color:'#fb923c',type:'dashed'}}},
      {name:'SSD占用',type:'bar',stack:'total',data:ssdVals,itemStyle:{color:'#6c63ff'}},
    ]
  });
  setFormula('formulaConcurrency',
    '<b>📐 计算方式（生命周期需求模型）</b><br>'+
    '单请求生命周期KV: <code>S<sub>life</sub> = ⌈S<sub>in</sub>/B⌉×B×kv + ⌈S<sub>out</sub>/2/B⌉×B×kv = '+formatBytes(r.avgLifetimeKv)+'</code>（含块碎片与输出增长）<br>'+
    '前缀抵扣: <code>−'+formatBytes(savedPerReq)+'/请求</code>（命中率 '+(p.prefixHit*100).toFixed(0)+'% × S<sub>in</sub>，期望值模型）<br>'+
    'N并发需求: <code>D = N × (S<sub>life</sub> − 抵扣)</code>，DRAM/SSD 存储体积 × 下沉量化比 '+p.tierQuant+'<br>'+
    '注意：此为静态容量视角；动态调度下的排队/淘汰行为见"调度策略"页仿真'
  );
}



// ======================== TAB 3: SCHEDULING ========================
export function refreshScheduleTab(){
  drawGantt();
  drawBatching();
  drawPrefixSharing();
  drawEviction();
}



export function drawGantt(r = state.simResults[0], input = state.simInput, pageIndex){
  const pager = $('ganttPagination');
  if (pager) {
    pager.hidden = true;
    $('ganttPrev').onclick = null;
    $('ganttNext').onclick = null;
  }
  if (!r || !input?.params || !input?.strategies?.length) {
    showRunPlaceholder(['chartGantt', 'chartBatchOcc'], ['formulaGantt', 'formulaBatchOcc']);
    return;
  }
  const p = input.params;
  const s = input.strategies[0];
  const replay = !!r.replay;
  drawBatchOccupancy(r, input);
  const simEnd = r.simEnd;
  const allRows = (r.timeline || []).map(t => ({ ...t, state: 'done' }))
    .concat(r.incomplete || [])
    .sort((a, b) => a.arrive - b.arrive || String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
  const pages = Math.max(1, Math.ceil(allRows.length / GANTT_PAGE_SIZE));
  const page = replay ? Math.max(0, Math.min(pages - 1, Math.trunc(pageIndex ?? ganttPages.get(r) ?? 0))) : 0;
  ganttPages.set(r, page);
  const offset = replay ? page * GANTT_PAGE_SIZE : 0;
  const timeline = replay ? allRows.slice(offset, offset + GANTT_PAGE_SIZE) : allRows;
  if (pager) {
    pager.hidden = !replay;
    if (replay) {
      const n = r.replay.counts;
      $('ganttPageStatus').textContent = `${allRows.length ? offset + 1 : 0}–${offset + timeline.length} / ${n.arrived} · 第 ${page + 1}/${pages} 页 · 成功 ${n.successful} / 失败 ${n.failed} / 已到达未完成 ${n.arrivedUnfinished}`;
      $('ganttPrev').disabled = page === 0;
      $('ganttNext').disabled = page === pages - 1;
      $('ganttPrev').onclick = () => drawGantt(r, input, page - 1);
      $('ganttNext').onclick = () => drawGantt(r, input, page + 1);
    }
  }
  const ganttEl = $('chartGantt');
  ganttEl.style.height = Math.min(4400, Math.max(320, timeline.length * 22)) + 'px';
  ganttEl.style.maxHeight = 'none';
  const ch = initChart('chartGantt');
  const status = t => t.state === 'done' ? '成功' : t.state === 'failed' ? '失败' : '截止未完成 (' + t.state + ')';
  const categories = timeline.map(t => 'Req #' + t.id + (replay || t.state !== 'done' ? ' · ' + status(t) : ''));
  const queueData = [], waitComputeData = [], prefillData = [], decodeData = [], failedData = [];
  timeline.forEach((t, row) => {
    const end = t.state === 'done' ? t.completeTime : t.state === 'failed' ? t.failedAt : simEnd;
    const segment = (data, start, stop) => {
      if (!Number.isFinite(start) || !Number.isFinite(end)) return;
      const finish = Math.min(stop ?? end, end);
      if (finish < start || (replay && finish === start)) return;
      const value = [row, start, finish];
      data.push(stop == null ? { value, itemStyle: { opacity: 0.35 } } : value);
    };
    segment(queueData, t.arrive, t.admitTime);
    segment(waitComputeData, t.admitTime, t.prefillStart);
    segment(prefillData, t.prefillStart, t.prefillEnd);
    segment(decodeData, t.prefillEnd, t.completeTime);
    if (t.state === 'failed') failedData.push([row, end, end]);
  });
  const maxT = replay ? simEnd : Math.max(simEnd, ...timeline.map(t => t.completeTime || 0), 0.01);

  function makeGanttSeries(name, color, data) {
    return { name: name, type: 'custom', renderItem: function(params, api) {
      let cat = api.value(0), start = api.coord([api.value(1), cat]), end = api.coord([api.value(2), cat]);
      let h = api.size([0, 1])[1] * 0.6;
      return { type: 'rect', shape: { x: start[0], y: start[1] - h / 2, width: Math.max(end[0] - start[0], 2), height: h }, style: api.style() };
    }, itemStyle: { color: color, borderRadius: 3 }, encode: { x: [1, 2], y: 0 }, data: data };
  }

  ch.setOption({
    title: timeline.length ? undefined : { text: replay ? '全程无实际到达请求' : '无请求记录', left: 'center', top: 'center', textStyle: { color: '#9ca0b0', fontSize: 13 } },
    tooltip: { trigger: 'item', formatter: p => {
      const d = Array.isArray(p.data) ? p.data : p.data.value;
      const t = timeline[d[0]];
      const detail = t.state === 'failed' ? '<br/>失败原因: ' + escapeHtml(t.reason) : '';
      return 'Req #' + escapeHtml(t.id) + ' · ' + escapeHtml(status(t)) + detail + '<br/>' + escapeHtml(p.seriesName) +
        '<br/>开始: ' + numberText(d[1], 3, 's') + '<br/>结束: ' + numberText(d[2], 3, 's') + '<br/>持续: ' + numberText(d[2] - d[1], 3, 's');
    }},
    legend: { data: ['Queue(等槽位/显存)', 'Wait(等算力)', 'Prefill', 'Decode', ...(failedData.length ? ['失败'] : [])], top: 0, textStyle: { color: '#9ca0b0' } },
    grid: { left: replay ? 220 : 80, right: 46, top: 40, bottom: 20 },
    // 只用 slider 缩放：移除 inside dataZoom——它即使 zoomOnMouseWheel:'shift' 仍会拦截滚轮事件，导致页面无法滚动
    dataZoom: [
      { type: 'slider', yAxisIndex: 0, right: 4, width: 14,
        start: 0, end: 100,
        borderColor: 'transparent', backgroundColor: 'rgba(46,51,71,.4)',
        fillerColor: 'rgba(108,99,255,.25)', handleStyle: { color: '#6c63ff' },
        textStyle: { color: '#9ca0b0' } }
    ],
    xAxis: { type: 'value', name: '时间(s)', nameTextStyle: { color: '#9ca0b0' }, axisLabel: { color: '#9ca0b0' }, min: 0, max: maxT },
    yAxis: { type: 'category', data: categories, axisLabel: { color: '#e4e4e7', fontSize: 9 } },
    series: [
      makeGanttSeries('Queue(等槽位/显存)', 'rgba(228,228,235,0.55)', queueData),
      makeGanttSeries('Wait(等算力)', '#fbbf24', waitComputeData),
      makeGanttSeries('Prefill', '#fb923c', prefillData),
      makeGanttSeries('Decode', '#6c63ff', decodeData),
      ...(failedData.length ? [{ name: '失败', type: 'scatter', symbol: 'diamond', symbolSize: 10, encode: { x: 1, y: 0 }, data: failedData, itemStyle: { color: '#f87171' } }] : []),
    ]
  });

  if (replay) {
    const n = r.replay.counts;
    setFormula('formulaGantt', resultCaption(r, input) + '<br>总到达 ' + n.arrived + ' · 成功 ' + n.successful + ' / 失败 ' + n.failed +
      ' / 已到达未完成 ' + n.arrivedUnfinished + '；按到达时间、请求 ID 排序，每页 100 行。未到达请求仅保留摘要计数。<br>' +
      'Queue = 到达→准入；Wait = 准入→Prefill 开始；Prefill = 开始→结束；Decode = Prefill 结束→成功完成（含期间等待，不提供逐 token 或细粒度等待事件）。<br>' +
      '失败段止于 failedAt，未完成段止于 simEnd；浅色表示该阶段未结束，菱形表示失败时刻，未发生阶段不绘制。<br>' + truncationNotice(r));
    return;
  }
  setFormula('formulaGantt',
    resultCaption(r, input) + '<br><b>计算方式 — 仿真引擎阶段记录（两级排队）</b><br>'+
    '• <b>Queue(灰)</b> = 到达 → 准入：等 batch 槽位(≤max_batch_size) + 显存可放置(含淘汰/传输耗时)<br>'+
    '• <b>Wait(黄)</b> = 准入 → Prefill 开始，记录准入后的等待区间，不细分等待事件<br>'+
    '• <b>Prefill(橙)</b> = 开始 → 结束的墙钟区间（可含竞争等待）；计算模型 <code>per-token τ(i)=a+b·i μs</code>（'+(p.mfuAuto?'Roofline 自动判瓶颈':'MFU='+(p.mfu*100).toFixed(0)+'% 计算瓶颈口径')+'；当前 a='+p.prefillA+', b='+p.prefillB+'）<br>'+
    '• <b>Decode(紫)</b> = Prefill 结束 → 成功完成，含期间等待；不提供逐 token 或细粒度等待事件<br>'+
    '• 策略 <code>'+escapeHtml(s.name||'当前策略')+'</code> · 完成 <code>'+r.completed+'/'+r.totalReqs+'</code> · 平均排队 <code>'+r.avgQueue.toFixed(2)+'s</code><br>'+
    '• 共 <code>'+timeline.length+'</code> 行（完成 '+r.completed+' + 未完成 '+(r.incomplete||[]).length+'，按到达时间、请求 ID 排序；浅色段=仿真结束时仍滞留在该阶段）<br>'+
    (r.truncated ? truncationNotice(r) + '<br>' : '')+
    '• 下方并发占用图为定时采样的 Prefill / Decode 活动请求数，不是逐事件执行轨迹'
  );
}



function drawBatchOccupancy(r, input) {
  const occ = r.concTimeline || [];
  const interval = r.replay?.samples.legacy.concurrencySampleIntervalSeconds ?? 0.01;
  setFormula('formulaBatchOcc', resultCaption(r, input) + '<br>活跃期约 ' + numberText(interval * 1000, 0) +
    'ms 定时采样，空闲跳步由边界点表示；非完整事件流。排队深度 = 等准入 + 等 Prefill，不含 Decode 等待。');
  const ch = initChart('chartBatchOcc');
  ch.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: ['Decode并发数', 'Prefill占用', '排队深度'], top: 0, textStyle: { color: '#9ca0b0', fontSize: 10 } },
    grid: { left: 60, right: 30, top: 30, bottom: 25 },
    xAxis: { type: 'value', name: '时间(s)', nameTextStyle: { color: '#9ca0b0' }, axisLabel: { color: '#9ca0b0' }, min: 0, max: r.simEnd },
    yAxis: { type: 'value', name: '请求数', nameTextStyle: { color: '#9ca0b0' }, axisLabel: { color: '#9ca0b0' }, minInterval: 1 },
    series: [
      { name: 'Decode并发数', type: 'line', step: 'end', data: occ.map(smp => [smp[0], smp[1]]),
        showSymbol: false, lineStyle: { color: '#6c63ff', width: 2 }, areaStyle: { color: 'rgba(108,99,255,.22)' } },
      { name: 'Prefill占用', type: 'line', step: 'end', data: occ.map(smp => [smp[0], smp[2]]),
        showSymbol: false, lineStyle: { color: '#fb923c', width: 1.5 }, areaStyle: { color: 'rgba(251,146,60,.22)' } },
      { name: '排队深度', type: 'line', step: 'end', data: occ.map(smp => [smp[0], smp[3]]),
        showSymbol: false, lineStyle: { color: '#9ca0b0', width: 1.5, type: 'dashed' } },
    ]
  });
}

export function drawBatching(){
  if (replayTheoryUnavailable('chartBatching', 'formulaBatching')) return;
  let p=getParams(), r=calcAll(p);
  let batchSizes=[1,2,4,8,16,32,64,128,256];
  let avgKv = r.avgLifetimeKv;
  let pts = batchSizes.map(b=>{
    let passMem = (r.modelWeightBytes * r.decodeWeightRatio + b*avgKv)/r.aggHbmBW
      + perReqMs(b, r.activatedParams, p.gpus)/1000; // 与引擎 per-req 校准一致
    let passCmp = 2*r.activatedParams*b/r.computeFlops;
    let passT = Math.max(passMem, passCmp) + r.commTime(b);
    let tp = b/passT;                                  // 批次总吞吐 tok/s
    // prefill 用位置感知积分(与 TTFT/引擎同源), 旧实现用 prefillTps 线性口径与 a/b 不一致
    let pfT = prefillIntegral(p, p.inputLen);
    let lat = (pfT + p.outputLen*passT)*1000;  // ms
    return {b:b, lat:lat, tp:tp, bound:passCmp>passMem?'算力':'带宽'};
  });
  let ch=initChart('chartBatching');
  ch.setOption({
    tooltip:{trigger:'item',formatter:d=>{let q=pts[d.dataIndex];return 'Batch='+q.b+'<br/>延迟: '+q.lat.toFixed(0)+'ms<br/>吞吐: '+formatNum(q.tp)+' tok/s<br/>受限: '+q.bound;}},
    grid:{left:70,right:20,top:20,bottom:40},
    xAxis:{type:'value',name:'单请求端到端延迟(ms)',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'}},
    yAxis:{type:'value',name:'批次吞吐量(tok/s)',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'}},
    series:[{type:'scatter',data:pts.map(q=>[q.lat,q.tp]),symbolSize:val=>10+Math.sqrt(val[1])/3,
      itemStyle:{color:new echarts.graphic.LinearGradient(0,0,1,1,[
        {offset:0,color:'#6c63ff'},{offset:1,color:'#34d399'}])},
      label:{show:true,formatter:(d)=>'B='+pts[d.dataIndex].b,position:'top',color:'#9ca0b0',fontSize:10},
      markLine:{silent:true,data:[{xAxis:(r.estLatency*1000),label:{formatter:'当前配置估计',color:'#f87171'}}],lineStyle:{color:'#f87171',type:'dashed'}}
    }]
  });
  setFormula('formulaBatching',
    '<b>📐 计算方式（Roofline 模型 + TP通信）</b><br>'+
    '每次前向(pass)耗时: <code>T(b) = max[(W + b×KV̄)/BW<sub>hbm</sub>, 2P<sub>act</sub>×b/FLOPS] + comm(b)</code><br>'+
    '&nbsp;&nbsp;W='+formatBytes(r.modelWeightBytes)+' · KV̄='+formatBytes(avgKv)+' · BW='+(p.hbmBW*p.gpus).toFixed(1)+'TB/s · FLOPS='+formatNum(r.computeFlops)+'<br>'+
    '&nbsp;&nbsp;comm(b) = TP='+r.tpSize+' AllReduce开销 = <code>2L×(2(TP−1)/TP×b×hidden×2B)/NVLink + 2L×5μs</code>（延迟项在小batch时占主导）<br>'+
    '吞吐: <code>TP(b) = b / T(b)</code> —— b小时带宽瓶颈（TP近线性增长），b大时算力瓶颈（TP饱和）<br>'+
    '延迟: <code>Lat(b) = prefill + S<sub>out</sub> × T(b)</code>（不含排队）· 曲线右上的拐点即 Roofline 拐点'
  );
}



export function drawPrefixSharing(){
  if (replayTheoryUnavailable('chartPrefix', 'formulaPrefix')) return;
  let p=getParams(), r=calcAll(p);
  let hitRates=[0,10,20,30,40,50,60,70,80,90,100];
  let groupRatios=PREFIX_RATIOS;
  let ch=initChart('chartPrefix');
  // 期望模型：每请求期望复用 = hit × inputLen（命中率=可复用前缀token占总输入的比例）
  let savedData=hitRates.map(hr=>hr/100*p.concurrency*p.inputLen*r.kvPerToken/1e9);
  let extraReqData=hitRates.map(hr=>Math.floor(hr/100*p.concurrency*p.inputLen*r.kvPerToken/r.avgLifetimeKv));
  ch.setOption({
    tooltip:{trigger:'axis'},
    legend:{data:['显存节省(GB)','额外并发数'],top:0,textStyle:{color:'#9ca0b0'}},
    grid:{left:60,right:60,top:40,bottom:30},
    xAxis:{type:'category',data:hitRates.map(h=>h+'%'),name:'前缀命中率(复用token占比)',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'}},
    yAxis:[
      {type:'value',name:'显存节省(GB)',nameTextStyle:{color:'#6c63ff'},axisLabel:{color:'#9ca0b0'}},
      {type:'value',name:'额外并发数',nameTextStyle:{color:'#34d399'},axisLabel:{color:'#9ca0b0'}}
    ],
    series:[
      {name:'显存节省(GB)',type:'bar',data:savedData,itemStyle:{color:'rgba(108,99,255,.6)'},
        label:{show:true,position:'top',formatter:p=>p.value.toFixed(1),color:'#6c63ff',fontSize:9}},
      {name:'额外并发数',type:'line',yAxisIndex:1,data:extraReqData,
        lineStyle:{color:'#34d399',width:2},itemStyle:{color:'#34d399'},
        label:{show:true,position:'top',color:'#34d399',fontSize:9}}
    ]
  });
  let ratiosStr=groupRatios.map(x=>(x*100).toFixed(0)+'%').join(', ');
  setFormula('formulaPrefix',
    '<b>📐 计算方式（期望值模型）</b><br>'+
    '命中率定义: <code>hit = 可复用前缀token / 总输入token</code> → 每请求期望复用 <code>hit × '+p.inputLen+' tok</code><br>'+
    '显存节省: <code>S = N × hit × S<sub>in</sub> × S<sub>kv/tok</sub></code> · 额外并发: <code>ΔN = S / S<sub>life</sub></code><br>'+
    '前缀组结构 <code>ratios = ['+ratiosStr+']</code>（均值 '+(AVG_PREFIX_RATIO*100).toFixed(0)+'%）只决定仿真中前缀长度的分布与可达上限，不影响期望节省量'
  );
}



export function drawEviction(){
  if (replayTheoryUnavailable('chartEviction', 'formulaEviction')) return;
  let p=getParams();
  let cacheSizes_pct=[5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,90,95];
  let nBlocks=200,nRequests=5000;
  // 固定种子生成同一条 Zipf trace —— 所有策略/容量共用，保证公平可比
  let rng = mulberry32(p.seed);
  let zipfCdf=[],sum=0;
  for(let i=1;i<=nBlocks;i++){sum+=1/Math.pow(i,1.2);zipfCdf.push(sum);}
  let trace=[];
  for(let t=0;t<nRequests;t++){
    let r0=rng()*sum,cum=0;
    for(let i=0;i<nBlocks;i++){if(zipfCdf[i]>=r0){trace.push('b'+(i+1));break;}}
  }
  // Belady 最优：预计算每个位置的下次使用索引
  let nextUse=new Array(nRequests);
  {
    let lastSeen={};
    for(let t=nRequests-1;t>=0;t--){let b=trace[t];nextUse[t]=(lastSeen[b]!==undefined)?lastSeen[b]:Infinity;lastSeen[b]=t;}
  }
  function simulate(strategy,cacheSize){
    let cache=[],hits=0,freq={},lastT={},inCacheT={};
    for(let t=0;t<nRequests;t++){
      let block=trace[t];
      freq[block]=(freq[block]||0)+1;
      let idx=cache.indexOf(block);
      if(idx>=0){hits++;lastT[block]=t;continue;}
      if(cache.length>=cacheSize){
        let victim;
        if(strategy==='lru') victim=cache.reduce((a,b)=>(lastT[a]||0)<=(lastT[b]||0)?a:b);
        else if(strategy==='lfu') victim=cache.reduce((a,b)=>(freq[a]||0)<=(freq[b]||0)?a:b);
        else if(strategy==='fifo') victim=cache.reduce((a,b)=>inCacheT[a]<=inCacheT[b]?a:b);
        else{ // belady: 淘汰下次使用最远的
          victim=cache.reduce((a,b)=>{
            let na=Infinity,nb=Infinity;
            for(let k=t+1;k<nRequests;k++){if(trace[k]===a){na=k;break;}}
            for(let k=t+1;k<nRequests;k++){if(trace[k]===b){nb=k;break;}}
            return na>=nb?a:b;
          });
        }
        cache.splice(cache.indexOf(victim),1);
        delete freq[victim];
      }
      cache.push(block);lastT[block]=t;inCacheT[block]=t;
    }
    return hits/nRequests*100;
  }
  // Belady 的 O(n×cache) 在内层扫描太慢，改用 nextUse 数组的版本
  function simulateBelady(cacheSize){
    let cache=[],hits=0;
    let posIdx={}; // block -> array of positions (pointer)
    let positions={};
    trace.forEach((b,t)=>{(positions[b]=positions[b]||[]).push(t);});
    let ptr={};
    for(let t=0;t<nRequests;t++){
      let b=trace[t];ptr[b]=(ptr[b]||0)+1;
      if(cache.indexOf(b)>=0){hits++;continue;}
      if(cache.length>=cacheSize){
        let victim=cache[0],worst=-1;
        cache.forEach(c=>{
          let arr=positions[c],pi=ptr[c]||0;
          let nu=pi<arr.length?arr[pi]:Infinity;
          if(nu>worst){worst=nu;victim=c;}
        });
        cache.splice(cache.indexOf(victim),1);
      }
      cache.push(b);
    }
    return hits/nRequests*100;
  }
  let strategies=[
    {name:'LRU',color:'#6c63ff',fn:s=>simulate('lru',s)},
    {name:'LFU',color:'#34d399',fn:s=>simulate('lfu',s)},
    {name:'FIFO',color:'#fb923c',fn:s=>simulate('fifo',s)},
    {name:'Optimal(Belady)',color:'#f87171',fn:s=>simulateBelady(s)},
  ];
  let ch=initChart('chartEviction');
  ch.setOption({
    tooltip:{trigger:'axis',valueFormatter:v=>v.toFixed(1)+'%'},
    legend:{data:strategies.map(s=>s.name),top:0,textStyle:{color:'#9ca0b0'}},
    grid:{left:60,right:20,top:40,bottom:30},
    xAxis:{type:'category',data:cacheSizes_pct.map(c=>c+'%'),name:'缓存容量(占全部Block的百分比)',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0',fontSize:9,rotate:45}},
    yAxis:{type:'value',name:'命中率(%)',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'},max:100},
    series:strategies.map(s=>({
      name:s.name,type:'line',smooth:true,
      data:cacheSizes_pct.map(c=>s.fn(Math.max(1,Math.floor(c/100*nBlocks)))),
      lineStyle:{color:s.color,width:2},
      itemStyle:{color:s.color}
    }))
  });
  setFormula('formulaEviction',
    '<b>📐 计算方式</b><br>'+
    '固定种子(seed='+p.seed+')生成唯一一条trace: <code>'+nBlocks+'</code>个块 · <code>'+nRequests+'</code>次访问 · Zipf(α=1.2)<br>'+
    '• <b>LRU</b>: 淘汰最久未访问 · <b>LFU</b>: 淘汰频率最低 · <b>FIFO</b>: 淘汰最早入缓存<br>'+
    '• <b>Optimal(Belady)</b>: 真实实现——预计算每个块的下次访问位置，淘汰未来最远才被访问的块（理论命中率上界）<br>'+
    '所有策略跑同一条trace，曲线差异完全来自策略本身（共同随机数法）'
  );
}



function replayMetricItems(sr) {
  const m = sr.replay.windows.measurement, n = sr.replay.counts, cache = m.cache;
  const items = [];
  for (const [name, key, unit] of [['TTFT', 'ttft', ' ms'], ['TPOT', 'tpot', ' ms/token'], ['E2E', 'endToEnd', ' ms']]) {
    const d = m.latency[key];
    for (const [label, field] of [['均值', 'mean'], ['P50', 'p50'], ['P99', 'p99']]) {
      items.push([name + '(' + label + ')', numberText(d[field], 3, unit), 'accent']);
    }
    items.push([name + '(样本数)', numberText(d.count, 0), 'accent']);
  }
  items.push(
    ['到达 QPS', numberText(m.arrivalQps, 3, ' 请求/秒'), 'green'],
    ['完成 QPS', numberText(m.completionQps, 3, ' 请求/秒'), 'green'],
    ['Token 命中率', numberText(cache.hitRate == null ? null : cache.hitRate * 100, 2, '%'), 'green'],
    ['命中 token 数', numberText(cache.hitL1Tokens + cache.hitL2Tokens + cache.hitL3Tokens, 0), 'green'],
    ['未命中 token 数', numberText(cache.missTokens, 0), 'orange'],
    ['输入 token 数', numberText(cache.inputTokens, 0), 'accent'],
  );
  for (const [label, key] of [['计划请求', 'planned'], ['到达请求', 'arrived'], ['完成请求', 'successful'], ['失败请求', 'failed'],
    ['取消请求', 'cancelled'], ['未完成请求', 'unfinished'], ['已到达未完成', 'arrivedUnfinished'], ['待到达', 'pendingArrival'], ['等待前置触发', 'waitingAnchor']]) {
    items.push([label + '(全程)', numberText(n[key], 0), 'accent']);
  }
  items.push(
    ['输出吞吐(全程)', numberText(sr.throughput, 3, ' tok/s'), 'green'],
    ['显存利用率峰值(全程)', numberText(sr.memUtilPeak, 1, '%'), 'accent'],
    ['显存利用率平均(全程)', numberText(sr.memUtilAvg, 1, '%'), 'accent'],
    ['平均排队(全程成功请求)', numberText(n.successful ? sr.avgQueue : null, 3, ' s'), 'orange'],
    ['Prefill 计算残差(全程)', numberText(sr.ttftBreakdown?.compute, 3, ' ms'), 'accent'],
    ['Prefill 纯计算(全程)', numberText(sr.ttftBreakdown?.computeNet, 3, ' ms'), 'accent'],
    ['算力竞争等待(全程)', numberText(sr.ttftBreakdown?.computeWait, 3, ' ms'), 'orange'],
    ['Prefill GPU忙碌(全程)', numberText(sr.ttftBreakdown?.computeBusyMs, 3, ' ms'), 'accent'],
    ['并发计算请求数(全程)', numberText(sr.ttftBreakdown?.computeConc, 1), 'accent'],
    ['Decode 计算/pass(全程)', numberText(sr.passMs ? sr.passMs.hbm + sr.passMs.cmp + sr.passMs.comm : null, 3, ' ms/pass'), 'accent'],
    ['瓶颈归因(全程)', sr.ptSamples ? bottleneckLabel(sr) : '无样本', 'accent'],
  );
  for (const name of ['L2读带宽', 'L3读带宽', 'L2驻留', 'L3驻留', '分层缓存能力', '物理 P/D 分离', '多实例分析']) {
    items.push([name, '不适用', 'accent']);
  }
  return items;
}

export function drawStrategyMetrics() {
  const input = resultInputs();
  let grid = $('strategyMetricsGrid');
  if (!input) { grid.textContent = '请先运行'; return; }
  const { gv } = input;
  let rows = [];
  state.simResults.forEach(sr => {
    const m = sr.replay?.windows.measurement;
    const heading = sr.replay ? resultCaption(sr, { strategies: [{ name: sr.name }] }) + '<br>核心指标：measurement [' +
      numberText(m.start) + ', ' + numberText(m.end) + ') s；延迟按成功请求到达归窗，完成 QPS 按完成事件归窗。全程分析单独标注。' : escapeHtml(sr.name);
    rows.push('<div style="grid-column:1/-1;font-size:.78rem;color:var(--accent);margin-bottom:2px;border-bottom:1px solid var(--border);padding-bottom:4px;margin-top:8px">'+heading+'</div>');
    let items = sr.replay ? replayMetricItems(sr) : [
      ['HBM命中率', (sr.hbmHitRate != null ? sr.hbmHitRate : 0).toFixed(1)+'%', 'green'],
      ['TTFT(均值)', sr.avgTtft.toFixed(0)+' ms', 'accent'],
      ['TTFT(P50)', sr.p50Ttft.toFixed(0)+' ms', 'accent'],
      ['TTFT(P99)', sr.p99Ttft.toFixed(0)+' ms', 'orange'],
      ['TPOT(均值)', sr.avgTpot.toFixed(1)+' ms/tok', 'accent'],
      ['TPOT(P99)', sr.p99Tpot.toFixed(1)+' ms/tok', 'red'],
      ['P50延迟', sr.p50.toFixed(0)+' ms', 'accent'],
      ['P99延迟', sr.p99.toFixed(0)+' ms', 'red'],
      ['平均排队', sr.avgQueue.toFixed(2)+' s', 'orange'],
      // 传输 vs 计算「重叠之前」的独立用时（2026-08-18）：看清带宽/算力各作用于哪个阶段
      // Prefill 传输(独立) = 仿真过程中的实际传输耗时(含 L3 带宽排队, 不含计算)——
      // 用真实时间戳差(_ft1-_ft0)独立测量, 不会被计算覆盖; race/be 下 fetch 计入 TTFT 为 0
      // 但此处仍如实报出被计算重叠隐藏的拉取过程时长。
      ['Prefill 传输(独立)', sr.ttftBreakdown ? (sr.ttftBreakdown.fetchReal||0).toFixed(0)+' ms' : '—', 'orange'],
      // ⚠️ 改名(2026-08-21): 原名"Prefill 计算(独立)"有误导 —— 它**不是**独立测量, 而是
      // 每请求"prefill 墙钟 − 拉取等待"的**残差**。拉取慢时会被挤压到甚至小于单请求独占
      // 计算时间(实测: 残差 134ms < 独占 185ms), 只看它会误判"计算不是瓶颈"。
      // 真实算力使用看下面两张卡(GPU忙碌 / 并发计算数)。
      ['Prefill 计算(残差)', sr.ttftBreakdown ? sr.ttftBreakdown.compute.toFixed(0)+' ms' : '—', 'accent'],
      // ★ compute 的二级拆分(2026-08-24): compute = 纯计算 + 算力竞争等待
      // ├ 纯计算   = 该请求**独占**的 GPU 时间(Σ chunk × τ(posMid), 波次上岗时累计)。
      //             与并发数无关(实测 qps 1→1000 离散仅 1.41%), 直接对标解析式
      //             prefillIntegral 增量(误差 2.5%, 优于"compute÷并发"的 10.3%)。
      // └ 算力竞争 = compute − 纯计算。N 个请求瓜分算力时, 每个都把整段墙钟记进自己的
      //             compute, 差额即被他人占用算力的时长。⚠️ 不含拉取等待(那在 fetch 里)。
      // 波次模式下"算力竞争"还含等整波其他成员算完的波次量化等待。
      ['├ 纯计算(独占)', sr.ttftBreakdown && sr.ttftBreakdown.computeNet != null
        ? sr.ttftBreakdown.computeNet.toFixed(0)+' ms' : '—', 'green'],
      // 竞争等待占 compute 过半 ⇒ 算力已被并发瓜分严重, 标红
      ['└ 算力竞争等待', sr.ttftBreakdown && sr.ttftBreakdown.computeWait != null
        ? sr.ttftBreakdown.computeWait.toFixed(0)+' ms ('
          + (sr.ttftBreakdown.computeWait / Math.max(sr.ttftBreakdown.compute, 1e-9) * 100).toFixed(0)
          + '%)' : '—',
        (sr.ttftBreakdown && sr.ttftBreakdown.computeWait
          > sr.ttftBreakdown.compute * 0.5) ? 'red'
          : ((sr.ttftBreakdown && sr.ttftBreakdown.computeWait
              > sr.ttftBreakdown.compute * 0.25) ? 'orange' : 'green')],
      // GPU 占用画像(2026-08-21): 区分"计算便宜"与"GPU 被存储饿死"
      ['Prefill GPU忙碌', sr.ttftBreakdown && sr.ttftBreakdown.computeBusyMs != null
        ? sr.ttftBreakdown.computeBusyMs.toFixed(0)+' ms ('+(sr.ttftBreakdown.computeBusyPct||0).toFixed(0)+'%窗口)' : '—', 'accent'],
      // 并发计算数 <2 ⇒ 流水线空转(算力被拉取饿死), 标红提示
      ['并发计算请求数', sr.ttftBreakdown && sr.ttftBreakdown.computeConc != null
        ? sr.ttftBreakdown.computeConc.toFixed(1)+' 个' : '—',
        (sr.ttftBreakdown && sr.ttftBreakdown.computeConc < 2) ? 'red'
          : ((sr.ttftBreakdown && sr.ttftBreakdown.computeConc < 5) ? 'orange' : 'green')],
      // ⚠️ 已被上面「├ 纯计算(独占)」取代(2026-08-24): 那是逐步累计的**直接测量**,
      // 这里的 compute÷并发 只是**比值估计**(实测误差 10.3% vs 直接测量 2.5%,
      // 因为 computeConc 是"GPU 忙时的条件平均", 与逐请求口径不完全一致)。
      // 保留此卡作**口径交叉校验**: 两者偏差大 ⇒ 并发分布很不均匀(有请求长期独占/长期挨饿)。
      ['└ 校验:残差÷并发', sr.ttftBreakdown && sr.ttftBreakdown.computeConc > 0
        ? (sr.ttftBreakdown.compute / sr.ttftBreakdown.computeConc).toFixed(0)+' ms'
          + (sr.ttftBreakdown.computeNet > 0
            ? ' (vs 直测 '
              + ((sr.ttftBreakdown.compute / sr.ttftBreakdown.computeConc
                  / sr.ttftBreakdown.computeNet - 1) * 100).toFixed(0) + '%)'
            : '')
        : '—', 'accent'],
      // PD 真分离(2026-08-20): P→D KV 传输是 TTFT 的新增分量, 只在真分离档非 0
      ['PD KV传输(TTFT内)', sr.pd ? (sr.ttftBreakdown ? sr.ttftBreakdown.xfer.toFixed(0)+' ms' : '—') : '—',
        sr.pd && sr.ttftBreakdown && sr.ttftBreakdown.xfer > sr.ttftBreakdown.compute ? 'red' : 'orange'],
      ['PD 传输量/请求', sr.pd ? sr.pd.xferPerReqMB.toFixed(0)+' MB' : '—', 'orange'],
      ['PD 传输(独立/实际)', sr.pd ? sr.pd.xferSoloMs.toFixed(0)+' / '+sr.pd.xferSpanMs.toFixed(0)+' ms' : '—',
        sr.pd && sr.pd.xferSpanMs > sr.pd.xferSoloMs * 1.5 ? 'red' : 'orange'],
      ['PD 卡数(P/D)', sr.pd ? sr.pd.prefillGpus+' / '+sr.pd.decodeGpus+' 卡' : '—', 'accent'],
      // 多实例(S2, 2026-08-20)
      ['实例数(卡/实例)', sr.multi ? sr.multi.count+' × '+sr.multi.gpusPerInst.join('/')+' 卡' : '—', 'accent'],
      ['路由策略', sr.multi ? sr.multi.routePolicy + (sr.multi.routeHook ? '(JS钩子)' : (sr.multi.routeFromDsl ? '(DSL)' : '')) : '—', 'accent'],
      // 均衡度主指标: queueCV(仅系统有负载窗内采样) —— 不用 avgQueue 的 CV(会被排空长尾污染)
      ['负载均衡度(队列CV)', sr.multi ? sr.multi.queueCV.toFixed(1)+'%' : '—',
        sr.multi && sr.multi.queueCV > 50 ? 'red' : (sr.multi && sr.multi.queueCV > 25 ? 'orange' : 'green')],
      ['峰值队列极差', sr.multi ? String(sr.multi.peakSpread) : '—',
        sr.multi && sr.multi.peakSpread > 20 ? 'red' : (sr.multi && sr.multi.peakSpread > 5 ? 'orange' : 'green')],
      ['各实例完成数', sr.multi ? sr.multi.perInst.map(x => x.completed).join(' / ') : '—', 'accent'],
      ['各实例在途(busy窗)', sr.multi ? sr.multi.perInst.map(x => x.busyQueue.toFixed(1)).join(' / ') : '—', 'orange'],
      ['各实例峰值队列', sr.multi ? sr.multi.perInst.map(x => x.peakQueue).join(' / ') : '—', 'orange'],
      // S4 前缀亲和(2026-08-20): 亲和开启后命中率从"保证值"变成"路由的输出"
      ['前缀亲和', sr.multi ? (sr.multi.affinity ? '开(按实例隔离)' : '关(全局共享)') : '—',
        sr.multi && sr.multi.affinity ? 'orange' : 'accent'],
      ['命中率(实测/上限)', sr.multi ? sr.multi.hitActual.toFixed(1)+'% / '+sr.multi.hitIdeal.toFixed(0)+'%' : '—',
        sr.multi && sr.multi.hitLossPct > 20 ? 'red' : (sr.multi && sr.multi.hitLossPct > 5 ? 'orange' : 'green')],
      ['路由命中损失', sr.multi ? sr.multi.hitLossPct.toFixed(1)+' pp' : '—',
        sr.multi && sr.multi.hitLossPct > 20 ? 'red' : (sr.multi && sr.multi.hitLossPct > 5 ? 'orange' : 'green')],
      ['各实例命中率', sr.multi ? sr.multi.instHitRate.map(x => x.toFixed(0)+'%').join(' / ') : '—', 'accent'],
      ['Decode 传输/pass(独立)', sr.passMs ? (sr.passMs.l2+sr.passMs.l3).toFixed(2)+' ms' : '—', (sr.passMs && (sr.passMs.l2+sr.passMs.l3) > sr.passMs.hbm+sr.passMs.cmp) ? 'red' : 'orange'],
      ['Decode 计算/pass(独立)', sr.passMs ? (sr.passMs.hbm+sr.passMs.cmp+sr.passMs.comm).toFixed(2)+' ms' : '—', 'accent'],
      ['吞吐', formatNum(sr.throughput)+' tok/s', 'green'],
      ['显存利用率(峰值)', sr.memUtilPeak.toFixed(1)+'%', 'accent'],
      ['显存利用率(平均)', sr.memUtilAvg.toFixed(1)+'%', 'accent'],
      ['淘汰次数', sr.evictions+' (活跃'+sr.activeEvictions+')', 'orange'],
      ['预取次数', sr.prefetches+' 次', 'accent'],
      ['丢弃块数', sr.drops+' 个', sr.drops>0?'red':'green'],
      ['跨层传输量', sr.transferGB.toFixed(1)+' GB', 'orange'],
      ['跨层传输带宽(实测)', formatRate(sr.transferBW), 'orange'],
      ['L2读带宽(实测)', formatRate(sr.l2ReadBW), 'orange'],
      ['L3读带宽(实测)', formatRate(sr.l3ReadBW), 'orange'],
      ['L2占用(峰/均)', sr.l2PeakGB.toFixed(1)+' / '+sr.l2AvgGB.toFixed(1)+' GB', sr.l2PeakGB>0?'orange':'green'],
      ['L3占用(峰/均)', sr.l3PeakGB.toFixed(1)+' / '+sr.l3AvgGB.toFixed(1)+' GB', sr.l3PeakGB>0?'orange':'green'],
      ['L2带宽需求(P99)', formatRate(sr.l2BWp99), sr.l2BWp99 > Math.min(gv('pPcieBW'), gv('pDramBW'))*1e9 ? 'red' : (sr.l2BWp99 > Math.min(gv('pPcieBW'), gv('pDramBW'))*1e9*0.5 ? 'orange' : 'green')],
      ['L3带宽需求(P99)', formatRate(sr.l3BWp99), sr.l3BWp99 > gv('pSsdBW')*1e9 ? 'red' : (sr.l3BWp99 > gv('pSsdBW')*1e9*0.5 ? 'orange' : 'green')],
      ['L2带宽需求(峰值)', formatRate(sr.l2BWPeak), sr.l2BWPeak > Math.min(gv('pPcieBW'), gv('pDramBW'))*1e9 ? 'red' : 'orange'],
      ['L3带宽需求(峰值)', formatRate(sr.l3BWPeak), sr.l3BWPeak > gv('pSsdBW')*1e9 ? 'red' : 'orange'],
      ['容量需求(L2峰值)', sr.l2PeakGB.toFixed(1)+' GB', sr.l2PeakGB > gv('pDram') ? 'red' : 'orange'],
      ['容量需求(L3峰值)', sr.l3PeakGB.toFixed(1)+' GB', sr.l3PeakGB > gv('pSsd')*1000 ? 'red' : 'orange'],
      ['瓶颈归因', bottleneckLabel(sr), 'accent'],
      ['前缀命中请求', sr.prefixHits+' 次', 'green'],
      // 实测分层命中率(2026-08-20, token 加权): 与输入命中率对比 —— 低于输入即说明
      // clamp(短请求被截) 或 容量淘汰/丢弃 侵蚀了命中。L1/L2 近似免费, L3 需付拉取时间。
      ['命中率(实测/输入)', sr.hitRate ? sr.hitRate.total.toFixed(1)+'% / '+sr.hitRate.input.toFixed(0)+'%' : '—',
        sr.hitRate ? (sr.hitRate.total < sr.hitRate.input - 1 ? 'orange' : 'green') : 'accent'],
      ['命中分层(L1/L2/L3)', sr.hitRate ? sr.hitRate.l1.toFixed(1)+' / '+sr.hitRate.l2.toFixed(1)+' / '+sr.hitRate.l3.toFixed(1)+'%' : '—',
        sr.hitRate && sr.hitRate.l3 > sr.hitRate.l1 + sr.hitRate.l2 ? 'orange' : 'accent'],
      ['未命中(需重算)', sr.hitRate ? sr.hitRate.miss.toFixed(1)+'%' : '—', sr.hitRate && sr.hitRate.miss > 50 ? 'orange' : 'green'],
      ['前缀节省显存', sr.prefixSavedMB.toFixed(0)+' MB', 'green'],
      ['会话复用', sr.sessionHits+' 次', 'green'],
      ['公平性(CV)', sr.fairnessCV.toFixed(0)+'%', 'accent'],
      ['完成请求', sr.completed+'/'+sr.totalReqs+' ('+(sr.totalReqs>0?(sr.completed/sr.totalReqs*100).toFixed(0):0)+'%)', sr.truncated?'red':(sr.completed<sr.totalReqs?'orange':'green')],
      ['仿真窗口', sr.simEnd.toFixed(0)+' s'+(sr.truncated?' · ⚠截断':' · 排空'), sr.truncated?'red':'green'],
    ];
    if (sr.truncated) {
      rows.push('<div style="grid-column:1/-1;color:var(--accent4)">' + truncationNotice(sr) + '</div>');
    }
    items.forEach(it => {
      rows.push('<div class="result-item"><div class="rl">'+it[0]+'</div><div class="rv '+it[2]+'">'+it[1]+'</div></div>');
    });
  });
  grid.innerHTML = rows.join('');
}



// passTime 分解中占比最大的分量 → 瓶颈归因标签
export function bottleneckLabel(sr){
  let b = sr.ptBreakdown;
  if(!b || sr.ptSamples === 0) return '无decode样本';
  let names = {hbm:'HBM读', l2:'L2读', l3:'L3读', cmp:'算力', comm:'TP通信'};
  let keys = ['hbm','l2','l3','cmp','comm'];
  let best = keys.reduce((a,k)=> (b[k]||0)>(b[a]||0)?k:a, 'hbm');
  return names[best]+' '+(b[best]||0).toFixed(0)+'%';
}



// L2/L3 需求推导展示：passTime 分解（瓶颈归因）+ 带宽需求分位 vs 配置 + 驻留时间序列
export function drawStrategyTierDemand(){
  const input = resultInputs();
  if (!input) {
    showRunPlaceholder(['chartStrategyPt', 'chartStrategyBwReq', 'chartStrategyResident'], ['formulaStrategyTier']);
    return;
  }
  const p = input.params;
  const replay = !!state.simResults[0]?.replay;
  let colors = {hbm:'#6c63ff', l2:'#fb923c', l3:'#f87171', cmp:'#34d399', comm:'#9ca0b0'};
  let names = {hbm:'HBM读', l2:'L2读', l3:'L3读', cmp:'算力下限', comm:'TP通信'};
  let keys = replay ? ['hbm','cmp','comm'] : ['hbm','l2','l3','cmp','comm'];
  // 图1: TTFT 分解 + passTime 分解（各 100% 堆叠，每策略两条）
  // TTFT 条 = prefill 段时间账（到达排队/准入排队/L3拉取/计算）；passTime 条 = decode 每 token 前向账
  // ——区分「TTFT 时间花在哪」vs「延迟(每前向)时间花在哪」，L3 拉取与 L3 读的落点一目了然
  // compute 拆成两段(2026-08-24): 纯计算(独占 GPU) + 算力竞争等待(被其他请求瓜分算力)。
  // 这样一眼能分清"计算真的贵" vs "算力被并发瓜分" —— 前者要加算力, 后者要做并发准入控制。
  // 兼容: computeNet/computeWait 缺失(旧结果)时回退为整块 compute 记入"纯计算"段。
  let ttftNames = ['TTFT·到达排队','TTFT·prefill排队','TTFT·L3拉取','TTFT·纯计算','TTFT·算力竞争等待'];
  let ttftKeys = ['queue','prefillQ','fetch','computeNet','computeWait'];
  let ttftColors = ['#B5D4F4','#85B7EB','#FAC775','#185FA5','#C8341F'];
  if (replay) {
    ttftNames.splice(2, 1);
    ttftKeys.splice(2, 1);
    ttftColors.splice(2, 1);
  }
  let ycats = [];
  state.simResults.forEach(s => {
    ycats.push(s.name + ' · TTFT' + (replay ? ' (全程)' + (!s.ttftBreakdown ? ' 无样本' : '') : ''));
    ycats.push(s.name + ' · 每token前向' + (replay ? ' (全程)' + (!s.ptSamples ? ' 无样本' : '') : ''));
  });
  let ch = initChart('chartStrategyPt');
  ch.setOption({
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:v=>numberText(v,1,'%')},
    legend:{data:[...ttftNames, ...keys.map(k=>names[k])],top:0,textStyle:{color:'#9ca0b0',fontSize:9}},
    grid:{left:120,right:30,top:46,bottom:24},
    xAxis:{type:'value',name:'占比(%)',max:100,nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'}},
    yAxis:{type:'category',data:ycats,axisLabel:{color:'#e4e4e7',fontSize:10}},
    series:[
      ...ttftKeys.map((k,i)=>({
        name:ttftNames[i],type:'bar',stack:'ttft',barMaxWidth:22,
        data:state.simResults.flatMap(s=>{ let b=s.ttftBreakdown; if(!b) return [null, null];
          let t=b.queue+b.prefillQ+b.fetch+b.compute;
          let v = (b.computeNet == null)
            ? (k==='computeNet' ? b.compute : (k==='computeWait' ? 0 : b[k]))
            : b[k];
          return [t > 0 && Number.isFinite(v) ? chartNumber(v / t * 100) : null, null]; }),
        itemStyle:{color:ttftColors[i]}
      })),
      ...keys.map(k=>({
        name:names[k],type:'bar',stack:'pt',barMaxWidth:22,
        data:state.simResults.flatMap(s=>[null, chartNumber(s.ptBreakdown?.[k])]),
        itemStyle:{color:colors[k]}
      }))
    ]
  });
  if (replay) {
    const message = '不适用：当前 Replay 未仿真 L2/L3 读带宽、驻留及分层缓存能力。';
    showChartMessage('chartStrategyBwReq', message);
    showChartMessage('chartStrategyResident', message);
    setFormula('formulaStrategyTier', resultCaption(state.simResults[0], state.simInput) +
      '<br>延迟分解为全程统计（顶层 ttftBreakdown，均值单位 ms；ptBreakdown，名义前向分量占比 %），不是 measurement。<br>' +
      'TTFT 分解 = 到达排队 + Prefill 排队 + 纯计算 + 算力竞争等待；纯计算与等待是 compute 残差的拆分。前向分解展示 HBM 读、算力下限和 TP 通信的名义分量，不等于可相加的实际延迟。无样本序列留空。<br>' + message);
    return;
  }
  // 图2: L2/L3 带宽需求 P99/峰值 vs 配置带宽
  let ch2 = initChart('chartStrategyBwReq');
  ch2.setOption({
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:v=>v.toFixed(1)+' GB/s'},
    legend:{data:['L2 P99','L2 峰值','L3 P99','L3 峰值','L2 配置','L3 配置'],top:0,textStyle:{color:'#9ca0b0',fontSize:10}},
    grid:{left:70,right:24,top:36,bottom:24},
    xAxis:{type:'category',data:state.simResults.map(s=>s.name),axisLabel:{color:'#e4e4e7',fontSize:10,rotate:15}},
    yAxis:{type:'value',name:'带宽 (GB/s)',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'}},
    series:[
      {name:'L2 P99',type:'bar',barMaxWidth:16,data:state.simResults.map(s=>+(s.l2BWp99/1e9).toFixed(2)),itemStyle:{color:'#7F77DD'}},
      {name:'L2 峰值',type:'bar',barMaxWidth:16,data:state.simResults.map(s=>+(s.l2BWPeak/1e9).toFixed(2)),itemStyle:{color:'#534AB7'}},
      {name:'L3 P99',type:'bar',barMaxWidth:16,data:state.simResults.map(s=>+(s.l3BWp99/1e9).toFixed(2)),itemStyle:{color:'#F0997B'}},
      {name:'L3 峰值',type:'bar',barMaxWidth:16,data:state.simResults.map(s=>+(s.l3BWPeak/1e9).toFixed(2)),itemStyle:{color:'#D85A30'}},
      {name:'L2 配置',type:'line',data:state.simResults.map(()=>effL2LinkBW(p)),symbol:'none',lineStyle:{color:'#f87171',type:'dashed',width:1.5},itemStyle:{color:'#f87171'}},
      {name:'L3 配置',type:'line',data:state.simResults.map(()=>p.ssdBW),symbol:'none',lineStyle:{color:'#f87171',type:'dotted',width:1.5},itemStyle:{color:'#f87171'}}
    ]
  });
  // 图3: 首个策略的 L2/L3 驻留时间序列（预取/淘汰波次的瞬态画像）
  let sr0 = state.simResults[0];
  let ch3 = initChart('chartStrategyResident');
  ch3.setOption({
    tooltip:{trigger:'axis',valueFormatter:v=>v+' GB'},
    legend:{data:['L2 (DRAM) 占用','L3 (SSD) 占用'],top:0,textStyle:{color:'#9ca0b0',fontSize:10}},
    grid:{left:60,right:24,top:30,bottom:24},
    xAxis:{type:'value',name:'时间(s)',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'}},
    yAxis:{type:'value',name:'占用 (GB)',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'}},
    series:[
      {name:'L2 (DRAM) 占用',type:'line',showSymbol:false,data:sr0.l2Series,lineStyle:{color:'#fb923c',width:1.5},areaStyle:{color:'rgba(251,146,60,.15)'}},
      {name:'L3 (SSD) 占用',type:'line',showSymbol:false,data:sr0.l3Series,lineStyle:{color:'#6c63ff',width:1.5},areaStyle:{color:'rgba(108,99,255,.15)'}}
    ]
  });
  setFormula('formulaStrategyTier',
    '<b>📐 L2/L3 需求推导（实测轨迹 → 所需资源，任意代码策略适用）</b><br>'+
    '• <b>带宽需求</b>: 每步瞬时链路速率 = decode读(<code>ΣKV<sub>T</sub>/passTime</code>) + 本步换入换出字节/DT；取 <code>P99 分位 = 推荐所需带宽</code>（峰值评估最坏突发）——平均口径会低估，预取/淘汰突发才是需求决定因素<br>'+
    '• <b>容量需求</b>: 该策略下 L2/L3 峰值占用（低于它必发生淘汰/丢弃/排队）<br>'+
    '• <b>TTFT 分解</b>（每个策略上条）: 到达排队(→准入) + prefill排队(→prefill开始) + <b>L3拉取fetch</b>(前缀KV从SSD拉回, wait_complete) + <b>纯计算</b> + <b>算力竞争等待</b>——TTFT 时间花在哪<br>'+
    '• <b>compute 已二级拆分</b>（2026-08-24）: 原来的「prefill计算」是<b>墙钟残差</b>，里面混着真计算与算力竞争等待，现在拆开：<code>纯计算(独占)</code>= 该请求<b>独占</b>的 GPU 时间（<code>Σ chunk × τ(posMid)</code>，波次上岗时按成员 chunk 累计），<b>与并发数无关</b>——实测 qps 1→1000 离散仅 1.41%，直接对标解析式 <code>prefillIntegral</code> 增量（误差 2.5%，优于「残差÷并发」的 10.3%）；<code>算力竞争等待</code>= <code>compute − 纯计算</code>，即被<b>其他请求占用算力</b>的时长（prefill 波与 decode pass 交替独占 GPU——一个请求被编进波之前/波与波之间都在等别人，差额就是它；还含「等整波其他成员算完」的波次量化等待）。<b>⚠️ 不含拉取等待</b>（那已单列为 fetch）。<b>诊断价值</b>: 纯计算占主体 ⇒ 真的算力不足，该加卡/降精度/上稀疏；竞争等待占主体（卡片标红）⇒ 算力被并发瓜分，该收紧 prefill token 预算或 max batch、加算力收益有限。实测 B300×8+Kimi-K2+h95: 纯计算恒 89ms，而竞争等待随 qps 从 20ms 涨到 91ms（占 compute 由 18.6% 升到 50.8%）<br>'+
    '• <b>每token前向分解</b>（下条, 原 passTime 分解）: 名义分量 <code>HBM读/L2读/L3读/算力/TP通信</code> 占比（passTime = max[带宽和,算力] + 通信），占比最大者 = 当前瓶颈——decode 延迟时间花在哪<br>'+
    '• <b>两者分工</b>: TTFT 条揭示 <code>fetch vs prefill计算</code> 的 trade-off（L3 拉取代价占比）；前向条揭示 decode 的 L3 读占比（如 77%）——同一图表区分 TTFT 与延迟（每前向）的分解<br>'+
    '• <b>传输 vs 计算</b>（结果卡片）: <code>Prefill 传输(独立)</code>=<b>仿真过程中的实际传输耗时</b>——用真实时间戳差独立测量，含 L3 并发带宽排队、不含计算，<b>不会被计算覆盖</b>（wc=prefill开始→拉完; race=prefill开始→相遇点, 即被计算重叠隐藏的拉取过程; be=到达→拉完或准入终止）。<code>Prefill 计算(残差)</code>=<b>墙钟残差</b>（prefill墙钟 − 拉取等待），<b>不是独立测量</b>：拉取慢时它会被挤压到甚至小于「单请求独占计算时间」（实测双实例 50GB/s 下残差 134ms &lt; 独占 185ms），<b>只看它会误判「计算不是瓶颈」</b>。要判断算力是否真的空闲，看新增的 <code>Prefill GPU忙碌</code>（GPU 真在算 prefill 的墙钟总时长，跨实例累加，括号内为占仿真窗口比例）与 <code>并发计算请求数</code>（平均同时占算力的请求数）：<b>并发数≈1 ⇒ 流水线空转、GPU 被存储饿死</b>（此时该提 L3 带宽或关「重复拉取」，而不是优化计算）；远大于 1 ⇒ 算力已填满，残差 compute 才真实反映计算成本。实测对照：SSD 50GB/s 时并发 1.3 个、残差 134ms；提到 200GB/s 后残差跳到 2200ms——计算成本一直都在，之前被拉取等待吃掉了。<code>Decode 传输/pass(独立)</code>=L2+L3 跨层读(含链路排队)，<code>Decode 计算/pass(独立)</code>=HBM读+算力下限+TP通信；passTime = max(带宽项, 算力项)+通信 ⇒ 两项独立用时中较大者主导实际每前向耗时。勾选「Decode 从 L3 重读」后已拉取前缀块 decode 期按 SSD 读计费(模拟 KV 被驱逐场景)，Decode 传输/pass 将显著上升；decode 的 L3 重读与 prefill 拉取共享同一总线且按需读优先 ⇒ 低带宽下 Prefill 传输(独立) 也会因挤占而上升。取消勾选「Prefill 每请求重复拉取」(=单飞去重) 后同组前缀只拉一次 ⇒ 拉取字节与 Prefill 传输(独立) 显著下降<br>'+
    '• <b>需求 &gt; 配置</b> ⇒ 该层成为瓶颈（TPOT 上升）；<b>需求 vs 解析上界</b>（基础参数页 L2/L3 卡片）⇒ 策略的资源松弛量'
  );
}



export function drawStrategyComparisonGantt() {
  const input = resultInputs();
  if (!input) {
    showRunPlaceholder(['chartStrategyGantt'], ['formulaStrategySim']);
    return;
  }
  const { control: $, gv, gi } = input;
  const replay = !!state.simResults[0]?.replay;
  const hitName = replay ? 'Token命中率(measurement,%)' : 'HBM命中率(%)';
  const memoryName = replay ? '显存利用率峰值(全程,%)' : '显存利用率峰值(%)';
  const latency = (s, key) => replay ? chartNumber(s.replay.windows.measurement.latency.endToEnd[key], 3) : chartNumber(s[key], 0);
  let ch = initChart('chartStrategyGantt');
  ch.setOption({
    tooltip: { trigger: 'axis', valueFormatter: v => numberText(v) },
    legend: { data: [hitName, 'P50延迟(ms)', 'P99延迟(ms)', memoryName], top: 0, textStyle: { color: '#9ca0b0' } },
    grid: { left: 100, right: 70, top: 50, bottom: 30 },
    xAxis: { type: 'category', data: state.simResults.map(s => s.name), axisLabel: { color: '#e4e4e7', rotate: 20, fontSize: 10 } },
    yAxis: [
      { type: 'value', name: '百分比(%)', axisLabel: { color: '#9ca0b0' } },
      { type: 'value', name: '延迟(ms)', axisLabel: { color: '#9ca0b0' } }
    ],
    series: [
      { name: hitName, type: 'bar', data: state.simResults.map(s => {
        const rate = replay ? s.replay.windows.measurement.cache.hitRate : s.hbmHitRate;
        return chartNumber(rate == null ? null : rate * (replay ? 100 : 1), replay ? 2 : 1);
      }), itemStyle: { color: '#34d399' } },
      { name: memoryName, type: 'bar', data: state.simResults.map(s => chartNumber(s.memUtilPeak)), itemStyle: { color: '#fb923c' } },
      { name: 'P50延迟(ms)', type: 'line', yAxisIndex: 1, data: state.simResults.map(s => latency(s, 'p50')), itemStyle: { color: '#6c63ff' }, lineStyle: { color: '#6c63ff', width: 2 } },
      { name: 'P99延迟(ms)', type: 'line', yAxisIndex: 1, data: state.simResults.map(s => latency(s, 'p99')), itemStyle: { color: '#f87171' }, lineStyle: { color: '#f87171', width: 2 } },
    ]
  });
  if (replay) {
    const r = state.simResults[0], m = r.replay.windows.measurement;
    setFormula('formulaStrategySim', resultCaption(r, state.simInput) + '<br>核心指标：measurement [' + numberText(m.start) + ', ' + numberText(m.end) +
      ') s。Token 命中率来自 token 前缀复用（比率 ×100%），不是 HBM 访问命中率。P50/P99 为成功请求端到端延迟 (ms)，按到达归窗。<br>' +
      '完成 QPS 按完成事件归窗；输出吞吐 tok/s 为全程分析，不是请求 QPS。显存利用率峰值为全程统计；空项表示无样本。<br>' + truncationNotice(r));
    return;
  }
  setFormula('formulaStrategySim',
    '<b>📐 仿真说明（事件驱动，全部指标来自真实统计）</b><br>'+
    '• 请求生成: <code>N = 请求数 = '+Math.min(gi('pConcurrency'),256)+'</code> 个 · 到达: '+($('pArrivalDist')&&$('pArrivalDist').value==='uniform'
      ? '均匀等间隔(间隔 1/λ='+(1/Math.max(gv('pQps'),1e-9)).toFixed(3)+'s)'
      : '泊松过程(λ='+gv('pQps')+', seed='+gi('pSeed')+')')+' · 长度分布: '+$('pLenDist').value+' · 多轮复用: '+gi('pMultiTurn')+'%<br>'+
    '• 准入: batch槽位≤max_batch_size 且显存可放置，否则排队 · Prefill: 并行 <code>并发≤min(maxBatch, 上限默认16)，per-token τ(i)=a+b·i μs 位置感知</code>，总算力按各请求当前位置成本加权分摊（sharer 的 prefill 只含非前缀部分——前缀缓存的 TTFT 收益，且组前缀在 founder prefill 完成后才可命中）<br>'+
    '• Decode: 批次共享前向 <code>passTime = max[(W+ΣKV<sub>hbm</sub>)/BW<sub>hbm</sub> + ΣKV<sub>dram</sub>/min(PCIe,DRAM) + ΣKV<sub>ssd</sub>/NVMe, 2P×B/FLOPS]</code><br>'+
    '• <b>L2/L3 实测带宽</b>: 平均口径 = 累计 ΣKV<sub>dram</sub>/ΣKV<sub>ssd</sub> 读取字节÷仿真时长；<b>需求口径</b> = 瞬时链路速率分位数（含预取/淘汰突发，见上方「L2/L3 带宽需求」图与指标网格）<br>'+
    '• <b>仿真窗口</b>: 时长 = <code>min(自适应排水估计, 仿真窗口上限 '+gi('pSimMaxTime')+'s)</code>。排水估计含 KV 下沉减速（HBM→DRAM→SSD 分层，与引擎同口径）。窗口触顶未排空 ⇒ 截断：完成样本不完整，TTFT/P99 跨配置比较会失真——结果会显示建议上限值（≈排水估计），调大「仿真窗口上限」即可跑完全部请求；重负载下亦可对比 TPOT/吞吐<br>'+
    '• 淘汰/预取的跨层搬运占用链路带宽，块到达前不可用 · 前缀共享为真实块引用计数，可被淘汰下沉'
  );
}
