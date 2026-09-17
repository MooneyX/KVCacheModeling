export function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function pctOf(arr, q){
  if(!arr || arr.length === 0) return 0;
  let a = arr.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((a.length - 1) * q))];
}

export function unionSpanSec(spans) {
  if (!spans || !spans.length) return 0;
  let a = spans.slice().sort((x, y) => x[0] - y[0]);
  let total = 0, curS = a[0][0], curE = a[0][1];
  for (let i = 1; i < a.length; i++) {
    if (a[i][0] > curE) { total += curE - curS; curS = a[i][0]; curE = a[i][1]; }
    else if (a[i][1] > curE) curE = a[i][1];
  }
  return total + (curE - curS);
}
