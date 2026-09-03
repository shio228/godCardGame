# 自作カードゲーム — ルールエンジン

神々が新世界の創造権を争う、スタック制の2人対戦カードゲーム。
このリポジトリは**描画から独立したルールエンジン**であり、UIもサーバもまだ無い。

## コマンド

```
npm run typecheck   # tsc --noEmit（strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess）
npm test            # node --test。ゴールデンテスト
npm run sweep       # 全カードを空盤面で走らせ、落ちるカードを一覧にする煙テスト
npm run simulate    # 自動対戦。神別勝率・決着サイクル・勝因・先攻後攻差を出す
npm run replay      # 1試合を記録して再生する（落ちた試合を1手ずつ追う）
npm run dashboard   # テスト・煙テスト・自動対戦・リプレイを1枚のHTMLにする
npm run deck        # 手組みデッキ（decks/*.txt）の検証と要約
npm run play        # 対話プレイ（自分で1試合打つ）
```

変更したら `typecheck` → `test` → `sweep` を必ず全部通す。
**sweep は成功数が減っていないかを見る**（減ったら退行。エラー内訳も比較する）。
進行やルールに触れたら `simulate` も回す。**エラー0が基準**（エラーはエンジンの穴）。
`simulate` が落ちた試合を出したら、表示される `npm run replay -- --p1 … --p2 … --seed …` で再現できる。

## 現在地

**`docs/roadmap.md` を読むこと。** 残タスク・優先順位・既知の不具合・保留が確定した設計は
すべてそこにある。このファイルには書かない（二重管理を避けるため）。

## ドキュメント

| ファイル | 内容 | いつ読むか |
|---|---|---|
| `docs/roadmap.md` | 現在地、残タスクと優先順位、既知の不具合、蒸し返さない決定 | 毎回 |
| `docs/rule-engine-design.md` | DSLの設計思想、ダメージパイプライン11段、確定事項 | `src/rules/types.ts` を触るとき |
| `docs/engine-notes.md` | エンジン実装の判断記録、勝利条件の実装仕様 | `src/engine/` を触るとき |

## ディレクトリ

| パス | 役割 |
|---|---|
| `src/rules/types.ts` | DSL（カード効果のデータ表現）。**変更は慎重に** — 92枚が依存している |
| `src/rules/cards.sample.ts` | カード92枚のデータ |
| `src/rules/objectives.sample.ts` | 特殊勝利条件12件のデータ |
| `decks/*.txt` | **手組みデッキ**（カード名で書くテキスト）。自動対戦もテストもこれを使う |
| `src/rules/decks.load.ts` | デッキファイルの読み込み。**`node:fs` を使う唯一のモジュール** |
| `src/engine/decklist.ts` | デッキリストの書式（純粋なパーサ） |
| `src/engine/effects.ts` | 解決エンジン本体（`resolve(effect, ctx)`） |
| `src/engine/damage.ts` | ダメージパイプライン11段 |
| `src/engine/flow.ts` | ゲーム進行。`startGame` → 6フェイズ → `runGame` |
| `src/engine/weather.ts` | 天候の定義テーブルと能動効果 |
| `src/engine/handlers.ts` | 標準 handler 3件 |
| `tools/sweep.ts` | 煙テスト |
| `src/engine/replay.ts` | 記録と再生（`GameRecord` / `RecordingChooser` / `ReplayChooser`） |
| `src/engine/progress.ts` | 勝利条件の達成度（`cond` を盤面で評価する） |
| `src/engine/ai.ts` | 目的志向の打ち手（`GreedyChooser`） |
| `tools/simulate.ts` | 自動対戦ハーネス |
| `tools/replay.ts` | 記録・再生のCLI |
| `tools/stats.ts` | 自動対戦の実行と集計（`simulate` と `dashboard` が共有） |
| `tools/dashboard.ts` | ダッシュボードHTMLの生成 |
| `tools/deck.ts` | デッキの検証と要約 |
| `tools/play.ts` / `tools/human.ts` | 対話プレイと人間用 Chooser |

## 一次資料（企画書）

カードと勝利条件の一次資料は**各神の設定シート**。「カード置き場」シートは古いので参照しない。

- 企画書 <https://docs.google.com/spreadsheets/d/1wsqflPdIjVbylahHXCFgm3aokhKRDwK4frGZlW5ItDI/edit>
- 画面定義書 <https://docs.google.com/spreadsheets/d/1GPNDPX_PRn9oEEf3T91MLElITygm-DaHTL0n6vwBnmM/edit>

企画書の色分けは **赤/青＝未合意の草案、黒細字＝仮採用、黒太字＝合意済み、背景色＝要決定の重要事項**。
**草案を確定仕様として実装しない。** 判断が要るものは実装せず、何を決める必要があるかを報告する。

## 破ってはいけない規約

- **`as never` / `as any` を書かない。** DSLの穴を隠して型チェックをすり抜けさせるため。
  必要になったらキャストではなくDSL側を直す
- **未対応を黙って無視しない。** 必ず `NotImplementedError` / `RuleError` / `BindingError` を投げる。
  0を返す・何もしない経路を作らない（束縛名の解決失敗も例外にする）
- **置換効果は必ず1本の経路を通す。** ライフの増減は `changeLife()`、ドローは `drawCards()`、
  ダメージは `dealDamage()` のみ。`p.life -= x` や `hand.push(deck.pop())` を直接書かない
- **カードテキストは自動生成しない**（設計書 §8）

## 用語（ダメージ）

- **「与えたダメージ」** = 修正込み・**軽減前**（パイプライン段4の値）。誘発と `bind` が参照するのはこれ
- **「実際に通ったダメージ」** = 装甲・軽減・回避・シールドを適用した後の値

`countEvent.measure` はこの2つが割れる場面（軽減しきったダメージ、0体での攻撃指令）のために必須。
`'events'` = 発生回数、`'units'` = 数量の合計。

## 作業の進め方

- 企画側の判断が必要な点は**勝手に決めず、選択肢とトレードオフを示して止まる**。
  過去に確定した判断は `docs/engine-notes.md` の「企画側で確定した仕様」に記録されている
- `docs/roadmap.md` の「保留が確定している設計」は蒸し返さない
  （待機値・優先度の保留、ミニオンの個体非管理、マリガンなし）
- 実装の判断を下したら、その理由を `docs/engine-notes.md` に追記する
