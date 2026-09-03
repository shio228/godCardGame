/** 全カードの onResolve を空盤面で走らせ、どのノードで落ちるかを数える煙テスト */
import { samplePool } from '../src/rules/cards.sample';
import { createEngine, play, putInHand, putOnDeck } from '../src/engine/flow';
import { resolveTop } from '../src/engine/effects';
import { Scope } from '../src/engine/context';

async function main() {
  const byKind = new Map<string, string[]>();
  let ok = 0;
  for (const card of samplePool.cards) {
    const engine = createEngine({ pool: samplePool, p1God: card.god === 'common' ? 'sea' : card.god, p2God: 'creation', cycle: 1, budget: 3000 });
    for (const pid of ['P1','P2'] as const) {
      putOnDeck(engine, pid, new Array(12).fill('sea/future_choice'));
      engine.state.players[pid].minions = { human: 3, angel: 3, wraith: 3, beast: 3 };
    }
    putInHand(engine, 'P1', ['sea/future_choice','sea/future_choice','sea/future_choice']);
    const [c] = putInHand(engine, 'P1', [card.id]);
    try {
      const item = await play(engine, 'P1', c!);
      // 瞬発は play() の中で解決済みなので、まだスタックに残っているものだけ手で叩く
      const stillOnStack = engine.state.stacks.some((st) => st.items.some((it) => it.uid === item.uid));
      if (stillOnStack) {
        for (const ab of card.abilities) {
          if (ab.kind === 'onResolve') {
            await resolveTop(ab.effect, { engine, self: 'P1', item, stackId: item.stackId, vars: new Scope() });
          }
        }
      }
      ok++;
    } catch (err) {
      const e = err as Error;
      const key = `${e.name}: ${e.message.slice(0, 70)}`;
      byKind.set(key, [...(byKind.get(key) ?? []), card.name]);
    }
  }
  console.log(`成功 ${ok} / ${samplePool.cards.length}`);
  for (const [k, v] of [...byKind.entries()].sort((a,b)=>b[1].length-a[1].length)) {
    console.log(`  [${v.length}] ${k}\n      ${v.join(' / ')}`);
  }
}
main();
