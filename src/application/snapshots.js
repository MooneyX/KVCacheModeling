import { SENS_PARAM_LABEL } from './labels.js';

export function sensSnapTitle(st) {
  if (!st) return '';
  let t = st.paramLabel + ' → ' + st.metricLabel;
  let ex = [];
  if (st.compareParam) ex.push('色:' + (SENS_PARAM_LABEL[st.compareParam] || st.compareParam));
  if (st.hasPf) ex.push('形:' + (st.shapeDim === 'prefetch' ? '预取策略'
    : (SENS_PARAM_LABEL[st.shapeDim] || st.shapeDim)));
  return t + (ex.length ? '（' + ex.join(' ') + '）' : '');
}
