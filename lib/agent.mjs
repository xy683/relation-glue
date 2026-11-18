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
const BOTS = 'https://ark.cn-beijing.volces.com/api/v3/bots/chat/completions';
const SESSIONS = 'https://ark.cn-beijing.volces.com/api/v3/sessions/';
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

/** Managed Agents：往会话里丢一条 user_message，然后轮询 events 等回复。 */
async function askSession(key, sessionId, text) {
  const base = SESSIONS + encodeURIComponent(sessionId) + '/events';
  const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + key };
  const post = await fetch(base, {
    method: 'POST',
    headers,
    body: JSON.stringify({ events: [{ type: 'user_message', content: [{ type: 'text', text }] }] }),
  });
  if (!post.ok) {
    const raw = await post.text();
    return { ok: false, detail: niceError(post.status, raw) };
  }
  /* 最多等 45 秒，每 2 秒看一次会话里有没有新的助手文本 */
  for (let i = 0; i < 23; i += 1) {
    await new Promise((ok) => setTimeout(ok, 2000));
    const res = await fetch(base, { headers });
    if (!res.ok) continue;
    const raw = await res.text();
    let body = null;
    try { body = JSON.parse(raw); } catch { continue; }
    const events = Array.isArray(body?.events) ? body.events : Array.isArray(body?.data) ? body.data : [];
    for (let j = events.length - 1; j >= 0; j -= 1) {
      const e = events[j];
      const role = e?.role || e?.author || e?.type;
      const parts = e?.content || e?.message?.content || [];
      const textOut = Array.isArray(parts) ? parts.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('') : String(parts || '');
      if (textOut && (role === 'assistant' || role === 'agent' || String(role).includes('assistant'))) {
        return { ok: true, text: textOut };
      }
    }
  }
  return { ok: false, detail: '会话没有在 45 秒内回话（可能还在跑，或这个会话没开）' };
}
let lastSessionError = '';
let lastModelError = '';

/** 用 Key 调一次模型：成功返回 { spec }，失败返回 { error }。 */
async function callModel(key, model, prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 95_000);
  try {
    const res = await fetch(ARK, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 700,
      }),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    if (!res.ok) return { spec: null, error: niceError(res.status, raw) };
    let body = null;
    try { body = JSON.parse(raw); } catch { return { spec: null, error: '返回不是 JSON' }; }
    const text = body?.choices?.[0]?.message?.content ?? '';
    const spec = cleanSpec(jsonIn(text));
    return spec ? { spec, error: null } : { spec: null, error: '格式不对：' + String(text).slice(0, 160) };
  } catch (e) {
    return { spec: null, error: '连不上：' + (e instanceof Error ? e.message : String(e)) };
  } finally {
    clearTimeout(timer);
  }
}


/** 把方舟的原始错误翻成一句能照做的话。 */
function niceError(status, raw) {
  const text = String(raw || '');
  if (/AccountOverdue/i.test(text)) return '账户欠费了：去火山引擎「费用中心」充值后再试';
  if (/AuthenticationError|invalid.*key/i.test(text)) return 'Key 不对：检查是不是复制全了';
  if (/InvalidEndpointOrModel|not exist or you do not have access/i.test(text)) return '这个模型没开通：去「模型广场」点开通';
  if (/InvalidParameter/i.test(text)) return '参数不对：' + text.slice(0, 120);
  if (status === 429) return '调用太频繁，等几秒再试';
  return 'HTTP ' + status + ' ' + text.slice(0, 200);
}
export async function designFilm(userKey, log, names, botId, modelOverride) {
  const key = String(userKey || '').trim() || legacyKey;
  if (!key) return { spec: null, error: '没有填 Key' };

  const id = String(botId || '').trim();
  const model = String(modelOverride || MODEL).trim() || MODEL;
  const clipped = String(log).split('\n').slice(0, 80).join('\n').slice(0, 6000);
  const prompt = [
    '下面是两个人的聊天记录。请为一段短片写分镜，只输出 JSON，不要解释：',
    '{"acts":[{"title":"2-4个字","note":"一句很轻的旁白，不超过14字"} 共五个],',
    '"palette":{"bg1":"#暗色","bg2":"#暗色","a":"#我的颜色","b":"#对方的颜色"},',
    '"music":{"root":"A|C|D|E|F|G","tempo":60-90,"mood":"quiet|warm|hopeful|melancholic"}}',
    '五个镜头顺序：初识、靠近、分享、沉默、回到初见。',
    '我：' + (names?.me || '我') + '；对方：' + (names?.partner || 'TA') + '。',
    '',
    clipped,
  ].join('\n');

  /* 1) 给了会话 ID：先走 Managed Agents */
  if (/^sess-/i.test(id)) {
    const ask = await askSession(key, id, prompt);
    if (ask.ok) {
      const spec = cleanSpec(jsonIn(ask.text));
      if (spec) return { spec, error: null };
      return { spec: null, error: '会话回了，但不是分镜格式：' + String(ask.text).slice(0, 160) };
    }
    /* 会话不通就继续用 Key 调模型，不让用户卡死 */
    lastSessionError = ask.detail;
  }

  /* 2) 用 Key 直接调模型；一个没开通就换下一个 */
  const tried = [];
  for (const m of [model, 'doubao-seed-1-6-250615', 'doubao-pro-32k-241215', 'deepseek-v3-250324']) {
    if (tried.includes(m)) continue;
    tried.push(m);
    const out = await callModel(key, m, prompt);
    if (out.spec) return { spec: out.spec, error: null, model: m };
    const msg = out.error || '';
    lastModelError = m + '：' + msg;
    if (!/404|not\s*found|not\s*activated|未开通|InvalidEndpoint|InvalidModel/i.test(msg)) break;
  }
  return { spec: null, error: (lastSessionError ? '会话：' + lastSessionError + '；' : '') + (lastModelError || '调用失败') };
}
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

/** 一次很轻的连通性测试：发一句话，看 Key（+ 会话）能不能通，并把原始错误带回来。 */
export async function testAgent(userKey, botId, modelOverride) {
  const key = String(userKey || '').trim();
  if (!key) return { ok: false, detail: '没有填 Key' };
  const id = String(botId || '').trim();
  const notes = [];
  if (/^sess-/i.test(id)) {
    const ask = await askSession(key, id, '只回两个字：在的');
    if (ask.ok) return { ok: true, detail: '会话通了：' + String(ask.text).slice(0, 60) };
    notes.push('会话：' + ask.detail);
  }
  const models = [String(modelOverride || '').trim(), MODEL, 'doubao-seed-1-6-250615', 'doubao-pro-32k-241215']
    .filter(Boolean)
    .filter((m, i, all) => all.indexOf(m) === i);
  for (const m of models) {
    const out = await callModel(key, m, '只回两个字：在的');
    if (out.error && out.error.indexOf('格式不对') === 0) return { ok: true, detail: m + ' 通了（Key 有效）' };
    notes.push(m + '：' + (out.error || '未知'));
    if (out.error && /401|403|Authentication/i.test(out.error)) break;
    if (out.error && !/404|not\s*found|not\s*activated|未开通|InvalidModel|InvalidEndpoint/i.test(out.error)) break;
  }
  return { ok: false, detail: notes.join(' / ') };
}