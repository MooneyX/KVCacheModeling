// 从 index.html 提取内联 <script> 内容,输出 kvcheck.js(供 smoke 测试使用)
const fs = require('fs');
const html = fs.readFileSync('D:/Documents/KVCacheModeling/index.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (scripts.length === 0) { console.error('NO_SCRIPT'); process.exit(1); }
const code = scripts.join('\n');
// 去掉末尾 DOMContentLoaded init(测试环境由 smoke 自行驱动)
const cleaned = code.replace(/\ndocument\.addEventListener\('DOMContentLoaded',\s*init\);\s*$/, '\n');
fs.writeFileSync('D:/Documents/KVCacheModeling/.workbuddy/kvcheck.js', cleaned);
console.log('kvcheck.js extracted:', cleaned.length, 'chars');
