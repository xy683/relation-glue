/**
 * What may cross into the first-meeting room, and what may not.
 *
 * The rule the product sets: a line that is friendly, curious or easy — the way two people talk when they have just
 * met — goes through untouched. A line that carries the later hurt (raking up the past, blame, interrogation, a
 * fight, sarcasm, an old grievance) does not reach the other person at all: only the sender is told, quietly, and
 * nothing is rewritten, answered or judged.
 *
 * This is a word-and-pattern reading, done here, not a model: it can be wrong at the edges, and when it is unsure it
 * lets the line through (a mistaken silence is worse than a line that should have waited).
 */

/** Each family of "later hurt", with the lines that give it away. */
const FAMILIES = [
  {
    key: 'old-grievance',
    weight: 2,
    said: ['上次', '当初', '以前', '那次', '那天', '之前你', '当年', '旧账', '还记得', '又提', '说过多少遍', '翻篇', '过不去'],
  },
  {
    key: 'blame',
    weight: 2,
    said: ['你总是', '你从来', '你就是', '都怪你', '你根本', '你每次', '你怎么又', '你凭什么', '你一点都不', '你只会', '你能不能别', '你又这样'],
  },
  {
    key: 'interrogation',
    weight: 2,
    said: ['为什么你', '凭什么', '你说啊', '你倒是', '你到底', '你是不是', '难道你', '你什么意思', '有完没完', '给我个解释'],
  },
  {
    key: 'fight',
    weight: 3,
    said: ['吵', '闭嘴', '滚', '烦不烦', '别说了', '够了', '受够', '分开', '分手', '离婚', '拉黑', '别联系', '有病'],
  },
  {
    key: 'sarcasm',
    weight: 2,
    said: ['呵呵', '行吧', '随你', '随便你', '你开心就好', '真行', '厉害呢', '可以啊你', '无语', '服了', '笑死'],
  },
  {
    key: 'old-hurt',
    weight: 2,
    said: ['矛盾', '冷战', '委屈', '伤害', '道歉', '原谅', '错误', '又犯', '旧事', '伤了', '心寒'],
  },
];

/** Warm words: they soften a line that has a hard word in it ("你总是这么可爱" is not a blame). */
const SOFT = ['喜欢', '想你', '可爱', '好看', '开心', '谢谢', '么么', '抱抱', '厉害', '晚安', '早安', '好呀', '一起'];

/** The reading: { ok: true } for a line that may cross, or { ok: false, why } with the family that held it. */
export function judge(text) {
  const said = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!said) return { ok: false, why: 'empty' };
  let score = 0;
  const hit = [];
  for (const family of FAMILIES) {
    if (family.said.some((word) => said.includes(word))) { score += family.weight; hit.push(family.key); }
  }
  /* a line with a hard word and a warm one in it is read as warm: a mistake of the kind the product prefers */
  const soft = SOFT.some((word) => said.includes(word));
  if (soft) score -= 2;
  /* "哦", "嗯" alone are not cold here, just quiet: they cross */
  if (/^[嗯哦噢好行]{1,3}[。！!？?…]*$/.test(said)) return { ok: true };
  return score >= 2 ? { ok: false, why: hit.join(',') } : { ok: true };
}

/** The lines this product never says to anyone (kept out of the code path by construction, and tested). */
export const FORBIDDEN_TONES = ['禁止', '违规', '处罚', '封号', '警告', '违规内容'];
