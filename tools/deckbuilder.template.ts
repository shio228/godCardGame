/**
 * デッキビルダーのHTML。`tools/deckbuilder.ts` が集めたデータと、
 * esbuild で束ねたパーサ（`src/browser/deckbuilder.entry.ts`）を1枚に埋め込む。
 *
 * 画面の合否判定は**すべて本物のパーサ**に投げている（`Deck.check`）。
 * 画面側で枚数を数え直すと `npm run deck` と食い違うため。
 *
 * `standalone: false` で `<html>` の枠を出さない断片を返す（Artifact 公開用）。
 */
import type { BuilderData } from '../src/browser/deckbuilder.entry';
import { FONTS, THEME_CSS } from './theme';

const CSS = THEME_CSS + `
.builder { display: grid; grid-template-columns: minmax(320px, 1.15fr) minmax(280px, 1fr) minmax(240px, .85fr); gap: 14px; align-items: start; }
@media (max-width: 1100px) { .builder { grid-template-columns: 1fr; } }

.col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.pane { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); padding: 12px 14px; }
.pane > h2 { margin-bottom: 8px; }

.tools { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }
input[type="search"], input[type="text"], select, textarea {
  font: inherit; color: var(--ink); background: var(--surface-2);
  border: 1px solid var(--line); border-radius: 8px; padding: 5px 10px;
}
input[type="search"] { flex: 1; min-width: 140px; }
textarea { width: 100%; min-height: 150px; resize: vertical; font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 12.5px; line-height: 1.6; }
input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

button.pill {
  appearance: none; font: inherit; cursor: pointer; color: var(--ink);
  background: var(--surface); border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px;
}
button.pill[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); }
button.pill:disabled { opacity: .4; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--surface); }

.pool { max-height: 62vh; overflow-y: auto; display: grid; gap: 4px; }
.entry { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.entry.in { border-color: var(--accent); background: var(--accent-soft); }
.entry .nm { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
.entry .nm b { font-weight: 500; }
.entry .tx { color: var(--muted); font-size: 12px; margin-top: 2px; white-space: pre-wrap; }
.tag { font-size: 10.5px; letter-spacing: .06em; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; }
.tag.kw { color: var(--accent); border-color: var(--accent); }
.tag.lim { color: var(--warn); border-color: var(--warn); }
.count { display: flex; align-items: center; gap: 5px; align-self: start; }
.count b { min-width: 12px; text-align: center; font-family: "JetBrains Mono", monospace; }
.count button { width: 26px; height: 26px; border-radius: 6px; padding: 0; line-height: 1; }

.deck { display: grid; gap: 3px; max-height: 42vh; overflow-y: auto; }
.slot { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: baseline; padding: 3px 6px; border-radius: 6px; }
.slot:hover { background: var(--surface-2); }
.slot .n { font-family: "JetBrains Mono", monospace; color: var(--accent); }

.gauge { display: flex; align-items: baseline; gap: 8px; margin: 6px 0 10px; }
.gauge .big { font-family: "JetBrains Mono", monospace; font-size: 22px; }
.gauge .bar { flex: 1; height: 8px; }
.gauge .bar > i.over { background: var(--crit); }
.gauge .bar > i.under { background: var(--warn); }

.objs { display: grid; gap: 5px; }
.obj { display: grid; grid-template-columns: auto 1fr; gap: 8px; align-items: start; padding: 5px 7px; border: 1px solid var(--line); border-radius: 8px; cursor: pointer; }
.obj.on { border-color: var(--accent); background: var(--accent-soft); }
.obj .init { font-family: "JetBrains Mono", monospace; color: var(--accent); }
.obj .t { color: var(--muted); font-size: 12px; }

.verdict { padding: 9px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface-2); }
.verdict.ok { border-color: var(--ok); color: var(--ok); }
.verdict.ng { border-color: var(--crit); color: var(--crit); white-space: pre-wrap; }

.stat { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; font-size: 12.5px; }
.stat span:last-child { font-family: "JetBrains Mono", monospace; color: var(--muted); }
.hint { color: var(--muted); font-size: 12px; }
.row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
`;

const SCRIPT = `
(function () {
  var D = window.__BUILDER__;
  var L = window.Deck;                    // esbuild で束ねた本物のパーサ
  var pool = L.makePool(D);

  var state = {
    god: D.gods[0].id,
    counts: {},                           // カードID → 枚数
    objectives: [],                       // 勝利条件ID
    name: '',
    comments: [],
    search: '',
    types: {},                            // 絞り込み中のタイプ
    onlyIn: false,
  };

  var KW = { instant: '瞬発', chant: '詠唱', static: '常在' };
  function kwName(k) { return KW[k] || k; }

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function cardsOf(god) { return D.cards.filter(function (c) { return c.god === god || c.god === 'common'; }); }
  function total() { return Object.keys(state.counts).reduce(function (a, id) { return a + state.counts[id]; }, 0); }
  function byId(id) { return D.cards.filter(function (c) { return c.id === id; })[0]; }

  // ---- 神を切り替える ----
  function setGod(god, keep) {
    state.god = god;
    if (!keep) {
      state.counts = {};
      state.objectives = D.objectives.filter(function (o) { return o.god === god; }).map(function (o) { return o.id; });
      state.name = D.gods.filter(function (g) { return g.id === god; })[0].name;
      state.comments = [];
    }
    render();
  }

  function add(id, delta) {
    var n = (state.counts[id] || 0) + delta;
    if (n < 0) n = 0;
    if (n > D.limits.maxCopies) n = D.limits.maxCopies;
    if (n === 0) delete state.counts[id]; else state.counts[id] = n;
    render();
  }

  // ---- 読み込み ----
  function loadText(text) {
    try {
      var deck = L.load(text, pool);
      state.god = deck.god;
      state.name = deck.name;
      state.objectives = deck.objectives.slice();
      state.counts = {};
      deck.cards.forEach(function (id) { state.counts[id] = (state.counts[id] || 0) + 1; });
      state.comments = text.split(/\\r?\\n/)
        .filter(function (l) { return l.indexOf('#') === 0 && l.indexOf('# 合計') !== 0; })
        .map(function (l) { return l.replace(/^#\\s?/, ''); });
      $('loadError').textContent = '';
      render();
    } catch (e) {
      $('loadError').textContent = String(e.message || e);
    }
  }

  // ---- 描画 ----
  function render() {
    renderGods();
    renderPool();
    renderDeck();
    renderObjectives();
    renderCheck();
  }

  function renderGods() {
    $('gods').innerHTML = D.gods.map(function (g) {
      return '<button class="pill" data-god="' + g.id + '" aria-pressed="' + (g.id === state.god) + '">' + esc(g.name) + '</button>';
    }).join('');
    $('gods').querySelectorAll('[data-god]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.god === state.god) return;
        setGod(b.dataset.god);
      });
    });
    $('deckName').value = state.name;
  }

  function renderPool() {
    var all = cardsOf(state.god);
    var types = {};
    all.forEach(function (c) { c.types.forEach(function (t) { types[t] = (types[t] || 0) + 1; }); });
    $('types').innerHTML = Object.keys(types).sort().map(function (t) {
      return '<button class="pill" data-type="' + esc(t) + '" aria-pressed="' + !!state.types[t] + '">' + esc(t) + '</button>';
    }).join('');
    $('types').querySelectorAll('[data-type]').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = b.dataset.type;
        if (state.types[t]) delete state.types[t]; else state.types[t] = true;
        renderPool();
      });
    });

    var picked = Object.keys(state.types);
    var q = state.search.trim();
    var list = all.filter(function (c) {
      if (state.onlyIn && !state.counts[c.id]) return false;
      if (picked.length > 0 && !picked.some(function (t) { return c.types.indexOf(t) >= 0; })) return false;
      if (q && c.name.indexOf(q) < 0 && c.text.indexOf(q) < 0 && c.types.join(' ').indexOf(q) < 0) return false;
      return true;
    });

    $('poolCount').textContent = list.length + ' / ' + all.length + ' 種類';
    $('pool').innerHTML = list.map(function (c) {
      var n = state.counts[c.id] || 0;
      var tags = c.types.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') +
        c.keywords.map(function (k) { return '<span class="tag kw">' + esc(kwName(k)) + '</span>'; }).join('') +
        (c.restricted ? '<span class="tag lim">プレイ制限</span>' : '');
      return '<div class="entry' + (n ? ' in' : '') + '">' +
        '<div><div class="nm"><b>' + esc(c.name) + '</b>' + tags + '</div>' +
        '<div class="tx">' + esc(c.text) + '</div></div>' +
        '<div class="count">' +
        '<button class="pill" data-minus="' + c.id + '"' + (n === 0 ? ' disabled' : '') + '>−</button>' +
        '<b>' + n + '</b>' +
        '<button class="pill" data-plus="' + c.id + '"' + (n >= D.limits.maxCopies ? ' disabled' : '') + '>＋</button>' +
        '</div></div>';
    }).join('') || '<p class="hint">条件に合うカードがありません</p>';

    $('pool').querySelectorAll('[data-plus]').forEach(function (b) {
      b.addEventListener('click', function () { add(b.dataset.plus, 1); });
    });
    $('pool').querySelectorAll('[data-minus]').forEach(function (b) {
      b.addEventListener('click', function () { add(b.dataset.minus, -1); });
    });
  }

  function renderDeck() {
    var ids = Object.keys(state.counts);
    var n = total();
    var pctv = Math.min(100, (n / D.limits.deckMax) * 100);
    var cls = n < D.limits.deckMin ? 'under' : n > D.limits.deckMax ? 'over' : '';
    $('gauge').innerHTML =
      '<span class="big">' + n + '</span><span class="hint">/ ' + D.limits.deckMin + '〜' + D.limits.deckMax + ' 枚</span>' +
      '<span class="bar"><i class="' + cls + '" style="width:' + pctv.toFixed(1) + '%"></i></span>' +
      '<span class="hint">' + ids.length + ' 種類</span>';

    $('deck').innerHTML = ids.map(function (id) { return byId(id); })
      .sort(function (a, b) { return (state.counts[b.id] - state.counts[a.id]) || a.name.localeCompare(b.name, 'ja'); })
      .map(function (c) {
        return '<div class="slot"><span class="n">' + state.counts[c.id] + '</span>' +
          '<span>' + esc(c.name) + '</span>' +
          '<button class="pill" data-del="' + c.id + '">−</button></div>';
      }).join('') || '<p class="hint">まだ1枚も入っていません</p>';
    $('deck').querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () { add(b.dataset.del, -1); });
    });
  }

  function renderObjectives() {
    var mine = D.objectives.filter(function (o) { return o.god === state.god; });
    $('objs').innerHTML = mine.map(function (o) {
      var on = state.objectives.indexOf(o.id) >= 0;
      return '<div class="obj' + (on ? ' on' : '') + '" data-obj="' + o.id + '" role="button" tabindex="0">' +
        '<span class="init">先行度' + o.initiative + '</span>' +
        '<span><b>' + esc(o.name) + '</b><div class="t">' + esc(o.text) + '</div></span></div>';
    }).join('');
    var toggle = function (id) {
      var i = state.objectives.indexOf(id);
      if (i >= 0) state.objectives.splice(i, 1); else state.objectives.push(id);
      renderObjectives();
      renderCheck();
    };
    $('objs').querySelectorAll('[data-obj]').forEach(function (d) {
      d.addEventListener('click', function () { toggle(d.dataset.obj); });
      d.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(d.dataset.obj); }
      });
    });
  }

  function renderCheck() {
    var deck = L.toDeck(state.name || state.god, state.god, state.counts, state.objectives);
    var res = L.check(deck, pool, state.comments);
    $('verdict').className = 'verdict ' + (res.ok ? 'ok' : 'ng');
    $('verdict').textContent = res.ok ? '✓ このデッキは合法です（npm run deck も通ります）' : '✗ ' + res.error;
    $('text').value = res.text;
    renderStats();
  }

  function renderStats() {
    var ids = Object.keys(state.counts);
    var types = {}, kws = {}, restricted = 0;
    ids.forEach(function (id) {
      var c = byId(id), n = state.counts[id];
      c.types.forEach(function (t) { types[t] = (types[t] || 0) + n; });
      c.keywords.forEach(function (k) { kws[k] = (kws[k] || 0) + n; });
      if (c.restricted) restricted += n;
    });
    var n = total() || 1;
    var rows = Object.keys(types).sort(function (a, b) { return types[b] - types[a]; }).map(function (t) {
      return '<div class="stat"><span>' + esc(t) + '</span>' +
        '<span class="bar"><i style="width:' + ((100 * types[t]) / n).toFixed(1) + '%"></i></span>' +
        '<span>' + types[t] + '</span></div>';
    }).join('');
    var kwRow = Object.keys(kws).map(function (k) { return esc(kwName(k)) + ' ' + kws[k]; }).join(' / ') || 'なし';
    var pickedInit = D.objectives
      .filter(function (o) { return state.objectives.indexOf(o.id) >= 0 && typeof o.initiative === 'number'; })
      .map(function (o) { return o.initiative; });
    var minInit = pickedInit.length ? Math.min.apply(null, pickedInit) : '-';

    $('stats').innerHTML =
      '<div class="hint" style="margin-bottom:6px">キーワード: ' + kwRow +
      '　/　プレイ制限つき: ' + restricted + '枚' +
      '　/　最小の先行度: ' + minInit + '（小さいほど先攻を取りやすい）</div>' + rows;
  }

  // ---- 操作の配線 ----
  $('search').addEventListener('input', function (e) { state.search = e.target.value; renderPool(); });
  $('onlyIn').addEventListener('click', function () {
    state.onlyIn = !state.onlyIn;
    $('onlyIn').setAttribute('aria-pressed', String(state.onlyIn));
    renderPool();
  });
  $('deckName').addEventListener('input', function (e) { state.name = e.target.value; renderCheck(); });
  $('clear').addEventListener('click', function () { setGod(state.god); });
  $('copy').addEventListener('click', function () {
    var ta = $('text');
    ta.select();
    var done = function () { $('copied').textContent = 'コピーしました'; setTimeout(function () { $('copied').textContent = ''; }, 1600); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(done, done);
    else { try { document.execCommand('copy'); } catch (e) {} done(); }
  });
  $('load').addEventListener('click', function () { loadText($('paste').value); });
  $('samples').innerHTML = Object.keys(D.decks).map(function (k) {
    return '<button class="pill" data-sample="' + k + '">' + esc(k) + '.txt</button>';
  }).join('');
  $('samples').querySelectorAll('[data-sample]').forEach(function (b) {
    b.addEventListener('click', function () { loadText(D.decks[b.dataset.sample]); });
  });

  setGod(state.god);
})();
`;

export function renderDeckBuilder(
  data: BuilderData,
  /** esbuild で束ねたパーサ（IIFE。`window.Deck` を作る） */
  bundle: string,
  opts: { standalone?: boolean } = {},
): string {
  const standalone = opts.standalone !== false;
  const { deckMin, deckMax, maxCopies } = data.limits;

  const body = `
<header class="top"><div class="topin">
  <h1>デッキ工房</h1>
  <span class="sub">神々のカードゲーム</span>
  <span class="spacer"></span>
  <span class="sub mono">${data.cards.length}枚のカードプール</span>
</div></header>
<div class="wrap">
  <p class="note" style="margin:14px 0 16px">
    カードを選んでデッキを組み、下のテキストをコピーして <span class="mono">decks/&lt;名前&gt;.txt</span> に貼ります。
    合否の判定はエンジンと同じパーサを通しているので、<b>ここで通れば <span class="mono">npm run deck</span> も通ります</b>。
    デッキは${deckMin}〜${deckMax}枚、同名は${maxCopies}枚まで。
  </p>

  <div class="builder">
    <div class="col">
      <div class="pane">
        <div class="rowhead"><h2>カードプール</h2><span class="dim mono" id="poolCount"></span></div>
        <div class="tools" id="gods"></div>
        <div class="tools">
          <input type="search" id="search" placeholder="名前・テキスト・タイプで探す" aria-label="カードを探す">
          <button class="pill" id="onlyIn" aria-pressed="false" type="button">入れた分だけ</button>
        </div>
        <div class="tools" id="types"></div>
        <div class="pool" id="pool"></div>
      </div>
    </div>

    <div class="col">
      <div class="pane">
        <div class="rowhead"><h2>デッキ</h2></div>
        <div class="tools">
          <input type="text" id="deckName" placeholder="デッキ名" aria-label="デッキ名" style="flex:1">
          <button class="pill" id="clear" type="button">空にする</button>
        </div>
        <div class="gauge" id="gauge"></div>
        <div class="deck" id="deck"></div>
      </div>
      <div class="pane">
        <div class="rowhead"><h2>勝利条件</h2><span class="note">${data.limits.objectiveMin}つ以上</span></div>
        <div class="objs" id="objs"></div>
      </div>
    </div>

    <div class="col">
      <div class="pane">
        <div class="rowhead"><h2>検証</h2></div>
        <div class="verdict" id="verdict"></div>
      </div>
      <div class="pane">
        <div class="rowhead"><h2>内訳</h2></div>
        <div id="stats"></div>
      </div>
    </div>
  </div>

  <div class="pane" style="margin-top:14px">
    <div class="rowhead"><h2>デッキリスト</h2><span class="dim" id="copied"></span></div>
    <textarea id="text" readonly aria-label="デッキリスト"></textarea>
    <div class="row" style="margin-top:8px">
      <button class="pill primary" id="copy" type="button">コピー</button>
      <span class="hint">これを <span class="mono">decks/</span> に .txt として置きます</span>
    </div>
  </div>

  <div class="pane" style="margin-top:14px">
    <div class="rowhead"><h2>読み込む</h2></div>
    <div class="row" style="margin-bottom:8px">
      <span class="hint">同梱のデッキ:</span><span class="row" id="samples"></span>
    </div>
    <textarea id="paste" placeholder="デッキリストを貼り付けて「読み込む」" aria-label="デッキリストを貼り付け"></textarea>
    <div class="row" style="margin-top:8px">
      <button class="pill" id="load" type="button">読み込む</button>
      <span class="dim" id="loadError"></span>
    </div>
  </div>
</div>
<script>window.__BUILDER__ = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>
<script>${bundle}</script>
<script>${SCRIPT}</script>`;

  const head = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>デッキ工房</title>
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
