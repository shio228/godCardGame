/**
 * 対戦画面のHTML（枠とスタイル）。中身は React が描く。
 *
 * 見た目はダッシュボードとデッキ工房と同じ `tools/theme.ts` の上に、
 * 盤面用のスタイルだけを足している。**テーマのトークン（`--accent` など）以外の色は書かない**——
 * ライト・ダークの3状態がそのまま効くようにするため。
 */
import { FONTS, THEME_CSS } from './theme';

/** 盤面のスタイル。テーマの `.card` / `.stack` / `.chip` とは役割が違うので上書きする */
export const GAME_CSS = `
body { margin: 0; background: var(--bg); color: var(--ink); }
#root { min-height: 100vh; }
button { font: inherit; color: inherit; }
button.primary {
  background: var(--accent); color: var(--surface); border: 0; border-radius: 8px;
  padding: 9px 18px; cursor: pointer; letter-spacing: .04em;
}
button.primary.big { padding: 13px 28px; font-size: 15px; }
button.primary:disabled { opacity: .45; cursor: not-allowed; }
button.ghost {
  background: none; border: 1px solid var(--line); border-radius: 8px;
  padding: 7px 14px; cursor: pointer; color: var(--muted);
}
button.ghost.danger { color: var(--crit); border-color: var(--crit); }
.grow { flex: 1; }
.muted, .note { color: var(--muted); }
.ok { color: var(--ok); }

/* ---------- 入口とロビー ---------- */
.entrance, .lobby { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; display: flex; flex-direction: column; gap: 18px; }
.entrance h1 { font-family: var(--serif, "Shippori Mincho", serif); font-size: 30px; margin: 0; }
.lead { color: var(--muted); margin: 0; }
section.panel {
  display: block; background: var(--surface); border: 1px solid var(--line);
  border-radius: 12px; box-shadow: var(--shadow); padding: 18px 20px;
  display: flex; flex-direction: column; gap: 12px;
}
section.panel h2 { margin: 0; font-size: 15px; letter-spacing: .06em; }
.field { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--muted); }
.field input, .field select, .field textarea {
  font: inherit; color: var(--ink); background: var(--surface-2);
  border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px;
}
.field textarea { font-family: var(--mono, "JetBrains Mono", monospace); font-size: 12px; resize: vertical; }
.check { display: flex; align-items: center; gap: 8px; font-size: 13px; }

.code-card { display: flex; align-items: center; gap: 12px; }
.code { font-family: var(--mono, "JetBrains Mono", monospace); font-size: 26px; letter-spacing: .22em; }
.seats { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.seat {
  background: var(--surface); border: 1px solid var(--line); border-radius: 12px;
  padding: 12px 14px; display: flex; flex-direction: column; gap: 3px; font-size: 13px;
}
.seat.ready { border-color: var(--accent); }
.seat.empty { color: var(--muted); justify-content: center; align-items: center; border-style: dashed; }
.presets { display: flex; flex-wrap: wrap; gap: 8px; }
.recent { display: inline-flex; align-items: center; gap: 4px; }

/* ---------- 盤面 ---------- */
.app { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
.topbar {
  display: flex; align-items: center; gap: 14px; padding: 9px 16px;
  border-bottom: 1px solid var(--line); background: var(--surface); font-size: 13px;
}
.brand { font-family: var(--serif, "Shippori Mincho", serif); font-size: 16px; }
.banner {
  padding: 10px 16px; background: var(--surface-2); border-bottom: 1px solid var(--line);
  display: flex; gap: 12px; align-items: center; font-size: 13px;
}
.banner.error { background: var(--accent-soft); color: var(--crit); }
.banner.result strong { font-size: 15px; }
.banner.result.win { color: var(--ok); }
.banner.result.lose { color: var(--crit); }

.board { flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) 320px; grid-template-rows: minmax(0, 1fr) auto; min-height: 0; }
.board-main {
  grid-column: 1; grid-row: 1; display: flex; flex-direction: column; gap: 10px;
  padding: 12px 14px; min-width: 0; min-height: 0; overflow-y: auto;
}
.rail { grid-column: 2; grid-row: 1; border-left: 1px solid var(--line); background: var(--surface); min-height: 0; overflow: hidden; }

.side { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 10px 14px; display: flex; flex-direction: column; gap: 7px; }
.side-me { border-color: var(--p1); }
.side-head { display: flex; align-items: baseline; gap: 10px; }
.side-head .who { font-size: 11px; letter-spacing: .1em; color: var(--muted); }
.side-head .god { color: var(--muted); font-size: 12px; }
.side-head .life { margin-left: auto; font-family: var(--mono, "JetBrains Mono", monospace); font-size: 19px; color: var(--accent); }
.counts { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; }
.count-label { color: var(--muted); margin-right: 4px; }
.count-n { font-family: var(--mono, "JetBrains Mono", monospace); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px;
  background: var(--surface-2); border: 1px solid var(--line); font-size: 12px; box-shadow: none;
}
.chip::before { content: none; }
.chip.equipped { border-color: var(--accent); }

.objectives { display: flex; flex-direction: column; gap: 4px; }
.objective { display: grid; grid-template-columns: 1fr auto 90px; gap: 10px; align-items: center; font-size: 12px; }
.objective.closed { color: var(--muted); }
.objective-detail { font-family: var(--mono, "JetBrains Mono", monospace); font-size: 11px; color: var(--muted); }
.gauge { position: relative; height: 5px; border-radius: 3px; background: var(--surface-2); overflow: hidden; }
.gauge > i { position: absolute; inset: 0 auto 0 0; background: var(--accent); }

.middle { display: flex; flex-direction: column; gap: 8px; }
.tape { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; color: var(--muted); padding: 0 4px; }
.tape-item.weather { color: var(--accent); }
.tape-item.crit { color: var(--crit); }
.stacks { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
.stacks.empty { color: var(--muted); font-size: 13px; padding: 18px 4px; }
.stack {
  display: flex; flex-direction: column; gap: 4px; min-width: 190px;
  background: var(--surface-2); border: 1px solid var(--line); border-radius: 12px; padding: 8px 10px;
}
.stack-head { font-size: 11px; letter-spacing: .1em; color: var(--muted); }
.item {
  display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 8px;
  background: var(--surface); border: 1px solid var(--line); font-size: 13px;
}
.item.mine { border-left: 3px solid var(--p1); }
.item.theirs { border-left: 3px solid var(--p2); }
.item.immovable { opacity: .7; }
.chant { margin-left: auto; font-size: 11px; color: var(--accent); }

.hand { display: flex; gap: 8px; flex-wrap: wrap; }
.card {
  width: 148px; text-align: left; display: flex; flex-direction: column; gap: 4px;
  background: var(--surface); border: 1px solid var(--line); border-radius: 10px;
  box-shadow: var(--shadow); padding: 9px 11px; cursor: default; opacity: .72;
}
.card.playable { opacity: 1; border-color: var(--accent); cursor: pointer; }
.card.playable:hover { transform: translateY(-2px); transition: transform .12s ease; }
.card-name { font-size: 13px; }
.card-types { font-size: 10px; letter-spacing: .08em; color: var(--muted); }
.card-text { font-size: 11px; color: var(--muted); max-height: 4.6em; overflow: hidden; }

.log { display: flex; flex-direction: column; height: 100%; }
.log-head { padding: 8px 12px; font-size: 11px; letter-spacing: .1em; color: var(--muted); border-bottom: 1px solid var(--line); }
.log-body { flex: 1; overflow-y: auto; padding: 8px 12px; font-size: 12px; display: flex; flex-direction: column; gap: 2px; }
.log .line { color: var(--muted); }
.log .depth-0 { color: var(--ink); }
.log .kind-phase { color: var(--accent); letter-spacing: .06em; }
.log .kind-damage { color: var(--crit); }
.log .kind-create { color: var(--ok); }
.log .depth-1 { padding-left: 10px; }
.log .depth-2 { padding-left: 20px; }
.log .depth-3 { padding-left: 30px; }
.log .depth-4 { padding-left: 40px; }

.choice {
  grid-column: 1 / -1; grid-row: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
  max-height: 34vh; overflow-y: auto;
  padding: 12px 16px; border-top: 1px solid var(--line); background: var(--surface);
}
.choice.waiting { color: var(--muted); }
.prompt { font-size: 13px; }
.options { display: flex; flex-wrap: wrap; gap: 7px; }
.option {
  background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px;
  padding: 7px 13px; cursor: pointer; font-size: 13px; display: inline-flex; gap: 6px; align-items: center;
}
.option.picked { border-color: var(--accent); background: var(--accent-soft); }
.order-no { font-family: var(--mono, "JetBrains Mono", monospace); font-size: 11px; color: var(--accent); }
.choice-actions { margin-left: auto; display: flex; gap: 8px; }
.choice input[type="number"] { font: inherit; width: 84px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); color: var(--ink); }
.spinner { width: 11px; height: 11px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--accent); animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 900px) {
  .board { grid-template-columns: minmax(0, 1fr); }
  .rail { display: none; }
  .board-main { grid-column: 1 / -1; }
  .seats { grid-template-columns: 1fr; }
}
`;

export function renderClient(bundle: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>神々の争い</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<style>
${THEME_CSS}
${GAME_CSS}
</style>
</head>
<body>
<div id="root"></div>
<script>
${bundle}
</script>
</body>
</html>
`;
}
