export const baseControls = {
  pConcurrency: '8', pInputLen: '2048', pOutputLen: '64', pQps: '4',
  pLenDist: 'uniform', pArrivalDist: 'poisson', pSeed: '42',
  pSimMaxTime: '120', pPrefixHit: '60', pPrefixWarm: true,
  pPrefillA: '239.83', pPrefillB: '0.01024', pFetchFixedUs: '0',
  pTieredKv: '1', pMaxBatch: '8', pFetchRepull: true,
};

export const scenarios = [
  { name: 'gqa-wc', controls: {} },
  { name: 'gqa-best-effort', controls: {}, prefetch: 'best_effort' },
  { name: 'gqa-timeout', controls: { pPfTimeoutBase: '0', pPfTimeoutPerPage: '0' }, prefetch: 'timeout' },
  { name: 'gqa-race', controls: {}, prefetch: 'race' },
  { name: 'no-prefix', controls: { pPrefixHit: '0' } },
  { name: 'single-batch', controls: { pSingleBatch: true, pPrefixHit: '0' } },
  { name: 'lognormal', controls: { pLenDist: 'lognormal', pMultiTurn: '30' } },
  { name: 'warm-l2', controls: { pPrefixWarmL2: '30', pFetchRepull: false } },
  { name: 'multi-instance', controls: { pInstances: '2', pRoutePolicy: 'power_of_two' } },
  { name: 'affinity', controls: { pInstances: '2', pRoutePolicy: 'hash_prefix', pPrefixAffinity: true } },
  { name: 'pd-separated', controls: { pPdSep: '2', pPdPrefillGpus: '4' } },
  { name: 'mla-ep-sparse', controls: { pAttnType: 'mla', pLayers: '27', pHidden: '2048', pKvLora: '512', pRopeDim: '64', pParamsB: '15.7', pActB: '2.4', pEpSize: '2', pMoeLayers: '26', pDenseB: '1', pSparseAttn: true, pSparseTopk: '512', pPrefillBIdx: '0.0001' } },
  { name: 'hardware-override', controls: {}, overrides: { hwPreset: 'b300x8', ssdBW: 17, nreq: 6, seed: 17 } },
  { name: 'window-truncated', controls: { pSimMaxTime: '1', pInputLen: '32768' } },
  { name: 'js-strategy', controls: {}, mode: 'js' },
];

export const reportState = {
  at: new Date('2026-09-17T00:00:00.000Z'),
  param: 'ssd_bw', paramLabel: 'L3聚合带宽', metric: 'ttft', metricLabel: '平均TTFT(ms)',
  compareParam: null, compareVals: [], hasPf: false, shapeDim: 'prefetch', shapeList: [],
  values: [10, 50], labels: ['10GB/s', '50GB/s'],
  opt: { title: { text: 'Regression' }, xAxis: { data: ['10GB/s', '50GB/s'] }, yAxis: {}, series: [{ name: 'WC', type: 'line', data: [12, 8] }] },
  curves: [{ name: 'WC', data: [12, 8] }],
  curveRecs: [[{ ttft: 12, throughput: 100 }, { ttft: 8, throughput: 120 }]],
  paramsJson: '{}', paramsMeta: {}, strategyDsl: 'ADMIT: always', strategyName: 'WC',
  points: [],
};
