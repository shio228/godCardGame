/**
 * 対戦画面の入口。
 *
 * 持っている状態は3つだけ:
 *   ① 席の身分証（`Session`。localStorage にも置くのでリロードで戻れる）
 *   ② サーバから受け取った最後の盤面（`RoomSnapshot`）
 *   ③ いま送信中かどうか
 *
 * **盤面はサーバが作ったものをそのまま描く。** 手札の中身も、勝利条件の達成度も、
 * 相手に見せてよいかの判定も、すべてサーバ側（`src/engine/view.ts`）で済んでいる。
 *
 * 相手を待つあいだは、版番号を返すだけの軽い経路に問い合わせる（`src/browser/net.ts`）。
 */
import { StrictMode, useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';

import { Board, godName } from './board';
import {
  api,
  ApiError,
  forgetSeat,
  isMyTurn,
  loadSession,
  pollDelay,
  recentSeats,
  saveSession,
  shouldPoll,
  type Session,
} from './net';
import type { Answer, DeckChoice, RoomSnapshot } from '../net/protocol';

function App(): JSX.Element {
  const [session, setSession] = useState<Session | undefined>(() => loadSession());
  const [snap, setSnap] = useState<RoomSnapshot | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const apply = useCallback((next: RoomSnapshot, seat?: Session) => {
    setSnap(next);
    if (seat) {
      setSession(seat);
      saveSession(seat);
    }
    setError(next.error);
  }, []);

  /** サーバを叩くところは全部ここを通す（送信中の印とエラー表示をまとめるため） */
  const send = useCallback(
    async (fn: () => Promise<RoomSnapshot>, keep?: (s: RoomSnapshot) => Session | undefined) => {
      setBusy(true);
      setError(undefined);
      try {
        const next = await fn();
        apply(next, keep?.(next));
      } catch (e) {
        setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [apply],
  );

  // 入り直し: 身分証があれば、まず今の盤面を取りにいく
  useEffect(() => {
    if (!session || snap) return;
    void send(() => api.state(session));
  }, [session, snap, send]);

  usePolling(session, snap, apply, setError);

  const leave = (): void => {
    saveSession(undefined);
    setSession(undefined);
    setSnap(undefined);
    setError(undefined);
  };

  const resume = (s: Session): void => {
    setSession(s);
    saveSession(s);
    void send(() => api.state(s));
  };

  if (!session || !snap) {
    return (
      <Entrance
        busy={busy}
        error={error}
        send={send}
        onResume={resume}
        onLeave={session ? leave : undefined}
      />
    );
  }

  return (
    <div className="app">
      <TopBar snap={snap} onLeave={leave} />
      {error !== undefined ? <div className="banner error">{error}</div> : null}
      {snap.status === 'lobby' ? (
        <Lobby snap={snap} session={session} busy={busy} send={send} />
      ) : snap.view ? (
        <>
          {snap.result ? <Result snap={snap} session={session} /> : null}
          <Board
            view={snap.view}
            pending={snap.pending}
            busy={busy}
            waitingNote={snap.status === 'over' ? '対戦は終わりました' : '相手の手番を待っています…'}
            onChoose={(answer: Answer) => {
              if (!snap.pending) return;
              const index = snap.pending.index;
              void send(() => api.choose(session, index, answer));
            }}
            onSurrender={() => {
              if (confirm('投了しますか？')) void send(() => api.surrender(session));
            }}
          />
        </>
      ) : (
        <div className="banner">盤面を待っています…</div>
      )}
    </div>
  );
}

// ============================================================
// ポーリング
// ============================================================

/**
 * 版番号を見に行く。**決着後とタブが隠れているあいだは行かない。**
 *
 * 自分の手番のあいだも、間隔をうんと空けて見に行く（`SELF_TURN_MS`）。
 * 送った選択の応答だけを頼りにすると、応答が届かなかったときに
 * 「こちらは手番のつもり・サーバは先へ進んでいる」で固まったまま戻れなくなるため。
 */
function usePolling(
  session: Session | undefined,
  snap: RoomSnapshot | undefined,
  apply: (s: RoomSnapshot) => void,
  onError: (m: string) => void,
): void {
  const round = useRef(0);
  const version = useRef(0);

  useEffect(() => {
    version.current = snap?.version ?? 0;
    round.current = 0;
  }, [snap?.version]);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    let timer: number | undefined;

    const tick = async (): Promise<void> => {
      if (!alive) return;
      if (!shouldPoll(snap, document.hidden)) {
        schedule();
        return;
      }
      try {
        const v = await api.version(session.room);
        if (!alive) return;
        if (v !== null && v > version.current) {
          version.current = v;
          apply(await api.state(session));
          round.current = 0;
        } else {
          round.current++;
        }
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
        round.current++;
      }
      schedule();
    };

    const schedule = (): void => {
      if (!alive) return;
      timer = window.setTimeout(() => void tick(), pollDelay(round.current, isMyTurn(snap)));
    };

    // 表に戻ったら、待たずに1回だけ見に行く
    const onVisible = (): void => {
      if (!document.hidden) {
        window.clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    schedule();

    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [session, snap, apply, onError]);
}

// ============================================================
// 入口（部屋を作る / コードで入る）
// ============================================================

type Send = (fn: () => Promise<RoomSnapshot>, keep?: (s: RoomSnapshot) => Session | undefined) => Promise<void>;

/**
 * 同梱デッキ。部屋に入る前はサーバに聞けないので、ここに名前だけ持つ
 * （中身はサーバ側の `decks/*.txt`。ロビーでは `snap.presets` を使う）。
 */
const PRESETS = [
  { name: 'earth', label: '大地アグロ' },
  { name: 'sea', label: '海コントロール' },
  { name: 'sky', label: '空天候' },
  { name: 'life', label: '生命展開' },
];

const seatOf = (s: RoomSnapshot): Session | undefined =>
  s.you ? { room: s.room, seat: s.you.seat, token: s.you.token } : undefined;

function Entrance({
  busy,
  error,
  send,
  onResume,
  onLeave,
}: {
  busy: boolean;
  error?: string | undefined;
  send: Send;
  onResume: (s: Session) => void;
  onLeave?: (() => void) | undefined;
}): JSX.Element {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [preset, setPreset] = useState('earth');
  const [text, setText] = useState('');
  const [vsAi, setVsAi] = useState(false);
  // 空文字＝おまかせ（自分と違う神からランダム）
  const [aiPreset, setAiPreset] = useState('');
  const [recent, setRecent] = useState<Session[]>(() => recentSeats());

  const deck = (): DeckChoice => (text.trim() === '' ? { preset } : { text });

  return (
    <div className="entrance">
      <h1>神々の争い</h1>
      <p className="lead">部屋を作って合言葉を相手に伝えるか、もらった合言葉で入ります。</p>

      {error !== undefined ? <div className="banner error">{error}</div> : null}

      {recent.length > 0 ? (
        <section className="panel">
          <h2>さっきの席に戻る</h2>
          <div className="presets">
            {recent.map((s) => (
              <span className="recent" key={`${s.room}:${s.seat}`}>
                <button className="option" disabled={busy} onClick={() => onResume(s)}>
                  {s.room} <span className="muted">/ {s.seat}</span>
                </button>
                <button
                  className="ghost"
                  onClick={() => {
                    forgetSeat(s);
                    setRecent(recentSeats());
                  }}
                  title="この席を忘れる"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <label className="field">
        <span>あなたの名前</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="名無しの神" />
      </label>

      <section className="panel">
        <h2>部屋を作る</h2>
        <label className="field">
          <span>デッキ</span>
          <select value={preset} onChange={(e) => setPreset(e.target.value)} disabled={text.trim() !== ''}>
            {PRESETS.map((p) => (
              <option value={p.name} key={p.name}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>持ち込み（デッキ工房のテキストを貼る）</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            placeholder={'name: 私のデッキ\ngod: earth\nobjectives: …'}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={vsAi} onChange={(e) => setVsAi(e.target.checked)} />
          <span>AI と対戦する（1人で始める）</span>
        </label>
        {vsAi ? (
          <label className="field">
            <span>AI のデッキ</span>
            <select value={aiPreset} onChange={(e) => setAiPreset(e.target.value)}>
              <option value="">おまかせ（自分と違う神からランダム）</option>
              {PRESETS.filter((p) => p.name !== preset || text.trim() !== '').map((p) => (
                <option value={p.name} key={p.name}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            void send(
              () =>
                api.create(
                  name.trim() === '' ? '名無しの神' : name,
                  deck(),
                  vsAi,
                  vsAi && aiPreset !== '' ? { preset: aiPreset } : undefined,
                ),
              seatOf,
            )
          }
        >
          部屋を作る
        </button>
      </section>

      <section className="panel">
        <h2>合言葉で入る</h2>
        <label className="field">
          <span>合言葉</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABC123"
            maxLength={6}
          />
        </label>
        <button
          className="primary"
          disabled={busy || code.length < 4}
          onClick={() => void send(() => api.join(code, name.trim() === '' ? '名無しの神' : name), seatOf)}
        >
          入る
        </button>
      </section>

      {onLeave ? (
        <button className="ghost" onClick={onLeave}>
          前の部屋を忘れる
        </button>
      ) : null}
    </div>
  );
}

// ============================================================
// ロビー
// ============================================================

function Lobby({
  snap,
  session,
  busy,
  send,
}: {
  snap: RoomSnapshot;
  session: Session;
  busy: boolean;
  send: Send;
}): JSX.Element {
  const [text, setText] = useState('');
  const me = snap.seats.find((s) => s.seat === session.seat);
  const presets = snap.presets ?? [];

  return (
    <div className="lobby">
      <div className="code-card">
        <span className="muted">合言葉</span>
        <strong className="code">{snap.room}</strong>
        <button className="ghost" onClick={() => void navigator.clipboard?.writeText(snap.room)}>
          写す
        </button>
      </div>

      <div className="seats">
        {snap.seats.map((s) => (
          <div className={`seat ${s.ready ? 'ready' : ''}`} key={s.seat}>
            <strong>{s.name}</strong>
            <span className="muted">
              {s.seat}
              {s.ai ? '（AI）' : ''}
            </span>
            <span>{s.god ? `${godName(s.god)} / ${s.deckName ?? ''}` : 'デッキ未選択'}</span>
            <span className={s.ready ? 'ok' : 'muted'}>{s.ready ? '準備完了' : '準備中'}</span>
          </div>
        ))}
        {snap.seats.length < 2 ? <div className="seat empty">相手を待っています…</div> : null}
      </div>

      <section className="panel">
        <h2>デッキ</h2>
        <div className="presets">
          {presets.map((p) => (
            <button
              className={`option ${me?.deckName === p.label ? 'picked' : ''}`}
              key={p.name}
              disabled={busy}
              onClick={() => void send(() => api.deck(session, { preset: p.name }))}
            >
              {p.label}
              <span className="muted"> / {godName(p.god)}</span>
            </button>
          ))}
        </div>
        <label className="field">
          <span>持ち込み（デッキ工房のテキストを貼る）</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} />
        </label>
        <button
          disabled={busy || text.trim() === ''}
          onClick={() => void send(() => api.deck(session, { text }))}
        >
          このデッキにする
        </button>
      </section>

      <button
        className="primary big"
        disabled={busy || me?.god === undefined}
        onClick={() => void send(() => api.ready(session, !(me?.ready ?? false)))}
      >
        {me?.ready ? '準備を解く' : '準備完了'}
      </button>
    </div>
  );
}

// ============================================================

function TopBar({ snap, onLeave }: { snap: RoomSnapshot; onLeave: () => void }): JSX.Element {
  return (
    <header className="topbar">
      <span className="brand">神々の争い</span>
      <span className="muted">合言葉 {snap.room}</span>
      <span className="grow" />
      <button className="ghost" onClick={onLeave}>
        部屋を出る
      </button>
    </header>
  );
}

function Result({ snap, session }: { snap: RoomSnapshot; session: Session }): JSX.Element {
  const r = snap.result!;
  const mine = r.winner === session.seat;
  return (
    <div className={`banner result ${mine ? 'win' : r.winner === 'draw' ? 'draw' : 'lose'}`}>
      <strong>{r.winner === 'draw' ? '引き分け' : mine ? 'あなたの勝ち' : 'あなたの負け'}</strong>
      <span>
        {r.reason ?? ''} / {r.cycles} サイクル
      </span>
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
