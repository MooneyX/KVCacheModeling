import { state } from './state.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const parameterIds = ['replayQps', 'replaySeed', 'replayDuration', 'replayWarmup', 'replayDrain'];
let bundle = null;
let fileSummary = null;
let reading = false;
let generation = 0;
let initialized = false;
let onInputChanged = () => {};
const element = id => document.getElementById(id);

export function replaySelection() {
  return { generation, ...fileSummary };
}

export function updateRunControls() {
  const running = state.simRunning;
  const replay = state.workloadSource === 'replay';
  element('workloadSource').disabled = running;
  element('replayFile').disabled = running;
  for (const id of parameterIds) element(id).disabled = running;
  document.querySelectorAll('button[onclick="applyStrategies()"]').forEach(button => {
    button.disabled = running || (replay && (reading || !bundle));
  });
  document.querySelectorAll('button[onclick="runAllStrategies()"]').forEach(button => {
    button.disabled = running || replay;
  });
  element('replayPanel').setAttribute('aria-busy', String(running || reading));
}

function numberValue(controls, id, label) {
  const raw = controls[id].value.trim();
  if (!raw) throw new Error(`${label}不能为空。`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${label}必须为有限数。`);
  return value;
}

export function createReplayJob({ params, controls, strategies, mode }) {
  if (reading || !bundle) throw new Error('请先选择并完成读取 Replay bundle。');
  if (mode !== 'dsl') throw new Error('Replay 仅支持 DSL 策略，请先切换策略模式。');
  if (strategies.length !== 1 || !strategies[0]) throw new Error('Replay 仅支持一个有效的 DSL 策略。');
  const qps = numberValue(controls, 'replayQps', '目标 QPS');
  const seed = numberValue(controls, 'replaySeed', 'seed');
  const durationSeconds = numberValue(controls, 'replayDuration', '投放时长 T');
  const warmupSeconds = numberValue(controls, 'replayWarmup', '暖机时长 W');
  const simMaxTime = numberValue(controls, 'replayDrain', '排空上限 D');
  if (qps <= 0) throw new Error('目标 QPS 必须大于 0。');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('seed 必须为 uint32 整数（0–4294967295）。');
  if (durationSeconds <= 0) throw new Error('投放时长 T 必须大于 0。');
  if (warmupSeconds < 0 || warmupSeconds >= durationSeconds) throw new Error('暖机时长 W 必须满足 0 ≤ W < T。');
  if (simMaxTime < 0) throw new Error('排空上限 D 必须大于等于 0。');
  if (numberValue(controls, 'pInstances', '计算实例数') !== 1) throw new Error('Replay 仅支持单计算实例，请将计算实例数设置为 1（GPU 张数不受此限制）。');
  if (numberValue(controls, 'pBlockSize', 'Block Size') !== 64) throw new Error('Replay 仅支持 64-token 页，请将 Block Size 手动设置为 64。');
  if (params.pdMode === 2) throw new Error('Replay 不支持物理 P/D 分离，请先修改当前配置。');
  const replayParams = { ...params, qps, seed, simMaxTime,
    concurrency: 1, inputLen: 0, outputLen: 0, lenDist: 'fixed', arrivalDist: 'poisson',
    multiTurn: 0, prefixHit: 0, prefixWarm: false, prefixWarmL2: 0, singleBatch: false,
  };
  return structuredClone({ params: replayParams, strategy: strategies[0], mode, overrides: {
    qps, seed, simMaxTime,
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
  if (state.simRunning) return;
  const current = ++generation;
  bundle = null;
  fileSummary = null;
  reading = false;
  updateRunControls();
  onInputChanged();
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
    updateRunControls();
    element('replayStatus').textContent = '正在读取并检查 bundle…';
    const bytes = await file.arrayBuffer();
    if (current !== generation) return;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw new Error('文件不是有效的 JSON。'); }
    bundle = basicBundle(parsed);
    fileSummary = { name: file.name, sizeBytes: file.size };
    element('replayStatus').textContent = '文件已就绪；完整字段、RLE、锚点和资源量由服务器校验。点击运行当前策略后提交新任务。';
  } catch (error) {
    if (current !== generation) return;
    bundle = null;
    element('replayStatus').textContent = `读取失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (current === generation) { reading = false; updateRunControls(); onInputChanged(); }
  }
}

export function initReplay(inputChanged) {
  if (initialized || !element('replayPanel')) return;
  initialized = true;
  onInputChanged = inputChanged || onInputChanged;
  for (const [target, source] of [['replayQps', 'pQps'], ['replaySeed', 'pSeed']]) element(target).value = element(source).value;
  element('workloadSource').addEventListener('change', () => {
    if (state.simRunning) { element('workloadSource').value = state.workloadSource; return; }
    state.workloadSource = element('workloadSource').value === 'replay' ? 'replay' : 'synthetic';
    element('syntheticPanel').hidden = state.workloadSource !== 'synthetic';
    element('replayPanel').hidden = state.workloadSource !== 'replay';
    updateRunControls();
    onInputChanged();
  });
  element('replayFile').addEventListener('change', selectFile);
  for (const id of parameterIds) {
    const changed = () => {
      if (state.simRunning) return;
      element('replayStatus').textContent = bundle ? '参数已变更，请重新运行。' : '请选择 Replay bundle。';
      onInputChanged();
    };
    element(id).addEventListener('input', changed);
    element(id).addEventListener('change', changed);
  }
  updateRunControls();
}
