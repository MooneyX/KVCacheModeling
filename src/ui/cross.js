import { $ } from "../adapters/browser/dom.js";
import { getParams } from "../adapters/browser/params.js";
import { state } from "./state.js";
import { parseDSL } from "../core/strategy.js";
import { strategyPresets } from "../core/presets.js";
import { executeBatch } from '../execution/browser/client.ts';
import { initChart, setFormula, escapeHtml } from "./charts.js";
import { extractSensMetrics } from '../application/metrics.js';
import { allowSyntheticAnalysis, updateRunControls, createReplayJob, replayControls, getReplayWorkloadConfig } from './replay.js';
import { buildSweepJob } from '../application/sweep.js';



// ======================== TAB 4: CROSS ANALYSIS ========================
let crossStarted = false;
export function refreshCrossTab(){
  updateRunControls();
  if (state.crossRunning) return;
  allowSyntheticAnalysis('crossStatus');
  // 进入界面只展示已有图表；任务只能由显式运行入口提交。
  if (crossStarted || window.__crossAnalyzed || $('chartHeatmap').hasChildNodes()) return;
  $('chartHeatmap').innerHTML = '<div class="progress-note" style="padding:28px 16px;text-align:center;line-height:2">'+
    '交叉分析需运行 <b>24</b> 次「策略 × 负载」仿真 + <b>4</b> 次综合评分仿真（合成扫描并发，Replay 扫描目标 QPS）<br>'+
    '计算在服务器独立进程执行，任务提交后可关闭页面，在任务列表下载结果</div>';
  $('chartRadar').innerHTML = '';
  $('formulaHeatmap').innerHTML = '';
  $('formulaRadar').innerHTML = '';
}


export async function runCrossAnalysis(){
  if (!allowSyntheticAnalysis('crossStatus')) return;
  try { await drawCrossAnalysis(); }
  catch (error) {
    const note = $('crossStatus');
    note.hidden = false;
    note.textContent = `任务未完成，保留上次结果：${error.message}`;
  }
}



// 热力图+雷达图共用一批真实仿真（异步执行避免阻塞UI）
export async function drawCrossAnalysis(){
  if (!allowSyntheticAnalysis('crossStatus') || state.crossRunning) return;
  let p = structuredClone(getParams());
  const mode = state.strategyMode;
  const isReplay = state.workloadSource === 'replay';
  let presetNames=['Pure-HBM','HBM+DRAM','Tiered-3L','Aggressive'];
  let strategies=[];
  structuredClone(state.savedStrategies.slice(0,4)).forEach(s=>strategies.push(s));
  for(let i=strategies.length;i<4;i++) strategies.push(parseDSL(strategyPresets[presetNames[i]]));
  strategies.forEach((s,i)=>{if(!s.name)s.name=presetNames[i]||('S'+i);});
  const baseJob = isReplay ? createReplayJob({ params: p, controls: replayControls(), strategies, mode })
    : { params: p, strategy: strategies[0], mode, overrides: { seed: p.seed } };
  p = baseJob.params;
  const workload = getReplayWorkloadConfig();
  let concurrencies = isReplay ? [0.1, 0.3, 1, 3, 8, 16] : [8,16,32,64,128,256];
  let heatData=new Array(concurrencies.length*4);
  const heatResults = new Array(concurrencies.length * 4);
  let radarResults=new Array(4);
  let totalJobs=concurrencies.length*4+4, doneJobs=0;
  crossStarted = true;
  state.crossRunning = true;
  updateRunControls();
  const status = $('crossStatus');
  status.hidden = false;
  status.replaceChildren();
  const note = document.createElement('span');
  const cancel = document.createElement('button');
  const controller = new AbortController();
  cancel.className = 'btn btn-sm'; cancel.textContent = '取消服务器计算';
  cancel.onclick = () => { cancel.disabled = true; controller.abort(); };
  status.append(note, cancel);

  let jobs=[];
  concurrencies.forEach((c,i)=>{strategies.forEach((s,j)=>{
    jobs.push({type:'heat',i:i,j:j,c:c,s:s});
  });});
  strategies.forEach((s,j)=>{jobs.push({type:'radar',j:j,s:s});});

  async function runRemote(){
    try {
      const batch = jobs.map(job => {
        const input = buildSweepJob({ ...baseJob, strategy: job.s }, isReplay && job.type === 'heat' ? [['qps', job.c]] : []);
        if (!isReplay) Object.assign(input.overrides, job.type === 'heat'
          ? { concurrency: job.c, nreq: Math.min(job.c * 1.5, 60) } : { nreq: Math.min(p.concurrency, 80) });
        return input;
      });
      await executeBatch(batch, 'batch', { label: isReplay ? 'Replay 目标 QPS 交叉分析' : '交叉分析', signal: controller.signal, onPoint: point => {
        const job = jobs[point.index], r = point.result;
        if (isReplay && !r?.replay?.windows?.measurement) throw new Error('服务器结果缺少 Replay measurement 窗口。');
        if (job.type === 'heat') {
          const latency = isReplay ? r.replay.windows.measurement.latency.endToEnd.p99 : r.p99;
          const valid = isReplay ? extractSensMetrics(r).workload.eligibleForComparison && Number.isFinite(latency) : r.completed > 0 && r.p99 > 0;
          heatData[job.i * 4 + job.j] = [job.i, job.j, valid ? +latency.toFixed(3) : null];
          heatResults[job.i * 4 + job.j] = r;
        } else radarResults[job.j] = r;
        doneJobs++;
        note.textContent = '服务器交叉分析中... ' + doneJobs + '/' + totalJobs;
      } });
      if (controller.signal.aborted) throw new Error('已取消服务器任务。');
      if (doneJobs !== totalJobs) throw new Error('交叉分析结果不完整。');
      renderAll();
      window.__crossAnalyzed = true;
      note.textContent = `交叉分析完成 · ${isReplay ? 'Replay 目标 QPS 轴 · 未使用结果缓存' : '合成负载'}`;
    } catch (error) {
      note.textContent = `任务未完成，保留上次结果：${error.message}`;
    } finally {
      cancel.remove();
      state.crossRunning = false;
      updateRunControls();
    }
  }

  function renderAll(){
    // ---- Heatmap ----
    let maxV=Math.max(...heatData.map(d=>d[2]==null?0:d[2]),100);
    let ch=initChart('chartHeatmap');
    ch.setOption({
      tooltip:{trigger:'item',formatter:d=>{
        const result = heatResults[d.value[0] * 4 + d.value[1]];
        const measurement = result?.replay?.windows?.measurement;
        const report = result?.replay;
        const value = n => Number.isFinite(n) ? n.toFixed(3) : '无样本';
        return (isReplay ? '目标 QPS: ' : '并发: ') + concurrencies[d.value[0]] + '<br/>策略: ' + escapeHtml(strategies[d.value[1]].name)
          + '<br/>P99延迟: ' + (d.value[2] == null ? '无有效比较样本' : d.value[2] + 'ms')
          + (measurement ? '<br/>measurement 实际到达 QPS: ' + value(measurement.arrivalQps)
            + '<br/>measurement 实际完成 QPS: ' + value(measurement.completionQps)
            + '<br/>measurement 观测 P99: ' + value(measurement.latency.endToEnd.p99) + 'ms'
            + '<br/>失败 / 取消: ' + report.counts.failed + ' / ' + report.counts.cancelled
            + '<br/>截断: ' + (report.state.truncated ? '是' : '否') : '');
      }},
      grid:{left:110,right:60,top:20,bottom:40},
      xAxis:{type:'category',data:concurrencies,name:isReplay?'目标 QPS':'并发数',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'}},
      yAxis:{type:'category',data:strategies.map(s=>s.name),name:'策略',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#e4e4e7',fontSize:10}},
      visualMap:{min:0,max:maxV,calculable:true,orient:'vertical',right:0,top:'center',
        inRange:{color:['#34d399','#fbbf24','#fb923c','#f87171']},textStyle:{color:'#9ca0b0'}},
      series:[{type:'heatmap',data:heatData,
        label:{show:true,color:'#e4e4e7',fontSize:10,formatter:d=>d.value[2]==null?'∞':(d.value[2]>=1000?(d.value[2]/1000).toFixed(1)+'k':d.value[2])},
        emphasis:{itemStyle:{shadowBlur:10,shadowColor:'rgba(0,0,0,.5)'}}}]
    });
    setFormula('formulaHeatmap',
      '<b>📐 计算方式</b><br>'+
      (isReplay ? '每格使用同一冻结 bundle、seed、T/W/D，横轴仅改变目标 QPS；同投放参数下 session 投放计划固定，completion 后继实际到达随执行改变。<br>延迟为 measurement 到达窗口内成功请求的 P99，实际到达/完成 QPS 与失败、截断见 tooltip。<br>' : '每个格子 = 一次完整事件驱动仿真（并发覆盖为该格并发数，请求数=min(1.5×并发,60)，同一种子）<br>') +
      'P99延迟来自仿真真实统计：排队 + 并行Prefill + 批次Decode + 跨层传输 · 高并发下超出批处理容量 → 排队主导，延迟非线性上升<br>'+
      (isReplay ? '<b>∞</b> = 无有效比较样本（无样本、失败或截断）；并非零延迟。实际观测值及状态见 tooltip。<br>' : '<b>∞</b> = 该格无请求完成（仿真窗口截断或请求不可执行），请查看任务结果。<br>') +
      '参与对比的策略 = 已保存列表前 4 个（不足用预设补齐）；未保存过则用 4 个预设策略'
    );
    // ---- Radar ----
    let valid=radarResults.filter(r => r && (!isReplay || (extractSensMetrics(r).workload.eligibleForComparison
      && Number.isFinite(r.replay.windows.measurement.latency.endToEnd.p50) && Number.isFinite(r.replay.windows.measurement.latency.endToEnd.p99)
      && Number.isFinite(r.replay.windows.measurement.completionQps) && Number.isFinite(r.throughput))));
    if (isReplay) valid = valid.map(r => ({ ...r, p50: r.replay.windows.measurement.latency.endToEnd.p50, p99: r.replay.windows.measurement.latency.endToEnd.p99 }));
    if(valid.length===0) {
      initChart('chartRadar').clear();
      setFormula('formulaRadar', '无可比较策略：无 measurement 延迟样本、失败或截断的结果不会作为零延迟最佳点。');
      return;
    }
    let maxT=Math.max(...valid.map(r=>r.throughput),1);
    const maxCompletionQps = isReplay ? Math.max(...valid.map(r => r.replay.windows.measurement.completionQps), Number.EPSILON) : 1;
    let minP50=Math.min(...valid.map(r=>r.p50)),maxP50=Math.max(...valid.map(r=>r.p50),1);
    let minP99=Math.min(...valid.map(r=>r.p99)),maxP99=Math.max(...valid.map(r=>r.p99),1);
    let score=(v,lo,hi)=>hi>lo?Math.max(5,(hi-v)/(hi-lo)*100):80; // 越低越好 → 映射到 5~100
    let ch2=initChart('chartRadar');
    ch2.setOption({
      tooltip:{},
      legend:{data:valid.map(r=>r.name),bottom:0,textStyle:{color:'#9ca0b0',fontSize:10}},
      radar:{
        center:['50%','48%'],radius:'62%',
        indicator: isReplay ? [
          {name:'全程输出吞吐',max:100},{name:'measurement P50',max:100},{name:'measurement P99',max:100},{name:'measurement 完成QPS',max:100},
        ] : [
          {name:'吞吐量',max:100},{name:'P50延迟',max:100},{name:'P99延迟',max:100},
          {name:'显存利用率',max:100},{name:'低碎片',max:100},{name:'公平性',max:100},
        ],
        axisName:{color:'#9ca0b0'}
      },
      series:[{
        type:'radar',
        data:valid.map((r,i)=>{
          let colors=['#6c63ff','#34d399','#fb923c','#f87171'];
          return {
            value:[
              +(r.throughput/maxT*100).toFixed(0),
              +score(r.p50,minP50,maxP50).toFixed(0),
              +score(r.p99,minP99,maxP99).toFixed(0),
              ...(isReplay ? [+(r.replay.windows.measurement.completionQps / maxCompletionQps * 100).toFixed(0)] : [
                +Math.min(100,r.memUtilAvg).toFixed(0),
                +Math.max(0,100-r.fragPct).toFixed(0),
                +Math.max(0,100-r.fairnessCV).toFixed(0),
              ]),
            ],
            name:r.name,lineStyle:{color:colors[i%4]},areaStyle:{color:colors[i%4]+'26'},itemStyle:{color:colors[i%4]}
          };
        })
      }]
    });
    setFormula('formulaRadar',
      '<b>📐 计算方式（全部来自仿真）</b><br>'+
      '• 吞吐量: 各策略 ÷ 最优 ×100 · P50/P99延迟: 相对最差值的反向映射<br>'+
      (isReplay ? '• measurement 完成QPS: 各策略 ÷ 最优 ×100；碎片、公平性、理想缓存未作本图评估，HBM占用不等同效率，不评分。<br>' : '• 显存利用率: 仿真时间加权平均 HBM 占用 · 低碎片: 100 − 块碎片率 · 公平性: 100 − 延迟变异系数CV%<br>') +
      (isReplay ? 'Replay：延迟按 measurement 窗口，吞吐保持全程输出 token/s；无样本、失败和截断不评分。目标 QPS=' + p.qps + ' · T/W/D=' + workload.options.durationSeconds + '/' + workload.options.warmupSeconds + '/' + workload.options.simMaxTime + ' · bundle=' + workload.bundleSummary.digest : '仿真条件: 冻结运行参数 · 请求数=min(请求数,80)') + ' · 种子=' + p.seed
    );
  }
  await runRemote();
}
