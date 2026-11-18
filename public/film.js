/**
 * 十五秒的回忆闪片：canvas 实时绘制，不加载任何视频文件。
 * 五个镜头各三秒：初识、靠近、分享、冷淡、重逢。画面里只有两个用颜色区分的剪影小人（没有脸），
 * 几枚从聊天记录里拆出来的气泡，加上胶片颗粒、光晕和暗角。
 * 音乐由 music.js 按五个镜头的情绪现场合成，和画面同一时间轴。
 */
(function () {
  'use strict';

  const DURATION = 15000;
  /** 片长跟着信息密度走：15 秒起，最长 3 分钟。 */
  const durationOf = (story) => Math.max(15000, Math.min(180000, Number(story && story.duration) || 15000));
  const ACT = 3000;
  const W = 1080;
  const H = 1920;

  /* 每个镜头一套颜色：天空、地面、两个人的颜色、光晕、题目 */
  const ACTS = [
    { bg: ['#1a1226', '#3a1b30'], glow: 'rgba(255,170,130,0.30)', a: '#ff8f6b', b: '#ffd7a4', title: '初识', note: '第一句话，总是很轻' },
    { bg: ['#171126', '#2a1740'], glow: 'rgba(255,150,120,0.28)', a: '#ff8f6b', b: '#79d6ff', title: '靠近', note: '消息开始密起来' },
    { bg: ['#20122c', '#3a1730'], glow: 'rgba(255,205,170,0.34)', a: '#ffa07c', b: '#93e4ff', title: '分享', note: '把一整天都讲给对方听' },
    { bg: ['#101018', '#1c1a24'], glow: 'rgba(120,130,160,0.16)', a: '#8f8a95', b: '#8799a3', title: '沉默', note: '有些话停在了对话框' },
    { bg: ['#1a1226', '#3b1a31'], glow: 'rgba(255,185,150,0.30)', a: '#ff8f6b', b: '#ffd7a4', title: '重逢', note: '回到第一次说话的那天' },
  ];

  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const ease = (v) => (v < 0.5 ? 2 * v * v : 1 - Math.pow(-2 * v + 2, 2) / 2);
  const easeOut = (v) => 1 - Math.pow(1 - v, 4);
  const lerp = (a, b, k) => a + (b - a) * k;

  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  /* 预渲染的颗粒贴图，避免每帧都算噪声 */
  let grainCanvas = null;
  function grain() {
    if (grainCanvas) return grainCanvas;
    const size = 220;
    grainCanvas = document.createElement('canvas');
    grainCanvas.width = grainCanvas.height = size;
    const g = grainCanvas.getContext('2d');
    const img = g.createImageData(size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 120 + Math.random() * 135;
      img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return grainCanvas;
  }

  const hex = (c) => { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
  const rgb = (c, al = 1) => `rgba(${c[0]},${c[1]},${c[2]},${al})`;

  /** 背景：渐变天幕 + 柔光 + 漂浮的光点 + 暗角，构图始终居中。 */
  function backdrop(ctx, w, h, act, next, k, t) {
    const top = mix(hex(act.bg[0]), hex(next.bg[0]), k);
    const bottom = mix(hex(act.bg[1]), hex(next.bg[1]), k);
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, rgb(top));
    sky.addColorStop(0.62, rgb(mix(top, bottom, 0.55)));
    sky.addColorStop(1, rgb(bottom));
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    /* 一团会呼吸的光，像黄昏从窗外照进来 */
    const breathe = 0.86 + Math.sin(t / 1400) * 0.14;
    const cx = w * 0.5 + Math.sin(t / 5200) * w * 0.05;
    const cy = h * 0.42 + Math.cos(t / 6100) * h * 0.02;
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, w * 0.72 * breathe);
    glow.addColorStop(0, act.glow);
    glow.addColorStop(0.55, 'rgba(255,190,160,0.06)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    /* 浮尘：几十个小点，慢慢往上飘 */
    const r = rng(4 + Math.floor(t / 3000) * 7);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 28; i += 1) {
      const x = r() * w;
      const base = r();
      const y = ((base * h - t * (0.02 + r() * 0.03)) % h + h) % h;
      const radius = 1.2 + r() * 3.4;
      ctx.fillStyle = `rgba(255,214,180,${0.05 + r() * 0.12})`;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    /* 暗角，让视线落在中间 */
    const vig = ctx.createRadialGradient(w / 2, h * 0.52, h * 0.18, w / 2, h * 0.52, h * 0.78);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);
  }

  /** 一条会呼吸的弧线（手臂、腿、身体），比直线柔和得多。 */
  function limb(ctx, x0, y0, x1, y1, bend, width) {
    const mx = (x0 + x1) / 2 + bend;
    const my = (y0 + y1) / 2 + Math.abs(bend) * 0.2;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(mx, my, x1, y1);
    ctx.stroke();
  }

  /**
   * 一个小人：圆头、身体、两条胳膊、两条腿。没有五官。
   * pose: idle / wave / lean / point / away / hug
   */
  function figure(ctx, x, y, s, color, pose, phase, face) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s * (face < 0 ? -1 : 1), s);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const bob = Math.sin(phase * 2.1) * 3;
    const headY = -104 + bob;
    const hip = 8 + bob * 0.5;

    /* 影子 */
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(0, 14, 46, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    /* 头 */
    ctx.beginPath();
    ctx.arc(0, headY, 33, 0, Math.PI * 2);
    ctx.fill();

    /* 身体 */
    limb(ctx, 0, headY + 30, 0, hip, 0, 11);

    /* 胳膊 */
    const armSwing = Math.sin(phase * 2.1) * 0.16;
    if (pose === 'wave') {
      limb(ctx, -2, headY + 44, -46, headY + 6, -18, 9);
      limb(ctx, 2, headY + 44, 52, headY - 34 + Math.sin(phase * 7) * 8, 14, 9);
    } else if (pose === 'lean') {
      limb(ctx, -2, headY + 44, -34, hip - 12, -10, 9);
      limb(ctx, 2, headY + 44, 40, hip - 26, 16, 9);
    } else if (pose === 'point') {
      limb(ctx, -2, headY + 44, -38, headY + 8, -14, 9);
      limb(ctx, 2, headY + 44, 62, headY + 22, 10, 9);
    } else if (pose === 'away') {
      limb(ctx, -2, headY + 44, -22, hip - 6, -6, 9);
      limb(ctx, 2, headY + 44, 22, hip - 6, 6, 9);
    } else if (pose === 'hug') {
      limb(ctx, -2, headY + 44, 44, headY + 30, 12, 9);
      limb(ctx, 2, headY + 44, -44, headY + 30, -12, 9);
    } else {
      limb(ctx, -2, headY + 44, -30 + armSwing * 20, hip - 8, -10, 9);
      limb(ctx, 2, headY + 44, 30 + armSwing * 20, hip - 8, 10, 9);
    }

    /* 腿 */
    const step = pose === 'away' ? 0 : Math.sin(phase * 2.1) * 6;
    limb(ctx, 0, hip, -16 - step, 10, -3, 10);
    limb(ctx, 0, hip, 16 + step, 10, 3, 10);

    ctx.restore();
  }

  /** 圆角矩形路径（气泡、光框共用）。 */
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  /** 气泡：圆角矩形 + 小尾巴，文字按时间一个个打出来。 */
  function bubble(ctx, x, y, text, opts) {
    const size = opts.size || 34;
    const maxWidth = opts.maxWidth || 520;
    const side = opts.side || 'left';
    opts.reveal = clamp(opts.reveal == null ? 1 : opts.reveal, 0, 1);
    const shown = text.slice(0, Math.max(0, Math.round(text.length * opts.reveal)));
    if (!shown) return;

    ctx.save();
    ctx.font = `500 ${size}px "PingFang SC","Microsoft YaHei",system-ui,sans-serif`;
    const words = Array.from(shown);
    const lines = [];
    let line = '';
    for (const ch of words) {
      if (ctx.measureText(line + ch).width > maxWidth) { lines.push(line); line = ch; } else line += ch;
    }
    if (line) lines.push(line);

    const padX = 30;
    const padY = 24;
    const lineH = size * 1.55;
    const w = Math.min(maxWidth, Math.max(...lines.map((l) => ctx.measureText(l).width))) + padX * 2;
    const h = lines.length * lineH + padY * 2 - (lineH - size);
    const bx = side === 'right' ? x - w : x;
    const by = y - h;

    ctx.globalAlpha = opts.alpha == null ? 1 : opts.alpha;
    const tailX = side === 'right' ? bx + w - 46 : bx + 46;

    ctx.beginPath();
    const r = 26;
    ctx.moveTo(bx + r, by);
    ctx.lineTo(bx + w - r, by);
    ctx.quadraticCurveTo(bx + w, by, bx + w, by + r);
    ctx.lineTo(bx + w, by + h - r);
    ctx.quadraticCurveTo(bx + w, by + h, bx + w - r, by + h);
    ctx.lineTo(bx + r, by + h);
    ctx.quadraticCurveTo(bx, by + h, bx, by + h - r);
    ctx.lineTo(bx, by + r);
    ctx.quadraticCurveTo(bx, by, bx + r, by);
    ctx.closePath();
    ctx.fillStyle = opts.fill || 'rgba(20,12,22,0.82)';
    ctx.fill();
    ctx.strokeStyle = opts.edge || 'rgba(255,214,180,0.22)';
    ctx.lineWidth = 2;
    ctx.stroke();

    /* 尾巴 */
    ctx.beginPath();
    ctx.moveTo(tailX - 12, by + h);
    ctx.lineTo(tailX + (side === 'right' ? 20 : -20), by + h + 18);
    ctx.lineTo(tailX + 16, by + h);
    ctx.closePath();
    ctx.fillStyle = opts.fill || 'rgba(20,12,22,0.82)';
    ctx.fill();

    ctx.fillStyle = opts.ink || 'rgba(255,244,238,0.94)';
    lines.forEach((l, i) => ctx.fillText(l, bx + padX, by + padY + size + i * lineH - (lineH - size) / 2));
    ctx.restore();
  }

  /** 片名：大一点、疏一点，慢慢浮上来。 */
  function title(ctx, text, sub, w, h, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,240,232,0.95)';
    ctx.font = '600 84px "Songti SC","STSong","Microsoft YaHei",serif';
    ctx.letterSpacing = '14px';
    ctx.fillText(text, w / 2, h * 0.155);
    ctx.font = '400 30px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = 'rgba(255,214,190,0.68)';
    ctx.letterSpacing = '4px';
    if (sub) ctx.fillText(sub, w / 2, h * 0.155 + 62);
    ctx.restore();
  }


/* ── 头像演片：把人像当成演员，慢推、呼吸、边缘柔化、暖光贴边 ── */
const portraitImages = new Map();
function portraitReady(set) {
  return set.every((src) => {
    let item = portraitImages.get(src);
    if (!item) { item = new Image(); item.src = src; item.onload = () => { item.ready = true; }; portraitImages.set(src, item); }
    return item.ready;
  });
}

function portrait(ctx, src, x, y, w, h, alpha, tilt, t, side) {
  const img = portraitImages.get(src);
  if (!img || !img.ready) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.rotate(tilt);

  /* 呼吸：极慢的推拉，避免“贴图”感 */
  const breath = 1 + Math.sin(t / 2600 + side * 1.4) * 0.012;
  ctx.scale(breath, breath);

  /* 椭圆形柔边遮罩 */
  ctx.beginPath();
  ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.save();
  ctx.clip();
  const s = Math.max(w / img.width, h / img.height);
  ctx.drawImage(img, -(img.width * s) / 2, -(img.height * s) / 2, img.width * s, img.height * s);
  /* 边缘压暗，让轮廓融进背景 */
  const fade = ctx.createRadialGradient(0, 0, Math.min(w, h) * 0.32, 0, 0, Math.max(w, h) * 0.55);
  fade.addColorStop(0, 'rgba(0,0,0,0)');
  fade.addColorStop(1, 'rgba(8,4,10,0.92)');
  ctx.fillStyle = fade;
  ctx.fillRect(-w / 2, -h / 2, w, h);
  /* 一道缓慢扫过的高光 */
  const sweep = ((t / 9000 + side * 0.4) % 1) * 2 - 1;
  const light = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
  light.addColorStop(0, 'rgba(255,220,190,0)');
  light.addColorStop(0.5, `rgba(255,220,190,${0.10 + Math.abs(sweep) * 0.05})`);
  light.addColorStop(1, 'rgba(255,220,190,0)');
  ctx.fillStyle = light;
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.restore();

  /* 暖色轮廓光 */
  ctx.beginPath();
  ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,190,150,0.22)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

/* ── 照片：当成底片，慢慢推近，压一层暗色让字看得清 ── */
const photoCache = new Map();
function photoReady(src) {
  let item = photoCache.get(src);
  if (!item) { item = new Image(); item.src = src; item.onload = () => { item.ready = true; }; photoCache.set(src, item); }
  return item.ready;
}
function drawPhoto(ctx, src, w, h, k, pulse) {
  const img = photoCache.get(src);
  if (!img || !img.ready) return false;
  const cw = w * 0.74;
  const ch = h * 0.44;
  const bob = Math.sin((k * 6 + pulse * 2) * 1.4) * 6 + (pulse || 0) * 14;
  const tilt = (pulse || 0) * 0.012;

  ctx.save();
  /* 卡片阴影 */
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 18;
  ctx.translate(w / 2, h * 0.5 + bob);
  ctx.rotate(tilt);
  roundRect(ctx, -cw / 2, -ch / 2, cw, ch, 34);
  ctx.fillStyle = 'rgba(20,12,24,0.55)';
  ctx.fill();
  ctx.restore();

  /* 图片本体 */
  ctx.save();
  ctx.translate(w / 2, h * 0.5 + bob);
  ctx.rotate(tilt);
  roundRect(ctx, -cw / 2, -ch / 2, cw, ch, 34);
  ctx.clip();
  const s = Math.max(cw / img.width, ch / img.height) * (1.02 + (pulse || 0) * 0.03);
  ctx.drawImage(img, -(img.width * s) / 2, -(img.height * s) / 2, img.width * s, img.height * s);
  /* 卡片内的一层柔光，像贴纸 */
  const glow = ctx.createLinearGradient(0, -ch / 2, 0, ch / 2);
  glow.addColorStop(0, 'rgba(255,255,255,0.10)');
  glow.addColorStop(0.55, 'rgba(255,255,255,0)');
  glow.addColorStop(1, 'rgba(255,190,150,0.10)');
  ctx.fillStyle = glow;
  ctx.fillRect(-cw / 2, -ch / 2, cw, ch);
  ctx.restore();

  /* 卡片的描边 */
  ctx.save();
  ctx.translate(w / 2, h * 0.5 + bob);
  ctx.rotate(tilt);
  ctx.strokeStyle = 'rgba(255,214,180,0.35)';
  ctx.lineWidth = 3;
  roundRect(ctx, -cw / 2, -ch / 2, cw, ch, 34);
  ctx.stroke();
  ctx.restore();

  /* 鼓点上的小星点 */
  if ((pulse || 0) > 0.05) {
    ctx.save();
    ctx.globalAlpha = (pulse || 0) * 0.9;
    for (let n = 0; n < 8; n += 1) {
      const a = (n / 8) * Math.PI * 2 + k;
      const r = Math.min(w, h) * (0.28 + (pulse || 0) * 0.08);
      const x = w / 2 + Math.cos(a) * r;
      const y = h * 0.5 + Math.sin(a) * r * 0.8;
      ctx.fillStyle = n % 2 ? 'rgba(255,214,180,0.9)' : 'rgba(180,200,255,0.9)';
      ctx.beginPath();
      ctx.arc(x, y, 3 + (pulse || 0) * 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /* 顶部/底部压暗，让字幕读得清 */
  const veil = ctx.createLinearGradient(0, 0, 0, h);
  veil.addColorStop(0, 'rgba(8,5,10,0.5)');
  veil.addColorStop(0.3, 'rgba(8,5,10,0.05)');
  veil.addColorStop(0.75, 'rgba(8,5,10,0.1)');
  veil.addColorStop(1, 'rgba(8,5,10,0.55)');
  ctx.fillStyle = veil;
  ctx.fillRect(0, 0, w, h);
  return true;
}

/** 动漫感的小花瓣，慢慢飘。 */
function petals(ctx, w, h, t) {
  const r = rng(11);
  ctx.save();
  for (let i = 0; i < 16; i += 1) {
    const x = ((r() * w + Math.sin(t / 2400 + i) * 40) % w + w) % w;
    const y = ((r() * h + t * (0.02 + r() * 0.03)) % h);
    const s = 3 + r() * 6;
    ctx.globalAlpha = 0.12 + r() * 0.2;
    ctx.fillStyle = i % 3 === 0 ? 'rgba(255,200,210,0.9)' : 'rgba(255,230,210,0.8)';
    ctx.beginPath();
    ctx.ellipse(x, y, s, s * 0.6, t / 3000 + i, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** 动漫字幕条：底部一条半透明带，字居中，淡入淡出。 */
function subtitle(ctx, w, h, text, alpha) {
  if (!text || alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  const band = ctx.createLinearGradient(0, h * 0.8, 0, h * 0.9);
  band.addColorStop(0, 'rgba(6,4,8,0)');
  band.addColorStop(0.35, 'rgba(6,4,8,0.55)');
  band.addColorStop(1, 'rgba(6,4,8,0)');
  ctx.fillStyle = band;
  ctx.fillRect(0, h * 0.8, w, h * 0.1);
  ctx.font = '500 40px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = 16;
  ctx.fillStyle = 'rgba(255,248,240,0.95)';
  ctx.fillText(text.slice(0, 34), w / 2, h * 0.862);
  ctx.restore();
}

/** 参考「VIBE 大赏」那种横屏动画：星空、月亮、一道弧、两个人、巨大的字。 */
function drawScene(ctx, w, h, story, i, local, t, photos, cuts, total) {
  const top = h * 0.12;
  const sw = w;
  const sh = Math.round(w * 9 / 16);
  ctx.save();
  ctx.translate(0, top);

  /* 星空 */
  const sky = ctx.createLinearGradient(0, 0, 0, sh);
  sky.addColorStop(0, '#1a1030');
  sky.addColorStop(0.55, '#2a1230');
  sky.addColorStop(1, '#0d0714');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, sw, sh);
  const r = rng(23);
  for (let n = 0; n < 90; n += 1) {
    const x = r() * sw;
    const y = r() * sh * 0.8;
    const a = 0.25 + r() * 0.6;
    ctx.fillStyle = 'rgba(255,240,230,' + a.toFixed(2) + ')';
    ctx.beginPath();
    ctx.arc(x, y, 1 + r() * 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  /* 月亮 */
  ctx.save();
  ctx.globalAlpha = 0.9;
  const mx = sw * 0.16;
  const my = sh * 0.22;
  const halo = ctx.createRadialGradient(mx, my, 0, mx, my, 120);
  halo.addColorStop(0, 'rgba(255,245,220,0.5)');
  halo.addColorStop(1, 'rgba(255,245,220,0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(mx, my, 120, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffe9b8';
  ctx.beginPath();
  ctx.arc(mx, my, 34, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1a1030';
  ctx.beginPath();
  ctx.arc(mx + 14, my - 10, 30, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  /* 地平线 */
  const groundY = sh * 0.78;
  ctx.beginPath();
  ctx.moveTo(0, groundY + 40);
  ctx.quadraticCurveTo(sw / 2, groundY - 90, sw, groundY + 40);
  ctx.lineTo(sw, sh);
  ctx.lineTo(0, sh);
  ctx.closePath();
  const g2 = ctx.createLinearGradient(0, groundY - 60, 0, sh);
  g2.addColorStop(0, '#241a3a');
  g2.addColorStop(1, '#0c0714');
  ctx.fillStyle = g2;
  ctx.fill();

  /* 弧线连接两个人 */
  const tone = (story.acts && story.acts[i] && story.acts[i].tone) || 'warm';
  const spread = tone === 'break' ? 0.12 : tone === 'cool' ? 0.18 : 0.24;
  const leftX = sw * spread;
  const rightX = sw * (1 - spread);
  const peopleY = groundY - 30;
  ctx.save();
  const arcColor = tone === 'break' ? 'rgba(255,110,110,0.7)' : tone === 'cool' ? 'rgba(130,175,255,0.75)' : 'rgba(255,120,190,0.85)';
  ctx.strokeStyle = arcColor;
  ctx.lineWidth = 3;
  ctx.shadowColor = arcColor;
  ctx.setLineDash(tone === 'break' ? [14, 16] : []);
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.moveTo(leftX, peopleY - 60);
  ctx.quadraticCurveTo(sw / 2, peopleY - (tone === 'break' ? 120 : 240), rightX, peopleY - 60);
  ctx.stroke();
  ctx.restore();

  /* 两个人：Q 版照片做成发光的圆 */
  const drawFace = (src, x, y, size, tint) => {
    const img = photoCache.get(src);
    ctx.save();
    ctx.shadowColor = tint;
    ctx.shadowBlur = 30;
    ctx.fillStyle = tint;
    ctx.beginPath();
    ctx.arc(x, y, size / 2 + 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    if (img && img.ready) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, size / 2, 0, Math.PI * 2);
      ctx.clip();
      const s = Math.max(size / img.width, size / img.height);
      ctx.drawImage(img, x - (img.width * s) / 2, y - (img.height * s) / 2, img.width * s, img.height * s);
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(x, y, size / 2, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 3;
    ctx.stroke();
  };
  if (photos[0]) drawFace(photos[0], leftX, peopleY - 70, 130, 'rgba(255,140,190,0.8)');
  if (photos[1] || photos[0]) drawFace(photos[1] || photos[0], rightX, peopleY - 70, 130, 'rgba(140,220,255,0.8)');

  /* 大字：这一镜的标题 + 统计 */
  const act = (story.acts && story.acts[i]) || {};
  ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 24;
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.font = '700 96px "Songti SC","STSong","Microsoft YaHei",serif';
  ctx.fillText((act.title || ['初见', '靠近', '分享', '沉默', '回望'][i]).slice(0, 6), sw / 2, sh * 0.54);
  ctx.font = '400 34px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillStyle = 'rgba(255,214,190,0.8)';
  if (act.note) ctx.fillText(String(act.note).slice(0, 22), sw / 2, sh * 0.54 + 58);

  /* 统计数字：消息条数 + 跨度，像参考片里的「9,860 km」 */
  const stats = story.stats || {};
  const big = String(stats.messages || 0);
  ctx.font = '800 120px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fillText(big, sw / 2 - 40, sh * 0.2);
  ctx.font = '600 42px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillStyle = 'rgba(255,214,120,0.95)';
  ctx.fillText('条消息', sw / 2 + 90, sh * 0.2);

  /* 底部字幕 */
  const said = act.bubbles && act.bubbles[0] && act.bubbles[0].text;
  if (said) {
    ctx.font = '500 40px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    const tw = Math.min(sw * 0.8, ctx.measureText(said).width + 60);
    roundRect(ctx, (sw - tw) / 2, sh - 120, tw, 60, 30);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,248,242,0.95)';
    ctx.fillText(String(said).slice(0, 30), sw / 2, sh - 78);
  }

  ctx.restore();

  /* 上下黑边 */
  ctx.fillStyle = '#07050a';
  ctx.fillRect(0, 0, w, top);
  ctx.fillRect(0, top + sh, w, h - top - sh);

  /* 鼓点白闪 */
  if (cuts && cuts.length) {
    let j = 0;
    while (j + 1 < cuts.length && cuts[j + 1] <= t) j += 1;
    const since = t - cuts[j];
    if (since < 130) {
      ctx.fillStyle = 'rgba(255,246,238,' + ((1 - since / 130) * 0.45).toFixed(3) + ')';
      ctx.fillRect(0, 0, w, h);
    }
  }
}

  function draw(canvas, story, t) {
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const w = W;
    const h = H;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    /* 有照片：走横屏动画（星空/弧线/两个人/大字），像参考片那样 */
    const scenePhotos = story && Array.isArray(story.images) ? story.images : [];
    if (scenePhotos.length) {
      const totalD = durationOf(story);
      const lenD = totalD / 5;
      const idxD = Math.min(4, Math.floor(t / lenD));
      const localD = clamp((t - idxD * lenD) / lenD, 0, 1);
      const cutsD = story.beats && story.beats.length > 1 ? story.beats.filter((b) => b > 0 && b < totalD) : [];
      drawScene(ctx, w, h, story, idxD, localD, t, scenePhotos, cutsD, totalD);
      return;
    }

    const total = durationOf(story);
    const actLen = total / 5;
    const i = Math.min(4, Math.floor(t / actLen));
    const local = clamp((t - i * actLen) / actLen, 0, 1);
    const saidAct = story && story.acts && story.acts[i];
    const pal = story && story.palette;
    const act = Object.assign({}, ACTS[i], { title: (saidAct && saidAct.title) || ACTS[i].title, note: (saidAct && saidAct.note) || ACTS[i].note });
    if (pal) { act.bg = [pal.bg1, pal.bg2]; act.a = pal.a; act.b = pal.b; }
    const nextI = Math.min(4, i + 1);
    const blend = clamp((local - 0.86) / 0.14, 0, 1);
    const next = Object.assign({}, ACTS[nextI]);
    if (pal) { next.bg = [pal.bg1, pal.bg2]; next.a = pal.a; next.b = pal.b; }
    const r = rng((story && story.seed ? story.seed : 7) + i * 31);

    /* 镜头：缓慢推近，最后一镜轻轻拉开 */
    const push = i === 4 ? lerp(1.06, 1, easeOut(local)) : lerp(1, 1.07, ease(local));
    ctx.save();
    ctx.translate(w / 2, h * 0.55);
    ctx.scale(push, push);
    ctx.translate(-w / 2, -h * 0.55);

    const photoList = story && Array.isArray(story.images) ? story.images : [];
    const cuts = story && Array.isArray(story.beats) && story.beats.length > 1
      ? story.beats.filter((b) => b > 0 && b < total)
      : [];
    let painted = false;
    let flash = 0;
    if (photoList.length) {
      let idx = 0;
      let progress = 0;
      if (cuts.length > 1) {
        let k = 0;
        while (k + 1 < cuts.length && cuts[k + 1] <= t) k += 1;
        const start = cuts[k];
        const end = cuts[k + 1] ?? total;
        idx = k % photoList.length;
        progress = Math.min(1, Math.max(0, (t - start) / Math.max(1, end - start)));
        if (t - start < 130) flash = 1 - (t - start) / 130;
      } else {
        const per = total / photoList.length;
        idx = Math.min(photoList.length - 1, Math.floor(t / per));
        progress = (t % per) / per;
      }
      let pulse = 0;
      if (cuts.length > 1) {
        let j = 0;
        while (j + 1 < cuts.length && cuts[j + 1] <= t) j += 1;
        pulse = Math.max(0, 1 - (t - cuts[j]) / 260);
      }
      if (photoReady(photoList[idx])) { painted = drawPhoto(ctx, photoList[idx], w, h, progress, pulse); if (painted) petals(ctx, w, h, t); }
    }
    if (!painted) backdrop(ctx, w, h, act, next, blend, t);

    /* 地面的一条微光，把两个人放在同一个空间里 */
    const floorY = h * 0.735;
    const floor = ctx.createLinearGradient(0, floorY - 120, 0, floorY + 240);
    floor.addColorStop(0, 'rgba(255,200,170,0)');
    floor.addColorStop(0.5, 'rgba(255,200,170,0.06)');
    floor.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = floor;
    ctx.fillRect(0, floorY - 120, w, 380);

    /* 两个人的位置：越到后面越近，沉默那镜各自退开 */
    const gap = i === 3 ? lerp(250, 320, ease(local)) : i === 2 ? 200 : lerp(300, 190, ease(local));
    const bob = Math.sin(t / 900) * 6;
    const baseY = floorY + bob;
    const poses = [
      ['wave', 'idle'],
      ['lean', 'wave'],
      ['point', 'lean'],
      ['away', 'away'],
      ['hug', 'hug'],
    ][i];

    const avatarSet = story && Array.isArray(story.avatars) ? story.avatars : [];
    if (avatarSet.length === 2 && portraitReady(avatarSet)) {
      const near = i === 4 ? 1 : i === 2 ? 0.9 : 0.6;
      const leftX = w * 0.315 - lerp(30, 0, near);
      const rightX = w * 0.685 + lerp(30, 0, near);
      const size = i === 3 ? 250 : 280;
      const dim = i === 3 ? 0.5 : 1;
      const rise = Math.sin(t / 1500) * 5;
      portrait(ctx, avatarSet[0], leftX, baseY - 215 + rise, size, size * 1.2, 0.94 * dim, -0.03, t, 0);
      portrait(ctx, avatarSet[1], rightX, baseY - 225 - rise, size * 1.06, size * 1.26, 0.96 * dim, 0.03, t, 1);
    } else {
      /* 没有头像时：不画火柴人，做一块「光框」——两个色点像两个人的位置，留白更像海报 */
      const frameW = w * 0.62;
      const frameH = h * 0.34;
      const fx = (w - frameW) / 2;
      const fy = h * 0.42;
      ctx.save();
      ctx.globalAlpha = 0.6;
      const panel = ctx.createLinearGradient(fx, fy, fx + frameW, fy + frameH);
      panel.addColorStop(0, 'rgba(255,190,150,0.10)');
      panel.addColorStop(1, 'rgba(120,150,255,0.06)');
      ctx.fillStyle = panel;
      roundRect(ctx, fx, fy, frameW, frameH, 36);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,214,180,0.16)';
      ctx.lineWidth = 1.5;
      roundRect(ctx, fx, fy, frameW, frameH, 36);
      ctx.stroke();

      const pulse = 1 + Math.sin(t / 900) * 0.04;
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = act.a;
      ctx.beginPath();
      ctx.arc(w * 0.4, fy + frameH * 0.52, 46 * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = act.b;
      ctx.beginPath();
      ctx.arc(w * 0.6, fy + frameH * 0.52, 46 / pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    /* 气泡：每镜最多一句，来自真实聊天记录 */
    const said = story && story.acts && story.acts[i] && story.acts[i].bubbles && story.acts[i].bubbles[0];
    if (said && said.text && painted) {
      const subA = clamp((local - 0.12) / 0.22, 0, 1) * (1 - clamp((local - 0.86) / 0.12, 0, 1));
      subtitle(ctx, w, h, said.text, subA);
    }

    if (said && said.text && !painted) {
      const who = said.who && story.me && said.who !== story.me ? 'right' : 'left';
      const reveal = clamp((local - 0.18) / 0.42, 0, 1);
      const alpha = clamp((local - 0.12) / 0.2, 0, 1) * (i === 3 ? 0.72 : 1);
      const bx = who === 'right' ? w * 0.9 : w * 0.1;
      const by = floorY - 260 - (i === 2 ? 40 : 0);
      bubble(ctx, bx, by, said.text, {
        side: who, reveal, alpha, size: 34, maxWidth: 560,
        ink: i === 3 ? 'rgba(210,214,220,0.86)' : 'rgba(255,244,238,0.95)',
        fill: i === 3 ? 'rgba(24,24,30,0.8)' : 'rgba(22,12,24,0.82)',
        edge: i === 3 ? 'rgba(160,170,190,0.18)' : 'rgba(255,214,180,0.24)',
      });
    }

    /* 片名 */
    const titleIn = clamp(local / 0.18, 0, 1);
    const titleOut = clamp((local - 0.82) / 0.12, 0, 1);
    ctx.globalAlpha = 1;
    title(ctx, act.title, act.note, w, h, easeOut(titleIn) * (1 - titleOut));

    if (flash > 0) {
      ctx.fillStyle = 'rgba(255,246,238,' + (flash * 0.5).toFixed(3) + ')';
      ctx.fillRect(0, 0, w, h);
    }

    /* 换镜：白闪一下，像旧胶片接片 */
    if (blend > 0) {
      ctx.fillStyle = `rgba(255,240,230,${blend * 0.16})`;
      ctx.fillRect(0, 0, w, h);
    }

    /* 颗粒 + 轻微暗角抖动 */
    const g = grain();
    ctx.save();
    ctx.globalAlpha = 0.06;
    const off = Math.floor((t / 45) % 220);
    for (let x = -220; x < w + 220; x += 220) {
      for (let y = -220; y < h + 220; y += 220) {
        ctx.drawImage(g, x + off * 0.4, y + off);
      }
    }
    ctx.restore();

    /* 底部细线：15 秒的进度，像放映机的边缘 */
    const barY = h - 96;
    ctx.fillStyle = 'rgba(255,230,210,0.16)';
    ctx.fillRect(w * 0.18, barY, w * 0.64, 2);
    ctx.fillStyle = 'rgba(255,190,150,0.75)';
    ctx.fillRect(w * 0.18, barY, (w * 0.64) * clamp(t / total, 0, 1), 2);
    ctx.fillStyle = 'rgba(255,230,210,0.42)';
    ctx.font = '400 22px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(Math.round(total / 1000) + ' 秒 · 阿呦的回忆胶', w / 2, barY + 44);

    ctx.restore();
  }

  window.GlueFilm = { draw, DURATION, durationOf, titleOf: (i) => ACTS[Math.max(0, Math.min(4, i))].title };
})();
