// ---- DOM stubs ----
const elements = {};
function makeEl(id){ return { id, value:undefined, textContent:'', innerHTML:'', style:{},
  classList:{toggle(){},add(){},remove(){},contains(){return false}},
  querySelectorAll(){return []}, appendChild(){}, addEventListener(){}, disabled:false }; }
global.document = {
  getElementById: id => elements[id] || (elements[id]=makeEl(id)),
  querySelectorAll: () => [], addEventListener: () => {}, createElement: () => makeEl('x'),
};
global.window = { addEventListener: () => {} };
global.echarts = { init:()=>({setOption(){},resize(){},dispose(){}}), getInstanceByDom:()=>null,
  graphic:{LinearGradient:function(){}} };

const fs = require('fs');
eval(fs.readFileSync('.workbuddy/kvcheck.js','utf8'));

// decode受限的SSD场景: 单卡H20 + 8B模型(prefill快) + 小DRAM → KV溢出SSD，decode读取主导延迟
const vals = {pAttnType:'gqa',pLayers:32,pKvHeads:8,pHeadDim:128,pKvLora:512,pRopeDim:64,pHidden:4096,
  pDtype:1,pWeightDtype:2,pParamsB:0,pActB:0,pGpuCount:1,pHbm:96,pHbmBW:4,pTflops:148,
  pTpSize:1,pNvlinkBW:900,pPcieBW:64,pTierQuant:1,pDram:16,pDramBW:400,pSsd:20,pSsdBW:10,
  pConcurrency:48,pInputLen:16384,pOutputLen:4096,pQps:2,pMfu:50,pMaxBatch:24,pBlockSize:16,
  pPrefixHit:0,pLenDist:'uniform',pMultiTurn:0,pSeed:42};
for (const k in vals) document.getElementById(k).value = vals[k];
for (const k of ["pFramework","pPrefixCache","pPdSep","pTieredKv"]) document.getElementById(k).value={pFramework:"generic",pPrefixCache:"hash",pPdSep:"0",pTieredKv:"1"}[k];

let r0 = calcAll(getParams());
console.log('availHbm:', (r0.availHbm/1e9).toFixed(0)+'GB', 'perReqKv:', (r0.perRequestKv/1e9).toFixed(2)+'GB',
  'maxHbmReq:', r0.maxHbmRequests);

console.log('\n== decode受限SSD场景: 1×H20, 8B, 16K输入/4K输出, DRAM=16GB ==');
console.log('ssdBW(GB/s)\tcompleted\thitRate\tavgTtft(ms)\tp50(ms)\ttput(tok/s)\ttransferGB');
for (const bw of [1, 5, 20, 80]) {
  let r = runSimulation(parseDSL(strategyPresets['Tiered-3L']), {seed:42, ssdBW: bw});
  console.log(bw+'\t\t'+r.completed+'/'+r.totalReqs+'\t'+r.hitRate.toFixed(1)+'%\t'
    +r.avgTtft.toFixed(0)+'\t\t'+r.p50.toFixed(0)+'\t'+r.throughput.toFixed(0)+'\t\t'+r.transferGB.toFixed(1));
}
console.log('\nDONE');
