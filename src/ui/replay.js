import { readParams } from '../adapters/parameters.js';
import { executeSimulation } from '../execution/browser/client';
import { getCurrentStrategy } from './strategy.js';
import { state } from './state.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const parameterIds = ['replayQps', 'replaySeed', 'replayDuration', 'replayWarmup', 'replayDrain'];
let bundle = null;
let result = null;
let reading = false;
let running = false;
let generation = 0;
let initialized = false;
const element = id => document.getElementById(id);

function updateControls() {
  element('replayFile').disabled = running;
  for (const id of parameterIds) element(id).disabled = running;
  element('replayRun').disabled = running || reading || !bundle;
  element('replayDownload').disabled = running || !result;
  element('replayPanel').setAttribute('aria-busy', String(running || reading));
}

function clearResult() {
  result = null;
  element('replaySummary').replaceChildren();
  element('replaySummary').hidden = true;
  updateControls();
}

function numberValue(id, label) {
  const raw = element(id).value.trim();
  if (!raw) throw new Error(`${label}不能为空。`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${label}必须为有限数。`);
  return value;
}

function createJob() {
  const qps = numberValue('replayQps', '目标 QPS');
  const seed = numberValue('replaySeed', 'seed');
  const durationSeconds = numberValue('replayDuration', '投放时长 T');
  const warmupSeconds = numberValue('replayWarmup', '暖机时长 W');
  const simMaxTime = numberValue('replayDrain', '排空上限 D');
  if (qps <= 0) throw new Error('目标 QPS 必须大于 0。');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('seed 必须为 uint32 整数（0–4294967295）。');
  if (durationSeconds <= 0) throw new Error('投放时长 T 必须大于 0。');
  if (warmupSeconds < 0 || warmupSeconds >= durationSeconds) throw new Error('暖机时长 W 必须满足 0 ≤ W < T。');
  if (simMaxTime < 0) throw new Error('排空上限 D 必须大于等于 0。');
  if (state.strategyMode !== 'dsl') throw new Error('Replay 仅支持 DSL 策略，请先切换策略模式。');
  if (numberValue('pInstances', '计算实例数') !== 1) throw new Error('Replay 仅支持单计算实例，请将计算实例数设置为 1（GPU 张数不受此限制）。');
  const params = readParams(element);
  if (params.pdMode === 2) throw new Error('Replay 不支持物理 P/D 分离，请先修改当前配置。');
  const strategy = getCurrentStrategy();
  if (!strategy) throw new Error('当前 DSL 策略解析失败，请检查策略编辑器。');
  return structuredClone({ params, strategy, mode: 'dsl', overrides: {
    qps, seed, simMaxTime, blockSize: 64,
    replay: { bundle, options: { durationSeconds, warmupSeconds, arrivalModel: 'closed', superblocks: false } },
  } });
}

function basicBundle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.version !== 1 || value.blockSize !== 64 || !Array.isArray(value.sessions) || !value.sessions.length
      || value.sessions.some(session => !session || !Array.isArray(session.req) || !session.req.length)) {
    throw new Error('请选择已构建的 bundle v1（version=1、blockSize=64、非空 sessions/req），不是原始 trace、报告或配置文件。');
  }
  return value;
}

async function selectFile() {
  if (running) return;
  const current = ++generation;
  bundle = null;
  reading = false;
  clearResult();
  const files = element('replayFile').files;
  const file = files?.[0];
  if (!file) {
    element('replayFileInfo').textContent = '尚未选择文件；可选择仓库 data/replay/sample.json。';
    element('replayStatus').textContent = '请选择 Replay bundle。';
    return;
  }
  element('replayFileInfo').textContent = `${file.name} · ${file.size.toLocaleString()} 字节`;
  try {
    if (files.length !== 1 || !/\.json$/i.test(file.name)) throw new Error('只接受一个 .json bundle 文件。');
    if (file.size > MAX_FILE_BYTES) throw new Error('文件超过 8 MiB 读取上限；请选择小型 bundle。');
    reading = true;
    updateControls();
    element('replayStatus').textContent = '正在读取并检查 bundle…';
    const bytes = await file.arrayBuffer();
    if (current !== generation) return;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw new Error('文件不是有效的 JSON。'); }
    bundle = basicBundle(parsed);
    element('replayStatus').textContent = '文件已就绪；完整字段、RLE、锚点和资源量由服务器校验。点击运行后提交新任务。';
  } catch (error) {
    if (current !== generation) return;
    bundle = null;
    element('replayStatus').textContent = `读取失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (current === generation) { reading = false; updateControls(); }
  }
}

function display(value) {
  if (value === null || value === undefined) return '无样本';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') {
    if (value !== 0 && Math.abs(value) < 0.0001) return value.toExponential(3);
    return value.toLocaleString('zh-CN', { maximumFractionDigits: 6 });
  }
  return String(value);
}

function section(parent, title, rows) {
  const heading = document.createElement('h3');
  heading.textContent = title;
  parent.append(heading);
  const list = document.createElement('dl');
  list.style.cssText = 'display:grid;grid-template-columns:minmax(150px,1fr) 2fr;gap:6px 16px;overflow-wrap:anywhere;margin:12px 0 20px';
  for (const [label, value] of rows) {
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.style.margin = '0';
    description.textContent = display(value);
    list.append(term, description);
  }
  parent.append(list);
}

function details(parent, title, value) {
  const container = document.createElement('details');
  const heading = document.createElement('summary');
  heading.textContent = title;
  const content = document.createElement('pre');
  content.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:400px;overflow:auto';
  content.textContent = JSON.stringify(value, (_key, item) => item === null ? '无样本' : item, 2);
  container.append(heading, content);
  parent.append(container);
}

function renderResult(value) {
  const report = value.replay;
  if (!report?.windows?.measurement) throw new Error('服务器结果缺少 Replay 测量窗口。');
  const { configuration: config, source, counts, state: status, samples } = report;
  const measurement = report.windows.measurement;
  const parent = element('replaySummary');
  parent.replaceChildren();
  section(parent, '本次实际执行配置', [
    ['bundle 摘要', config.bundleDigest], ['目标 QPS', config.targetQps], ['seed', config.seed],
    ['投放时长 T（秒）', config.durationSeconds], ['暖机时长 W（秒）', config.warmupSeconds],
    ['排空上限 D（秒）', config.execution.simMaxTime], ['硬截止 T+D（秒）', config.hardCutoff],
    ['策略', config.strategy.name], ['GPU 张数 / 计算实例数', `${config.execution.gpus} / ${config.execution.instances}`],
    ['物理页 token 数', config.blockMapping.physical], ['输出身份', config.outputIdentity],
  ]);
  section(parent, '模板池与实际投放（投放不等于全池一遍）', [
    ['模板数', source.sessions], ['模板池请求数', source.requests], ['模板池输入 token', source.inputTokens], ['模板池输出 token', source.outputTokens],
    ['投放 session 数', counts.launchedSessions], ['完整圈数', counts.completeCycles], ['已完成 session 数', counts.completedSessions],
    ['已投放请求数', counts.planned], ['成功请求', counts.successful], ['失败请求', counts.failed], ['取消请求', counts.cancelled], ['未完成请求', counts.unfinished],
  ]);
  section(parent, '主报告：measurement 测量窗口', [
    ['窗口起止（秒）', `[${display(measurement.start)}, ${display(measurement.end)})`], ['窗口时长（秒）', measurement.durationSeconds],
    ['到达 QPS', measurement.arrivalQps], ['完成 QPS', measurement.completionQps],
  ]);
  const note = document.createElement('p');
  note.textContent = '延迟仅统计成功请求，按到达所属窗口归属；无样本不等于 0。';
  parent.append(note);
  for (const [label, key] of [['TTFT', 'ttft'], ['TPOT', 'tpot'], ['端到端延迟', 'endToEnd']]) {
    const latency = measurement.latency[key];
    section(parent, `${label}（${measurement.latency.unit}）`, [['样本数', latency.count], ['平均', latency.mean], ['P50', latency.p50], ['P99', latency.p99]]);
  }
  const cache = measurement.cache;
  section(parent, '测量窗口缓存', [
    ['输入 token', cache.inputTokens], ['L1 命中 token', cache.hitL1Tokens], ['L2 命中 token', cache.hitL2Tokens],
    ['L3 命中 token', cache.hitL3Tokens], ['miss token', cache.missTokens], ['命中率', cache.hitRate == null ? null : `${display(cache.hitRate * 100)}%`],
  ]);
  section(parent, '运行状态与采样覆盖', [
    ['截断', status.truncated], ['终止原因', status.terminationReason], ['支持范围', status.supportedScope],
    ['完成依赖', status.completionDependencies], ['稳定性 / 理想缓存', `${status.stability} / ${status.idealCache}`],
    ['采样覆盖（秒）', samples.coverage.map(display).join(' – ')], ['采样桶宽（秒）', samples.bucketWidth], ['时间序列桶数', samples.series.length],
    ['请求采样 / 总数', `${samples.requestCoverage.sampled} / ${samples.requestCoverage.total}`], ['请求采样完整', samples.requestCoverage.complete],
    ['投放采样 / 总数', `${samples.launchCoverage.sampled} / ${samples.launchCoverage.total}`], ['投放采样完整', samples.launchCoverage.complete],
  ]);
  details(parent, '有效运行限额', status.limits);
  details(parent, '完整执行配置（模型、硬件及策略快照）', config);
  details(parent, '完整计数与状态', { source, counts, state: status });
  parent.hidden = false;
}

async function runReplay() {
  if (running || reading || !bundle) return;
  running = true;
  clearResult();
  element('replayStatus').textContent = '运行中：正在提交并等待服务器任务；进度可在上方任务列表查看。';
  try {
    const job = createJob();
    const value = await executeSimulation(job);
    renderResult(value);
    result = value;
    element('replayStatus').textContent = value.replay.state.truncated ? '运行结束：已截断，请查看终止原因和未完成计数。' : '运行完成；摘要和下载均对应本次提交快照。';
  } catch (error) {
    clearResult();
    element('replayStatus').textContent = `运行失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    running = false;
    updateControls();
  }
}

function downloadResult() {
  if (!result || running) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `replay-result-seed-${result.replay.configuration.seed}.json`;
  document.body.append(link);
  try { link.click(); }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0); }
}

export function initReplay() {
  if (initialized || !element('replayPanel')) return;
  initialized = true;
  for (const [target, source] of [['replayQps', 'pQps'], ['replaySeed', 'pSeed']]) element(target).value = element(source).value;
  element('replayFile').addEventListener('change', selectFile);
  for (const id of parameterIds) {
    const changed = () => {
      if (running) return;
      clearResult();
      element('replayStatus').textContent = bundle ? '参数已变更，请重新运行。' : '请选择 Replay bundle。';
    };
    element(id).addEventListener('input', changed);
    element(id).addEventListener('change', changed);
  }
  element('replayRun').addEventListener('click', runReplay);
  element('replayDownload').addEventListener('click', downloadResult);
  updateControls();
}
