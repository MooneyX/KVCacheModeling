// gen_inventory_mindmap.js
// 从 docs/inventory.yaml（唯一真理源）一键生成思维导图 drawio（双 page）。
//
//   page 1「推理系统组件盘点」 根 → 板块 → 机制 → sglang 组件（着色即完成度）→ note（仅必要时）
//   page 2「保真度路线图」     根 → 分组 → 对象 → 理由
//
// 用法: node scripts/gen_inventory_mindmap.js [输出路径]
//
// 零依赖：内置 YAML 子集解析器（嵌套映射 / 列表 / | 多行标量 / # 注释 / 引号字符串）。
// 坐标与配色全部由本脚本决定，源文件不含任何布局信息。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'docs', 'inventory.yaml');
const OUT = process.argv[2] || path.join(ROOT, 'docs', 'reports', '推理系统组件盘点_思维导图_20260913.drawio');

// ════════════════════════════════════════════════════════════════════
//  YAML 子集解析器
// ════════════════════════════════════════════════════════════════════
// 支持: key: value / key: / - value / - key: value / | 多行标量 / # 注释 / '"' 引号
// 不支持: 锚点别名、多文档、流式集合（本源文件不使用这些）

function unquote(s) {
  if (s.length >= 2) {
    const a = s[0], b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return s.slice(1, -1);
  }
  return s;
}

// 在首个「冒号 + 空格」或「行尾冒号」处切分；全角「：」不是分隔符
function splitKV(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ':') continue;
    if (i === s.length - 1) return [s.slice(0, i), ''];
    if (s[i + 1] === ' ') return [s.slice(0, i), s.slice(i + 2).trim()];
  }
  return null;
}

function parseYaml(text) {
  const raw = text.split(/\r?\n/);

  // ── 阶段一：折叠块标量，产出 token 列表 ──
  const toks = []; // {indent, body, block?}
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.length - line.replace(/^\s*/, '').length;
    const body = line.trim();

    const kv = splitKV(body.startsWith('- ') ? body.slice(2).trim() : body);
    if (kv && (kv[1] === '|' || kv[1] === '>')) {
      const fold = kv[1] === '>';
      const buf = [];
      let j = i + 1;
      let base = -1;
      for (; j < raw.length; j++) {
        if (!raw[j].trim()) { buf.push(''); continue; }
        const ind = raw[j].length - raw[j].replace(/^\s*/, '').length;
        if (ind <= indent) break;
        if (base < 0) base = ind;
        buf.push(raw[j].slice(base));
      }
      while (buf.length && !buf[buf.length - 1].trim()) buf.pop();
      const val = fold ? buf.join(' ').replace(/\s+/g, ' ').trim() : buf.join('\n');
      toks.push({ indent, body: body.slice(0, body.length - 1).trimEnd(), block: val });
      i = j - 1;
      continue;
    }
    toks.push({ indent, body });
  }

  // ── 阶段二：按缩进递归构造 ──
  let pos = 0;

  function parseBlock(minIndent) {
    if (pos >= toks.length) return null;
    return toks[pos].body.startsWith('- ') || toks[pos].body === '-'
      ? parseSeq(minIndent) : parseMap(minIndent);
  }

  function parseSeq(indent) {
    const arr = [];
    while (pos < toks.length && toks[pos].indent === indent &&
           (toks[pos].body.startsWith('- ') || toks[pos].body === '-')) {
      const t = toks[pos];
      const inner = t.body === '-' ? '' : t.body.slice(2).trim();
      if (!inner) { pos++; arr.push(parseBlock(indent + 2)); continue; }
      const kv = splitKV(inner);
      if (kv) {
        // 列表项是一个映射：首个键与 "- " 同行，视作缩进 +2
        const obj = {};
        const childIndent = indent + 2;
        if (t.block !== undefined) { obj[kv[0].trim()] = t.block; pos++; }
        else if (kv[1] === '') { pos++; obj[kv[0].trim()] = parseBlock(childIndent + 2); }
        else { obj[kv[0].trim()] = unquote(kv[1]); pos++; }
        Object.assign(obj, parseMap(childIndent, true));
        arr.push(obj);
      } else { arr.push(unquote(inner)); pos++; }
    }
    return arr;
  }

  function parseMap(indent, lenient) {
    const obj = {};
    while (pos < toks.length) {
      const t = toks[pos];
      if (t.indent < indent) break;
      if (t.indent > indent) { if (lenient) break; pos++; continue; }
      if (t.body.startsWith('- ') || t.body === '-') break;
      const kv = splitKV(t.body);
      if (!kv) { pos++; continue; }
      const key = kv[0].trim();
      if (t.block !== undefined) { obj[key] = t.block; pos++; continue; }
      if (kv[1] === '') { pos++; obj[key] = parseBlock(indent + 2); continue; }
      obj[key] = unquote(kv[1]); pos++;
    }
    return obj;
  }

  return parseMap(0);
}

// ════════════════════════════════════════════════════════════════════
//  样式
// ════════════════════════════════════════════════════════════════════
const STATUS_STYLE = {
  full:    { fill: '#d5e8d4', stroke: '#82b366', font: '#000000', label: '完整' },
  partial: { fill: '#fff2cc', stroke: '#d6b656', font: '#000000', label: '部分' },
  none:    { fill: '#f8cecc', stroke: '#b85450', font: '#000000', label: '未实现' },
  oos:     { fill: '#eeeeee', stroke: '#999999', font: '#666666', label: '范围外' },
};

const X = { root: 40, sec: 380, mech: 700, comp: 1080, note: 1540 };
const W = { root: 300, sec: 220, mech: 350, comp: 430, note: 340 };
const FS = { root: 16, sec: 13, mech: 11, comp: 10, note: 9 };
const H_MIN = 28;
const GAP_COMP = 8;
const GAP_MECH = 24;
const GAP_SEC = 60;

const S = {
  root: `rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontSize=${FS.root};fontStyle=1;`,
  sec: `rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;fontSize=${FS.sec};fontStyle=1;`,
  mech: `rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#666666;fontSize=${FS.mech};align=left;spacingLeft=8;verticalAlign=middle;`,
  note: `rounded=0;whiteSpace=wrap;html=1;fillColor=#fafafa;strokeColor=#cccccc;dashed=1;fontSize=${FS.note};fontColor=#333333;align=left;verticalAlign=top;spacing=4;`,
  edge: 'edgeStyle=orthogonalEdgeStyle;curved=1;rounded=1;html=1;strokeColor=#999999;exitX=1;exitY=0.5;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;',
  noteEdge: 'edgeStyle=orthogonalEdgeStyle;curved=1;rounded=1;html=1;strokeColor=#cccccc;dashed=1;exitX=1;exitY=0.5;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;',
  legend: 'rounded=0;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#cccccc;fontSize=10;align=left;verticalAlign=top;spacing=6;',
  caption: 'text;html=1;align=left;verticalAlign=top;fontSize=10;fontColor=#999999;',
};

function compStyle(st) {
  const c = STATUS_STYLE[st] || STATUS_STYLE.none;
  return `rounded=1;whiteSpace=wrap;html=1;fillColor=${c.fill};strokeColor=${c.stroke};fontColor=${c.font};fontSize=${FS.comp};align=left;spacingLeft=8;verticalAlign=middle;`;
}

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 按字符宽度估算所需高度（中日韩字符按全宽计）
function estH(text, width, fontSize, pad) {
  const usable = width - 18;
  let w = 0;
  for (const ch of String(text || '')) w += (ch.codePointAt(0) > 0x2000 ? fontSize : fontSize * 0.55);
  const lines = Math.max(1, Math.ceil(w / usable));
  return Math.max(H_MIN, lines * (fontSize + 5) + (pad == null ? 12 : pad));
}

// ════════════════════════════════════════════════════════════════════
//  画布
// ════════════════════════════════════════════════════════════════════
function Canvas(prefix) {
  this.cells = [];
  this.edges = [];
  this.seq = 0;
  this.prefix = prefix || '';
}
Canvas.prototype.id = function (p) { return `${this.prefix}${p}${this.seq++}`; };
Canvas.prototype.vertex = function (id, label, tooltip, style, x, y, w, h) {
  if (tooltip) {
    this.cells.push(`<object label="${esc(label)}" tooltip="${esc(tooltip)}" id="${id}">` +
      `<mxCell style="${style}" vertex="1" parent="1">` +
      `<mxGeometry x="${Math.round(x)}" y="${Math.round(y)}" width="${Math.round(w)}" height="${Math.round(h)}" as="geometry"/></mxCell></object>`);
  } else {
    this.cells.push(`<mxCell id="${id}" value="${esc(label)}" style="${style}" vertex="1" parent="1">` +
      `<mxGeometry x="${Math.round(x)}" y="${Math.round(y)}" width="${Math.round(w)}" height="${Math.round(h)}" as="geometry"/></mxCell>`);
  }
  return id;
};
Canvas.prototype.edge = function (from, to, style) {
  this.edges.push(`<mxCell id="${this.id('e')}" style="${style || S.edge}" edge="1" parent="1" ` +
    `source="${from}" target="${to}"><mxGeometry relative="1" as="geometry"/></mxCell>`);
};
Canvas.prototype.xml = function (diagId, name) {
  return `  <diagram id="${diagId}" name="${name}">\n` +
    `    <mxGraphModel dx="1200" dy="800" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" ` +
    `arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0">\n      <root>\n` +
    `        <mxCell id="0"/>\n        <mxCell id="1" parent="0"/>\n        ` +
    this.cells.join('\n        ') + '\n        ' + this.edges.join('\n        ') +
    `\n      </root>\n    </mxGraphModel>\n  </diagram>`;
};

// ════════════════════════════════════════════════════════════════════
//  page 1：盘点表
// ════════════════════════════════════════════════════════════════════
function buildInventoryPage(doc, stats) {
  const c = new Canvas('iv');
  const rootId = c.id('n');
  let y = 120;
  const secCenters = [];

  for (const sec of doc.sections) {
    const secId = c.id('n');
    const mechCenters = [];

    for (const mech of (sec.mechanisms || [])) {
      const mechId = c.id('n');
      const compCenters = [];

      for (const comp of (mech.components || [])) {
        const st = comp.status;
        stats.byStatus[st] = (stats.byStatus[st] || 0) + 1;
        stats.total++;

        const compH = estH(comp.sglang, W.comp, FS.comp);
        const noteH = comp.note ? estH(comp.note, W.note, FS.note, 14) : 0;
        const slotH = Math.max(compH, noteH, H_MIN);
        const cy = y + slotH / 2;

        // tooltip：两侧代码坐标
        const tip = [
          mech.sglang_ref ? `sglang: ${mech.sglang_ref}` : '',
          comp.evidence ? `本系统: ${comp.evidence}` : (comp.no_evidence ? `本系统: ${comp.no_evidence}` : ''),
          `完成度: ${(STATUS_STYLE[st] || {}).label || st}`,
        ].filter(Boolean).join('\n');

        const compId = c.vertex(c.id('n'), comp.sglang, tip, compStyle(st),
          X.comp, cy - compH / 2, W.comp, compH);
        c.edge(mechId, compId);

        if (comp.note) {
          const noteId = c.vertex(c.id('n'), comp.note, '', S.note,
            X.note, cy - noteH / 2, W.note, noteH);
          c.edge(compId, noteId, S.noteEdge);
        }
        compCenters.push(cy);
        y += slotH + GAP_COMP;
      }

      if (!compCenters.length) continue;
      const mechLabel = mech.subtitle ? `${mech.title} — ${mech.subtitle}` : mech.title;
      const mechH = estH(mechLabel, W.mech, FS.mech);
      const mechCy = (compCenters[0] + compCenters[compCenters.length - 1]) / 2;
      c.vertex(mechId, mechLabel, mech.sglang_ref || '', S.mech,
        X.mech, mechCy - mechH / 2, W.mech, mechH);
      c.edge(secId, mechId);
      mechCenters.push(mechCy);
      stats.mechanisms++;
      y += GAP_MECH;
    }

    if (!mechCenters.length) continue;
    const secLabel = `${sec.index} ${sec.title}`;
    const secH = estH(secLabel, W.sec, FS.sec);
    const secCy = (mechCenters[0] + mechCenters[mechCenters.length - 1]) / 2;
    c.vertex(secId, secLabel, (sec.desc || '').replace(/\n/g, ' '), S.sec,
      X.sec, secCy - secH / 2, W.sec, secH);
    c.edge(rootId, secId);
    secCenters.push(secCy);
    stats.sections++;
    y += GAP_SEC;
  }

  const rootH = estH(doc.meta.title, W.root, FS.root, 20);
  c.vertex(rootId, doc.meta.title, (doc.meta.rules || '').replace(/\n/g, ' '), S.root,
    X.root, (secCenters[0] + secCenters[secCenters.length - 1]) / 2 - rootH / 2, W.root, rootH);

  // 图例 + 出处
  const order = ['full', 'partial', 'none', 'oos'];
  let ly = 60;
  c.vertex(c.id('n'), '图例 · 第 3 列颜色 = 完成度', '', S.caption, X.root, 34, 420, 18);
  for (const k of order) {
    const s = STATUS_STYLE[k];
    const n = stats.byStatus[k] || 0;
    c.vertex(c.id('n'), `${s.label}（${k}） ${n}`, '', compStyle(k), X.root, ly, 150, 24);
    ly += 28;
  }
  c.vertex(c.id('n'),
    `生成自 docs/inventory.yaml · 基准：${doc.meta.baseline} · 对象：${doc.meta.target} · ${doc.meta.updated}` +
    `\n本文件由 scripts/gen_inventory_mindmap.js 生成，请勿直接编辑；改动请回到 YAML 源文件。` +
    `\n第 3 列 = sglang 组件（着色即完成度），第 4 列 = 当前系统说明（仅必要时给）。hover 节点可见两侧代码位置。`,
    '', S.caption, X.sec, 34, 900, 54);

  return c.xml('inventory', '推理系统组件盘点');
}

// ════════════════════════════════════════════════════════════════════
//  page 2：保真度路线图
// ════════════════════════════════════════════════════════════════════
function buildRoadmapPage(doc) {
  const c = new Canvas('rm');
  const rm = doc.fidelity_roadmap;
  const rootId = c.id('n');

  const groups = [
    { key: 'up', title: '建议升到算子级', fill: '#ffe6cc', stroke: '#d79b00',
      items: (rm.items || []).filter(i => i.current !== i.target) },
    { key: 'keep', title: '保持现状', fill: '#d5e8d4', stroke: '#82b366',
      items: (rm.items || []).filter(i => i.current === i.target) },
    { key: 'na', title: '不适用（非保真度问题）', fill: '#eeeeee', stroke: '#999999',
      items: (rm.excluded || []) },
  ];

  const GX = { root: 40, grp: 360, item: 660, reason: 1060 };
  const GW = { root: 280, grp: 240, item: 340, reason: 560 };

  let y = 120;
  const grpCenters = [];
  for (const g of groups) {
    if (!g.items.length) continue;
    const grpId = c.id('n');
    const itemCenters = [];
    for (const it of g.items) {
      const label = it.target
        ? `${it.object}\n${it.current} → ${it.target}`
        : `${it.object}`;
      const itemH = Math.max(estH(it.object, GW.item, 11), 40);
      const reasonH = estH(it.reason, GW.reason, 9, 14);
      const slotH = Math.max(itemH, reasonH, H_MIN);
      const cy = y + slotH / 2;

      const itemStyle = `rounded=1;whiteSpace=wrap;html=1;fillColor=${g.fill};strokeColor=${g.stroke};` +
        `fontSize=11;align=left;spacingLeft=8;verticalAlign=middle;`;
      const itemId = c.vertex(c.id('n'), label, '', itemStyle,
        GX.item, cy - itemH / 2, GW.item, itemH);
      c.edge(grpId, itemId);

      const rId = c.vertex(c.id('n'), it.reason, '', S.note,
        GX.reason, cy - reasonH / 2, GW.reason, reasonH);
      c.edge(itemId, rId, S.noteEdge);

      itemCenters.push(cy);
      y += slotH + GAP_COMP;
    }
    const grpCy = (itemCenters[0] + itemCenters[itemCenters.length - 1]) / 2;
    c.vertex(grpId, g.title, '', S.sec, GX.grp, grpCy - 22, GW.grp, 44);
    c.edge(rootId, grpId);
    grpCenters.push(grpCy);
    y += GAP_SEC;
  }

  c.vertex(rootId, '保真度路线图', '与盘点表正交：盘点表回答「有没有」，本表回答「做到哪个保真度、要不要再升」',
    S.root, GX.root, (grpCenters[0] + grpCenters[grpCenters.length - 1]) / 2 - 32, GW.root, 64);

  const lv = Object.keys(rm.levels || {}).map(k => `${k} = ${rm.levels[k]}`).join(' · ');
  c.vertex(c.id('n'),
    `两档：${lv}。实测不设档，作为两者的校准手段。` +
    `\n生成自 docs/inventory.yaml 的 fidelity_roadmap 段，请勿直接编辑。`,
    '', S.caption, GX.root, 40, 900, 36);

  return c.xml('roadmap', '保真度路线图');
}

// ════════════════════════════════════════════════════════════════════
//  主流程
// ════════════════════════════════════════════════════════════════════
const doc = parseYaml(fs.readFileSync(SRC, 'utf8'));

// ── 源文件校验（按 meta.rules 的硬性要求）──
const problems = [];
for (const sec of doc.sections || []) {
  if (!sec.index || !sec.title) problems.push(`板块缺 index/title: ${JSON.stringify(sec).slice(0, 60)}`);
  for (const mech of sec.mechanisms || []) {
    if (!mech.title) problems.push(`[${sec.index}] 机制缺 title`);
    if (!(mech.components || []).length) problems.push(`[${sec.index}] ${mech.title}: 无组件`);
    for (const comp of mech.components || []) {
      const at = `[${sec.index}] ${mech.title} / ${String(comp.sglang).slice(0, 24)}`;
      if (!comp.sglang) problems.push(`${at}: 缺 sglang 字段`);
      if (!STATUS_STYLE[comp.status]) problems.push(`${at}: 非法 status "${comp.status}"`);
      if ((comp.status === 'full' || comp.status === 'partial') && !comp.evidence && !comp.no_evidence)
        problems.push(`${at}: ${comp.status} 必须给 evidence（或用 no_evidence 显式豁免）`);
      if (comp.evidence && comp.no_evidence) problems.push(`${at}: evidence 与 no_evidence 不能同时给`);
      if (comp.no_evidence && comp.status !== 'full') problems.push(`${at}: no_evidence 只允许用于 full`);
      if (comp.status === 'partial' && !comp.note) problems.push(`${at}: partial 必须给 note`);
    }
  }
}
if (problems.length) {
  console.error('源文件校验未通过:');
  problems.forEach(p => console.error('  · ' + p));
  process.exit(1);
}

const stats = { sections: 0, mechanisms: 0, total: 0, byStatus: {} };
const page1 = buildInventoryPage(doc, stats);
const page2 = buildRoadmapPage(doc);

const xml = `<mxfile host="Electron" agent="gen_inventory_mindmap.js" version="24.7.17" type="device">\n${page1}\n${page2}\n</mxfile>\n`;

fs.writeFileSync(OUT, xml, 'utf8');

// ── 产物自检（按 page 分别检查：drawio 每页各有自己的 id 空间，根节点 0/1 必然跨页重复）──
const fails = [];
for (const page of [page1, page2]) {
  const name = (page.match(/name="([^"]+)"/) || [, '?'])[1];
  const allIds = [
    ...page.matchAll(/<object [^>]*?id="([^"]+)"/g),
    ...page.matchAll(/<mxCell id="([^"]+)"/g),
  ].map(m => m[1]);
  const ids = new Set(allIds);
  const refs = [...page.matchAll(/(?:source|target)="([^"]+)"/g)].map(m => m[1]);
  const dangling = refs.filter(r => !ids.has(r));
  if (dangling.length) fails.push(`[${name}] 悬挂边指向: ${dangling.slice(0, 5).join(', ')}`);
  if (ids.size !== allIds.length) fails.push(`[${name}] 存在重复 ID`);
  if (/&(?!amp;|lt;|gt;|quot;|#)/.test(page)) fails.push(`[${name}] 存在未转义的 &`);
}
if (fails.length) {
  console.error('产物自检失败:');
  fails.forEach(f => console.error('  · ' + f));
  process.exit(1);
}

console.log('源文件校验通过 · 产物自检通过（逐页无悬挂边、ID 唯一、转义正确）');
console.log('板块 %d · 机制 %d · 组件 %d', stats.sections, stats.mechanisms, stats.total);
for (const k of ['full', 'partial', 'none', 'oos']) {
  const n = stats.byStatus[k] || 0;
  console.log('  %s(%s): %d  %s%%', STATUS_STYLE[k].label, k, n, (n / stats.total * 100).toFixed(1));
}
console.log('路线图 %d 项 (升档 %d) · 已写出: %s',
  (doc.fidelity_roadmap.items || []).length,
  (doc.fidelity_roadmap.items || []).filter(i => i.current !== i.target).length, OUT);
