export function $(id) { return document.getElementById(id); }
export function gv(id) { const el = $(id); return el ? parseFloat(el.value) || 0 : 0; }
export function gi(id) { const el = $(id); return el ? parseInt(el.value) || 0 : 0; }
