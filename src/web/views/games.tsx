import type { Child } from 'hono/jsx';

/** 予想の画面どうしを行き来するタブ。 */
const TABS = [
  { key: 'updown', href: '/predict', label: '上がる下がる (5 分)' },
  { key: 'closest', href: '/predict/closest', label: '終値予想 (1 時間)' },
  { key: 'ranking', href: '/predict/ranking', label: '順位予想 (1 時間)' },
  { key: 'volatility', href: '/predict/volatility', label: '値幅予想 (1 時間)' },
  { key: 'markets', href: '/predict/markets', label: 'みんなで予想' },
] as const;

export type GameTab = (typeof TABS)[number]['key'];

export function GameTabs({ current }: { current: GameTab }) {
  return (
    <p class="row" style="margin:0 0 18px">
      {TABS.map((tab) => (
        <a class={`tag ${tab.key === current ? 'accent' : ''}`} href={tab.href}>
          {tab.label}
        </a>
      ))}
    </p>
  );
}

const TIME_ZONE = 'Asia/Tokyo';

/** 時刻。日本時間で出す。 */
export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString('ja-JP', { hour12: false, timeZone: TIME_ZONE });
}

/** 日付つきの時刻。日本時間で出す。 */
export function dateTime(ms: number): string {
  return new Date(ms).toLocaleString('ja-JP', {
    hour12: false,
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * 締め切りまでの秒を数える。画面を開いたままでも締め切りが分かるように。
 * id="countdown" の data-deadline (ミリ秒) を読む。
 */
export const COUNTDOWN_SCRIPT = `
(function () {
  var el = document.getElementById('countdown');
  if (!el) return;
  var deadline = Number(el.getAttribute('data-deadline'));
  function tick() {
    var left = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
    var text = left >= 60
      ? 'あと ' + Math.floor(left / 60) + ' 分 ' + (left % 60) + ' 秒で締め切り'
      : 'あと ' + left + ' 秒で締め切り';
    el.textContent = left > 0 ? text : '締め切りました。読み込み直してください';
    if (left > 0) setTimeout(tick, 1000);
  }
  tick();
})();
`;

/** 当たったら 1 BOAG がいくらになるか。小数 2 桁。分ける相手がいなければ undefined。 */
export function multiplier(win: bigint, total: bigint): string | undefined {
  if (win === 0n || win === total) return undefined;
  const hundredths = (total * 100n) / win;
  return `${(hundredths / 100n).toString()}.${(hundredths % 100n).toString().padStart(2, '0')}`;
}

export function Rules({ children }: { children: Child }) {
  return (
    <>
      <h2>決まり</h2>
      <section class="panel">
        <ul class="field-hint" style="margin:0;padding-left:20px">
          {children}
        </ul>
      </section>
    </>
  );
}
