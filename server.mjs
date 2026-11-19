/**
 * 关系复原胶 · the whole service, one file: the pages, the rooms, and the two people in a room kept in step.
 *
 * A room is made from one chat log: the log is read here (lib/analyzer.mjs) into the five acts of a 15-second film,
 * and never leaves this process. Two people join by the room's link; the film starts once both are in; both are asked
 * whether to go on; the chat that follows is 20 minutes long, and a line that carries the later hurt never reaches
 * the other person (lib/filter.mjs). When the 20 minutes end, the words are gone with the room's lights.
 *
 * No install, no account, no database: a room lives in this process (two hours at most), so the link works while the
 * service runs, on a phone or on a computer, on the same network.
 */
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { networkInterfaces, tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from './lib/analyzer.mjs';
import { judge } from './lib/filter.mjs';
import { logFromOcr } from './lib/ocr.mjs';
import { decode, detect } from './lib/importers.mjs';
import { designFilm, hasLegacyKey, localDesign, saveKey, testAgent, MODEL } from './lib/agent.mjs';
import { renderFilm, wav } from './lib/render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
const PORT = Number(process.env.PORT || 5178);
const FILM_MS = Number(process.env.GLUE_FILM_MS || 15_000);
const CHAT_MS = Number(process.env.GLUE_CHAT_MS || 20 * 60_000);
const ROOM_TTL = 2 * 60 * 60_000;
const LEAD_MS = 1500;

/** @typedef {{ id: string, hostToken: string, createdAt: number, names: { me: string, partner: string }, story: any, status: 'waiting'|'ready'|'film'|'confirm'|'declined'|'chat'|'ended', joined: { host: boolean, guest: boolean }, confirm: { host: boolean|null, guest: boolean|null }, filmStart: number|null, readyDeadline?: number, chatEnd: number|null, messages: Array<{ id: string, from: 'host'|'guest', name: string, text: string, at: number }>, sse: Set<any>, timers: NodeJS.Timeout[] }} Room */

/** Every room, by its link's id. */
/* ── 聊天记录 → 回忆脚本 ───────────────────────────────── */

const CONFLICT_RE = /(分手|分开|吵架|冷战|拉黑|删了|不理|生气|失望|算了|随便你|别联系|再见|累了|冷静)/;
const SWEET_RE = /(想你|抱抱|喜欢|爱你|晚安|早安|开心|么么|宝贝|陪你|等你)/;

function parseChatLines(log) {
  return String(log || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})?\s*(\d{1,2}:\d{2})?\s*([^：:]{1,16})[：:]\s*(.*)$/);
      if (m) return { date: m[1] || '', time: m[2] || '', who: m[3].trim(), text: m[4].trim() };
      return { date: '', time: '', who: '', text: line };
    });
}

function sceneOf(hour) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return '夜里';
  if (h >= 5 && h < 9) return '清晨';
  if (h >= 9 && h < 12) return '上午';
  if (h >= 12 && h < 17) return '午后';
  if (h >= 17 && h < 22) return '傍晚';
  return '深夜';
}

/** 从聊天记录里整理出一条 6 段 × 10 秒的回忆脚本。 */
function buildScript(log, me, partner, segCount = 3) {
  const lines = parseChatLines(log);
  const who1 = me || '我';
  const who2 = partner || 'TA';
  const text = lines.map((l) => l.text).join('\n');
  const conflicts = (text.match(new RegExp(CONFLICT_RE.source, 'g')) || []).length;
  const sweets = (text.match(new RegExp(SWEET_RE.source, 'g')) || []).length;
  const arc = conflicts >= 2 && conflicts >= sweets ? 'break' : 'warm';
  const dates = lines.map((l) => l.date).filter(Boolean);
  const firstDate = dates[0] || '';
  const lastDate = dates[dates.length - 1] || '';
  const per = Math.max(1, Math.ceil(lines.length / segCount));
  const shots = ['缓慢推近', '轻轻横移', '停住不动', '慢慢拉远', '贴近细节', '缓缓升起'];
  const segments = [];
  for (let i = 0; i < segCount; i += 1) {
    const chunk = lines.slice(i * per, (i + 1) * per);
    if (!chunk.length) break;
    const chunkText = chunk.map((l) => l.text).join(' ');
    const sad = CONFLICT_RE.test(chunkText);
    const mood = sad ? '沉默、克制' : '温柔、靠近';
    const hour = (chunk[0].time || '').split(':')[0];
    const line = chunk.find((l) => l.text.length >= 4 && l.text.length <= 22) || chunk[0];
    segments.push({
      index: i + 1,
      time: [chunk[0].date, chunk[0].time].filter(Boolean).join(' ') || ('第 ' + (i + 1) + ' 段'),
      scene: sceneOf(hour) + (sad ? '，两个人各自看着屏幕' : '，两个小人靠在一起'),
      shot: shots[i % shots.length],
      subtitle: line.text.slice(0, 22),
      emotion: mood,
      who: line.who || '',
      excerpt: chunk.slice(0, 2).map((l) => (l.who ? l.who + '：' : '') + l.text).join(' / ').slice(0, 60),
    });
  }
  return {
    title: '从「' + (lines[0]?.text || '在吗').slice(0, 12) + '」开始的回忆',
    characters: who1 + ' 与 ' + who2,
    theme: arc === 'break' ? '从满怀期待，到慢慢走散' : '那些以为会一直继续的日子',
    mood: arc === 'break' ? '温柔里带一点遗憾' : '温柔、治愈、回忆感',
    arc,
    span: firstDate && lastDate ? firstDate + ' — ' + lastDate : '',
    messages: lines.length,
    conflicts,
    sweets,
    segments,
  };
}

/** 用户自己写的小故事 → 3 段脚本（不再解析聊天记录）。 */
function buildScriptFromStory(text, me, partner) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  let parts = clean.split(/(?<=[。！？!?；;\n])/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 6) {
    const more = [];
    parts.forEach((p) => {
      const bits = p.split(/(?<=[，,、])/).map((s) => s.trim()).filter(Boolean);
      if (bits.length > 1) more.push(...bits); else more.push(p);
    });
    parts = more;
  }
  while (parts.length < 3) {
    let idx = 0;
    parts.forEach((p, i) => { if (p.length > parts[idx].length) idx = i; });
    const p = parts[idx];
    const half = Math.ceil(p.length / 2);
    parts.splice(idx, 1, p.slice(0, half), p.slice(half));
  }
  const segCount = 3;
  const shots = ['缓慢推近', '轻轻横移', '慢慢拉远', '贴近细节', '缓缓升起', '停住不动'];
  const conflict = /(分开|分手|吵架|冷战|离开|走散|误会|闹掰|不理|失望)/;
  const sweet = /(遇见|第一次|一起|温柔|开心|喜欢|爱|照顾|等我|陪伴|旅行|海|风)/;
  const segments = [];
  for (let i = 0; i < segCount; i += 1) {
    const start = Math.floor((i * parts.length) / segCount);
    const end = Math.floor(((i + 1) * parts.length) / segCount);
    const chunk = parts.slice(start, Math.max(start + 1, end));
    if (!chunk.length) break;
    const chunkText = chunk.join('');
    const sad = conflict.test(chunkText);
    segments.push({
      index: i + 1,
      time: '第 ' + (i + 1) + ' 段',
      scene: sad ? '夜里，两个人各自站着，风吹动衣角' : (i === 0 ? '初次见面的地方，光很软' : '两个人并肩走在有光的地方'),
      shot: shots[i % shots.length],
      subtitle: chunk[0].slice(0, 34),
      emotion: sad ? '克制、遗憾' : '温柔、明亮',
      who: '',
      excerpt: chunkText.slice(0, 60),
    });
  }
  return {
    title: '你们的小故事',
    characters: (me || '你') + ' 与 ' + (partner || 'TA'),
    theme: conflict.test(clean) ? '从相遇到慢慢走散' : '那些被记下来的小事',
    mood: conflict.test(clean) ? '温柔里带一点遗憾' : '温柔、治愈、回忆感',
    arc: conflict.test(clean) ? 'break' : 'warm',
    span: '',
    messages: parts.length,
    conflicts: (clean.match(new RegExp(conflict.source, 'g')) || []).length,
    sweets: (clean.match(new RegExp(sweet.source, 'g')) || []).length,
    segments,
  };
}
const filmJobs = new Map();
/* 站长的 Key：优先读 /opt/glue/owner-key.txt，其次环境变量。只留在服务器，绝不下发到浏览器。 */
const OWNER_KEY = (() => {
  try {
    const fromFile = readFileSync(join(HERE, 'owner-key.txt'), 'utf8').trim();
    if (fromFile) return fromFile;
  } catch { /* 没有文件就继续 */ }
  return String(process.env.ARK_API_KEY || '').trim();
})();

/* ── 先收钱，再生成 ─────────────────────────────────────
 * 一次成片 29.9 元（3 段 ×10 秒，480P）。顾客点「是」才建订单；
 * 站长在 /owner 页面确认到账之后，服务器才用 OWNER_KEY 调模型。
 * 管理口令不写进代码：由 owner-key.txt 派生，或环境变量 GLUE_ADMIN_KEY 指定。 */
const ORDER_PRICE = 29.9;
const orders = new Map();
const ADMIN_KEY = (() => {
  const fromEnv = String(process.env.GLUE_ADMIN_KEY || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const fromFile = readFileSync(join(HERE, 'admin-key.txt'), 'utf8').trim();
    if (fromFile) return fromFile;
  } catch { /* 没有就派生 */ }
  if (OWNER_KEY) return createHash('sha256').update('glue-admin-v1:' + OWNER_KEY).digest('hex').slice(0, 24);
  return '';
})();
const adminOk = (url) => {
  const given = String(url.searchParams.get('key') || '');
  if (!ADMIN_KEY || given.length !== ADMIN_KEY.length) return false;
  return createHash('sha256').update(given).digest('hex') === createHash('sha256').update(ADMIN_KEY).digest('hex');
};

/* 自动放行的回调口令：收款服务把「到账」回调到这个地址，服务器核对金额后自动生成。
 * 个人静态收款码没有回调，必须接一个有回调的收款服务（商户号或免签服务）。 */
const PAY_TOKEN = (() => {
  const fromEnv = String(process.env.GLUE_PAY_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const f = readFileSync(join(HERE, 'pay-token.txt'), 'utf8').trim();
    if (f) return f;
  } catch { /* 没有就派生 */ }
  if (OWNER_KEY) return createHash('sha256').update('glue-pay-v1:' + OWNER_KEY).digest('hex').slice(0, 24);
  return '';
})();
const sameSecret = (a, b) => Boolean(a) && Boolean(b) && a.length === b.length
  && createHash('sha256').update(a).digest('hex') === createHash('sha256').update(b).digest('hex');

/* 支付FM（个人可进件拉卡拉/杉德聚合收银台，官方回调，不用挂机）
 * zhifufm.txt：第1行接口根地址，第2行商户号，第3行接入密钥，第4行 payType（可空，默认 lkl-cashier） */
const ZHIFU = (() => {
  const api = String(process.env.ZHIFU_API || '').trim();
  const merchant = String(process.env.ZHIFU_MERCHANT || '').trim();
  const secret = String(process.env.ZHIFU_SECRET || '').trim();
  const payType = String(process.env.ZHIFU_PAYTYPE || 'lkl-cashier').trim();
  if (api && merchant && secret) return { api, merchant, secret, payType };
  try {
    const lines = readFileSync(join(HERE, 'zhifufm.txt'), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines.length >= 3) return { api: lines[0], merchant: lines[1], secret: lines[2], payType: lines[3] || 'lkl-cashier' };
  } catch { /* 没配 */ }
  return null;
})();
async function createZhifuPayment(room, payType) {
  const o = room.order;
  const amount = o.amount.toFixed(2);
  const notifyUrl = BASE_URL + '/api/pay/zhifufm';
  const sign = createHash('md5').update(ZHIFU.merchant + o.id + amount + notifyUrl + ZHIFU.secret).digest('hex');
  const q = new URLSearchParams({
    merchantNum: ZHIFU.merchant,
    orderNo: o.id,
    amount,
    notifyUrl,
    returnUrl: BASE_URL + '/r/' + room.id,
    payType: payType || ZHIFU.payType,
    subject: '关系复原胶 三十秒动漫小故事',
    returnType: 'json',
    sign,
  });
  const r = await fetch(ZHIFU.api.replace(/\/+$/, '') + '/startOrder?' + q.toString(), { method: 'POST' });
  const j = await r.json().catch(() => ({}));
  if (!j || j.success !== true) throw new Error(String(j.msg || '支付FM下单失败'));
  return { url: String((j.data && j.data.payUrl) || '') };
}

/* 虎皮椒（个人聚合支付，不用执照、不用挂机）：appid + 密钥 配好就等于接了支付宝/微信 */
const XUNHU = (() => {
  const appid = String(process.env.XUNHU_APPID || '').trim();
  const secret = String(process.env.XUNHU_APPSECRET || '').trim();
  if (appid && secret) return { appid, secret };
  try {
    const lines = readFileSync(join(HERE, 'xunhu.txt'), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines.length >= 2) return { appid: lines[0], secret: lines[1] };
  } catch { /* 没配 */ }
  return null;
})();
function xunhuHash(params, secret) {
  const keys = Object.keys(params)
    .filter((k) => k !== 'hash' && params[k] !== null && params[k] !== undefined && String(params[k]) !== '')
    .sort();
  return createHash('md5').update(keys.map((k) => k + '=' + params[k]).join('&') + secret).digest('hex');
}
async function createXunhuPayment(room) {
  const o = room.order;
  const params = {
    version: '1.1',
    appid: XUNHU.appid,
    trade_order_id: o.id,
    total_fee: o.amount.toFixed(2),
    title: '关系复原胶 三十秒动漫小故事',
    time: Math.floor(Date.now() / 1000),
    notify_url: BASE_URL + '/api/pay/xunhu',
    return_url: BASE_URL + '/r/' + room.id,
    nonce_str: randomBytes(8).toString('hex'),
    plugins: 'glue',
    attach: room.id,
  };
  params.hash = xunhuHash(params, XUNHU.secret);
  const r = await fetch('https://api.xunhupay.com/payment/do.html', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const j = await r.json().catch(() => ({}));
  if (!j || Number(j.errcode) !== 0) throw new Error(String(j.errmsg || '支付下单失败'));
  return { url: String(j.url || ''), qr: String(j.url_qrcode || '') };
}
/** 回调确认到账：只把订单标成已付款，等客户点「服务须知」后再生成 */
function markPaid(room) {
  if (!room || !room.order) return false;
  if (room.order.status === 'paid') return true;
  if (room.order.status !== 'awaiting' && room.order.status !== 'review') return false;
  room.order.status = 'paid';
  room.order.paidAt = Date.now();
  tell(room);
  return true;
}
function createOrder(room) {
  const id = randomBytes(6).toString('hex');
  room.order = { id, amount: ORDER_PRICE, status: 'awaiting', at: Date.now(), confirmToken: randomBytes(9).toString('base64url') };
  orders.set(id, room);
  return room.order;
}

/* 有人点「已付款」时，往站长的微信推一条：点链接就算确认到账（不用开后台、不用盯手机）。
 * GLUE_PUSH_URL 填推送服务的 webhook；GLUE_BASE_URL 填网站根地址。 */
const PUSH_URL = (() => {
  const fromEnv = String(process.env.GLUE_PUSH_URL || '').trim();
  if (fromEnv) return fromEnv;
  try { return readFileSync(join(HERE, 'push-url.txt'), 'utf8').trim(); } catch { return ''; }
})();
const BASE_URL = String(process.env.GLUE_BASE_URL || 'http://124.223.2.216:5178').replace(/\/+$/, '');
async function pushPaid(room) {
  if (!PUSH_URL || !room.order) return;
  const link = BASE_URL + '/pay/confirm?t=' + encodeURIComponent(room.order.confirmToken);
  const title = '有人付了 ' + room.order.amount + ' 元';
  const content = '订单 ' + room.order.id + '\n' + room.names.me + ' · ' + room.names.partner + '\n点下面这条确认到账并开始生成：\n' + link;
  let body;
  if (/qyapi\.weixin\.qq\.com/.test(PUSH_URL)) body = { msgtype: 'text', text: { content: title + '\n' + content } };
  else if (/sctapi\.ftqq\.com/.test(PUSH_URL)) body = { title, desp: content };
  else if (/pushplus/.test(PUSH_URL)) body = { title, content: content.replace(/\n/g, '<br>'), template: 'html' };
  else body = { title, content };
  try {
    await fetch(PUSH_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch { /* 推送失败不影响订单 */ }
}
/** 站长确认到账：这里才开始花钱调模型 */
function beginPaidFilm(room) {
  if (!OWNER_KEY) {
    room.order.status = 'error';
    room.order.error = '站长的 Key 还没配好';
    tell(room);
    return '';
  }
  const jobId = randomBytes(6).toString('hex');
  filmJobs.set(jobId, { status: 'running', phase: 'script', step: 0, total: 3, url: '', error: '', at: Date.now() });
  room.order.status = 'paid';
  room.order.paidAt = Date.now();
  room.order.jobId = jobId;
  void runFilmJob(jobId, {
    key: OWNER_KEY,
    script: room.story.script || {},
    storyText: room.story.storyText || '',
    musicUrl: room.story.musicUrl || '',
    images: room.story.images || [],
    avatars: room.story.avatars || [],
    host: '',
    roomId: room.id,
    ip: 'order:' + room.id,
    at: Date.now(),
  });
  tell(room);
  return jobId;
}

/* 参考样片里提炼出来的风格（只复刻风格，不复刻剧情/人物） */const STYLE = [
  '日系 2D 动画电影质感，赛璐璐上色，Q 版小人（约 2.5 头身）：大头、大眼、小身体，圆润可爱，线条干净，柔和高光。',
  '同一部短片里的连续镜头：同一对角色（男生黑发、女生长发，长相与服装以人物参考图为准），前后完全一致。',
  '两个角色始终同框、有互动：对视、并肩走、递东西、一起坐着、一起笑；不要空镜、不要只拍风景、不要火柴人。',
  '背景是真实场景的动画化：公园、街道、海边、老房子、夜里的窗前，斑驳阳光、树影光斑、浅景深虚化。',
  '暖色调（米金、暖橙、浅绿），明亮通透，轻微胶片颗粒，电影感构图，画面干净。',
  '镜头稳定，缓慢推近或轻微横移，不要快速摇镜、不要甩镜。',
].join('');
const NEGATIVE = '避免出现：人脸扭曲、五官错乱、肢体畸形、多手多脚、物体穿模、画面闪烁、抖动、模糊、崩坏、画风突变、真人照片感，以及任何文字、字幕、对话框、logo、水印。';
/* 防刷：同一个 IP 每天最多 5 次，且两次之间至少隔 30 分钟 */
const filmQuota = new Map();
const rooms = new Map();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' };

/* 没传头像时：生成一张固定的「默认男女主」Q 版参考图，之后所有片子都用它锁形象 */
async function ensureDefaultCouple(key) {
  const dir = join(HERE, 'public', 'qstyle');
  mkdirSync(dir, { recursive: true });
  const rel = '/qstyle/default-couple.png';
  const file = join(dir, 'default-couple.png');
  if (existsSync(file)) return rel;
  const r = await fetch('https://ark.cn-beijing.volces.com/api/v3/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: 'doubao-seedream-5-5-261028',
      prompt: 'Two cute anime characters standing together, a boy with black hair in a blue shirt and a girl with long black hair in a white dress, cel-shaded 2D anime style, clean lineart, warm sunlight, plain soft background, full body, no text',
      size: '1024x1024',
      response_format: 'url',
    }),
  });
  if (!r.ok) return '';
  const j = await r.json().catch(() => ({}));
  const url = j?.data?.[0]?.url;
  if (!url) return '';
  const bin = await fetch(url);
  if (!bin.ok) return '';
  writeFileSync(file, Buffer.from(await bin.arrayBuffer()));
  return rel;
}
/* 中文字幕字体：Windows 用微软雅黑；Linux 用 fc-list 找思源/Noto；找不到就不烧字幕（宁可不加字，也不加一堆方块） */
function filmFont() {
  if (process.platform === 'win32') return existsSync('C:/Windows/Fonts/msyh.ttc') ? 'Microsoft YaHei' : '';
  try {
    const out = execFileSync('fc-list', [':lang=zh', 'family'], { encoding: 'utf8', timeout: 8000 });
    const fams = out.split('\n').map((s) => s.split(',')[0].trim()).filter(Boolean);
    return fams.find((f) => /Noto Sans CJK|Source Han|WenQuanYi|Droid Sans Fallback/i.test(f)) || fams[0] || '';
  } catch { return ''; }
}
const assClock = (sec) => {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = (s % 60).toFixed(2).padStart(5, '0');
  return h + ':' + String(m).padStart(2, '0') + ':' + rest;
};
const assText = (text, max) => String(text || '').replace(/[\r\n]+/g, ' ').replace(/[{}]/g, '').replace(/\\/g, '').trim().slice(0, max);
/** 故事里的句子 → 字幕：每镜一句，淡入淡出，压在下三分之一。 */
function filmAss(segs, segDur, fade, font) {
  const head = [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1080', 'PlayResY: 1920', 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Sub,' + font + ',54,&H00FFFFFF,&H00FFFFFF,&H00100814,&H64000000,1,0,0,0,100,100,1,0,1,0,0,2,110,110,300,1',
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = [];
  segs.forEach((seg, i) => {
    const line = assText(seg.subtitle || seg.excerpt || '', 26);
    if (!line) return;
    const at = i * (segDur - fade);
    events.push('Dialogue: 0,' + assClock(at + 1.1) + ',' + assClock(at + segDur - 0.9) + ',Sub,,0,0,0,,{\\fad(420,420)}' + line);
  });
  return head.concat(events).join('\n');
}

async function runFilmJob(id, opts) {
  const job = filmJobs.get(id);
  const dir = mkdtempSync(join(tmpdir(), 'gluefilm-'));
  const ffmpeg = process.platform === 'win32' ? 'C:/Users/Administrator/Doubao/tools/ffmpeg/bin/ffmpeg.exe' : '/usr/bin/ffmpeg';
  try {
    const segs = Array.isArray(opts.script.segments) ? opts.script.segments.slice(0, 3) : [];
    if (!segs.length) throw new Error('脚本里没有分镜。');
    job.total = segs.length;
    /* 参考图缩到 768 宽、内联成 data URL：不依赖「豆包能不能访问到这台机器」，本地、内网、公网都一样 */
    const toRef = (s) => {
      if (typeof s !== 'string') return '';
      if (s.startsWith('data:image/')) return s;
      if (!s.startsWith('/qstyle/')) return '';
      const file = join(HERE, 'public', s.replace(/^\//, ''));
      if (!existsSync(file)) return '';
      try {
        const small = join(dir, 'ref-' + randomBytes(4).toString('hex') + '.jpg');
        execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', file, '-vf', 'scale=768:-2', '-q:v', '4', small], { timeout: 20000, stdio: 'ignore' });
        if (existsSync(small)) return 'data:image/jpeg;base64,' + readFileSync(small).toString('base64');
      } catch { /* 转不了就用原图 */ }
      const ext = /\.(png|jpe?g|webp)$/i.exec(file)?.[1]?.toLowerCase() || 'png';
      const mime = ext === 'jpg' ? 'jpeg' : ext;
      return 'data:image/' + mime + ';base64,' + readFileSync(file).toString('base64');
    };
    const charRefs = (Array.isArray(opts.avatars) ? opts.avatars : []).map(toRef).filter(Boolean).slice(0, 2);
    const bgRefs = (Array.isArray(opts.images) ? opts.images : []).map(toRef).filter(Boolean).slice(0, 1);
    const outs = [];
    /* 不再生成任何默认参考图：只用客户自己上传的照片 */
    const genOnce = async (i) => {
      job.phase = 'segments';
      const seg = segs[i];
      seg.refs = charRefs.concat(bgRefs);
      const prompt = [
        STYLE,
        '第 ' + (i + 1) + '/' + segs.length + ' 镜，和上一镜是同一部短片里的连续画面：同一对角色、同一身衣服。',
        opts.script && opts.script.characters ? '角色：' + String(opts.script.characters).slice(0, 40) : '',
        seg.excerpt ? '这一镜发生的事：' + String(seg.excerpt).slice(0, 90) : '',
        '场景：' + (seg.scene || '有光的地方') + '；镜头：' + (seg.shot || '缓慢推近') + '；情绪：' + (seg.emotion || '温柔') + '。',
        '只画这一镜的事，画面里不要出现任何文字、字幕、对话框、logo、水印。',
        NEGATIVE,
      ].filter(Boolean).join('\n');
      const content = [{ type: 'text', text: prompt }];
      (seg.refs || []).slice(0, 2).forEach((ref) => { if (ref) content.push({ type: 'image_url', image_url: { url: ref }, role: 'reference_image' }); });
      const make = async (resolution) => {
        const r = await fetch('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + opts.key },
          body: JSON.stringify({ model: 'doubao-seedance-2-0-fast-260128', content, ratio: '9:16', duration: 10, ...(resolution ? { resolution } : {}) }),
        });
        return { ok: r.ok, raw: await r.text() };
      };
      /* 站长定价 29.9 元一支：固定 480P、30 秒，和之前的片子一致 */
      const made = await make('480p');
      if (!made.ok) {
        let msg = made.raw.slice(0, 200);
        try { const j = JSON.parse(made.raw); msg = j.error?.message || msg; } catch { /* 忽略 */ }
        throw new Error('第 ' + (i + 1) + ' 段：' + msg);
      }
      const taskId = JSON.parse(made.raw).id;
      let videoUrl = '';
      for (let k = 0; k < 120; k += 1) {
        await new Promise((ok) => setTimeout(ok, 3000));
        const st = await fetch('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/' + taskId, { headers: { authorization: 'Bearer ' + opts.key } });
        const sj = await st.json().catch(() => ({}));
        if (sj.status === 'succeeded') { videoUrl = sj.content?.video_url || ''; break; }
        if (sj.status === 'failed') throw new Error('第 ' + (i + 1) + ' 段生成失败。');
      }
      if (!videoUrl) throw new Error('第 ' + (i + 1) + ' 段超时。');
      const bin = await fetch(videoUrl);
      writeFileSync(join(dir, i + '.mp4'), Buffer.from(await bin.arrayBuffer()));
      outs[i] = join(dir, i + '.mp4');
      job.step = outs.filter(Boolean).length;
    };
    const genOne = async (i) => {
      for (let a = 0; a < 2; a += 1) {
        try { await genOnce(i); return; } catch (e) {
          if (a === 1) throw e;
          await new Promise((ok) => setTimeout(ok, 4000));
        }
      }
    };
    await Promise.all(segs.map((_, i) => genOne(i)));
    job.phase = 'concat';
    const outDir = join(HERE, 'outputs');
    mkdirSync(outDir, { recursive: true });
    const outFile = join(outDir, id + '.mp4');
    let bgm = opts.musicUrl ? join(HERE, 'public', opts.musicUrl.replace(/^\//, '')) : '';
    /* 没传配乐也要有声音：现场合成一段 32 秒的钢琴底噪，不再输出无声视频 */
    if (!bgm || !existsSync(bgm)) {
      bgm = join(dir, 'bgm.wav');
      try { writeFileSync(bgm, wav(32, 'melancholic', 'warm')); } catch { bgm = ''; }
    }
    const hasBgm = Boolean(bgm && existsSync(bgm));
    const runFfmpeg = (args) => new Promise((ok) => {
      const child = spawn(ffmpeg, args, { cwd: dir, stdio: 'ignore' });
      child.on('exit', (code) => ok(code === 0));
      child.on('error', () => ok(false));
    });

    /* 三镜之间 0.5 秒交叉溶解 + 首尾淡入淡出；故事里的句子由本机烧成字幕，不让模型自己写字（它一定写乱） */
    const segDur = 10;
    const fade = 0.5;
    const total = Math.max(1, outs.length) * segDur - (Math.max(1, outs.length) - 1) * fade;
    const font = filmFont();
    if (font) writeFileSync(join(dir, 'subs.ass'), filmAss(segs, segDur, fade, font), 'utf8');

    const graph = [];
    const xargs = ['-y'];
    outs.forEach((f, k) => {
      xargs.push('-i', f);
      graph.push('[' + k + ':v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1,format=yuv420p[v' + k + ']');
    });
    if (hasBgm) xargs.push('-i', bgm);
    let vout = 'v0';
    for (let k = 1; k < outs.length; k += 1) {
      graph.push('[' + vout + '][v' + k + ']xfade=transition=fade:duration=' + fade + ':offset=' + (k * (segDur - fade)).toFixed(2) + '[x' + k + ']');
      vout = 'x' + k;
    }
    const tail = ['fade=t=in:st=0:d=0.6', 'fade=t=out:st=' + Math.max(0, total - 0.8).toFixed(2) + ':d=0.8'];
    if (font) tail.push('subtitles=subs.ass');
    graph.push('[' + vout + ']' + tail.join(',') + '[vo]');
    if (hasBgm) graph.push('[' + outs.length + ':a]apad[a]');
    xargs.push('-filter_complex', graph.join(';'), '-map', '[vo]');
    if (hasBgm) xargs.push('-map', '[a]', '-shortest', '-c:a', 'aac', '-b:a', '192k');
    xargs.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile);
    let okRun = await runFfmpeg(xargs);

    if (!okRun) {
      /* 万一某一段长度不是 10 秒、交叉溶解对不上：退回硬切拼接，保证片子出得来 */
      const list = join(dir, 'list.txt');
      writeFileSync(list, outs.map((f) => "file '" + f.replace(/'/g, "'\\''") + "'").join('\n'));
      const sargs = ['-y', '-f', 'concat', '-safe', '0', '-i', list];
      if (hasBgm) sargs.push('-i', bgm);
      let vf = 'fps=30,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1';
      if (font) vf += ',subtitles=subs.ass';
      sargs.push('-vf', vf);
      if (hasBgm) sargs.push('-map', '0:v', '-map', '1:a', '-af', 'apad', '-shortest', '-c:a', 'aac', '-b:a', '192k');
      sargs.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile);
      okRun = await runFfmpeg(sargs);
    }
    if (!okRun) throw new Error('拼接失败。');
    job.phase = 'done';
    job.status = 'done';
    job.url = '/outputs/' + id + '.mp4';
    if (opts.roomId) {
      const room = rooms.get(opts.roomId);
      if (room && room.status !== 'chat' && room.status !== 'ended') {
        room.filmUrl = job.url;
        /* 成片好了先不播：TA 已经在房里就直接开始，否则等 TA 进来（最多两分钟） */
        if (room.joined.guest) startFilmWindow(room, 'both');
        else readyFilm(room);
      }
    }
  } catch (e) {
    job.status = 'error';
    job.error = e instanceof Error ? e.message : String(e);
    /* 失败不占额度：把这次的时间戳退回去，可以马上重试 */
    try {
      const arr = (filmQuota.get(opts.ip) || []).filter((t) => t !== opts.at);
      filmQuota.set(opts.ip, arr);
    } catch { /* 忽略 */ }
    if (opts.roomId) {
      const room = rooms.get(opts.roomId);
      if (room && room.order && room.order.status === 'paid') {
        room.order.status = 'failed';
        room.order.error = job.error;
        tell(room);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    setTimeout(() => filmJobs.delete(id), 60 * 60 * 1000);
  }
}
function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { fail(Object.assign(new Error('太长了'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { fail(Object.assign(new Error('格式不对'), { status: 400 })); }
    });
    req.on('error', fail);
  });
}

/** 图片的字节（不是 JSON）：一张截图，交给 OCR。 */
function readImage(req, limit = 12 * 1024 * 1024) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { fail(Object.assign(new Error('图有点大，换一张小一点的吧。'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

/** The room as the two pages may see it: no tokens, and the words only while the room is open. */
function publicState(room, now = Date.now()) {
  return {
    id: room.id,
    names: room.names,
    status: room.status,
    joined: room.joined,
    confirm: room.confirm,
    filmStart: room.filmStart,
    readyDeadline: room.readyDeadline || 0,
    filmReason: room.filmReason || '',
    chatEnd: room.chatEnd,
    offerDeadline: room.offerDeadline || 0,
    askDeadline: room.askDeadline || 0,
    result: room.result || '',
    serverNow: now,
    story: Object.assign({}, room.story, { beats: [] }),
    filmUrl: room.filmUrl || '',
    order: room.order ? { id: room.order.id, amount: room.order.amount, status: room.order.status, error: room.order.error || '' } : null,
    payXunhu: Boolean(XUNHU || ZHIFU),
    messages: room.status === 'chat' ? room.messages.slice(-200) : [],
  };
}

function send(room, event, data) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of room.sse) { try { res.write(line); } catch { room.sse.delete(res); } }
}

const tell = (room) => send(room, 'state', publicState(room));

function clearTimers(room) {
  for (const timer of room.timers.splice(0)) clearTimeout(timer);
}

/** 成片好了、人还没齐：先把片子扣在手里，两分钟内等接收人进来 */
const FILM_GRACE_MS = 2 * 60_000;
/** 一支 30 秒的片子，多给一点缓冲时间，放完就弹确认面板 */
const FILM_WINDOW_MS = 31_500;

function readyFilm(room) {
  clearTimers(room);
  room.status = 'ready';
  room.filmStart = null;
  room.readyAt = Date.now();
  room.readyDeadline = room.readyAt + FILM_GRACE_MS;
  room.timers.push(setTimeout(() => {
    /* 两分钟到了还没人来：不等了，先自己看完 */
    if (room.status === 'ready') startFilmWindow(room, 'timeout');
  }, FILM_GRACE_MS + 200));
  tell(room);
}

/** 两个人一起从头看：filmStart 是两边共用的同一个开始时刻 */
function startFilmWindow(room, reason = 'guest') {
  if (!room || room.status === 'chat' || room.status === 'ended') return;
  clearTimers(room);
  room.status = 'film';
  room.filmStart = Date.now();
  room.filmReason = reason;
  room.readyDeadline = 0;
  room.timers.push(setTimeout(() => {
    if (room.status === 'film') { room.status = 'confirm'; tell(room); }
  }, FILM_WINDOW_MS));
  tell(room);
}
function startChat(room) {
  if (room.status !== 'confirm') return;
  room.status = 'chat';
  room.messages = [];
  room.chatEnd = Date.now() + CHAT_MS;
  room.timers.push(setTimeout(() => {
    if (room.status !== 'chat') return;
    room.messages = [];
    /* 聊天结束：只给发起方 60 秒，可以发起「关系复原胶」 */
    room.status = 'offer';
    room.offerDeadline = Date.now() + 60_000;
    room.result = '';
    room.timers.push(setTimeout(() => {
      if (room.status === 'offer') { room.status = 'ended'; tell(room); }
    }, 60_200));
    tell(room);
  }, CHAT_MS + 200));
  tell(room);
}

function decline(room) {
  clearTimers(room);
  room.status = 'declined';
  room.messages = [];
  tell(room);
}

function roomFor(id) {
  const room = rooms.get(String(id ?? ''));
  return room && Date.now() - room.createdAt < ROOM_TTL ? room : null;
}

/** Who is asking: the host with their own key, else the guest's seat. */
function seatOf(room, role, token) {
  if (role === 'host') return token && token === room.hostToken ? 'host' : null;
  if (role === 'guest') return 'guest';
  return null;
}

/** Every address this machine has on the local network, for the phone that opens it. */
const LAN = [...new Set(Object.values(networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address))];

/** 跑一次 tools 里的 PowerShell 脚本，拿它最后一行的 JSON。 */
function runPs(script, args, timeoutMs = 90_000) {
  return new Promise((ok) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'tools', script), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => { /* 脚本自己的日志不往外传 */ });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } ok(''); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); ok(''); });
    child.on('exit', () => {
      clearTimeout(timer);
      const last = out.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
      ok(last);
    });
  });
}

/** 各个应用的窗口：list / open / capture。失败时给一句能读的话。 */
async function appWindow(action, id, out) {
  if (process.platform !== 'win32') return { ok: false, error: '云端版不支持打开本地应用，请用粘贴、文件或截图导入。' };
  const args = ['-Action', action, '-Hint', id];
  if (out) args.push('-Out', out);
  const line = await runPs('app-window.ps1', args);
  try { return JSON.parse(line || '{}'); } catch { return { ok: false, error: '它的窗口没有回应，再点一次试试。' }; }
}

/** 一张窗口截图 → OCR 的 JSON 文字。 */
async function runOcr(image, out) {
  await runPs('ocr.ps1', [image, out], 90_000);
  return existsSync(out) ? readFileSync(out, 'utf8') : '';
}

function serveStatic(req, res, pathname) {
  if (pathname.startsWith('/outputs/')) {
    const outDir = join(HERE, 'outputs');
    const name = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '').replace(/^outputs[/\\]+/, '');
    const file = resolve(outDir, name);
    if (!file.startsWith(outDir + sep) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': body.length, 'cache-control': 'no-cache' });
    res.end(body);
    return;
  }
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  const file = resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + sep) && file !== PUBLIC) { res.writeHead(403); res.end(); return; }
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('not here'); return; }
  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const body = readFileSync(file);
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'content-length': body.length });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  try {
    /* 各个应用：在不在、开没开、能不能把它带到前面、能不能把它的窗口读成聊天记录 */
    if (path === '/api/apps' && req.method === 'GET') {
      const ids = ['wechat', 'qq', 'douyin', 'kuaishou'];
      const list = await Promise.all(ids.map(async (id) => ({ id, ...(await appWindow('list', id)) })));
      return json(res, 200, { apps: list });
    }
    if (path === '/api/apps/open' && req.method === 'POST') {
      const body = await readBody(req);
      const id = String(body.id ?? '');
      if (!['wechat', 'qq', 'douyin', 'kuaishou'].includes(id)) return json(res, 400, { error: '不认识这个应用。' });
      const out = await appWindow('open', id);
      return json(res, out.ok ? 200 : 409, out);
    }
    if (path === '/api/apps/capture' && req.method === 'POST') {
      const body = await readBody(req);
      const id = String(body.id ?? '');
      if (!['wechat', 'qq', 'douyin', 'kuaishou'].includes(id)) return json(res, 400, { error: '不认识这个应用。' });
      const dir = mkdtempSync(join(tmpdir(), 'glue-win-'));
      const shot = join(dir, 'window.png');
      const lines = join(dir, 'lines.json');
      try {
        const captured = await appWindow('capture', id, shot);
        if (!captured.ok) return json(res, 409, { error: captured.error ?? '它的窗口没有截下来。' });
        const ocr = await runOcr(shot, lines);
        if (!ocr) return json(res, 502, { error: '窗口截下来了，但字没有读出来。' });
        const text = logFromOcr(ocr, { me: String(body.me ?? ''), partner: String(body.partner ?? '') });
        if (!text.trim()) return json(res, 422, { error: '这个窗口里没有认出能当作对话的字，把它拉大一点、翻到聊天那一页再试。' });
        return json(res, 200, { text, chars: text.length, title: captured.title, width: captured.width, height: captured.height });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    if (path === '/api/health') return json(res, 200, { ok: true, rooms: rooms.size, port: PORT, lan: LAN, platform: process.platform });
    /* 一份各应用导出的聊天记录（.txt/.html/.mht/.csv/.json）→ 这个项目认得的「谁：什么」 */
    if (path === '/api/import' && req.method === 'POST') {
      const bytes = await readImage(req, 24 * 1024 * 1024);
      if (!bytes.length) return json(res, 400, { error: '这个文件是空的。' });
      let filename = 'chat.txt';
      try { filename = decodeURIComponent(String(req.headers['x-filename'] ?? 'chat.txt')).slice(0, 200); } catch { /* as it is */ }
      const got = detect(decode(bytes), filename);
      if (!got.messages.length) {
        return json(res, 422, { error: '没认出这份记录里的对话。微信/QQ 请导出成 .txt 或 .mht；抖音快手的私信没有导出，用截图。' });
      }
      return json(res, 200, { app: got.app, format: got.format, note: got.note, messages: got.messages.length, text: got.text });
    }
    if (path === '/api/ocr' && req.method === 'POST') {
      const bytes = await readImage(req);
      if (!bytes.length) return json(res, 400, { error: '这张图是空的。' });
      const dir = mkdtempSync(join(tmpdir(), 'glue-ocr-'));
      const image = join(dir, 'shot.png');
      const out = join(dir, 'lines.json');
      try {
        writeFileSync(image, bytes);
        const raw = process.platform === 'win32' ? await ocrWindows(image, out) : await ocrTesseract(image, bytes);
        if (!raw) return json(res, 504, { error: '这次没有把图看完，换一张再试试。' });
        const text = logFromOcr(raw, { me: url.searchParams.get('me') ?? '', partner: url.searchParams.get('partner') ?? '' });
        if (!text.trim()) return json(res, 422, { error: '这张图里没有认出能当作对话的字，换一张清楚一点的截图试试。' });
        return json(res, 200, { text, chars: text.length });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    /* a room from a chat log: the log is read here and never stored whole */
    /* 把一支闪片渲染成 MP4：ffmpeg 在本机合成，几十秒出片 */
    if (path === '/api/render' && req.method === 'POST') {
      const body = await readBody(req, 16 * 1024 * 1024);
      const story = body.story;
      if (!story || !Array.isArray(story.acts)) return json(res, 400, { error: '缺了这支片子的分镜。' });
      const seconds = Math.max(15, Math.min(180, (Number(story.duration) || 15000) / 1000));
      story.duration = seconds * 1000;
      const ffmpeg = process.platform === 'win32' ? 'C:/Users/Administrator/Doubao/tools/ffmpeg/bin/ffmpeg.exe' : '/usr/bin/ffmpeg';
      const fontName = process.platform === 'win32' ? 'Microsoft YaHei' : 'Noto Sans CJK SC';
      try {
        const themeName = story.theme || (story.music && story.music.theme) || 'miss';
        const bgmFile = join(HERE, 'public', 'bgm', themeName + '.mp3');
        const out = await renderFilm(story, { ffmpeg, fontName, bgmFile, outDir: join(HERE, 'outputs') });
        return json(res, 200, { url: '/outputs/' + out.id + '.mp4', seconds: out.seconds });
      } catch (e) {
        return json(res, 500, { error: e instanceof Error ? e.message : '渲染失败' });
      }
    }    /* 真人照片 → Q 版：用使用者自己的 Key 调 Seedream 图生图 */
    if (path === '/api/qstyle' && req.method === 'POST') {
      /* 只能用使用者自己的 Key：绝不能在付款前动用站长的火山额度 */
      const key = String(req.headers['x-agent-key'] || '').trim();
      if (!key) return json(res, 400, { error: '需要你自己的豆包 Key。' });
      const bytes = await readImage(req, 12 * 1024 * 1024);
      if (!bytes.length) return json(res, 400, { error: '图片是空的。' });
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
      const mime = isPng ? 'image/png' : 'image/jpeg';
      const dataUrl = 'data:' + mime + ';base64,' + bytes.toString('base64');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120_000);
      try {
        const upstream = await fetch('https://ark.cn-beijing.volces.com/api/v3/images/generations', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
          body: JSON.stringify({
            model: 'doubao-seedream-5-5-261028',
            prompt: String(req.headers['x-kind'] || 'portrait') === 'scene'
              ? 'Turn this photo into a soft anime-style background: cel-shaded 2D anime scenery, warm sunlight, dappled light, gentle bokeh, pastel warm tones, clean lineart, no people, no text'
              : 'Turn this photo into a cute chibi anime character: big head, big eyes, cel-shaded 2D anime style, soft warm light, clean lineart, keep the person recognizable, plain soft background, no text',
            image: dataUrl,
            size: '1024x1024',
            response_format: 'url',
          }),
          signal: ctrl.signal,
        });
        const raw = await upstream.text();
        if (!upstream.ok) {
          let msg = raw.slice(0, 240);
          try { const j = JSON.parse(raw); msg = j.error?.message || msg; } catch { /* 忽略 */ }
          return json(res, 502, { error: '豆包图片接口：' + msg });
        }
        const body = JSON.parse(raw);
        const url = body?.data?.[0]?.url;
        if (!url) return json(res, 502, { error: '豆包没返回图片。' });
        const imgRes = await fetch(url, { signal: ctrl.signal });
        if (!imgRes.ok) return json(res, 502, { error: '图片没下载下来。' });
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const dir = join(HERE, 'public', 'qstyle');
        mkdirSync(dir, { recursive: true });
        const id = randomBytes(8).toString('hex');
        writeFileSync(join(dir, id + '.png'), buf);
        return json(res, 200, { url: '/qstyle/' + id + '.png' });
      } catch (e) {
        return json(res, 500, { error: '生成失败：' + (e instanceof Error ? e.message : String(e)) });
      } finally {
        clearTimeout(timer);
      }
    }    /* 使用者自己的配乐：音频直接用，视频用 ffmpeg 抽音轨 */
    if (path === '/api/music' && req.method === 'POST') {
      const bytes = await readImage(req, 40 * 1024 * 1024);
      if (!bytes.length) return json(res, 400, { error: '这个文件是空的。' });
      let name = 'upload';
      try { name = decodeURIComponent(String(req.headers['x-filename'] ?? 'upload')).slice(-80); } catch { /* 忽略 */ }
      const type = String(req.headers['content-type'] || '');
      const extMatch = /\.(mp3|m4a|aac|wav|ogg|flac|mp4|mov|mkv|webm|avi)$/i.exec(name);
      const ext = extMatch ? extMatch[1].toLowerCase() : (type.startsWith('video/') ? 'mp4' : 'mp3');
      const videoExts = ['mp4', 'mov', 'mkv', 'webm', 'avi'];
      const dir = join(HERE, 'public', 'music');
      mkdirSync(dir, { recursive: true });
      const id = randomBytes(8).toString('hex');
      const rawFile = join(dir, id + '.' + ext);
      writeFileSync(rawFile, bytes);
      let outExt = ext;
      if (videoExts.includes(ext)) {
        const audioFile = join(dir, id + '.m4a');
        const ffmpeg = process.platform === 'win32' ? 'C:/Users/Administrator/Doubao/tools/ffmpeg/bin/ffmpeg.exe' : '/usr/bin/ffmpeg';
        const res2 = await new Promise((ok) => {
          const child = spawn(ffmpeg, ['-y', '-i', rawFile, '-vn', '-acodec', 'aac', '-b:a', '160k', audioFile], { stdio: 'ignore' });
          child.on('exit', (code) => ok(code === 0));
          child.on('error', () => ok(false));
        });
        if (!res2) return json(res, 500, { error: '视频里的音轨没抽出来，换一个文件试试。' });
        rmSync(rawFile, { force: true });
        outExt = 'm4a';
      }
      return json(res, 200, { url: '/music/' + id + '.' + outExt });
    }    /* 脚本预览：聊天记录 → 人物 / 主题 / 6 段分镜 */
    if (path === '/api/script' && req.method === 'POST') {
      const body = await readBody(req, 8 * 1024 * 1024);
      const script = buildScript(String(body.log ?? ''), String(body.me ?? ''), String(body.partner ?? ''));
      return json(res, 200, { script });
    }

    /* 成片任务：只留给「已经确认到账」的房间；普通客户不能直接调 */
    if (path === '/api/film-jobs' && req.method === 'POST') {
      const body = await readBody(req, 16 * 1024 * 1024);
      const room = rooms.get(String(body.roomId ?? ''));
      if (!room || !room.order || room.order.status !== 'paid') {
        return json(res, 402, { error: '生成前要先付款，并且由站长确认到账。' });
      }
      return json(res, 200, { id: room.order.jobId || '' });
    }
    if (path.startsWith('/api/film-jobs/') && req.method === 'GET') {
      const id = path.split('/')[3];
      const job = filmJobs.get(id);
      if (!job) return json(res, 404, { error: '任务不见了。' });
      return json(res, 200, job);
    }
    /* 成片：4 段 15 秒的 Seedance 视频，逐段带同一张 Q 版参考图，最后拼接 + 用户 BGM */
    if (path === '/api/film' && req.method === 'POST') {
      return json(res, 410, { error: '这个入口已经停用，请在房间里付款后生成。' });
    }
    /* 旧入口（已停用） */
    if (false && path === '/api/film' && req.method === 'POST') {
      const body = await readBody(req, 16 * 1024 * 1024);
      const key = String(body.key ?? '').trim() || OWNER_KEY;
      if (!key) return json(res, 400, { error: '站长的 Key 还没配好。' });
      const story = body.story || {};
      const model = String(body.model ?? 'doubao-seedance-2-0-fast-260128');
      const acts = Array.isArray(story.acts) ? story.acts.slice(0, 5) : [];
      if (!acts.length) return json(res, 400, { error: '缺少分镜。' });
      const refs = Array.isArray(story.images) ? story.images.filter((s) => typeof s === 'string' && s.startsWith('/qstyle/')).slice(0, 1) : [];
      const refUrl = refs.length ? ('http://' + String(req.headers.host || 'localhost') + refs[0]) : '';
      const dir = mkdtempSync(join(tmpdir(), 'gluefilm-'));
      const outs = [];
      const wantSeconds = Math.max(10, Math.min(60, Math.round((Number(story.duration) || 60000) / 1000)));
      const segments = Math.max(1, Math.min(6, Number(body.segments) || Math.ceil(wantSeconds / 10)));
      try {
        for (let i = 0; i < segments; i += 1) {
          const act = acts[Math.min(i, acts.length - 1)] || {};
          const line = act.bubbles && act.bubbles[0] ? act.bubbles[0].text : '';
          const prompt = [
            '极简 Q 版小人动画，温柔、治愈、回忆感、低饱和柔光，不要真人，不要复杂五官。',
            '第 ' + (i + 1) + ' 段（15 秒）：' + (act.title || '回忆') + '。' + (act.note || ''),
            line ? '字幕只出现这句：' + line : '',
            '镜头缓慢推近，画面干净，人物形象与参考图完全一致。',
          ].filter(Boolean).join('\n');
          const content = [{ type: 'text', text: prompt }];
          if (refUrl) content.push({ type: 'image_url', image_url: { url: refUrl } });
          const created = await fetch('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
            body: JSON.stringify({ model, content, ratio: '9:16', duration: 10 }),
          });
          const rawCreate = await created.text();
          if (!created.ok) {
            let msg = rawCreate.slice(0, 200);
            try { const j = JSON.parse(rawCreate); msg = j.error?.message || msg; } catch { /* 忽略 */ }
            return json(res, 502, { error: '视频接口：' + msg });
          }
          const taskId = JSON.parse(rawCreate).id;
          let videoUrl = '';
          for (let k = 0; k < 100; k += 1) {
            await new Promise((ok) => setTimeout(ok, 3000));
            const st = await fetch('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/' + taskId, { headers: { authorization: 'Bearer ' + key } });
            const stJson = await st.json().catch(() => ({}));
            if (stJson.status === 'succeeded') { videoUrl = stJson.content?.video_url || ''; break; }
            if (stJson.status === 'failed') return json(res, 502, { error: '第 ' + (i + 1) + ' 段生成失败。' });
          }
          if (!videoUrl) return json(res, 504, { error: '第 ' + (i + 1) + ' 段超时了。' });
          const file = join(dir, i + '.mp4');
          const bin = await fetch(videoUrl);
          writeFileSync(file, Buffer.from(await bin.arrayBuffer()));
          outs.push(file);
        }
        const outDir = join(HERE, 'outputs');
        mkdirSync(outDir, { recursive: true });
        const id = randomBytes(6).toString('hex');
        const outFile = join(outDir, id + '.mp4');
        const list = join(dir, 'list.txt');
        writeFileSync(list, outs.map((f) => "file '" + f.replace(/'/g, "'\\''") + "'").join('\n'));
        const bgmSrc = story.musicUrl ? join(HERE, 'public', story.musicUrl.replace(/^\//, '')) : '';
        const ffmpeg = process.platform === 'win32' ? 'C:/Users/Administrator/Doubao/tools/ffmpeg/bin/ffmpeg.exe' : '/usr/bin/ffmpeg';
        const args = ['-y', '-f', 'concat', '-safe', '0', '-i', list];
        if (bgmSrc && existsSync(bgmSrc)) args.push('-i', bgmSrc);
        args.push('-filter_complex', '[0:v]fps=30,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1[v]');
        args.push('-map', '[v]');
        if (bgmSrc && existsSync(bgmSrc)) args.push('-map', '1:a', '-shortest', '-c:a', 'aac', '-b:a', '160k');
        args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile);
        const okRun = await new Promise((ok) => {
          const child = spawn(ffmpeg, args, { stdio: 'ignore' });
          child.on('exit', (code) => ok(code === 0));
          child.on('error', () => ok(false));
        });
        if (!okRun) return json(res, 500, { error: '拼接失败。' });
        return json(res, 200, { url: '/outputs/' + id + '.mp4', segments: outs.length });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }    /* 连通性测试：用使用者自己的 Key + 智能体 ID 发一句话 */
    if (path === '/api/agent/test' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await testAgent(String(body.key ?? ''), String(body.id ?? ''), String(body.agentModel ?? ''));
      return json(res, 200, { ok: out.ok, detail: out.detail });
    }    /* 豆包智能体：有没有 Key、用的是哪个模型 */
    if (path === '/api/agent' && req.method === 'GET') {
      return json(res, 200, { ready: hasLegacyKey(), model: MODEL, hint: '' });
    }
    if (path === '/api/agent/key' && req.method === 'POST') {
      const body = await readBody(req);
      const next = String(body.key ?? '').trim();
      if (!/^[A-Za-z0-9_-]{12,}$/.test(next)) return json(res, 400, { error: '这串 Key 看起来不对（应该是一长串字母数字）。' });
      saveKey(next);
      return json(res, 200, { ready: true, model: MODEL, hint: '' });
    }    if (path === '/api/rooms' && req.method === 'POST') {
      const body = await readBody(req, 8 * 1024 * 1024);
      const rawStory = String(body.storyText ?? '').trim();
      /* 用户写的是故事：先拆成对话样子的行，交给 analyze；脚本用故事版生成 */
      const log = rawStory
        ? rawStory.split(/(?<=[。！？!?；;])/).map((s) => s.trim()).filter(Boolean)
          .map((s, i) => (i % 2 ? String(body.partner || 'TA') : String(body.me || '我')) + '：' + s).join(String.fromCharCode(10))
        : String(body.log ?? '');
      if (log.length < 20) return json(res, 400, { error: '记录太短了，多贴几句吧。' });
      if (log.length > 60_000) return json(res, 400, { error: '记录有点长，先贴最近的一段吧。' });
      const mode = body.mode === 'agent' ? 'agent' : 'plain';
      const theme = ['miss', 'warm', 'regret'].includes(String(body.theme)) ? String(body.theme) : 'miss';
      let story;
      try { story = analyze(log, { me: String(body.me ?? '').slice(0, 24), partner: String(body.partner ?? '').slice(0, 24) }); }
      catch (e) { return json(res, 400, { error: /** @type {Error} */ (e).message }); }
      /* 片长跟着信息密度走：15 秒起，最长 3 分钟 */
      const lines = log.split(String.fromCharCode(10)).filter((line) => line.trim()).length;
      const media = (log.match(/\[(图片|视频|语音|表情)\]|图片|照片|风景|截图/g) || []).length;
      const seconds = Math.max(15, Math.min(180, Math.round((15 + Math.max(0, lines - 20) * 3 + media * 6) / 3) * 3));
      /* 普通模式固定 15 秒；智能体模式才按信息密度拉长 */
      /* 普通模式固定 30 秒；智能体模式按信息密度 15 秒到 3 分钟 */
      story.duration = 30000;
      story.theme = theme;
      if (mode === 'plain') story.music = { root: 'A', tempo: 68, mood: 'warm', theme };
      else if (story.music) story.music.theme = theme;
      story.mode = mode;
      /* 从聊天记录里读情绪的走向：越往后是热恋还是崩，决定分镜的标题和画面冷暖 */
      const conflictHits = (log.match(/(分手|分开|吵架|冷战|拉黑|删了|不理|生气|失望|算了|随便你|别联系|再见|冷静)/g) || []).length;
      const warmHits = (log.match(/(想你|抱抱|喜欢|爱你|晚安|早安|开心|想你啦|么么|宝贝)/g) || []).length;
      const lateLines = log.split(String.fromCharCode(10));
      const lateText = lateLines.slice(Math.floor(lateLines.length * 0.6)).join(' ');
      const lateConflict = /(分手|分开|吵架|冷战|拉黑|删了|不理|生气|失望|算了|随便你|别联系|再见|冷静)/.test(lateText);
      story.arc = (lateConflict || (conflictHits >= 2 && conflictHits >= warmHits)) ? 'break' : 'warm';
      story.acts.forEach((act, idx) => {
        const late = idx >= 3;
        act.tone = story.arc === 'break' && late ? 'break' : (late && conflictHits ? 'cool' : 'warm');
      });
      if (mode !== 'agent') {
        const warmTitles = [['初见', '第一句话，总是很轻'], ['靠近', '消息开始密起来'], ['热恋', '把一整天都讲给对方听'], ['习惯', '安静也算陪着'], ['回望', '还是记得第一句']];
        const breakTitles = [['初见', '那天，我先开了口'], ['靠近', '后来就开始等消息'], ['疏远', '回复越来越慢'], ['分开', '有些话停在了对话框'], ['回望', '如果还能再说一次在吗']];
        const set = story.arc === 'break' ? breakTitles : warmTitles;
        story.acts.forEach((act, idx) => { act.title = set[idx][0]; act.note = set[idx][1]; });
      }
      const musicUrl = typeof body.musicUrl === 'string' && /^[/]music[/][A-Za-z0-9._-]+[.][A-Za-z0-9]+$/.test(body.musicUrl) ? body.musicUrl : '';
      story.musicUrl = musicUrl;
      story.beats = Array.isArray(body.beats)
        ? body.beats.map(Number).filter((n) => Number.isFinite(n) && n >= 0 && n <= 180000).slice(0, 400).sort((a, b) => a - b)
        : [];
      /* 两张头像（可选）：客户端已经缩到 320px 的 dataURL，这里只收 image/jpeg 且不超过 200KB */
      const avatars = Array.isArray(body.avatars) ? body.avatars.slice(0, 2) : [];
      const images = Array.isArray(body.images) ? body.images.slice(0, 8) : [];
      story.images = images.filter((src) => typeof src === 'string' && (src.indexOf('data:image/') === 0 || src.indexOf('/qstyle/') === 0) && src.length < 400000).slice(0, 8);
      story.avatars = avatars
        .filter((src) => typeof src === 'string' && (src.indexOf('data:image/') === 0 || src.indexOf('/qstyle/') === 0) && src.length < 400000)
      if (mode === 'agent') {
        /* 付款前绝不调用任何火山模型：分镜、配色、音乐全部本地生成 */
        const designed = localDesign(story.seed, story.stats);
        story.fromAgent = false;
        story.agentNote = '本地定制';
        designed.acts.forEach((a, idx) => { if (story.acts[idx]) { story.acts[idx].title = a.title; story.acts[idx].note = a.note; } });
        story.palette = designed.palette;
        story.music = designed.music;
      }
      /* 把脚本直接挂在 story 上，客户端不用再回传聊天记录 */
      story.script = body.storyText ? buildScriptFromStory(String(body.storyText), story.me, story.partner) : buildScript(log, story.me, story.partner, 3);
      story.storyText = (rawStory || log).slice(0, 1200);
      const id = randomBytes(9).toString('base64url');
      /** @type {Room} */
      const room = {
        id, hostToken: randomBytes(18).toString('base64url'), createdAt: Date.now(),
        names: { me: story.me, partner: story.partner }, story,
        status: 'waiting', joined: { host: false, guest: false }, confirm: { host: null, guest: null },
        filmStart: null, chatEnd: null, messages: [], sse: new Set(), timers: [], order: null,
      };
      rooms.set(id, room);
      return json(res, 201, { id, hostToken: room.hostToken });
    }

    /* 站长上传收款码（不进公开仓库，放在 public/pay/） */
    if (path === '/api/pay/qr' && req.method === 'POST') {
      if (!adminOk(url)) return json(res, 403, { error: '口令不对。' });
      const kind = String(req.headers['x-kind'] || '');
      if (kind !== 'wechat' && kind !== 'alipay') return json(res, 400, { error: '不认识这个收款码。' });
      const bytes = await readImage(req, 8 * 1024 * 1024);
      if (!bytes.length) return json(res, 400, { error: '图是空的。' });
      const dir = join(PUBLIC, 'pay');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, kind + '.jpg'), bytes);
      return json(res, 200, { ok: true, url: '/pay/' + kind + '.jpg', bytes: bytes.length });
    }

    /* 支付FM回调：GET/POST，验签 + 金额核对，通过就自动放行 */
    if (path === '/api/pay/zhifufm') {
      if (!ZHIFU) return json(res, 503, { error: '还没配置支付FM。' });
      const p = Object.fromEntries(url.searchParams);
      if (req.method === 'POST') {
        const raw = await readImage(req, 64 * 1024).then((b) => b.toString('utf8')).catch(() => '');
        Object.assign(p, Object.fromEntries(new URLSearchParams(raw)));
      }
      const sign = createHash('md5')
        .update(String(p.state || '') + String(p.merchantNum || '') + String(p.orderNo || '') + String(p.amount || '') + ZHIFU.secret)
        .digest('hex');
      const ok = sign === String(p.sign || '') && String(p.state) === '1' && String(p.merchantNum) === ZHIFU.merchant;
      if (ok) {
        const room = orders.get(String(p.orderNo || ''));
        const amount = Number(p.amount || 0);
        if (room && room.order && Math.abs(amount - room.order.amount) < 0.005 && room.status === 'waiting' && !room.filmUrl) markPaid(room);
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(ok ? 'success' : 'fail');
    }

    /* 虎皮椒回调：验签 + 金额核对，通过就自动放行 */
    if (path === '/api/pay/xunhu') {
      if (!XUNHU) return json(res, 503, { error: '还没配置虎皮椒。' });
      const raw = await readImage(req, 64 * 1024).then((b) => b.toString('utf8')).catch(() => '');
      const body = Object.fromEntries(new URLSearchParams(raw));
      const ok = String(body.hash || '') === xunhuHash(body, XUNHU.secret);
      if (ok && String(body.status) === 'OD') {
        const room = orders.get(String(body.trade_order_id || ''));
        const amount = Number(body.total_fee || 0);
        if (room && room.order && Math.abs(amount - room.order.amount) < 0.005 && room.status === 'waiting' && !room.filmUrl) {
          markPaid(room);
        }
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(ok ? 'success' : 'fail');
    }

    /* 站长在微信里点一下：确认到账并开始生成 */
    if (path === '/pay/confirm' && req.method === 'GET') {
      const t = String(url.searchParams.get('t') || '');
      const room = [...orders.values()].find((r) => r.order && r.order.confirmToken && sameSecret(t, r.order.confirmToken));
      const page = (text) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:-apple-system,\'Microsoft YaHei\',sans-serif;background:#f7f3ee;color:#2b2018;padding:48px 24px;line-height:1.9;font-size:16px">' + text + '</body>');
      };
      if (!room) return page('链接无效，或者已经被用过了。');
      if (room.status !== 'waiting') return page('这间房已经不在等待生成了（可能已经处理过）。');
      if (room.order.status === 'awaiting' || room.order.status === 'review' || room.order.status === 'failed') {
        beginPaidFilm(room);
        return page('✅ 已确认到账，开始生成。<br><span style="color:#8a7767;font-size:14px">客户那边会自动看到进度；这次生成 480P、30 秒。</span>');
      }
      return page('这笔订单现在的状态是：' + room.order.status + '，不需要再确认。');
    }

    /* 收款服务回调：金额对得上、订单还在等，就自动确认到账并开始生成 */
    if (path === '/api/pay/notify') {
      if (!PAY_TOKEN) return json(res, 503, { error: '还没配置自动到账。' });
      if (!sameSecret(String(url.searchParams.get('token') || ''), PAY_TOKEN)) {
        return json(res, 403, { error: 'token 不对。' });
      }
      let body = {};
      const raw = await readImage(req, 256 * 1024).then((b) => b.toString('utf8')).catch(() => '');
      if (raw) {
        try { body = JSON.parse(raw); } catch { body = Object.fromEntries(new URLSearchParams(raw)); }
      }
      const no = String(body.out_trade_no || body.outTradeNo || body.orderId || body.order_id || body.id || '');
      const amount = Number(body.amount ?? body.price ?? body.total ?? body.money ?? body.total_fee ?? 0);
      const room = orders.get(no);
      if (!room || !room.order) return json(res, 404, { error: '没有这个订单。' });
      if (!(Math.abs(amount - room.order.amount) < 0.005)) return json(res, 400, { error: '金额不对。' });
      if (room.order.status === 'awaiting' || room.order.status === 'review' || room.order.status === 'failed') {
        if (room.status === 'waiting' && !room.filmUrl) markPaid(room);
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('success');
    }

    /* 站长后台：看订单、确认到账、取消 */
    if (path === '/api/admin/state' && req.method === 'GET') {
      if (!adminOk(url)) return json(res, 403, { error: '口令不对。' });
      return json(res, 200, {
        auto: Boolean(PAY_TOKEN),
        notifyUrl: '/api/pay/notify?token=' + PAY_TOKEN,
        push: Boolean(PUSH_URL),
        price: ORDER_PRICE,
      });
    }
    if (path === '/api/admin/orders' && req.method === 'GET') {
      if (!adminOk(url)) return json(res, 403, { error: '口令不对。' });
      const list = [...orders.values()]
        .filter((room) => room && room.order)
        .map((room) => ({
          id: room.order.id,
          roomId: room.id,
          names: room.names,
          amount: room.order.amount,
          status: room.order.status,
          at: room.order.at,
          error: room.order.error || '',
        }))
        .sort((a, b) => b.at - a.at)
        .slice(0, 60);
      return json(res, 200, { orders: list, price: ORDER_PRICE });
    }
    if (path.startsWith('/api/admin/orders/') && req.method === 'POST') {
      if (!adminOk(url)) return json(res, 403, { error: '口令不对。' });
      const m = /^\/api\/admin\/orders\/([a-f0-9]{12})\/(confirm|cancel)$/.exec(path);
      if (!m) return json(res, 404, { error: '没有这个订单。' });
      const room = orders.get(m[1]);
      if (!room || !room.order) return json(res, 404, { error: '订单不见了。' });
      if (m[2] === 'confirm') {
        if (room.status !== 'waiting') return json(res, 409, { error: '这间房已经不在等待了。' });
        beginPaidFilm(room);
      } else {
        room.order.status = 'cancelled';
        tell(room);
      }
      return json(res, 200, { ok: true, status: room.order.status });
    }

    const open = /^\/api\/rooms\/([A-Za-z0-9_-]{6,32})\/(state|events|join|confirm|message|offer|answer|checkout|paid|start)$/.exec(path);
    if (open) {
      const room = roomFor(open[1]);
      if (!room) return json(res, 404, { error: '这间房已经不在了，链接也许过期了。' });
      const action = open[2];

      if (action === 'state' && req.method === 'GET') return json(res, 200, publicState(room));

      if (action === 'events' && req.method === 'GET') {
        const role = seatOf(room, url.searchParams.get('role'), url.searchParams.get('token'));
        if (!role) return json(res, 403, { error: '不知道你是谁。' });
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no',
        });
        res.write('retry: 1500\n\n');
        res.write(`event: state\ndata: ${JSON.stringify(publicState(room))}\n\n`);
        room.sse.add(res);
        const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* gone */ } }, 25_000);
        req.on('close', () => { clearInterval(beat); room.sse.delete(res); });
        return;
      }

      if (action === 'join' && req.method === 'POST') {
        const body = await readBody(req);
        const role = seatOf(room, body.role, body.token);
        if (!role) return json(res, 403, { error: '这扇门不为这个身份打开。' });
        if (role === 'guest' && room.joined.host === false && room.joined.guest === true) return json(res, 409, { error: '这间房已经有两个人了。' });
        room.joined[role] = true;
        /* 接收人进来 = 可以开演了；晚到就从头再来一遍，两个人都看全 */
        if (role === 'guest' && room.filmUrl && (room.status === 'ready' || room.status === 'film' || room.status === 'confirm')) {
          room.confirm = { host: null, guest: null };
          startFilmWindow(room, 'guest');
        } else if (room.status === 'waiting' && room.joined.host && room.joined.guest) {
          tell(room);
        } else {
          tell(room);
        }
        return json(res, 200, { ok: true, role, state: publicState(room) });
      }

      /* 顾客点「是」：建一张 29.9 元的订单，等站长确认到账 */
      if (action === 'checkout' && req.method === 'POST') {
        const body = await readBody(req);
        const role = seatOf(room, body.role, body.token);
        if (role !== 'host') return json(res, 403, { error: '只有发起链接的人可以充值。' });
        if (room.status !== 'waiting') return json(res, 409, { error: '现在不是充值的时候。' });
        if (!room.order || room.order.status === 'cancelled' || room.order.status === 'failed') createOrder(room);
        let payment = null;
        if (ZHIFU) {
          const channel = String(body.channel || 'alipay') === 'wechat' ? 'wechat' : 'alipay';
          try { payment = await createZhifuPayment(room, channel); } catch (e) { payment = { error: e instanceof Error ? e.message : String(e) }; }
        } else if (XUNHU) {
          try { payment = await createXunhuPayment(room); } catch (e) { payment = { error: e instanceof Error ? e.message : String(e) }; }
        }
        tell(room);
        return json(res, 200, { order: { id: room.order.id, amount: room.order.amount, status: room.order.status }, payment });
      }

      /* 顾客点「我已完成付款」：进入待确认，不调模型 */
      if (action === 'paid' && req.method === 'POST') {
        const body = await readBody(req);
        const role = seatOf(room, body.role, body.token);
        if (role !== 'host') return json(res, 403, { error: '只有发起链接的人可以确认。' });
        if (!room.order) return json(res, 409, { error: '还没有订单。' });
        if (room.order.status === 'awaiting') {
          room.order.status = 'review';
          room.order.reviewAt = Date.now();
          void pushPaid(room);
        }
        tell(room);
        return json(res, 200, { order: { id: room.order.id, amount: room.order.amount, status: room.order.status } });
      }

      /* 客户看过服务须知、点确认之后，才真正开始生成 */
      if (action === 'start' && req.method === 'POST') {
        const body = await readBody(req);
        const role = seatOf(room, body.role, body.token);
        if (role !== 'host') return json(res, 403, { error: '只有发起链接的人可以确认。' });
        if (!room.order || room.order.status !== 'paid') return json(res, 409, { error: '还没确认到账。' });
        if (room.filmUrl) return json(res, 200, { ok: true });
        beginPaidFilm(room);
        return json(res, 200, { ok: true, orderId: room.order.id });
      }
      if (action === 'confirm' && req.method === 'POST') {
        const body = await readBody(req);
        const role = seatOf(room, body.role, body.token);
        if (!role) return json(res, 403, { error: '这扇门不为这个身份打开。' });
        if (room.status !== 'confirm') return json(res, 409, { error: '现在还不是时候。' });
        room.confirm[role] = body.yes === true;
        if (body.yes !== true) { decline(room); return json(res, 200, { ok: true, status: room.status }); }
        if (room.confirm.host === true && room.confirm.guest === true) startChat(room);
        else tell(room);
        return json(res, 200, { ok: true, status: room.status });
      }


      /* 发起方 60 秒内可以发起「关系复原胶」 */
      if (action === 'offer' && req.method === 'POST') {
        const body = await readBody(req);
        const role = seatOf(room, body.role, body.token);
        if (!role) return json(res, 403, { error: '这扇门不为这个身份打开。' });
        if (role !== 'host') return json(res, 403, { error: '只有发起链接的人可以发起复原胶。' });
        if (room.status !== 'offer') return json(res, 409, { error: '现在不能发起。' });
        if (Date.now() > (room.offerDeadline || 0)) return json(res, 409, { error: '一分钟已经过去了。' });
        room.status = 'asking';
        room.askDeadline = Date.now() + 120_000;
        room.timers.push(setTimeout(() => {
          if (room.status === 'asking') { room.result = '好好爱自己，好好生活'; room.status = 'result'; tell(room); }
        }, 120_200));
        tell(room);
        return json(res, 200, { ok: true });
      }

      /* 接收方 2 分钟内选择 */
      if (action === 'answer' && req.method === 'POST') {
        const body = await readBody(req);
        const role = seatOf(room, body.role, body.token);
        if (!role) return json(res, 403, { error: '这扇门不为这个身份打开。' });
        if (role !== 'guest') return json(res, 403, { error: '这一步只能接收方选。' });
        if (room.status !== 'asking') return json(res, 409, { error: '现在没有在等你选。' });
        const choice = String(body.choice || '');
        room.result = choice === 'yes' ? '恭喜重归于好' : choice === 'think' ? '相遇不易，请珍惜彼此' : '好好爱自己，好好生活';
        room.status = 'result';
        tell(room);
        return json(res, 200, { ok: true, result: room.result });
      }

      if (action === 'message' && req.method === 'POST') {
        const body = await readBody(req);
        const role = seatOf(room, body.role, body.token);
        if (!role) return json(res, 403, { error: '这扇门不为这个身份打开。' });
        if (room.status !== 'chat') return json(res, 409, { error: '房间里现在很安静。' });
        const text = String(body.text ?? '').replace(/\s+$/g, '').slice(0, 500);
        if (!text.trim()) return json(res, 200, { ok: true, empty: true });
        const judged = judge(text);
        if (!judged.ok) {
          /* only the sender hears of it: nothing is forwarded, nothing is rewritten, no button is offered */
          return json(res, 200, { ok: true, soft: true });
        }
        room.messages.push({ id: randomBytes(6).toString('base64url'), from: role, name: role === 'host' ? room.names.me : room.names.partner, text, at: Date.now() });
        if (room.messages.length > 500) room.messages.splice(0, room.messages.length - 500);
        send(room, 'message', room.messages.at(-1));
        return json(res, 200, { ok: true, id: room.messages.at(-1)?.id });
      }
      return json(res, 405, { error: '不是这个动作。' });
    }

    if (path === '/owner' || path === '/owner.html') return serveStatic(req, res, '/owner.html');
    if (path === '/' || path === '/index.html' || /^\/r\/[A-Za-z0-9_-]{6,32}\/?$/.test(path)) {
      return serveStatic(req, res, '/index.html');
    }
    if (path.startsWith('/api/')) return json(res, 404, { error: '没有这个接口。' });
    return serveStatic(req, res, path);
  } catch (e) {
    const said = /** @type {any} */ (e);
    if (!res.headersSent) json(res, said?.status ?? 500, { error: said?.message ?? '出了点小状况，再试一次。' });
    else try { res.end(); } catch { /* gone */ }
  }
});

/* old rooms go, with the words in them */
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL) { clearTimers(room); rooms.delete(id); for (const res of room.sse) { try { res.end(); } catch { /* gone */ } } }
  }
}, 10 * 60_000).unref?.();

server.listen(PORT, '0.0.0.0', () => {
  const nets = Object.values(networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal);
  const addresses = [...new Set(nets.map((n) => n.address))];
  console.log(`关系复原胶  ·  http://localhost:${PORT}`);
  for (const address of addresses) console.log(`              http://${address}:${PORT}  （同一个 Wi-Fi 下的手机打开这个）`);
});
/** Windows：系统自带的中文 OCR（PowerShell）。 */
function ocrWindows(image, out) {
  return new Promise((ok) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'tools', 'ocr.ps1'), image, out], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { try { ps.kill(); } catch { /* gone */ } ok(''); }, 60_000);
    ps.on('exit', () => { clearTimeout(timer); ok(existsSync(out) ? readFileSync(out, 'utf8') : ''); });
    ps.on('error', () => { clearTimeout(timer); ok(''); });
  });
}

/** Linux（云上）：tesseract + chi_sim，把 TSV 里的字框拼回一行行。 */
function ocrTesseract(image, bytes) {
  return new Promise((ok) => {
    const size = pngSize(bytes);
    const child = spawn('tesseract', [image, 'stdout', '-l', 'chi_sim+eng', '--psm', '6', 'tsv'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => { /* 引擎日志不需要 */ });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } ok(''); }, 60_000);
    child.on('error', () => { clearTimeout(timer); ok(''); });
    child.on('exit', () => {
      clearTimeout(timer);
      const rows = out.split(/\r?\n/).slice(1).map((line) => line.split('\t')).filter((cells) => cells.length >= 12 && cells[0] === '5' && cells[11].trim());
      const groups = new Map();
      for (const cells of rows) {
        const key = `${cells[1]}-${cells[2]}-${cells[3]}-${cells[4]}`;
        const left = Number(cells[6]);
        const top = Number(cells[7]);
        const w = Number(cells[8]);
        const h = Number(cells[9]);
        const g = groups.get(key) ?? { x: left, y: top, right: left + w, bottom: top + h, words: [] };
        g.x = Math.min(g.x, left);
        g.y = Math.min(g.y, top);
        g.right = Math.max(g.right, left + w);
        g.bottom = Math.max(g.bottom, top + h);
        g.words.push(cells[11].trim());
        groups.set(key, g);
      }
      const lines = [...groups.values()].map((g) => ({ x: g.x, y: g.y, w: g.right - g.x, h: g.bottom - g.y, text: g.words.join(' ') }));
      ok(JSON.stringify({ width: size.width, height: size.height, lines }));
    });
  });
}

/** PNG 头里量宽高；量不到就返回 0。 */
function pngSize(buf) {
  try {
    if (buf && buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
      const view = new DataView(buf.buffer, buf.byteOffset || 0, buf.byteLength);
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
  } catch { /* 不是 PNG */ }
  return { width: 0, height: 0 };
}
