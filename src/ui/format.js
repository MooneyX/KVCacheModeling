


export function formatBytes(b){
  if(b>=1e15) return (b/1e15).toFixed(2)+' PB';
  if(b>=1e12) return (b/1e12).toFixed(2)+' TB';
  if(b>=1e9)  return (b/1e9).toFixed(2)+' GB';
  if(b>=1e6)  return (b/1e6).toFixed(2)+' MB';
  if(b>=1e3)  return (b/1e3).toFixed(2)+' KB';
  return b.toFixed(0)+' B';
}



export function formatRate(bps){
  if(bps>=1e12) return (bps/1e12).toFixed(2)+' TB/s';
  if(bps>=1e9)  return (bps/1e9).toFixed(2)+' GB/s';
  if(bps>=1e6)  return (bps/1e6).toFixed(2)+' MB/s';
  return bps.toFixed(0)+' B/s';
}



export function formatNum(n){
  if(n>=1e9) return (n/1e9).toFixed(1)+'B';
  if(n>=1e6) return (n/1e6).toFixed(1)+'M';
  if(n>=1e3) return (n/1e3).toFixed(1)+'K';
  return n.toFixed(0);
}
