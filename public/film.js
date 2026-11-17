/**
 * 十五秒的回忆闪片：一支用 canvas 画出来的短片，不加载任何视频文件。
 *
 * 五个镜头各三秒 —— 初识打招呼、慢慢靠近、分享日常、冷淡与沉默、定格回到初遇。
 * 画面里只有两个用颜色区分的简约小人（没有脸、没有真人），几枚从聊天记录里拆出来的气泡，
 * 加上胶片颗粒、柔焦和暗角。同一个房间的两个人看的是同一段画面，因为两边都用同一个开始时刻来算 t。
 */
(function () {
  'use strict';

  const DURATION = 15_000;
  const ACT = 3_000;
  const W = 1080;
  const H = 1920;

  /** 每个镜头的一套颜色：底、光、两个人的颜色 */
  const ACTS = [
    { bg: ['#1a1024', '#2a1530'], glow: 'rgba(255, 190, 150, 0.22)', a: '#ff8a6b', b: '#ffd9a0', title: '初 识' },
    { bg: ['#171026', '#241436'], glow: 'rgba(255, 154, 120, 0.26)', a: '#ff8a6b', b: '#6bd5ff', title: '靠 近' },
    { bg: ['#20122a', '#2e1533'], glow: 'rgba(255, 200, 170, 0.30)', a: '#ff9a7c', b: '#8fe0ff', title: '分 享' },
    { bg: ['#141220', '#1d1626'], glow: 'rgba(120, 130, 160, 0.14)', a: '#9d8f92', b: '#8fa6ad', title: '沉 默' },
    { bg: ['#1a1024', '#2b1631'], glow: 'rgba(255, 196, 160, 0.26)', a: '#ff8a6b', b: '#ffd9a0', title: '初 遇' },
  ];

  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const ease = (v) => v < 0.5 ? 2 * v * v : 1 - Math.pow(-2 * v + 2, 2) / 2;
  const easeOut = (v) => 1 - Math.pow(1 - v, 3);
  const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
  function hex(c) { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  const rgb = (c, alpha = 1) => `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;

  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  /** 一个简笔小人：圆头、身体、两条胳膊、两条腿。没有五官。 */
  function figure(ctx, x, y, scale, color, pose, turn = 0) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.rotate(turn);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = 'round';
    ctx.lineWidth = 9;
    /* 头 */
    ctx.beginPath();
    ctx.arc(0, -96, 34, 0, Math.PI * 2);
    ctx.fill();
    /* 脖子与身体 */
    ctx.beginPath();
    ctx.moveTo(0, -62);
    ctx.lineTo(0, 6);
    ctx.stroke();
    /* 胳膊 */
    const arm = pose === 'wave' ? -0.9 : pose === 'open' ? -0.45 : pose === 'away' ? 0.25 : 0.55;
    ctx.beginPath();
    ctx.moveTo(0, -42);
    ctx.lineTo(-42, pose === 'open' ? -52 : -6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -42);
    ctx.lineTo(42, pose === 'wave' ? -96 : pose === 'open' ? -52 : arm * 40 - 6);
    ctx.stroke();
    /* 腿 */
    ctx.beginPath();
    ctx.moveTo(0, 6);
    ctx.lineTo(-26, 74);
    ctx.moveTo(0, 6);
    ctx.lineTo(26, 74);
    ctx.stroke();
    ctx.restore();
  }

  /** 一枚聊天气泡：圆角、一个小尾巴，最多两行字。 */
  function bubble(ctx, x, y, text, opts = {}) {
    if (!text) return;
    const { side = 'left', alpha = 1, color = '#ffd9a0', inks = '#2a1720', size = 38 } = opts;
    if (alpha <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `500 ${size}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    const max = 13;
    const lines = [];
    let rest = String(text);
    while (rest.length && lines.length < 2) {
      if (rest.length <= max) { lines.push(rest); break; }
      let cut = max;
      const punct = Math.max(rest.lastIndexOf('，', max), rest.lastIndexOf(' ', max));
      if (punct >= max * 0.5) cut = punct + 1;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest && lines.length === 2) lines[1] = lines[1].slice(0, Math.max(1, max - 1)) + '…';
    const width = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 56;
    const height = lines.length * (size + 12) + 30;
    const bx = side === 'left' ? x : x - width;
    const by = y;
    const r = 26;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(bx, by, width, height, r);
    else ctx.rect(bx, by, width, height);
    ctx.fillStyle = color;
    ctx.fill();
    /* 尾巴 */
    ctx.beginPath();
    const tail = side === 'left' ? bx + 34 : bx + width - 34;
    ctx.moveTo(tail, by + height - 2);
    ctx.lineTo(tail + (side === 'left' ? -10 : 10), by + height + 18);
    ctx.lineTo(tail + (side === 'left' ? 16 : -16), by + height - 2);
    ctx.fill();
    ctx.fillStyle = inks;
    lines.forEach((line, i) => ctx.fillText(line, bx + 28, by + 40 + i * (size + 12)));
    ctx.restore();
  }

  function heart(ctx, x, y, size, color, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y + size * 0.3);
    ctx.bezierCurveTo(x, y, x - size, y, x - size, y + size * 0.35);
    ctx.bezierCurveTo(x - size, y + size * 0.75, x, y + size * 1.0, x, y + size * 1.3);
    ctx.bezierCurveTo(x, y + size * 1.0, x + size, y + size * 0.75, x + size, y + size * 0.35);
    ctx.bezierCurveTo(x + size, y, x, y, x, y + size * 0.3);
    ctx.fill();
    ctx.restore();
  }

  /** 画一帧：`t` 是从短片开始算的毫秒。 */
  function draw(canvas, story, t) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const at = clamp(t, 0, DURATION - 1);
    const actIndex = Math.min(4, Math.floor(at / ACT));
    const local = (at - actIndex * ACT) / ACT;
    const act = ACTS[actIndex];
    const next = ACTS[Math.min(4, actIndex + 1)];
    const blend = actIndex < 4 ? clamp((local - 0.86) / 0.14) : 0;
    const bgA = mix(hex(act.bg[0]), hex(next.bg[0]), blend);
    const bgB = mix(hex(act.bg[1]), hex(next.bg[1]), blend);
    const rand = rng((story?.seed ?? 7) + actIndex * 31);

    /* 底 */
    const base = ctx.createLinearGradient(0, 0, 0, H);
    base.addColorStop(0, rgb(bgA));
    base.addColorStop(1, rgb(bgB));
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);

    /* 一团会呼吸的光 */
    const glow = ctx.createRadialGradient(W * 0.5, H * (0.42 + 0.02 * Math.sin(local * Math.PI)), 40, W * 0.5, H * 0.45, W * 0.95);
    glow.addColorStop(0, act.glow);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    /* 尘埃 */
    for (let i = 0; i < 46; i++) {
      const x = rand() * W;
      const y = (rand() * H + t * (0.012 + rand() * 0.02)) % H;
      const r = 1 + rand() * 2.4;
      ctx.globalAlpha = 0.12 + rand() * 0.3;
      ctx.fillStyle = '#ffe9d6';
      ctx.beginPath();
      ctx.arc(x, H - y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    /* 两个人的位置：靠近、并肩、拉开、再回到最初 */
    const cx = W / 2;
    const groundY = H * 0.66;
    const scale = 3.1;
    let ax = W * 0.27;
    let bx = W * 0.73;
    let poseA = 'wave';
    let poseB = 'idle';
    let alpha = 1;

    if (actIndex === 1) {
      const k = ease(clamp(local / 0.75));
      ax = W * (0.27 + 0.12 * k);
      bx = W * (0.73 - 0.12 * k);
      poseA = k > 0.5 ? 'idle' : 'wave';
      poseB = k > 0.5 ? 'open' : 'idle';
      /* 两点之间连起一串小圆点：越聊越多 */
      const dots = Math.floor(6 + 10 * k);
      for (let i = 1; i < dots; i++) {
        const p = i / dots;
        const x = ax + (bx - ax) * p;
        const y = groundY - 330 + Math.sin(p * Math.PI) * -34;
        ctx.globalAlpha = 0.18 + 0.5 * k * Math.sin(Math.PI * p);
        ctx.fillStyle = '#ffd9a0';
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else if (actIndex === 2) {
      ax = W * 0.39;
      bx = W * 0.61;
      poseA = 'open';
      poseB = 'open';
      /* 小小的心 */
      for (let i = 0; i < 7; i++) {
        const k = (local + i * 0.17) % 1;
        heart(ctx, cx + (rand() - 0.5) * W * 0.5, groundY - 520 - k * 260, 16 + rand() * 8, 'rgba(255, 170, 150, 0.85)', (1 - k) * 0.55);
      }
    } else if (actIndex === 3) {
      ax = W * 0.3;
      bx = W * 0.7;
      poseA = 'away';
      poseB = 'away';
      alpha = 0.72;
      /* 一道细小的裂纹 */
      ctx.strokeStyle = 'rgba(200, 210, 230, 0.22)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - 30, groundY - 380);
      ctx.lineTo(cx + 6, groundY - 300);
      ctx.lineTo(cx - 14, groundY - 236);
      ctx.lineTo(cx + 24, groundY - 160);
      ctx.stroke();
    } else if (actIndex === 4) {
      const k = easeOut(clamp(local / 0.45));
      ax = W * (0.3 - 0.03 * k);
      bx = W * (0.7 + 0.03 * k);
      poseA = 'wave';
      poseB = 'idle';
      /* 定格：一道柔和的白光扫过，然后停住 */
      if (local > 0.3) {
        const flash = clamp((local - 0.3) / 0.18) * (1 - clamp((local - 0.5) / 0.4) * 0.4);
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, `rgba(255, 236, 220, ${0.16 * flash})`);
        g.addColorStop(0.5, 'rgba(255,236,220,0)');
        g.addColorStop(1, `rgba(255, 210, 190, ${0.12 * flash})`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      }
    }

    /* 两个人（先用柔焦画一层，再清楚一层，像隔着旧胶片） */
    const drawPair = (blur) => {
      ctx.save();
      if (blur && 'filter' in ctx) ctx.filter = `blur(${blur}px)`;
      ctx.globalAlpha = alpha;
      figure(ctx, ax, groundY, scale, act.a, poseA, actIndex === 3 ? -0.1 : 0);
      figure(ctx, bx, groundY, scale, act.b, poseB, actIndex === 3 ? 0.1 : 0);
      ctx.restore();
    };
    drawPair(10);
    drawPair(0);
    ctx.globalAlpha = 1;

    /* 气泡：这个镜头里那一句真的说过的话 */
    const said = story?.acts?.[actIndex]?.bubbles?.[0];
    if (said && said.text) {
      const inAt = actIndex === 0 ? 0.18 : 0.24;
      const outAt = actIndex === 3 ? 0.82 : 0.9;
      const a = clamp((local - inAt) / 0.1) * (1 - clamp((local - outAt) / 0.1));
      const side = said.who && story?.me && said.who !== story.me ? 'right' : 'left';
      const x = side === 'left' ? W * 0.19 : W * 0.81;
      const y = groundY - 470 - 18 * Math.sin(local * Math.PI * 2);
      bubble(ctx, x, y, said.text, { side, alpha: a * 0.96, color: actIndex === 3 ? '#c9cfd8' : '#ffd9a0', inks: '#2a1720' });
    }

    /* 镜头标题 */
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = '#ffe9dc';
    ctx.font = '500 34px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.letterSpacing = '10px';
    ctx.fillText(act.title, W / 2, H - 96);
    ctx.restore();

    /* 胶片颗粒与暗角 */
    for (let i = 0; i < 900; i++) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      ctx.globalAlpha = Math.random() * 0.05;
      ctx.fillStyle = Math.random() > 0.5 ? '#fff' : '#000';
      ctx.fillRect(x, y, 1.6, 1.6);
    }
    ctx.globalAlpha = 1;
    const vig = ctx.createRadialGradient(W / 2, H / 2, W * 0.28, W / 2, H / 2, W * 0.95);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, W, H);
  }

  window.GlueFilm = { draw, DURATION, titleOf: (i) => ACTS[Math.max(0, Math.min(4, i))].title };
})();
