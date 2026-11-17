/**
 * 从各个应用导出来的聊天记录，认出来，再变成这个项目认识的「谁：说了什么」。
 *
 * 微信和 QQ 都没有给外部程序读聊天记录的接口（本地库是加密的），抖音、快手干脆没有导出：
 * 能拿到手的，是它们自己（或它们的电脑版）导出的 .txt / .html / .mht，和截图。
 * 这里做的事就是：认出这是哪一家的导出、是哪一种排版，把消息拆出来，补上时间和说话人。
 *
 * 认不出来也绝不硬猜：返回 generic，让原来的「名字：内容」解析接手；再不行就交给贴进来的人自己改。
 */
import { createHash } from 'node:crypto';

/** 一个文件的名字和字节 → 文字：BOM 优先，其次 UTF-8，最后按 GBK 再试一次（微信 QQ 的老导出常是 GBK）。 */
export function decode(buffer) {
  if (!buffer?.length) return '';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer);
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer);
  let start = 0;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) start = 3;
  const bytes = buffer.subarray(start);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { try { return new TextDecoder('gbk').decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); } }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”', hellip: '…', mdash: '—' };

/** HTML（或 MHT 里那段 HTML）→ 一行一行的纯文字：块级标签断行，实体还原，脚本样式丢掉。 */
export function stripHtml(html) {
  const text = String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<(p|div|li|tr|h[1-6]|section|article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)))
    .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);
  return text.split('\n').map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean).join('\n');
}

/** MHT（QQ「导出消息记录」的一种）：取出里面那段 HTML，quoted-printable 解回来。 */
export function htmlFromMht(raw) {
  const body = String(raw ?? '');
  const split = body.split(/^--/m).find((part) => /content-type:\s*text\/html/i.test(part));
  if (!split) return '';
  const headerEnd = split.indexOf('\n\n');
  const payload = headerEnd >= 0 ? split.slice(headerEnd + 2) : split;
  const unquoted = payload
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  /* quoted-printable 解出来是字节；按 UTF-8 / GBK 再读一次 */
  const bytes = Buffer.from(unquoted, 'latin1');
  return decode(bytes);
}

const DATE = '(\\d{4}[-/年]\\d{1,2}[-/月]\\d{1,2}日?(?:[ T]\\d{1,2}:\\d{2}(?::\\d{2})?)?)';
const TIME_ONLY = /^(\d{1,2}:\d{2}(?::\d{2})?)$/;
const DATE_LINE = new RegExp(`^${DATE}$`);
const DATE_NAME = new RegExp(`^${DATE}[\\s\\u3000]+(.{1,40}?)\\s*(?:\\(\\d{4,12}\\))?\\s*$`);
const NAME_DATE = new RegExp(`^(.{1,40}?)\\s*(?:\\(\\d{4,12}\\))?[\\s\\u3000]+${DATE}\\s*$`);

/** 时间写成一个能被后面的解析认出的样子：2023-05-01 20:13。 */
export function normalizeTime(raw) {
  if (!raw) return '';
  const m = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::\d{2})?)?/.exec(String(raw).trim());
  if (!m) return '';
  const pad = (v) => String(v).padStart(2, '0');
  return `${m[1]}-${pad(m[2])}-${pad(m[3])}${m[4] != null ? ` ${pad(m[4])}:${m[5]}` : ''}`;
}

/** 每一条消息：一行时间+名字，后面跟着它的内容（微信、QQ 的 txt 导出都是这样）。 */
export function parseBlockLog(lines) {
  const out = [];
  let current = null;
  const push = () => { if (current && current.text.trim()) out.push({ ...current, text: current.text.trim() }); };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    /* 只看时间的行：下一行是名字，再下面是内容 */
    if (DATE_LINE.test(line)) { push(); current = { at: normalizeTime(line), who: '', text: '' }; continue; }
    if (TIME_ONLY.test(line) && current && !current.text && !current.who) { current.at = current.at || ''; continue; }
    const dateName = DATE_NAME.exec(line);
    if (dateName) { push(); current = { at: normalizeTime(dateName[1]), who: dateName[2].trim(), text: '' }; continue; }
    const nameDate = NAME_DATE.exec(line);
    if (nameDate) { push(); current = { at: normalizeTime(nameDate[2]), who: nameDate[1].trim(), text: '' }; continue; }
    if (current) {
      if (!current.who && line.length <= 40 && !/[：:]/.test(line)) { current.who = line; continue; }
      current.text += `${current.text ? '\n' : ''}${line}`;
    }
  }
  push();
  return out;
}

/** 「名字：内容」或「名字 内容」的普通文本（这一家的导出没有时间也行）。 */
export function parseNameLog(lines) {
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(.{1,30}?)[\s\u3000]*[：:][\s\u3000]*(.*)$/.exec(line);
    if (!m) {
      if (out.length) out.at(-1).text += `\n${line}`;
      continue;
    }
    out.push({ at: '', who: m[1].trim(), text: m[2].trim() });
  }
  return out.filter((m) => m.text);
}

/** 一家的导出认成什么：谁说的、什么时候、说了什么。 */
export function detect(raw, filename = '') {
  const name = String(filename).toLowerCase();
  const text = String(raw ?? '');
  const isMht = /\.mht$/i.test(name) || /^mime-version:/im.test(text.slice(0, 4000));
  const isHtml = !isMht && (/\.html?$/i.test(name) || /<html[\s>]/i.test(text.slice(0, 4000)));
  const plain = isMht ? stripHtml(htmlFromMht(text)) : isHtml ? stripHtml(text) : text;
  const lines = plain.replace(/\r\n?/g, '\n').split('\n');

  /* QQ 的导出会在名字后面带 QQ 号；微信的常常是一个时间一行 */
  const qqMark = lines.some((l) => /^.{1,40}\(\d{4,12}\)\s*$/.test(l.trim())) || /qq/i.test(name) || /消息记录|消息管理器/.test(text.slice(0, 600));
  const wechatMark = /微信|wechat/i.test(filename) || /^[\s\u3000]*微信[\s\u3000]*$/m.test(plain) || lines.some((l) => DATE_LINE.test(l.trim()));

  let messages = parseBlockLog(lines);
  let app = 'generic';
  let format = 'text';
  if (isMht) format = 'mht';
  else if (isHtml) format = 'html';
  if (messages.length >= 2) {
    app = qqMark ? 'qq' : wechatMark ? 'wechat' : 'generic';
    format = `${format}-block`;
  } else {
    messages = parseNameLog(lines);
    if (messages.length >= 2) { app = qqMark ? 'qq' : wechatMark ? 'wechat' : 'generic'; format = `${format}-line`; }
  }
  if (messages.length < 1) return { app: 'unknown', format, messages: [], text: '', note: '没认出这个文件里的对话。' };
  const log = messages.map((m) => `${m.at ? `${m.at} ` : ''}${m.who || 'TA'}：${m.text.replace(/\n/g, ' ')}`).join('\n');
  return {
    app,
    format,
    messages,
    text: log,
    note: `${APP_NAMES[app] ?? '聊天记录'} · ${messages.length} 条`,
  };
}

const APP_NAMES = { wechat: '微信', qq: 'QQ', douyin: '抖音', kuaishou: '快手', generic: '聊天记录', unknown: '未知格式' };

/** 一行行的「谁：什么」→ 这个项目的聊天记录（名字里带括号的 QQ 号去掉）。 */
export function toProjectLog(messages) {
  return messages.map((m) => `${m.who || 'TA'}：${m.text.replace(/\n/g, ' ')}`).join('\n');
}

/** 导入文件的内容指纹：同一份文件贴两次时，界面可以说一句「这份好像已经导入过了」。 */
export function fingerprint(buffer) {
  return createHash('sha1').update(buffer).digest('hex').slice(0, 12);
}
