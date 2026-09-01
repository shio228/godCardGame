/** エンジンが投げる例外。すべて EngineError を継承する。 */
export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * DSL のノードのうち、まだインタプリタが対応していないもの。
 * 「静かに何もしない」ことを避けるため、必ず明示的に投げる。
 */
export class NotImplementedError extends EngineError {
  constructor(
    readonly what: string,
    readonly node?: unknown,
  ) {
    super(`未実装: ${what}`);
  }
}

/** ルール上あり得ない状態（空のスタックを参照した等）。データかエンジンのバグ。 */
export class RuleError extends EngineError {}

/** 束縛名が見つからない・型が合わない等、効果データの記述ミス。 */
export class BindingError extends EngineError {}

/** 無限ループ検出。 */
export class LoopError extends EngineError {}

export function unreachable(node: never, what: string): never {
  throw new NotImplementedError(`${what}: ${JSON.stringify(node)}`, node);
}
