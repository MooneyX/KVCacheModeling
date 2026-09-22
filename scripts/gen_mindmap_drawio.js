// gen_mindmap_drawio.js
// 从 docs/reports/推理系统组件盘点_sglang源码对照_20260903.md 的六大板块表格
// 生成 drawio 思维导图（根 → 六大类 → 组件 → sglang实现/当前系统/完成度 三分支）
// 用法: node scripts/gen_mindmap_drawio.js [输出路径]
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MD = path.join(ROOT, 'docs', 'reports', '推理系统组件盘点_sglang源码对照_20260903.md');
const OUT = process.argv[2] || path.join(ROOT, 'docs', 'reports', '推理系统组件盘点_思维导图_20260907.drawio');

const md = fs.readFileSync(MD, 'utf8');
const lines = md.split(/\r?\n/);

// ---------- 解析 ----------
const SEC_RE = /^## ([一二三四五六])、(.+)$/;
const sections = []; // {name, desc, rows:[{comp, anchor, sglang, sys, degree, degreeNote}]}
let cur = null;

for (const line of lines) {
  const mSec = line.match(SEC_RE);
  if (mSec) {
    cur = { name: `${mSec[1]} ${mSec[2]}`, desc: '', rows: [] };
    sections.push(cur);
    continue;
  }
  if (/^## /.test(line)) { cur = null; continue; } // 七/八/附录不再收集
  if (!cur) continue;
  if (!cur.desc && line.startsWith('> ')) { cur.desc = line.slice(2).trim(); continue; }
  if (!line.startsWith('|')) continue;
  if (/^\|[\s:-]+\|/.test(line)) continue;          // 分隔行
  const cells = line.split('|').slice(1, -1).map(s => s.trim());
  if (cells.length !== 4) { console.warn('跳过异常行(单元格数=%d): %s', cells.length, line.slice(0, 60)); continue; }
  if (cells[0] === '组件') continue;                 // 表头
  const [comp, sglang, sys, degreeCell] = cells;
  const mAnchor = sglang.match(/^\*\*(.+?)\*\*/);
  if (!mAnchor) console.warn('无白话锚点: %s / %s', cur.name, comp);
  const mDeg = degreeCell.match(/^([^（(]+)[（(](.*)[)）]$/);
  cur.rows.push({
    comp,
    anchor: mAnchor ? mAnchor[1] : '',
    sglang,
    sys,
    degree: (mDeg ? mDeg[1] : degreeCell).trim(),
    degreeNote: mDeg ? mDeg[2] : '',
  });
}

const totalRows = sections.reduce((n, s) => n + s.rows.length, 0);
console.log('板块数: %d, 组件总数: %d', sections.length, totalRows);
sections.forEach(s => console.log('  %s: %d 个组件', s.name, s.rows.length));

// ---------- 文本处理 ----------
const clean = s => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- 布局参数（向右展开的树） ----------
const X = { root: 40, cat: 380, comp: 680, leaf: 1060, content: 1300 };
const W = { root: 280, cat: 220, comp: 320, leaf: 180, content: 460 };
const H = { root: 64, cat: 44, comp: 44, leaf: 30 };
const CAT_GAP = 70;             // 大类间距
const CONTENT_FONT = 9;

// 按字符宽度估算内容文本块所需高度
function estH(text) {
  const usable = W.content - 16;
  let w = 0;
  for (const ch of text) w += (ch.codePointAt(0) > 255 ? CONTENT_FONT : CONTENT_FONT * 0.55);
  const lines = Math.max(1, Math.ceil(w / usable));
  return Math.max(H.leaf, lines * (CONTENT_FONT + 5) + 14);
}

const STYLE = {
  root: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontSize=16;fontStyle=1;',
  cat: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;fontSize=13;fontStyle=1;',
  comp: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#666666;fontSize=11;align=left;spacingLeft=8;verticalAlign=middle;',
  sglang: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;fontSize=10;',
  sys: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontSize=10;',
  degree: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;fontSize=10;fontStyle=1;',
  content: 'rounded=0;whiteSpace=wrap;html=1;align=left;verticalAlign=top;fontSize=9;fontColor=#333333;fillColor=#fafafa;strokeColor=#cccccc;dashed=1;spacing=4;',
  contentEdge: 'edgeStyle=orthogonalEdgeStyle;curved=1;rounded=1;html=1;strokeColor=#bbbbbb;dashed=1;exitX=1;exitY=0.5;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;',
  note: 'text;html=1;align=left;verticalAlign=top;fontSize=10;fontColor=#999999;',
  edge: 'edgeStyle=orthogonalEdgeStyle;curved=1;rounded=1;html=1;strokeColor=#999999;exitX=1;exitY=0.5;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;',
};

// ---------- 生成 ----------
let seq = 0;
const nid = p => `${p}_${seq++}`;
const cells = [];
const edges = [];

function vertex(id, label, tooltip, style, x, y, w, h) {
  if (tooltip) {
    cells.push(`<object label="${esc(label)}" tooltip="${esc(tooltip)}" id="${id}">` +
      `<mxCell style="${style}" vertex="1" parent="1">` +
      `<mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell></object>`);
  } else {
    cells.push(`<mxCell id="${id}" value="${esc(label)}" style="${style}" vertex="1" parent="1">` +
      `<mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`);
  }
}
function edge(from, to, style) {
  const id = nid('e');
  edges.push(`<mxCell id="${id}" style="${style || STYLE.edge}" edge="1" parent="1" source="${from}" target="${to}">` +
    `<mxGeometry relative="1" as="geometry"/></mxCell>`);
}

const ROOT_LABEL = '推理系统组件盘点：sglang 源码对照 × 当前建模系统完成进度';
const ROOT_TIP = clean('一次性快照：生成自 docs/reports/推理系统组件盘点_sglang源码对照_20260903.md（2026-09-07）。' +
  '不与 .md 双向同步——.md 更新后用 node scripts/gen_mindmap_drawio.js 重新生成本文件。' +
  '节点仅放短语，sglang实现/当前系统/完成度 的完整原文显示在各叶子右侧的虚线文本块（可直接编辑），hover 备注同步保留。');
const rootId = nid('root');

let y = 40;
const catCenters = [];

for (const sec of sections) {
  const catId = nid('cat');
  const compCenters = [];
  for (const row of sec.rows) {
    const compId = nid('c');
    const compLabel = row.anchor ? `${row.comp} — ${row.anchor}` : row.comp;
    const degMain = clean(row.degree);
    const leafDefs = [
      { label: 'sglang 实现', tip: clean(row.sglang), style: STYLE.sglang },
      { label: '当前系统', tip: clean(row.sys), style: STYLE.sys },
      { label: '完成度', tip: row.degreeNote ? `${degMain}（${clean(row.degreeNote)}）` : degMain, style: STYLE.degree },
    ];
    const leafCenters = [];
    for (const lf of leafDefs) {
      const contentH = lf.tip ? estH(lf.tip) : H.leaf;
      const slotH = Math.max(H.leaf, contentH);
      const cy = y + slotH / 2;
      const leafId = nid('l');
      vertex(leafId, lf.label, lf.tip, lf.style, X.leaf, Math.round(cy - H.leaf / 2), W.leaf, H.leaf);
      edge(compId, leafId);
      if (lf.tip) {
        const cid = nid('t');
        vertex(cid, lf.tip, '', STYLE.content, X.content, Math.round(cy - contentH / 2), W.content, contentH);
        edge(leafId, cid, STYLE.contentEdge);
      }
      leafCenters.push(cy);
      y += slotH + 8;
    }
    const compY = (leafCenters[0] + leafCenters[leafCenters.length - 1]) / 2 - H.comp / 2;
    vertex(compId, compLabel, '', STYLE.comp, X.comp, Math.round(compY), W.comp, H.comp);
    edge(catId, compId);
    compCenters.push(compY + H.comp / 2);
    y += 14; // 组件间距
  }
  const catY = (compCenters[0] + compCenters[compCenters.length - 1]) / 2 - H.cat / 2;
  vertex(catId, sec.name, sec.desc ? clean(sec.desc) : '', STYLE.cat, X.cat, catY, W.cat, H.cat);
  edge(rootId, catId);
  catCenters.push(catY + H.cat / 2);
  y += CAT_GAP;
}

vertex(rootId, ROOT_LABEL, ROOT_TIP, STYLE.root, X.root, (catCenters[0] + catCenters[catCenters.length - 1]) / 2 - H.root / 2, W.root, H.root);

// 来源标注
const noteId = nid('note');
vertex(noteId,
  '生成自 docs/reports/推理系统组件盘点_sglang源码对照_20260903.md @2026-09-07（一次性快照，不与 .md 双向同步）；叶子右侧虚线块为完整原文，hover 备注同步保留',
  '', STYLE.note, X.root, 8, 560, 20);

const xml = `<mxfile host="Electron" agent="CodeBuddy gen_mindmap_drawio.js" version="24.7.17" type="device">
  <diagram id="mindmap" name="推理系统组件盘点">
    <mxGraphModel dx="1000" dy="600" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        ${cells.join('\n        ')}
        ${edges.join('\n        ')}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`;

fs.writeFileSync(OUT, xml, 'utf8');

// ---------- 自检 ----------
const allIds = [...xml.matchAll(/<object [^>]* id="([^"]+)"/g), ...xml.matchAll(/<mxCell id="([^"]+)"/g)].map(m => m[1]);
const ids = new Set(allIds);
const refs = [...xml.matchAll(/(?:source|target)="([^"]+)"/g)].map(m => m[1]);
const dangling = refs.filter(r => !ids.has(r));
const badAmp = /&(?!amp;|lt;|gt;|quot;|#)/.test(xml);
const dupId = ids.size !== allIds.length;
if (dangling.length || badAmp || dupId) {
  console.error('自检失败: dangling=%o badAmp=%s dupId=%s', dangling.slice(0, 5), badAmp, dupId);
  process.exit(1);
}
console.log('自检通过: 无悬挂边、转义正确、ID 无重复');
console.log('节点: %d, 边: %d', cells.length, edges.length);
console.log('已写出: %s', OUT);
