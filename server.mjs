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
import { randomBytes } from 'node:crypto';
import { networkInterfaces, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from './lib/analyzer.mjs';
import { judge } from './lib/filter.mjs';
import { logFromOcr } from './lib/ocr.mjs';
import { decode, detect } from './lib/importers.mjs';
import { designFilm, hasLegacyKey, localDesign, saveKey, testAgent, MODEL } from './lib/agent.mjs';
import { renderFilm } from './lib/render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
const PORT = Number(process.env.PORT || 5178);
const FILM_MS = Number(process.env.GLUE_FILM_MS || 15_000);
const CHAT_MS = Number(process.env.GLUE_CHAT_MS || 20 * 60_000);
const ROOM_TTL = 2 * 60 * 60_000;
const LEAD_MS = 1500;

/** @typedef {{ id: string, hostToken: string, createdAt: number, names: { me: string, partner: string }, story: any, status: 'waiting'|'film'|'confirm'|'declined'|'chat'|'ended', joined: { host: boolean, guest: boolean }, confirm: { host: boolean|null, guest: boolean|null }, filmStart: number|null, chatEnd: number|null, messages: Array<{ id: string, from: 'host'|'guest', name: string, text: string, at: number }>, sse: Set<any>, timers: NodeJS.Timeout[] }} Room */

/** Every room, by its link's id. */
const rooms = new Map();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' };

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
    chatEnd: room.chatEnd,
    serverNow: now,
    story: room.story,
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

/** The film once both are in: a moment's lead, then 15 seconds counted by both pages on the same clock. */
function startFilm(room) {
  if (room.status !== 'waiting') return;
  room.status = 'film';
  room.filmStart = Date.now() + LEAD_MS;
  room.timers.push(setTimeout(() => {
    if (room.status !== 'film') return;
    room.status = 'confirm';
    tell(room);
  }, LEAD_MS + FILM_MS + 250));
  tell(room);
}

/** Both said yes: twenty minutes begin, and the words that were here (there are none yet) are cleared. */
function startChat(room) {
  if (room.status !== 'confirm') return;
  room.status = 'chat';
  room.messages = [];
  room.chatEnd = Date.now() + CHAT_MS;
  room.timers.push(setTimeout(() => {
    if (room.status !== 'chat') return;
    room.status = 'ended';
    room.messages = [];
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
            prompt: 'Turn this photo into a cute chibi cartoon character: big head, big eyes, small body, flat pastel colors, thick clean outline, sticker style, keep the person recognizable, plain soft background',
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
      const log = String(body.log ?? '');
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
      story.duration = mode === 'agent' ? seconds * 1000 : 30000;
      story.theme = theme;
      if (mode === 'plain') story.music = { root: 'A', tempo: 68, mood: 'warm', theme };
      else if (story.music) story.music.theme = theme;
      story.mode = mode;
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
        /* 请豆包当导演：它给分镜、颜色、音乐的性格；画面与声音还是本地的 */
        const userKey = String(body.agentKey ?? '').trim();
        const agentId = String(body.agentId ?? '').trim();
        const result = await designFilm(userKey, log, { me: story.me, partner: story.partner }, agentId, String(body.agentModel ?? ''));
        const spec = result.spec;
        const designed = spec ?? localDesign(story.seed, story.stats);
        story.fromAgent = Boolean(spec);
        story.agentNote = spec ? (agentId ? '豆包智能体定制' : '豆包定制') : (result.error ? ('豆包：' + result.error) : '没填 Key，先按本地的来');
        designed.acts.forEach((a, i) => {
          if (story.acts[i]) { story.acts[i].title = a.title; story.acts[i].note = a.note; }
        });
        story.palette = designed.palette;
        story.music = designed.music;
      }
      const id = randomBytes(9).toString('base64url');
      /** @type {Room} */
      const room = {
        id, hostToken: randomBytes(18).toString('base64url'), createdAt: Date.now(),
        names: { me: story.me, partner: story.partner }, story,
        status: 'waiting', joined: { host: false, guest: false }, confirm: { host: null, guest: null },
        filmStart: null, chatEnd: null, messages: [], sse: new Set(), timers: [],
      };
      rooms.set(id, room);
      return json(res, 201, { id, hostToken: room.hostToken });
    }

    const open = /^\/api\/rooms\/([A-Za-z0-9_-]{6,32})\/(state|events|join|confirm|message)$/.exec(path);
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
        if (room.joined.host && room.joined.guest && room.status === 'waiting') startFilm(room);
        else tell(room);
        return json(res, 200, { ok: true, role, state: publicState(room) });
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
