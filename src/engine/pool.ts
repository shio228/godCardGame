/** CardPool を id 索引に変換したもの。エンジンは常にこれ越しに定義を引く。 */
import type {
  CardDef,
  CardPool,
  God,
  GodDef,
  MinionDef,
  NamedActionDef,
  ObjectiveDef,
  Species,
  TokenDef,
} from '../rules/types';
import { RuleError } from './errors';

export class PoolIndex {
  readonly cards = new Map<string, CardDef>();
  readonly tokens = new Map<string, TokenDef>();
  readonly minions = new Map<Species, MinionDef>();
  readonly actions = new Map<string, NamedActionDef>();
  readonly gods = new Map<God, GodDef>();
  readonly objectives = new Map<string, ObjectiveDef>();
  /** group → その group に属する NamedAction の id */
  readonly actionGroups = new Map<string, string[]>();

  constructor(readonly raw: CardPool) {
    for (const c of raw.cards) this.cards.set(c.id, c);
    for (const t of raw.tokens) this.tokens.set(t.id, t);
    for (const m of raw.minions) this.minions.set(m.species, m);
    for (const g of raw.gods) this.gods.set(g.id, g);
    for (const o of raw.objectives) this.objectives.set(o.id, o);
    for (const a of raw.actions) {
      this.actions.set(a.id, a);
      if (a.group) {
        const list = this.actionGroups.get(a.group) ?? [];
        list.push(a.id);
        this.actionGroups.set(a.group, list);
      }
    }
  }

  card(id: string): CardDef {
    const c = this.cards.get(id);
    if (!c) throw new RuleError(`未知のカード id: ${id}`);
    return c;
  }

  token(id: string): TokenDef {
    const t = this.tokens.get(id);
    if (!t) throw new RuleError(`未知のトークン id: ${id}`);
    return t;
  }

  action(id: string): NamedActionDef {
    const a = this.actions.get(id);
    if (!a) throw new RuleError(`未知のアクション id: ${id}`);
    return a;
  }

  group(name: string): string[] {
    const g = this.actionGroups.get(name);
    if (!g) throw new RuleError(`未知のアクショングループ: ${name}`);
    return g;
  }

  god(id: God): GodDef | undefined {
    return this.gods.get(id);
  }

  objective(id: string): ObjectiveDef {
    const o = this.objectives.get(id);
    if (!o) throw new RuleError(`未知の勝利条件 id: ${id}`);
    return o;
  }

  minion(sp: Species): MinionDef | undefined {
    return this.minions.get(sp);
  }
}
