import defaults from './control-defaults.json' with { type: 'json' };
import { readParams } from '../parameters.js';
import { parseDSL, autoNameStrategy } from '../../core/strategy.js';

export function paramsFromControls(values = {}) {
  const controls = structuredClone(defaults);
  for (const [id, value] of Object.entries(values)) {
    const control = controls[id];
    if (!control) continue;
    if (control.type === 'checkbox') control.checked = !!value;
    else {
      let text = String(value);
      if (control.options && !control.options.includes(text)) text = '';
      if (control.type === 'number' && text !== '' && !Number.isFinite(Number(text))) text = '';
      if (control.type === 'range') {
        const min = Number(control.min || 0), max = Number(control.max || 100);
        const number = text.trim() === '' || !Number.isFinite(Number(text)) ? (min + max) / 2 : Number(text);
        text = String(Math.min(max, Math.max(min, Math.round(number))));
      }
      control.value = text;
    }
  }
  const batch = controls.sDsl.value.match(/^BATCH:\s*\w+\s*max\(\s*(\d+)\s*\)/m);
  if (batch) controls.pMaxBatch.value = batch[1];
  controls.pPrefixWarmL2.value = String(Math.min(Number(controls.pPrefixWarmL2.value), Number(controls.pPrefixHit.value)));
  return readParams(id => controls[id] || null);
}

export function jobFromControls(values = {}) {
  const params = paramsFromControls(values);
  const strategy = parseDSL(String(values.sDsl ?? defaults.sDsl.value));
  strategy.name = String(values.sName || autoNameStrategy(strategy));
  return { params, strategy, mode: values._strategyMode === 'js' ? 'js' : 'dsl', overrides: {} };
}
