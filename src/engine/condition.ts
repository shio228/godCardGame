/** 条件式（Condition）の評価。 */
import type { Condition } from '../rules/types';
import { state, type Ctx } from './context';
import { RuleError, unreachable } from './errors';
import { matchCard, matchStack, resolveCards, resolveStack } from './select';
import { weatherSide } from './state';
import { evalValue } from './value';

export async function evalCondition(c: Condition, ctx: Ctx): Promise<boolean> {
  const s = state(ctx);
  switch (c.t) {
    case 'cmp': {
      const a = await evalValue(c.a, ctx);
      const b = await evalValue(c.b, ctx);
      switch (c.op) {
        case '==':
          return a === b;
        case '!=':
          return a !== b;
        case '>':
          return a > b;
        case '>=':
          return a >= b;
        case '<':
          return a < b;
        case '<=':
          return a <= b;
        default:
          return unreachable(c.op, 'cmp.op');
      }
    }

    case 'weatherIs': {
      const ws = Array.isArray(c.weather) ? c.weather : [c.weather];
      return ws.includes(s.weather);
    }

    case 'weatherSide':
      return weatherSide(s.weather) === c.side;

    case 'apocalypse':
      return s.apocalypse;

    case 'and': {
      for (const x of c.of) if (!(await evalCondition(x, ctx))) return false;
      return true;
    }

    case 'or': {
      for (const x of c.of) if (await evalCondition(x, ctx)) return true;
      return false;
    }

    case 'not':
      return !(await evalCondition(c.of, ctx));

    case 'exists':
      return (await resolveStack(c.stack, ctx)).length > 0;

    case 'matchesStack': {
      const items = await resolveStack(c.item, ctx);
      if (items.length === 0) return false;
      for (const it of items) if (!(await matchStack(it, c.filter, ctx))) return false;
      return true;
    }

    case 'matchesCard': {
      const cards = await resolveCards(c.card, ctx);
      if (cards.length === 0) return false;
      for (const cd of cards) if (!(await matchCard(cd, c.filter, ctx))) return false;
      return true;
    }

    case 'handler': {
      const fn = ctx.engine.handlers.condition.get(c.id);
      if (!fn) throw new RuleError(`condition handler "${c.id}" が登録されていない`);
      return fn(ctx);
    }

    default:
      return unreachable(c, 'Condition');
  }
}
