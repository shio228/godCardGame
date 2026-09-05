/**
 * `GET /api/state?room=&seat=&token=` — その席の保存済みビューを返す。
 * 版が変わったときだけ本文が返る（それ以外は 304）。エンジンは回さない。
 */
import { stateRoute } from '../src/net/routes';

export function GET(request: Request): Promise<Response> {
  return stateRoute(request);
}
