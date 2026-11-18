/**
 * 把一支闪片渲染成真正的 MP4：ffmpeg 合成，缓慢淡入淡出、烧字幕、配一条 A 小调钢琴 BGM。
 * 字幕走 ASS（比 drawtext 稳，中文、换行、淡入淡出都不用转义），画面是暗色底 + 胶片颗粒 + 暗角。
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const RATE = 44100;

/* ── 一条很轻的钢琴 BGM：A 小调分解和弦，带衰减和底噪 ── */
function wav(seconds, mood) {
  const total = Math.max(1, Math.floor(seconds * RATE));
  const data = new Int16Array(total);
  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const prog = mood === 'melancholic'
    ? [[57, 60, 64], [52, 55, 59], [53, 57, 60], [55, 59, 62], [57, 60, 64]]
    : [[57, 60, 64], [53, 57, 60], [48, 60, 64], [52, 55, 59], [57, 60, 64]];
  const beat = 0.62;
  const notes = [];
  for (let bar = 0; bar * 4 * beat < seconds; bar += 1) {
    const chord = prog[bar % prog.length];
    for (let k = 0; k < 4; k += 1) {
      notes.push({ at: bar * 4 * beat + k * beat, note: chord[k % chord.length] + (k === 3 ? 12 : 0), dur: 1.9, gain: k === 0 ? 0.5 : 0.3 });
    }
    notes.push({ at: bar * 4 * beat, note: chord[0] - 12, dur: 2.6, gain: 0.34 });
  }
  for (const n of notes) {
    const start = Math.floor(n.at * RATE);
    const len = Math.floor(n.dur * RATE);
    if (start >= total) continue;
    const f = midi(n.note);
    for (let i = 0; i < len && start + i < total; i += 1) {
      const t = i / RATE;
      const env = Math.exp(-2.6 * t) * Math.min(1, t * 120);
      const v = Math.sin(2 * Math.PI * f * t) * 0.7 + Math.sin(2 * Math.PI * f * 2 * t) * 0.18 + Math.sin(2 * Math.PI * f * 3 * t) * 0.06;
      data[start + i] += Math.max(-1, Math.min(1, v * env * n.gain)) * 12000;
    }
  }
  let seed = 7;
  for (let i = 0; i < total; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] += ((seed / 0x7fffffff) - 0.5) * 90;
  }
  const buf = Buffer.alloc(44 + total * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + total * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(total * 2, 40);
  for (let i = 0; i < total; i += 1) buf.writeInt16LE(Math.max(-32767, Math.min(32767, data[i])), 44 + i * 2);
  return buf;
}

const stamp = (sec) => {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = (s % 60).toFixed(2).padStart(5, '0');
  return String(h) + ':' + String(m).padStart(2, '0') + ':' + rest;
};

const clean = (text, max) => String(text || '').replace(/[\r\n]+/g, ' ').replace(/[{}]/g, '').slice(0, max);

/** 一份 ASS 字幕：标题、旁白、一句真实的话，各自淡入淡出。 */
function ass(story, duration, fontName) {
  const actLen = duration / 5;
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Title,' + fontName + ',92,&H00FFFFFF,&H00FFFFFF,&H00100814,&H64000000,1,0,0,0,100,100,8,0,1,0,0,8,80,80,230,1',
    'Style: Note,' + fontName + ',40,&H00A0D9FF,&H00A0D9FF,&H00100814,&H64000000,0,0,0,0,100,100,3,0,1,0,0,8,80,80,150,1',
    'Style: Line,' + fontName + ',46,&H00FFFFFF,&H00FFFFFF,&H0014080F,&H96000000,0,0,0,0,100,100,1,0,1,18,0,2,80,80,60,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = [];
  const acts = Array.isArray(story.acts) ? story.acts.slice(0, 5) : [];
  for (let i = 0; i < 5; i += 1) {
    const act = acts[i] || {};
    const start = i * actLen;
    const end = start + actLen;
    const title = clean(act.title || ['初识', '靠近', '分享', '沉默', '重逢'][i], 8);
    const note = clean(act.note || '', 20);
    events.push('Dialogue: 0,' + stamp(start) + ',' + stamp(end) + ',Title,,0,0,0,,{\\fad(650,650)}' + title);
    if (note) events.push('Dialogue: 0,' + stamp(start + 0.15) + ',' + stamp(end) + ',Note,,0,0,0,,{\\fad(650,650)}' + note);
    const bubble = act.bubbles && act.bubbles[0] && act.bubbles[0].text;
    if (bubble) {
      const line = clean(bubble, 24);
      events.push('Dialogue: 1,' + stamp(start + 1.1) + ',' + stamp(end - 0.2) + ',Line,,0,0,0,,{\\fad(500,500)}' + line);
    }
  }
  return head.concat(events).join('\n');
}

function run(ffmpeg, args, cwd, timeoutMs) {
  return new Promise((ok) => {
    const child = spawn(ffmpeg, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } ok({ ok: false, err: 'timeout' }); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); ok({ ok: false, err: 'spawn' }); });
    child.on('exit', (code) => { clearTimeout(timer); ok({ ok: code === 0, err }); });
  });
}

/**
 * story → MP4。opts: { ffmpeg, outDir, fontName, timeoutMs }
 * 返回 { file, seconds, id }。
 */
export async function renderFilm(story, opts) {
  const ffmpeg = opts.ffmpeg;
  const outDir = opts.outDir;
  if (!ffmpeg || !existsSync(ffmpeg)) throw new Error('没有找到 ffmpeg');
  mkdirSync(outDir, { recursive: true });

  const duration = Math.max(15, Math.min(180, (Number(story.duration) || 15000) / 1000));
  const id = randomBytes(6).toString('hex');
  const dir = join(outDir, '.work-' + id);
  mkdirSync(dir, { recursive: true });

  const bgm = 'bgm.wav';
  writeFileSync(join(dir, bgm), wav(duration, story.music && story.music.mood));
  writeFileSync(join(dir, 'subs.ass'), ass(story, duration, opts.fontName || 'Microsoft YaHei'), 'utf8');

  /* 本地相对路径 + cwd，避开 Windows 盘符冒号在滤镜里的转义问题 */
  const graph = 'color=c=0x0d0812:s=1080x1920:d=' + duration.toFixed(3) + ':r=30[base];'
    + '[base]subtitles=subs.ass:fontsdir=.,noise=alls=6:allf=t,vignette=PI/5[outv];'
    + '[0:a]volume=0.95[a]';

  const outFile = join(outDir, id + '.mp4');
  const args = [
    '-y',
    '-i', bgm,
    '-filter_complex', graph,
    '-map', '[outv]', '-map', '[a]',
    '-t', String(duration),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
    outFile,
  ];
  const res = await run(ffmpeg, args, dir, opts.timeoutMs || 210_000);
  rmSync(dir, { recursive: true, force: true });
  if (!res.ok) throw new Error('渲染失败：' + String(res.err).split('\n').slice(-3).join(' '));
  return { file: outFile, seconds: duration, id };
}
