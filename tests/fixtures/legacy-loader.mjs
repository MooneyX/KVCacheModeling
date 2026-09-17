import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

export const legacyHtml = readFileSync(new URL('./legacy/index.html', import.meta.url), 'utf8');
export const legacyCode = [...legacyHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

export function loadLegacy(values = {}) {
  const dom = new JSDOM(legacyHtml, { runScripts: 'outside-only' });
  const document = dom.window.document;
  for (const [id, value] of Object.entries(values)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (typeof value === 'boolean') el.checked = value;
    else el.value = String(value);
  }
  const events = [];
  document.addEventListener = (...args) => events.push(args);
  const charts = new Map();
  const echarts = {
    init(el) {
      const chart = { option: {}, setOption(o) { this.option = o; }, getOption() { return this.option; }, resize() {}, dispose() {} };
      charts.set(el, chart);
      return chart;
    },
    getInstanceByDom(el) { return charts.get(el) || null; },
  };
  const api = new Function('document', 'window', 'echarts', legacyCode + '\nreturn { init, importParamsFromBox, runSimulation, parseDSL, dslToText, getParams, calcAll, estimatePrefillParams, mulberry32, extractSensMetrics, strategyPresets, strategyPresetsJS, applyParamVal, sortedJson, buildSensPoints, parseRangeOrList, buildSensHtml, setReportState(value) { sensExportState = value; }, setMode(mode) { strategyMode = mode; } };')(document, dom.window, echarts);
  return { ...api, document, close: () => dom.window.close() };
}
