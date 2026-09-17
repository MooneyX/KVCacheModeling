import { test, expect } from '@playwright/test';

test('legacy sensitivity cache ranges retain 1-2-2 behavior', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'development', 'This assertion inspects source module cache state.');
  await page.goto('/');
  await page.waitForFunction(() => typeof window.runSensitivity === 'function');
  await page.evaluate(() => {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = String(v); };
    set('pAttnType', 'gqa'); set('pLayers', 80); set('pKvHeads', 8); set('pHeadDim', 128);
    set('pKvLora', 512); set('pRopeDim', 64); set('pHidden', 8192); set('pVocab', 128256);
    set('pParamsB', 0); set('pActB', 0); set('pWeightDtype', 2); set('pDtype', 2);
    set('pGpuCount', 8); set('pHbm', 24); set('pHbmBW', 4); set('pTflops', 148); set('pTpSize', 8);
    set('pNvlinkBW', 900); set('pPcieBW', 64); set('pTierQuant', 1);
    set('pDram', 12); set('pDramBW', 400); set('pSsd', 20); set('pSsdBW', 10);
    set('pConcurrency', 4); set('pInputLen', 16384); set('pOutputLen', 16);
    set('pPrefixHit', 95); set('pBlockSize', 256); set('pQps', 0.4);
    set('pMfu', 60); set('pMaxBatch', 8);
    set('pMultiTurn', 0); set('pLenDist', 'uniform'); set('pArrivalDist', 'poisson'); set('pSeed', 42);
    set('pPdSep', '0'); set('pTieredKv', '1'); set('pSimMaxTime', 1200);
    document.getElementById('pPrefixWarm').checked = true;
    set('pPrefillA', 0); set('pPrefillB', 0); set('pFetchFixedUs', 0);
    set('sSweepParam', 'prefix_hit'); set('sSweepMetric', 'ttft'); set('sSweepCompareParam', '');
    set('sDsl', 'ADMIT: threshold(hbm=0.7)\nEVICT: lfu from hbm when 85% -> dram, lru from dram when 90% -> ssd\nPREFETCH: none\nBATCH: dynamic max(32)\nPLACE: tiered');
    set('sName', '');
  });
  for (const [range, expected] of [['0,90,10', 1], ['40,60,10', 2], ['40,60,10', 2]]) {
    await page.locator('#sSweepRange').fill(range);
    await page.locator('#btnRunSens').click();
    await expect(page.locator('#btnRunSens')).toBeEnabled({ timeout: 30_000 });
    const count = await page.evaluate(async () => Object.keys((await import('/src/ui/state.js')).state.sensCache).length);
    expect(count).toBe(expected);
  }
});
