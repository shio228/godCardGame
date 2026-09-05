/**
 * ダッシュボードとデッキビルダーで共有する見た目。
 *
 * 配色は海の神から取った深いティール（`--accent`）を軸に、
 * 神々のカードゲームらしさを出すために見出しだけ明朝（Shippori Mincho）にしてある。
 * 数字は等幅（JetBrains Mono）で桁を揃える。
 *
 * ライト・ダークの3状態（明示的な指定なし＝OSの設定に従う / data-theme="light" / "dark"）に
 * 対応するため、色は必ずトークンで定義してコンポーネント側では直接書かない。
 */

/** 唯一の外部依存。Artifact の CSP が許しているのは Google Fonts だけ */
export const FONTS =
  'https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@600;700&family=Zen+Kaku+Gothic+New:wght@400;500;700&family=JetBrains+Mono:wght@400;600&display=swap';

/** 配色・字組み・ページの骨格・共通の部品 */
export const THEME_CSS = `
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

.dim { color: var(--muted); }
.note { color: var(--muted); font-size: 12px; }
ul.plain { margin: 6px 0 0; padding-left: 18px; }
`;

/** `<head>` に入れるぶん（フォント読み込み + テーマ） */
export function headStyles(): string {
  return [
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    `<link rel="stylesheet" href="${FONTS}">`,
  ].join('\n');
}
