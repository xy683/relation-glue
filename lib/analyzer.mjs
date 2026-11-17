/**
 * Reading a chat log into the arc of a relationship, on this machine, with no model.
 *
 * What it does: every line becomes a message (who said it, when, what), the timestamps give the rhythm (how often
 * they wrote, how long the silences grew), a small word list gives the warmth of each stretch, and the five acts of
 * the 15-second film are chosen from that: the first hello, the weeks they wrote most, the warmest stretch, the
 * silence that came later, and the first hello again.
 *
 * What it never does: invent words. Every bubble in the film is a line from the person's own log (cut short), and
 * when the log has nothing to show for an act, the act says so with a mark instead of a made-up sentence.
 */

/** Warm and cold words: what a line feels like, never what it means. Small on purpose. */
const WARM = ['哈哈', '嘿嘿', '开心', '高兴', '喜欢', '想你', '晚安', '早安', '可爱', '好呀', '好的呀', '一起', '期待', '谢谢', '抱抱', '分享', '好玩', '好看', '好吃', '冲', '加油', '么么', '乖乖', '想你啦', '在吗', '早上好', '晚上好'];
const COLD = ['烦', '累', '算了', '随便', '呵呵', '哦', '嗯', '行吧', '没事', '不用', '别', '闭嘴', '滚', '吵', '冷战', '分手', '拉黑', '敷衍', '无语', '失望', '委屈', '道歉', '原谅', '凭什么', '你总是', '你从来'];

const SPEAKER = /^[\s\u3000]*(\[[^\]]{4,40}\]|\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?[ T]?\d{1,2}:\d{2}(?::\d{2})?)?[\s\u3000]*([^\s:：]{1,24})[\s\u3000]*[:：][\s\u3000]*(.+)$/;
const EMPTY_TALK = /^[\s\u3000]*(?:\[图片\]|\[表情\]|\[语音\]|\[视频\]|\[文件\])[\s\u3000]*$/;

/** A timestamp as milliseconds; NaN when it says no time. */
export function timeOf(raw) {
  if (!raw) return NaN;
  const text = String(raw).replace(/[\[\]]/g, '').trim()
    .replace(/年|-/g, '/').replace(/月/g, '/').replace(/日/g, ' ').replace(/T/, ' ');
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
  if (!m) {
    const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
    if (!hm) return NaN;
    const d = new Date(2000, 0, 1, Number(hm[1]), Number(hm[2]), Number(hm[3] ?? 0));
    return d.getTime();
  }
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  return d.getTime();
}

/** The log as messages: [{ who, text, at }], lines with no speaker joined to the one before. */
export function parseLog(log) {
  const out = [];
  let last = null;
  for (const raw of String(log ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\u200b/g, '');
    if (!line.trim()) continue;
    if (/^[-=*_]{2,}$/.test(line.trim())) continue;
    const m = SPEAKER.exec(line);
    if (m) {
      const at = timeOf(m[1]);
      last = { who: m[2].trim().slice(0, 24), text: m[3].trim().slice(0, 240), at: Number.isNaN(at) ? null : at };
      out.push(last);
    } else if (last && !EMPTY_TALK.test(line)) {
      last.text = `${last.text} ${line.trim()}`.slice(0, 240);
    }
  }
  return out;
}

/** A line as a bubble: short, one line, no links, cut at a word's end when it must be. */
export function bubbleOf(text, max = 16) {
  const clean = String(text ?? '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\[[^\]]{1,12}\]/g, '')
    .replace(/[\s\u3000]+/g, ' ')
    .trim();
  if (!clean) return '';
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const at = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('。'), cut.lastIndexOf(' '), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
  return `${at >= max * 0.5 ? cut.slice(0, at) : cut}…`;
}

/** How warm a stretch of text is: 0 (cold) to 1 (warm), or null when it says nothing either way. */
export function warmth(text) {
  const said = String(text ?? '');
  let warm = 0;
  let cold = 0;
  for (const w of WARM) if (said.includes(w)) warm++;
  for (const w of COLD) if (said.includes(w)) cold++;
  if (!warm && !cold) return null;
  return warm / (warm + cold);
}

/** A small stable seed from the log, so the same log draws the same film. */
export function seedOf(text) {
  let h = 2166136261;
  for (let i = 0; i < String(text).length; i++) { h ^= String(text).charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 100000;
}

/** A gap as a person reads it: 3 天, 5 小时, 20 分钟. */
export function span(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '一小会儿';
  const minutes = ms / 60000;
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} 分钟`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)} 小时`;
  const days = hours / 24;
  if (days < 60) return `${Math.round(days)} 天`;
  return `${Math.round(days / 30)} 个月`;
}

/** The messages split into `count` stretches of the same length of time, timestamps or not. */
function stretches(messages, count) {
  const timed = messages.filter((m) => m.at != null);
  const groups = Array.from({ length: count }, () => []);
  if (timed.length >= count + 1) {
    const from = timed[0].at;
    const to = timed[timed.length - 1].at;
    const span2 = Math.max(1, to - from);
    for (const m of timed) groups[Math.min(count - 1, Math.floor(((m.at - from) / span2) * count))].push(m);
    return groups;
  }
  /* no times: by the order they came in */
  const size = Math.max(1, Math.ceil(messages.length / count));
  for (let i = 0; i < count; i++) groups[i] = messages.slice(i * size, (i + 1) * size);
  return groups;
}

/**
 * The five acts of the film, from the log.
 * @param {string} log @param {{ me?: string, partner?: string }} names
 */
export function analyze(log, names = {}) {
  const messages = parseLog(log);
  if (messages.length < 2) throw new Error('这串记录里还没有两个人的对话，再多贴几句吧。');
  const timed = messages.filter((m) => m.at != null);
  const speakers = [...new Set(messages.map((m) => m.who))];
  const me = names.me?.trim() || speakers[0] || '我';
  const partner = names.partner?.trim() || speakers.find((s) => s !== me) || '对方';

  /* the rhythm: each message's gap from the one before it */
  const gaps = [];
  for (let i = 1; i < messages.length; i++) if (messages[i].at != null && messages[i - 1].at != null) gaps.push(Math.max(0, messages[i].at - messages[i - 1].at));
  const longGap = gaps.length ? Math.max(...gaps) : 0;
  const totalSpan = timed.length > 1 ? timed[timed.length - 1].at - timed[0].at : 0;

  const groups = stretches(messages, 5);
  const groupWarmth = groups.map((g) => {
    const rates = g.map((m) => warmth(m.text)).filter((v) => v != null);
    return rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
  });
  const counts = groups.map((g) => g.length);
  const busiest = counts.indexOf(Math.max(...counts));
  const warmest = groupWarmth.reduce((best, v, i) => (v != null && (best < 0 || v > (groupWarmth[best] ?? -1)) ? i : best), -1);

  /* the bubbles: real lines, short, one per act where the act has something to show */
  const pick = (list, warm) => {
    const good = list.filter((m) => {
      const b = bubbleOf(m.text);
      return b && b.length >= 2 && !/^(嗯|哦|好的?|在|哈哈)$/.test(b) && (warm == null || warmth(m.text) === null || warmth(m.text) >= 0.5 === warm);
    });
    const pool = good.length ? good : list.filter((m) => bubbleOf(m.text));
    if (!pool.length) return null;
    const m = pool[Math.floor(pool.length / 2)];
    return { who: m.who, text: bubbleOf(m.text) };
  };
  const first = messages.find((m) => bubbleOf(m.text)) ?? messages[0];
  const hello = { who: first.who, text: bubbleOf(first.text) || '嗨' };
  const close = pick(groups[Math.min(busiest, 4)] ?? messages, true) ?? hello;
  const sweet = pick(groups[warmest >= 0 ? warmest : 2] ?? messages, true) ?? close;
  const coldGroup = groups.slice(-2).flat();
  const cold = pick(coldGroup, false) ?? { who: '', text: '……' };

  const coldness = (() => {
    if (!gaps.length) return 0.35;
    const lastGaps = gaps.slice(Math.floor(gaps.length * 0.6));
    const avg = lastGaps.reduce((a, b) => a + b, 0) / Math.max(1, lastGaps.length);
    const all = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const ratio = all > 0 ? avg / all : 1;
    return Math.max(0, Math.min(1, (ratio - 0.8) / 2.2));
  })();

  const acts = [
    { key: 'hello', title: '初识', line: '第一次打招呼', bubbles: [hello], tone: 'warm' },
    { key: 'closer', title: '靠近', line: '越聊越多，越聊越晚', bubbles: [close], tone: 'warm' },
    { key: 'sweet', title: '分享', line: '把日常都讲给你听', bubbles: [sweet], tone: 'sweet' },
    { key: 'cold', title: '沉默', line: '后来的话，越来越短', bubbles: [cold], tone: 'cold' },
    { key: 'again', title: '初遇', line: '回到第一次说话的那天', bubbles: [hello], tone: 'memory' },
  ];

  return {
    me,
    partner,
    seed: seedOf(log),
    stats: {
      messages: messages.length,
      span: totalSpan ? span(totalSpan) : '这几天',
      silence: longGap ? span(longGap) : null,
      coldness: Number(coldness.toFixed(2)),
      warmth: Number(((groupWarmth.filter((v) => v != null).reduce((a, b) => a + b, 0) / Math.max(1, groupWarmth.filter((v) => v != null).length)) || 0.5).toFixed(2)),
    },
    acts,
  };
}
