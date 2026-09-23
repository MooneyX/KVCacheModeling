import { $ } from "../adapters/browser/dom.js";
import { getParams } from "../adapters/browser/params.js";
import { state } from "./state.js";
import { parseDSL } from "../core/strategy.js";
import { strategyPresets } from "../core/presets.js";
import { executeBatch } from '../execution/browser/client.ts';
import { initChart, setFormula } from "./charts.js";



// ======================== TAB 4: CROSS ANALYSIS ========================
export function refreshCrossTab(){
  // 懒加载：不默认跑 24+4 次全量仿真（高并发档每次墙钟 5-20s，串行执行会长时间阻塞 UI）。
  // 进入界面只展示已有图表；任务只能由显式运行入口提交。
  if (window.__crossAnalyzed) return;
  $('chartHeatmap').innerHTML = '<div class="progress-note" style="padding:28px 16px;text-align:center;line-height:2">'+
    '交叉分析需运行 <b>24</b> 次「策略 × 并发」仿真 + <b>4</b> 次综合评分仿真<br>'+
    '计算在服务器独立进程执行，任务提交后可关闭页面，在任务列表下载结果<br><br>'+
    '<button class="btn" onclick="runCrossAnalysis()" style="font-size:.85rem">▶️ 按需运行交叉分析</button></div>';
  $('chartRadar').innerHTML = '';
  $('formulaHeatmap').innerHTML = '';
  $('formulaRadar').innerHTML = '';
}


export function runCrossAnalysis(){
  window.__crossAnalyzed = true;
  drawCrossAnalysis();
}



// 热力图+雷达图共用一批真实仿真（异步执行避免阻塞UI）
let crossRunning = false;
let crossRequested = '';
export async function drawCrossAnalysis(){
  let p=getParams();
  const fingerprint = JSON.stringify([p, state.savedStrategies, state.strategyMode]);
  crossRequested = fingerprint;
  if (crossRunning) return;
  crossRunning = true;
  let presetNames=['Pure-HBM','HBM+DRAM','Tiered-3L','Aggressive'];
  let strategies=[];
  state.savedStrategies.slice(0,4).forEach(s=>strategies.push(s));
  for(let i=strategies.length;i<4;i++) strategies.push(parseDSL(strategyPresets[presetNames[i]]));
  strategies.forEach((s,i)=>{if(!s.name)s.name=presetNames[i]||('S'+i);});
  let concurrencies=[8,16,32,64,128,256];
  let heatData=new Array(concurrencies.length*4);
  let radarResults=new Array(4);
  let totalJobs=concurrencies.length*4+4, doneJobs=0;

  let heatEl=$('chartHeatmap');
  heatEl.innerHTML='<div class="progress-note">⏳ 交叉分析仿真中... 0/'+totalJobs+'</div>';
  $('chartRadar').innerHTML='<div class="progress-note">⏳ 等待仿真...</div>';

  let jobs=[];
  concurrencies.forEach((c,i)=>{strategies.forEach((s,j)=>{
    jobs.push({type:'heat',i:i,j:j,c:c,s:s});
  });});
  strategies.forEach((s,j)=>{jobs.push({type:'radar',j:j,s:s});});

  async function runRemote(){
    const batch = jobs.map(job => ({ params: p, strategy: job.s, mode: state.strategyMode,
      overrides: job.type === 'heat'
        ? { concurrency: job.c, nreq: Math.min(job.c * 1.5, 60), seed: p.seed }
        : { nreq: Math.min(p.concurrency, 80), seed: p.seed } }));
    try {
      await executeBatch(batch, 'batch', { label: '交叉分析', onPoint: point => {
        const job = jobs[point.index], r = point.result;
        if (job.type === 'heat') {
          const v = (r.completed > 0 && r.p99 > 0) ? +r.p99.toFixed(0) : null;
          heatData[job.i * 4 + job.j] = [job.i, job.j, v];
        } else radarResults[job.j] = r;
        doneJobs++;
        if (crossRequested === fingerprint) heatEl.textContent = '服务器交叉分析中... ' + doneJobs + '/' + totalJobs;
      } });
      if (crossRequested === fingerprint) renderAll();
    } catch (error) {
      heatEl.textContent = error.message;
      $('chartRadar').textContent = '任务未完成，请查看服务器任务列表。';
    } finally {
      crossRunning = false;
      if (crossRequested !== fingerprint) void drawCrossAnalysis();
    }
  }

  function renderAll(){
    // ---- Heatmap ----
    let maxV=Math.max(...heatData.map(d=>d[2]==null?0:d[2]),100);
    let ch=initChart('chartHeatmap');
    ch.setOption({
      tooltip:{trigger:'item',formatter:d=>'并发: '+concurrencies[d.value[0]]+'<br/>策略: '+strategies[d.value[1]].name
        +'<br/>P99延迟: '+(d.value[2]==null?'无完成请求(∞)':d.value[2]+'ms')},
      grid:{left:110,right:40,top:20,bottom:40},
      xAxis:{type:'category',data:concurrencies,name:'并发数',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'}},
      yAxis:{type:'category',data:strategies.map(s=>s.name),name:'策略',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#e4e4e7',fontSize:10}},
      visualMap:{min:0,max:maxV,calculable:true,orient:'vertical',right:0,top:'center',
        inRange:{color:['#34d399','#fbbf24','#fb923c','#f87171']},textStyle:{color:'#9ca0b0'}},
      series:[{type:'heatmap',data:heatData,
        label:{show:true,color:'#e4e4e7',fontSize:10,formatter:d=>d.value[2]==null?'∞':(d.value[2]>=1000?(d.value[2]/1000).toFixed(1)+'k':d.value[2])},
        emphasis:{itemStyle:{shadowBlur:10,shadowColor:'rgba(0,0,0,.5)'}}}]
    });
    setFormula('formulaHeatmap',
      '<b>📐 计算方式</b><br>'+
      '每个格子 = 一次完整事件驱动仿真（并发覆盖为该格并发数，请求数=min(1.5×并发,60)，同一种子）<br>'+
      'P99延迟来自仿真真实统计：排队 + 并行Prefill + 批次Decode + 跨层传输 · 高并发下超出批处理容量 → 排队主导，延迟非线性上升<br>'+
      '<b>∞</b> = 该格无请求完成（仿真窗口截断——负载排水时间超过窗口上限，策略在该负载下不可用；调大「仿真窗口上限」即可跑完）<br>'+
      '参与对比的策略 = 已保存列表前 4 个（不足用预设补齐）；未保存过则用 4 个预设策略'
    );
    // ---- Radar ----
    let valid=radarResults.filter(Boolean);
    if(valid.length===0)return;
    let maxT=Math.max(...valid.map(r=>r.throughput),1);
    let minP50=Math.min(...valid.map(r=>r.p50)),maxP50=Math.max(...valid.map(r=>r.p50),1);
    let minP99=Math.min(...valid.map(r=>r.p99)),maxP99=Math.max(...valid.map(r=>r.p99),1);
    let score=(v,lo,hi)=>hi>lo?Math.max(5,(hi-v)/(hi-lo)*100):80; // 越低越好 → 映射到 5~100
    let ch2=initChart('chartRadar');
    ch2.setOption({
      tooltip:{},
      legend:{data:valid.map(r=>r.name),bottom:0,textStyle:{color:'#9ca0b0',fontSize:10}},
      radar:{
        center:['50%','48%'],radius:'62%',
        indicator:[
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
              +Math.min(100,r.memUtilAvg).toFixed(0),
              +Math.max(0,100-r.fragPct).toFixed(0),
              +Math.max(0,100-r.fairnessCV).toFixed(0),
            ],
            name:r.name,lineStyle:{color:colors[i%4]},areaStyle:{color:colors[i%4]+'26'},itemStyle:{color:colors[i%4]}
          };
        })
      }]
    });
    setFormula('formulaRadar',
      '<b>📐 计算方式（全部来自仿真）</b><br>'+
      '• 吞吐量: 各策略 ÷ 最优 ×100 · P50/P99延迟: 相对最差值的反向映射<br>'+
      '• 显存利用率: 仿真时间加权平均 HBM 占用 · 低碎片: 100 − 块碎片率 · 公平性: 100 − 延迟变异系数CV%<br>'+
      '仿真条件: 当前参数 · 请求数=min(请求数,80) · 种子='+p.seed
    );
  }
  await runRemote();
}
