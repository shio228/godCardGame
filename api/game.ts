/**
 * `POST /api/game` — 部屋の操作（作る・入る・デッキ・準備・選択・投了）。
 * **エンジンを回すのはこの経路だけ。**
 */
import { nodeHandler } from '../src/net/node-bridge';
import { gameRoute } from '../src/net/routes';

export function POST(request: Request): Promise<Response> {
  return gameRoute(request);
}

export default nodeHandler(gameRoute);
