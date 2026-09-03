/**
 * ダッシュボードのHTML。`tools/dashboard.ts` が集めたデータを1枚のページにする。
 *
 * 外部依存は Google Fonts だけで、CSS も JS も埋め込む（ファイル1つで完結させる）。
 * `standalone: false` にすると `<html>`/`<head>`/`<body>` を出さない断片を返す
 * （Artifact として公開するときはこちら。公開側が枠を付ける）。
 */
import type { GameRecord } from '../src/engine/replay';
import type { Summary } from './stats';

export interface TestSuite {
  name: string;
  tests: { name: string; ok: boolean; ms: number }[];
}

export interface DashboardData {
  generatedAt: string;
  typecheck: { ok: boolean; output: string };
  tests: { total: number; pass: number; fail: number; suites: TestSuite[] };
  sweep: { ok: number; total: number; failures: { message: string; cards: string[] }[] };
  sim: {
    games: number;
    seed: number;
    random: Summary;
    greedy: Summary;
    head: { games: number; winRate: number };
  };
  replays: { id: string; label: string; record: GameRecord }[];
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;

const FONTS =
  'https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@600;700&family=Zen+Kaku+Gothic+New:wght@400;500;700&family=JetBrains+Mono:wght@400;600&display=swap';

const CSS = `
:root {
  --bg: #eef2f2;
  --surface: #fbfdfd;
  --surface-2: #f2f6f6;
  --ink: #0f1d1e;
  --muted: #5a6b6c;
  --line: #d3dede;
  --accent: #0b7a78;
  --accent-soft: #d6edec;
  --ok: #1f7a4d;
  --warn: #b4741a;
  --crit: #b33a3a;
  --p1: #0b7a78;
  --p2: #9a5b1f;
  --shadow: 0 1px 2px rgba(15, 29, 30, .06), 0 8px 24px rgba(15, 29, 30, .05);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0b1416;
    --surface: #101e20;
    --surface-2: #16292b;
    --ink: #e6f0ef;
    --muted: #8fa3a3;
    --line: #22383a;
    --accent: #4fd1c5;
    --accent-soft: #123033;
    --ok: #57c48a;
    --warn: #e0a64a;
    --crit: #e36b6b;
    --p1: #4fd1c5;
    --p2: #e0a64a;
    --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 8px 24px rgba(0, 0, 0, .3);
  }
}
:root[data-theme="dark"] {
  --bg: #0b1416;
  --surface: #101e20;
  --surface-2: #16292b;
  --ink: #e6f0ef;
  --muted: #8fa3a3;
  --line: #22383a;
  --accent: #4fd1c5;
  --accent-soft: #123033;
  --ok: #57c48a;
  --warn: #e0a64a;
  --crit: #e36b6b;
  --p1: #4fd1c5;
  --p2: #e0a64a;
  --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 8px 24px rgba(0, 0, 0, .3);
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: "Zen Kaku Gothic New", system-ui, "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;
  font-size: 14px;
  line-height: 1.7;
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3 { font-family: "Shippori Mincho", "Hiragino Mincho ProN", serif; font-weight: 600; text-wrap: balance; margin: 0; }
h1 { font-size: 22px; letter-spacing: .04em; }
h2 { font-size: 17px; letter-spacing: .03em; }
h3 { font-size: 14px; letter-spacing: .03em; color: var(--muted); }
.mono, td.num, .log, .val { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 0 20px 64px; }

header.top {
  position: sticky; top: 0; z-index: 20;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--line);
}
.topin { max-width: 1180px; margin: 0 auto; padding: 14px 20px; display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: baseline; }
.sub { color: var(--muted); font-size: 12px; letter-spacing: .06em; }
.spacer { flex: 1; }

.chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 18px 0 22px; }
.chip {
  display: inline-flex; align-items: baseline; gap: 8px;
  padding: 7px 12px; border-radius: 999px;
  background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow);
}
.chip b { font-size: 13px; }
.chip .k { color: var(--muted); font-size: 11px; letter-spacing: .08em; }
.chip::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); align-self: center; }
.chip.warn::before { background: var(--warn); }
.chip.bad::before { background: var(--crit); }

nav.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); margin-bottom: 22px; flex-wrap: wrap; }
nav.tabs button {
  appearance: none; background: none; border: 0; border-bottom: 2px solid transparent;
  padding: 9px 14px; font: inherit; color: var(--muted); cursor: pointer; letter-spacing: .04em;
}
nav.tabs button[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--accent); }
nav.tabs button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

section.panel { display: none; }
section.panel.on { display: block; }

.card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); padding: 16px 18px; }
.grid { display: grid; gap: 14px; }
.grid.two { grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
.stack { display: flex; flex-direction: column; gap: 14px; }
.rowhead { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }

table { border-collapse: collapse; width: 100%; font-size: 13px; }
.scroll { overflow-x: auto; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 500; font-size: 11px; letter-spacing: .08em; }
td.num, th.num { text-align: right; }
tr:last-child td { border-bottom: 0; }

.bar { display: block; position: relative; height: 6px; min-width: 40px; border-radius: 3px; background: var(--surface-2); overflow: hidden; }
.bar > i { position: absolute; inset: 0 auto 0 0; background: var(--accent); border-radius: 3px; }
.bar.b2 > i { background: var(--p2); }

.heat td.cell { text-align: center; font-family: "JetBrains Mono", monospace; }

.tests { display: grid; gap: 10px; }
.suite { border: 1px solid var(--line); border-radius: 8px; background: var(--surface); overflow: hidden; }
.suite > summary { cursor: pointer; padding: 9px 14px; display: flex; gap: 10px; align-items: baseline; list-style: none; }
.suite > summary::-webkit-details-marker { display: none; }
.suite > summary::before { content: "▸"; color: var(--muted); }
.suite[open] > summary::before { content: "▾"; }
.suite ul { margin: 0; padding: 0 14px 12px 32px; list-style: none; display: grid; gap: 3px; }
.suite li { display: flex; gap: 10px; align-items: baseline; color: var(--muted); }
.suite li b { color: var(--ink); font-weight: 400; }
.tick { color: var(--ok); }
.cross { color: var(--crit); }

.replay { display: grid; grid-template-columns: 260px 1fr; gap: 16px; align-items: start; }
@media (max-width: 860px) { .replay { grid-template-columns: 1fr; } }
.games { display: grid; gap: 6px; max-height: 640px; overflow-y: auto; }
.game {
  text-align: left; appearance: none; cursor: pointer; font: inherit; color: inherit;
  background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px;
}
.game[aria-current="true"] { border-color: var(--accent); background: var(--accent-soft); }
.game .m { color: var(--muted); font-size: 11px; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.controls button, .filter {
  appearance: none; font: inherit; cursor: pointer; color: var(--ink);
  background: var(--surface); border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px;
}
.filter[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); }
input[type="range"] { flex: 1; min-width: 160px; accent-color: var(--accent); }

.readout { display: flex; flex-wrap: wrap; gap: 6px 18px; padding: 10px 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); margin-bottom: 12px; }
.readout div { display: flex; gap: 6px; align-items: baseline; }
.readout .k { color: var(--muted); font-size: 11px; letter-spacing: .06em; }

.log { max-height: 460px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.log .line { display: grid; grid-template-columns: 42px 84px 1fr; gap: 10px; padding: 3px 12px; font-size: 12.5px; cursor: pointer; border-left: 3px solid transparent; }
.log .line:hover { background: var(--surface-2); }
.log .line[aria-current="true"] { background: var(--accent-soft); border-left-color: var(--accent); }
.log .c, .log .p { color: var(--muted); }
.log .t { white-space: pre-wrap; }
.log .k-phase .t { font-weight: 700; }
.log .k-win .t { color: var(--crit); }
.log .k-play .t { color: var(--accent); }
.dim { color: var(--muted); }
.note { color: var(--muted); font-size: 12px; }
ul.plain { margin: 6px 0 0; padding-left: 18px; }
`;

const SCRIPT = `
(function () {
  var D = window.__DASH__;
  var tabs = document.querySelectorAll('nav.tabs button');
  tabs.forEach(function (b) {
    b.addEventListener('click', function () {
      tabs.forEach(function (x) { x.setAttribute('aria-selected', String(x === b)); });
      document.querySelectorAll('section.panel').forEach(function (p) {
        p.classList.toggle('on', p.id === b.dataset.tab);
      });
    });
  });

  // ---- リプレイ ----
  var games = D.replays || [];
  var cur = 0, step = 0, filters = {};
  var KINDS = ['phase', 'play', 'pass', 'draw', 'reveal', 'resolve', 'trigger', 'weather', 'win'];
  KINDS.forEach(function (k) { filters[k] = true; });
  var showAll = false;

  var elList = document.getElementById('games');
  var elLog = document.getElementById('log');
  var elRead = document.getElementById('readout');
  var elChart = document.getElementById('chart');
  var elRange = document.getElementById('range');
  var elMeta = document.getElementById('rmeta');
  var elChoices = document.getElementById('choices');

  function lines() {
    var log = games[cur] ? games[cur].record.log : [];
    return log.filter(function (l) { return showAll ? true : (l.kind && filters[l.kind]); });
  }

  function renderGames() {
    elList.innerHTML = games.map(function (g, i) {
      var r = g.record.result;
      var res = r.error ? 'エラー' : (r.winner + ' / ' + (r.reason || ''));
      return '<button class="game" data-i="' + i + '" aria-current="' + (i === cur) + '">' +
        '<div>' + g.label + '</div><div class="m">' + res + '（' + r.cycles + 'サイクル）</div></button>';
    }).join('');
    elList.querySelectorAll('.game').forEach(function (b) {
      b.addEventListener('click', function () { cur = +b.dataset.i; step = 0; render(); });
    });
  }

  function render() {
    var g = games[cur];
    if (!g) return;
    var ls = lines();
    if (step >= ls.length) step = Math.max(0, ls.length - 1);
    elMeta.textContent = g.record.setup.p1God + ' vs ' + g.record.setup.p2God +
      '  seed ' + g.record.setup.seed + '  選択 ' + g.record.choices.length + '手  ログ ' + g.record.log.length + '行';
    elRange.max = String(Math.max(0, ls.length - 1));
    elRange.value = String(step);

    elLog.innerHTML = ls.map(function (l, i) {
      return '<div class="line k-' + (l.kind || 'x') + '" data-i="' + i + '" aria-current="' + (i === step) + '">' +
        '<span class="c mono">C' + (l.cycle == null ? '-' : l.cycle) + '</span>' +
        '<span class="p">' + (l.phase || '') + '</span>' +
        '<span class="t">' + esc(l.text) + '</span></div>';
    }).join('');
    elLog.querySelectorAll('.line').forEach(function (d) {
      d.addEventListener('click', function () { step = +d.dataset.i; render(); });
    });
    var el = elLog.querySelector('[aria-current="true"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });

    var s = ls[step] && ls[step].snap;
    elRead.innerHTML = s
      ? [['ライフ', s.life[0] + ' / ' + s.life[1]], ['手札', s.hand[0] + ' / ' + s.hand[1]],
         ['スタック', s.stack], ['天候', s.weather + (s.apocalypse ? ' + 終末' : '')]]
          .map(function (kv) { return '<div><span class="k">' + kv[0] + '</span><span class="val">' + kv[1] + '</span></div>'; }).join('')
      : '<div class="k">この行に盤面の記録はありません</div>';

    drawChart(ls);
    elChoices.innerHTML = g.record.choices.map(function (c, i) {
      var what = c.t === 'select' || c.t === 'order' ? (c.labels.length ? c.labels.join(', ') : '(選ばない)') : String(c.value);
      return '<div class="line"><span class="c mono">' + (i + 1) + '</span><span class="p">' + c.player +
        '</span><span class="t">' + esc(c.prompt) + ' → ' + esc(what) + '</span></div>';
    }).join('');

    elList.querySelectorAll('.game').forEach(function (b) { b.setAttribute('aria-current', String(+b.dataset.i === cur)); });
  }

  function drawChart(ls) {
    var pts = ls.map(function (l) { return l.snap; }).filter(Boolean);
    if (pts.length < 2) { elChart.innerHTML = ''; return; }
    var W = 720, H = 90, pad = 4;
    var maxLife = Math.max(30, Math.max.apply(null, pts.map(function (p) { return Math.max(p.life[0], p.life[1]); })));
    function path(idx) {
      return pts.map(function (p, i) {
        var x = pad + (W - 2 * pad) * (pts.length === 1 ? 0 : i / (pts.length - 1));
        var y = H - pad - (H - 2 * pad) * Math.max(0, p.life[idx]) / maxLife;
        return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
      }).join(' ');
    }
    var snapIndex = 0, seen = 0;
    for (var i = 0; i < ls.length && i <= step; i++) if (ls[i].snap) seen++;
    snapIndex = Math.max(0, seen - 1);
    var mx = pad + (W - 2 * pad) * (pts.length === 1 ? 0 : snapIndex / (pts.length - 1));
    elChart.innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" role="img" aria-label="ライフの推移">' +
      '<line x1="' + mx + '" y1="0" x2="' + mx + '" y2="' + H + '" stroke="currentColor" opacity=".25"/>' +
      '<path d="' + path(0) + '" fill="none" stroke="var(--p1)" stroke-width="2"/>' +
      '<path d="' + path(1) + '" fill="none" stroke="var(--p2)" stroke-width="2" stroke-dasharray="3 3"/>' +
      '</svg>';
  }

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  document.getElementById('prev').addEventListener('click', function () { step = Math.max(0, step - 1); render(); });
  document.getElementById('next').addEventListener('click', function () { step = Math.min(lines().length - 1, step + 1); render(); });
  elRange.addEventListener('input', function () { step = +elRange.value; render(); });
  document.querySelectorAll('.filter[data-kind]').forEach(function (b) {
    b.addEventListener('click', function () {
      var k = b.dataset.kind;
      if (k === 'all') { showAll = !showAll; b.setAttribute('aria-pressed', String(showAll)); }
      else { filters[k] = !filters[k]; b.setAttribute('aria-pressed', String(filters[k])); }
      step = 0; render();
    });
  });

  renderGames();
  render();
})();
`;

function chip(label: string, value: string, state: 'ok' | 'warn' | 'bad'): string {
  return `<span class="chip ${state === 'ok' ? '' : state}"><span class="k">${esc(label)}</span><b class="mono">${esc(value)}</b></span>`;
}

function bar(value: number, cls = ''): string {
  return `<span class="bar ${cls}"><i style="width:${Math.max(0, Math.min(100, value * 100)).toFixed(1)}%"></i></span>`;
}

function testsPanel(d: DashboardData): string {
  const suites = d.tests.suites
    .map((s) => {
      const failed = s.tests.filter((t) => !t.ok).length;
      const items = s.tests
        .map(
          (t) =>
            `<li><span class="${t.ok ? 'tick' : 'cross'}">${t.ok ? '✓' : '✗'}</span><b>${esc(t.name)}</b><span class="mono dim">${t.ms.toFixed(1)}ms</span></li>`,
        )
        .join('');
      return `<details class="suite"${failed ? ' open' : ''}><summary><b>${esc(s.name)}</b>
        <span class="dim mono">${s.tests.length - failed}/${s.tests.length}</span></summary><ul>${items}</ul></details>`;
    })
    .join('');
  return `<div class="stack">
    <div class="card">
      <div class="rowhead"><h2>ゴールデンテスト</h2><span class="dim mono">${d.tests.pass} / ${d.tests.total}</span></div>
      <p class="note">カード1枚ごとの「初期状態 → 効果適用 → 期待状態」と、ターン進行・天候・記録と再生の検証。</p>
      ${bar(d.tests.total === 0 ? 0 : d.tests.pass / d.tests.total)}
    </div>
    <div class="tests">${suites}</div>
  </div>`;
}

function sweepPanel(d: DashboardData): string {
  const rows = d.sweep.failures
    .map(
      (f) =>
        `<tr><td class="num mono">${f.cards.length}</td><td>${esc(f.message)}</td><td class="dim">${esc(f.cards.join(' / '))}</td></tr>`,
    )
    .join('');
  return `<div class="stack">
    <div class="card">
      <div class="rowhead"><h2>煙テスト（全カードを空盤面で走らせる）</h2>
        <span class="dim mono">${d.sweep.ok} / ${d.sweep.total} 枚</span></div>
      <p class="note">1枚ずつプレイして解決し、落ちるカードを数える。<b>成功数が減っていないか</b>を見るための数字。</p>
      ${bar(d.sweep.total === 0 ? 0 : d.sweep.ok / d.sweep.total)}
    </div>
    <div class="card scroll">
      <h3>落ちたカード</h3>
      <table><thead><tr><th class="num">枚</th><th>理由</th><th>カード</th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="dim">なし</td></tr>'}</tbody></table>
    </div>
  </div>`;
}

function simPanel(d: DashboardData): string {
  const { random, greedy, head } = d.sim;
  const gods = random.byGod.map((g) => g.god);

  const cmp = [
    ['平均決着サイクル', random.avgCycles.toFixed(2), greedy.avgCycles.toFixed(2)],
    [
      '先攻の有利さ（神と相性を補正）',
      random.firstAdvantageMean === undefined ? '-' : `${(100 * random.firstAdvantageMean).toFixed(1)}pt`,
      greedy.firstAdvantageMean === undefined ? '-' : `${(100 * greedy.firstAdvantageMean).toFixed(1)}pt`,
    ],
    ['特殊勝利で決着', pct(random.objectiveWinRate), pct(greedy.objectiveWinRate)],
    ['エラー', String(random.errors.length), String(greedy.errors.length)],
  ]
    .map(([k, a, b]) => `<tr><td>${esc(k!)}</td><td class="num mono">${esc(a!)}</td><td class="num mono">${esc(b!)}</td></tr>`)
    .join('');

  const godRows = gods
    .map((g) => {
      const r = random.byGod.find((x) => x.god === g)!;
      const y = greedy.byGod.find((x) => x.god === g)!;
      return `<tr><td>${esc(g)}</td>
        <td class="num mono">${pct(r.rate)}</td><td style="width:120px">${bar(r.rate)}</td>
        <td class="num mono">${pct(y.rate)}</td><td style="width:120px">${bar(y.rate, 'b2')}</td></tr>`;
    })
    .join('');

  const objRows = random.objectives
    .map((o) => {
      const g = greedy.objectives.find((x) => x.id === o.id);
      const mean = g?.meanProgress;
      const max = g?.maxProgress;
      return `<tr>
        <td>${esc(o.name)}</td><td class="dim">${esc(o.god)}</td>
        <td class="num mono">${pct(o.rate)}</td>
        <td class="num mono">${pct(g?.rate ?? 0)}</td>
        <td style="width:140px">${mean === undefined ? '<span class="dim">測れない</span>' : bar(mean)}</td>
        <td class="num mono dim">${mean === undefined ? '-' : pct(mean)}</td>
        <td class="num mono dim">${max === undefined ? '-' : pct(max)}</td>
      </tr>`;
    })
    .join('');

  const matrix = `<table class="heat"><thead><tr><th>先手側 \\ 後手側</th>${gods.map((g) => `<th class="num">${esc(g)}</th>`).join('')}</tr></thead><tbody>
    ${gods
      .map(
        (a) =>
          `<tr><td>${esc(a)}</td>${gods
            .map((b) => {
              const m = greedy.matrix.find((x) => x.p1 === a && x.p2 === b);
              if (!m) return '<td class="cell dim">—</td>';
              const alpha = (0.08 + 0.55 * m.rate).toFixed(2);
              return `<td class="cell" style="background:color-mix(in srgb, var(--accent) ${Number(alpha) * 100}%, transparent)">${pct(m.rate)}</td>`;
            })
            .join('')}</tr>`,
      )
      .join('')}
  </tbody></table>`;

  const advRows = greedy.firstAdvantage
    .map(
      (f) =>
        `<tr><td>${esc(f.pair[0])} vs ${esc(f.pair[1])}</td>
       <td class="num mono">${pct(f.asFirst.rate)}<span class="dim"> (${f.asFirst.games})</span></td>
       <td class="num mono">${pct(f.asSecond.rate)}<span class="dim"> (${f.asSecond.games})</span></td>
       <td class="num mono">${f.delta === undefined ? '<span class="dim">試合数不足</span>' : `${f.delta >= 0 ? '+' : ''}${(100 * f.delta).toFixed(1)}pt`}</td></tr>`,
    )
    .join('');

  return `<div class="stack">
    <div class="grid two">
      <div class="card">
        <div class="rowhead"><h2>AI比較</h2><span class="dim mono">各 ${d.sim.games} 戦 / seed ${d.sim.seed}</span></div>
        <table><thead><tr><th></th><th class="num">ランダム</th><th class="num">目的志向</th></tr></thead><tbody>${cmp}</tbody></table>
        <p class="note" style="margin-top:10px">直接対決（先後を入れ替えた ${head.games} 戦）で目的志向AIの勝率 <b class="mono">${pct(head.winRate)}</b>。
        50%を明確に超えていれば打ち手として機能している。</p>
      </div>
      <div class="card">
        <div class="rowhead"><h2>神ごとの総合勝率</h2></div>
        <table><thead><tr><th>神</th><th class="num">ランダム</th><th></th><th class="num">目的志向</th><th></th></tr></thead><tbody>${godRows}</tbody></table>
      </div>
    </div>

    <div class="card scroll">
      <div class="rowhead"><h2>勝利条件</h2><span class="note">達成率と、達成できなかった試合も含めた到達度</span></div>
      <p class="note">到達度は勝利条件のデータ（<span class="mono">cond</span>）をそのまま盤面で評価した値。
      <b>達成率0%でも到達度が高い条件は「あと一歩」、低い条件は「そもそも届いていない」</b>と読む。</p>
      <table><thead><tr><th>条件</th><th>神</th><th class="num">達成率(乱)</th><th class="num">達成率(目)</th>
        <th>到達度（目的志向・平均）</th><th class="num">平均</th><th class="num">最大</th></tr></thead><tbody>${objRows}</tbody></table>
    </div>

    <div class="grid two">
      <div class="card scroll">
        <div class="rowhead"><h2>先攻の有利さ</h2></div>
        <p class="note">同じ対戦カードの中で「先攻だった試合 / 後攻だった試合」を比べる。神の強さと相性が打ち消される。</p>
        <table><thead><tr><th>対戦</th><th class="num">先攻時</th><th class="num">後攻時</th><th class="num">差</th></tr></thead><tbody>${advRows}</tbody></table>
      </div>
      <div class="card scroll">
        <div class="rowhead"><h2>神別マトリクス（目的志向AI）</h2></div>
        <p class="note">行の神が P1、列の神が P2。値は P1 の勝率。</p>
        ${matrix}
      </div>
    </div>
  </div>`;
}

function replayPanel(d: DashboardData): string {
  const kinds: [string, string][] = [
    ['phase', 'フェイズ'],
    ['play', 'プレイ'],
    ['pass', 'パス'],
    ['draw', 'ドロー'],
    ['reveal', '公開'],
    ['resolve', '解決'],
    ['trigger', '誘発'],
    ['weather', '天候'],
    ['win', '勝敗'],
  ];
  return `<div class="replay">
    <div class="stack">
      <h3>試合</h3>
      <div class="games" id="games"></div>
      <p class="note">記録は <span class="mono">npm run replay -- --in &lt;file&gt;</span> でも再生できる。</p>
    </div>
    <div class="stack">
      <div class="card">
        <div class="rowhead"><h2>行動ログ</h2><span class="dim mono" id="rmeta"></span></div>
        <div class="controls">
          <button id="prev" type="button">◀ 前</button>
          <button id="next" type="button">次 ▶</button>
          <input type="range" id="range" min="0" max="0" value="0" aria-label="再生位置">
        </div>
        <div class="controls">
          ${kinds.map(([k, label]) => `<button class="filter" data-kind="${k}" aria-pressed="true" type="button">${label}</button>`).join('')}
          <button class="filter" data-kind="all" aria-pressed="false" type="button">効果の内部も表示</button>
        </div>
        <div class="readout" id="readout"></div>
        <div id="chart" style="color:var(--muted)"></div>
        <div class="log" id="log"></div>
      </div>
      <details class="card">
        <summary><b>選択の記録</b> <span class="note">— 誰が何を選んだか。再生はこれを読み上げる</span></summary>
        <div class="log" id="choices" style="margin-top:10px"></div>
      </details>
    </div>
  </div>`;
}

export function renderDashboard(d: DashboardData, opts: { standalone?: boolean } = {}): string {
  const standalone = opts.standalone !== false;
  const testState = d.tests.fail > 0 ? 'bad' : 'ok';
  const sweepState = d.sweep.ok === d.sweep.total ? 'ok' : 'warn';
  const simErrors = d.sim.random.errors.length + d.sim.greedy.errors.length;

  const body = `
<header class="top"><div class="topin">
  <h1>ルールエンジン計器盤</h1>
  <span class="sub">神々のカードゲーム</span>
  <span class="spacer"></span>
  <span class="sub mono">${esc(d.generatedAt)}</span>
</div></header>
<div class="wrap">
  <div class="chips">
    ${chip('型検査', d.typecheck.ok ? 'クリーン' : '失敗', d.typecheck.ok ? 'ok' : 'bad')}
    ${chip('テスト', `${d.tests.pass}/${d.tests.total}`, testState)}
    ${chip('煙テスト', `${d.sweep.ok}/${d.sweep.total} 枚`, sweepState)}
    ${chip('自動対戦', `${d.sim.random.games + d.sim.greedy.games} 戦 / エラー ${simErrors}`, simErrors > 0 ? 'bad' : 'ok')}
    ${chip('特殊勝利で決着', `${pct(d.sim.random.objectiveWinRate)} → ${pct(d.sim.greedy.objectiveWinRate)}`, 'ok')}
  </div>

  <nav class="tabs" role="tablist">
    <button data-tab="p-sim" aria-selected="true" type="button">自動対戦</button>
    <button data-tab="p-replay" aria-selected="false" type="button">リプレイ</button>
    <button data-tab="p-tests" aria-selected="false" type="button">テスト</button>
    <button data-tab="p-sweep" aria-selected="false" type="button">煙テスト</button>
  </nav>

  <section class="panel on" id="p-sim">${simPanel(d)}</section>
  <section class="panel" id="p-replay">${replayPanel(d)}</section>
  <section class="panel" id="p-tests">${testsPanel(d)}</section>
  <section class="panel" id="p-sweep">${sweepPanel(d)}</section>
</div>
<script>window.__DASH__ = ${JSON.stringify({ replays: d.replays }).replace(/</g, '\\u003c')};</script>
<script>${SCRIPT}</script>`;

  const head = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ルールエンジン計器盤</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<style>${CSS}</style>`;

  if (!standalone) return `${head}\n${body}`;
  return `<!doctype html>
<html lang="ja">
<head>
${head}
</head>
<body>
${body}
</body>
</html>`;
}
