/**
 * 豆包智能体：把一段聊天记录交给豆包，请它当导演，给出这支短片的「分镜表」——
 * 五个镜头的标题与旁白、一套颜色、一段音乐的性格。画面和声音仍然由本地的 canvas / Web Audio 画出来、奏出来，
 * 豆包改的是「怎么讲故事」，不负责渲染。
 *
 * Key 是使用者自己的：每次请求从浏览器带上来，用完就丢，不写盘、不进日志。
 * 没填 Key 或网络不通时，用本地的一套规则生成同样结构的分镜表（标注 false），不假装是模型给的。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ARK = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
export const MODEL = process.env.DOUBAO_MODEL || 'doubao-seed-2-1-pro-260915';

/** 使用者自己的 Key，只在这台机器的一次请求里用；不落盘。 */
const KEY_FILE = join(process.cwd(), '.agent-key.json');

const SYSTEM_PROMPT = [
  '你是专业的情侣情感短片导演，核心要求：快速出片，3 分钟内必须完成。',
  '规则：',
  '1. 时长 15 秒到 3 分钟，按聊天记录的信息密度自动调节；',
  '2. 配乐走《我好想你》、梁静茹、薛之谦、《心做し》这类爱情/伤感的气质；没有原曲时用钢琴铺底；',
  '3. 节奏要慢，推拉和淡入淡出，关键对话做成情感字幕，不要复杂特效；',
  '4. 拿到素材直接开工，不反复确认，只给结果；',
  '5. 抓住初见心动、打情骂俏、思念这些情绪点，不评判他们的关系。',
].join('\n');

/* 兼容旧版本：如果服务器上留过一份 Key（本机自用），仍然可用；但页面永远优先用浏览器里的 Key。 */
let legacyKey = String(process.env.DOUBAO_KEY || '').trim();
if (!legacyKey && existsSync(KEY_FILE)) {
  try { legacyKey = String(JSON.parse(readFileSync(KEY_FILE, 'utf8')).key || '').trim(); } catch { /* 忽略坏文件 */ }
}

export const hasLegacyKey = () => Boolean(legacyKey);
export function saveKey(next) {
  legacyKey = String(next || '').trim();
  try {
    if (legacyKey) writeFileSync(KEY_FILE, JSON.stringify({ key: legacyKey }), { mode: 0o600 });
    else if (existsSync(KEY_FILE)) writeFileSync(KEY_FILE, '{}');
  } catch { /* 写不了就只在内存里 */ }
}

const HEX = /^#[0-9a-f]{6}$/i;
const okColor = (c, fallback) => (typeof c === 'string' && HEX.test(c) ? c : fallback);

/** 只留豆包能给的那几样，别的字段一律不认。 */
export function cleanSpec(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const acts = Array.isArray(raw.acts) ? raw.acts.slice(0, 5) : [];
  if (acts.length < 5) return null;
  const cleaned = acts.map((a, i) => ({
    title: String(a?.title ?? '').replace(/[<>]/g, '').slice(0, 6) || ['初识', '靠近', '分享', '沉默', '重逢'][i],
    note: String(a?.note ?? '').replace(/[<>]/g, '').slice(0, 18),
  }));
  const p = raw.palette || {};
  const palette = {
    bg1: okColor(p.bg1, '#1a1226'), bg2: okColor(p.bg2, '#3a1b30'),
    a: okColor(p.a, '#ff8f6b'), b: okColor(p.b, '#ffd7a4'),
  };
  const m = raw.music || {};
  const mood = ['quiet', 'warm', 'hopeful', 'melancholic'].includes(m.mood) ? m.mood : 'warm';
  const tempo = Math.min(96, Math.max(54, Number(m.tempo) || 72));
  const roots = ['A', 'C', 'D', 'E', 'F', 'G'];
  const root = roots.includes(String(m.root).toUpperCase()) ? String(m.root).toUpperCase() : 'A';
  return { acts: cleaned, palette, music: { root, tempo, mood } };
}

function jsonIn(text) {
  const s = String(text || '');
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const body = fence ? fence[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

/** 请豆包当一次导演；失败返回 null，由调用方退回本地分镜。 */
export async function designFilm(userKey, log, names) {
  const key = String(userKey || '').trim() || legacyKey;
  if (!key) return null;
  const clipped = String(log).split('\n').slice(0, 80).join('\n').slice(0, 6000);
  const prompt = [
    '下面是一段两个人的聊天记录（真实发生过的话）。',
    '我：' + (names?.me || '我') + '；对方：' + (names?.partner || 'TA') + '。',
    '请为一段短片写分镜，只输出 JSON，不要任何解释：',
    '{"acts":[{"title":"2-4个字","note":"一句很轻的旁白，不超过14字"} 共五个],',
    '"palette":{"bg1":"#暗色","bg2":"#暗色","a":"#我的颜色","b":"#对方的颜色"},',
    '"music":{"root":"A|C|D|E|F|G","tempo":60-90,"mood":"quiet|warm|hopeful|melancholic"}}',
    '五个镜头的顺序固定：初识、靠近、分享、冷淡或沉默、回到初见。',
    '旁白要克制、具体、像人话，不要口号，不要“治愈”“灵魂”“双向奔赴”这类词。',
    '颜色要暗、电影感，a 与 b 要能区分但不刺眼。音乐要贴这段对话的情绪。',
    '',
    '聊天记录：',
    clipped,
  ].join('\n');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(ARK, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 700,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content ?? '';
    return cleanSpec(jsonIn(text));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 没 Key 时的本地分镜：不冒充模型，但保证短片仍然有标题、旁白、颜色和音乐。 */
export function localDesign(seed, stats) {
  const warm = Number(stats?.warmth ?? 0.5);
  const spanDays = Number(stats?.days ?? 0);
  const templates = warm > 0.62
    ? [
      ['初识', '第一句话，总是很轻'],
      ['靠近', '消息开始密起来'],
      ['分享', '把一整天都讲给对方听'],
      ['沉默', '有些话停在了对话框'],
      ['重逢', '回到第一次说话的那天'],
    ]
    : [
      ['初识', '那天只是随口一句'],
      ['靠近', '后来就习惯了等消息'],
      ['分享', '连路边的小事也想说'],
      ['冷却', '回复越来越慢'],
      ['回望', '还是记得第一句'],
    ];
  const palette = warm > 0.62
    ? { bg1: '#1a1226', bg2: '#3a1b30', a: '#ff8f6b', b: '#ffd7a4' }
    : { bg1: '#13131a', bg2: '#22222c', a: '#a89aa0', b: '#9fb3bb' };
  return {
    acts: templates.map(([title, note]) => ({ title, note })),
    palette,
    music: { root: warm > 0.62 ? 'C' : 'A', tempo: spanDays > 30 ? 66 : 76, mood: warm > 0.62 ? 'warm' : 'melancholic' },
  };
}
