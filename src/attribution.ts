// 字幕「這句話是誰說的」
import type { Attribution } from './captions';
import type { IdResult } from './dsp/types';

export interface TimelineItem {
  t: number; // 判斷時間（毫秒）；這次判斷看的是 [t - 2 秒, t] 的聲音
  name: string | null; // 認出的人（分不出來時用第一名）；陌生人為 null
  stranger: boolean;
}

/**
 * 方法 1（主要）：整句的聲紋一次判斷。句子夠長時最可靠。
 * CAM++ 用專門的整句門檻；GMM 用它自己的陌生人判斷。
 */
export function fromSentence(r: IdResult, sentenceThreshold: number | null, filter: boolean): Attribution {
  if (!r.best) return { speaker: null, stranger: false, drop: false };
  const stranger = sentenceThreshold !== null ? r.best.score < sentenceThreshold : r.stranger;
  if (stranger) return { speaker: null, stranger: true, drop: filter };
  return { speaker: r.name ?? r.best.name, stranger: false, drop: false };
}

/**
 * 方法 2（備用，給很短的句子和「正在說」的即時顯示）：拿即時判斷結果投票。
 * 只算「判斷視窗的中心落在這句話裡」的結果，避免算到上一個人的尾巴。
 * 資訊太少 → 保留並標「？」，避免把自己的「好」「嗯」刪掉。
 */
export function voteFrom(timeline: TimelineItem[], start: number, end: number, filter: boolean, windowMs = 3000): Attribution {
  // 判斷視窗 [t - windowMs, t] 跟這句話有重疊的結果都算（短句子才收得到結果）
  const rs = timeline.filter((x) => x.t >= start + 300 && x.t - windowMs <= end - 300);
  const counts = new Map<string, number>();
  for (const x of rs) if (x.name) counts.set(x.name, (counts.get(x.name) ?? 0) + 1);
  const strangers = rs.filter((x) => x.stranger).length;
  const named = [...counts.values()].reduce((a, b) => a + b, 0);
  if (named > 0 && named * 2 >= strangers) {
    const speaker = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return { speaker, stranger: false, drop: false };
  }
  if (strangers >= 2) return { speaker: null, stranger: true, drop: filter };
  return { speaker: null, stranger: false, drop: false };
}
