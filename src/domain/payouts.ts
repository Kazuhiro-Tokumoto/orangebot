/**
 * 賭けの払い戻しの計算。DB に依存しない純粋関数。
 *
 * どの方式も胴元は取らない。払い戻しの合計は預かった賭け金の合計にちょうど一致し、
 * どの賭けも払い戻しがマイナスにはならない。
 */

export interface Stake {
  readonly id: string;
  /** SOAG。0 より大きい。 */
  readonly stake: bigint;
}

function refundAll(stakes: readonly Stake[]): Map<string, bigint> {
  return new Map(stakes.map((entry) => [entry.id, entry.stake]));
}

/**
 * パリミュチュエル。負けた賭けの合計を、勝った賭けで賭け金に比例して分ける。
 *
 * 勝ちが 1 つも無いか、全部が勝ちなら、分ける相手がいないので全員に返す。
 * 切り捨てで余った端数は、並びでいちばん前の勝ちに足す。
 */
export function splitPool(
  stakes: readonly Stake[],
  winners: ReadonlySet<string>,
): Map<string, bigint> {
  const total = stakes.reduce((sum, entry) => sum + entry.stake, 0n);
  const winPool = stakes.reduce((sum, entry) => sum + (winners.has(entry.id) ? entry.stake : 0n), 0n);
  const losePool = total - winPool;
  if (winPool === 0n || losePool === 0n) return refundAll(stakes);

  const payouts = new Map<string, bigint>();
  let paid = 0n;
  let first: string | undefined;
  for (const entry of stakes) {
    if (!winners.has(entry.id)) {
      payouts.set(entry.id, 0n);
      continue;
    }
    const amount = entry.stake + (losePool * entry.stake) / winPool;
    payouts.set(entry.id, amount);
    paid += amount;
    first ??= entry.id;
  }
  if (first !== undefined) payouts.set(first, (payouts.get(first) ?? 0n) + (total - paid));
  return payouts;
}

/**
 * いちばん近い予想の総取り。ただし取れる額は自分の賭け金で頭打ちにする。
 *
 * 負けた人は、勝った人たちの賭け金の合計を上限に、自分の賭け金を差し出す。
 * それを勝った人たちで賭け金に比例して分ける。したがって勝った人が 1 人の負けから
 * 受け取るのは、多くても自分の賭け金と同じ額まで。
 *
 * 頭打ちにしないと、最低額だけ賭けて大きな賭けを総取りする遊び方が得になってしまう。
 * 差し出しきらなかった分と、切り捨ての端数は、負けた人の手元に残る。
 *
 * 1 人しかいないか、全員が同じだけ近ければ、全員に返す。
 */
export function closestTakesAll(
  entries: readonly (Stake & { readonly error: bigint })[],
): Map<string, bigint> {
  if (entries.length < 2) return refundAll(entries);

  const best = entries.reduce((min, entry) => (entry.error < min ? entry.error : min), entries[0]?.error ?? 0n);
  const winners = entries.filter((entry) => entry.error === best);
  if (winners.length === entries.length) return refundAll(entries);

  const winnerStake = winners.reduce((sum, entry) => sum + entry.stake, 0n);
  const payouts = refundAll(entries);
  for (const loser of entries) {
    if (loser.error === best) continue;
    const offered = loser.stake < winnerStake ? loser.stake : winnerStake;
    let given = 0n;
    for (const winner of winners) {
      const share = (offered * winner.stake) / winnerStake;
      payouts.set(winner.id, (payouts.get(winner.id) ?? 0n) + share);
      given += share;
    }
    payouts.set(loser.id, (payouts.get(loser.id) ?? 0n) - given);
  }
  return payouts;
}
