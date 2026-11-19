/**
 * 关系复原胶的页面逻辑：一间房，两个人，一支十五秒的短片，和之后的二十分钟。
 *
 * 页面自己不生成任何内容，也不替谁说话：它只是把房间的状态画出来 —— 等待、短片、确认、聊天、结束。
 * 两个页面看同一支片子，是因为两边都用房间里同一个开始时刻来算 t。
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const film = window.GlueFilm;
  const DURATION = film?.DURATION ?? 15000;
  const CACHE = 'glue.rooms';

  /** @type {any} */
  let room = { id: '', role: 'guest', token: '', state: null, offset: 0, sse: null, joined: false, raf: 0, tick: 0, readyTick: 0, seen: new Set(), tipTimer: 0, tipAt: 0, view: '', story: null, filmSrc: '', lastFilmStart: null };

  /* ── 小工具 ───────────────────────────────────────── */
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('on'), 2200);
  }
  function copy(text) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } finally { area.remove(); }
    return Promise.resolve();
  }
  function rooms() { try { return JSON.parse(localStorage.getItem(CACHE) ?? '{}'); } catch { return {}; } }
  function remember(id, token) { try { const all = rooms(); all[id] = token; localStorage.setItem(CACHE, JSON.stringify(all)); } catch { /* private mode */ } }
  function tokenFor(id) { const hash = new URLSearchParams(location.hash.slice(1)).get('h'); return hash || rooms()[id] || ''; }

  function stars() {
    const sky = $('sky');
    for (let i = 0; i < 26; i++) {
      const dot = document.createElement('i');
      dot.style.left = `${Math.random() * 100}%`;
      dot.style.top = `${20 + Math.random() * 80}%`;
      dot.style.animationDelay = `${Math.random() * 9}s`;
      dot.style.animationDuration = `${7 + Math.random() * 8}s`;
      sky.appendChild(dot);
    }
  }

  /* ── 路由 ─────────────────────────────────────────── */
  function start() {
    stars();
    const match = /^\/r\/([A-Za-z0-9_-]{6,32})\/?$/.exec(location.pathname);
    if (match) openRoom(match[1]);
    else home();
  }

  /* ── 导入：文件与截图 ─────────────────────────────── */
  function appendLog(text) {
    const area = $('log');
    const clean = String(text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
    if (!clean) return 0;
    area.value = area.value.trim() ? `${area.value.replace(/\s+$/, '')}\n${clean}` : clean;
    area.scrollTop = area.scrollHeight;
    return clean.length;
  }

  /** 文件交给服务端认格式（微信/QQ 的 txt、html、mht，GBK 也能读）；图片交给本机的 OCR。 */
  async function importFiles(files) {
    const list = [...(files ?? [])];
    if (!list.length) return;
    const texts = list.filter((f) => !/^image\//.test(f.type) && !/\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name));
    const images = list.filter((f) => !texts.includes(f));
    const state = $('importState');
    let added = 0;
    let note = '';
    try {
      if (texts.length) {
        state.textContent = '正在读文件…';
        state.classList.add('busy');
        for (const file of texts) {
          try {
            const res = await fetch('/api/import', {
              method: 'POST',
              headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) },
              body: file,
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) { toast(body.error ?? '这份文件没读出来。'); continue; }
            const before = added;
            added += appendLog(body.text);
            if (added > before) note = body.note;
          } catch (e) { toast(e instanceof Error ? e.message : '这份文件没读出来。'); }
        }
      }
      for (const [i, file] of images.entries()) {
        state.textContent = images.length > 1 ? `正在看第 ${i + 1}/${images.length} 张图…` : '正在看这张图…';
        state.classList.add('busy');
        const query = new URLSearchParams({ me: $('me').value, partner: $('partner').value });
        try {
          const res = await fetch(`/api/ocr?${query}`, { method: 'POST', headers: { 'content-type': file.type || 'image/png' }, body: file });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error ?? '这张图没有读出来。');
          added += appendLog(body.text);
        } catch (e) { toast(e instanceof Error ? e.message : '这张图没有读出来。'); }
      }
    } finally {
      state.textContent = '';
      state.classList.remove('busy');
    }
    if (added) toast(`已导入${note ? ` ${note}` : ` ${added} 个字`}，检查一下说话人和顺序`);
  }

  /** 四个应用：点一下把它叫到前面，人在它里面选好聊天，回到这里读这一屏。 */
  const APPS = { wechat: '微信', qq: 'QQ', douyin: '抖音', kuaishou: '快手' };

  function appStatus(text, busy = false) {
    const el = $('appState');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('busy', busy);
  }

  function showGuide(app) {
    const label = APPS[app];
    if (!label) return;
    document.querySelectorAll('.app').forEach((el) => el.classList.toggle('on', el.dataset.app === app));
    const guide = $('appGuide');
    guide.innerHTML = `<b>从${label}导入</b>`
      + `<p class="gline">① 点「打开${label}」，它就到最前面。</p>`
      + `<p class="gline">② 在${label}里选中要用的聊天内容，按 Ctrl+C 复制（手机上长按 → 复制）。</p>`
      + '<p class="gline">③ 回到这里点「粘贴导入」，内容就进来了。</p>'
      + `<div class="gbtns"><button type="button" class="btn small" id="appOpen">打开${label}</button>`
      + '<button type="button" class="btn small ghost" id="appPaste">粘贴导入</button></div>'
      + '<p class="hint busy" id="appState"></p>'
      + '<p class="hint">聊天库是加密的，我们不碰它；导入的是你自己选中并复制的那段话。也可以在输入框里直接 Ctrl+V 粘贴。</p>';
    guide.classList.remove('hidden');
    $('appOpen').addEventListener('click', async () => {
      appStatus('正在打开…', true);
      try {
        const res = await fetch('/api/apps/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: app }) });
        const body = await res.json().catch(() => ({}));
        appStatus(body.ok ? `已经打开：${body.title ?? label}。在里面选中消息复制，再回来点「粘贴导入」。` : (body.error ?? '没有打开。'));
      } catch (e) { appStatus(e instanceof Error ? e.message : '没有打开。'); }
    });
    $('appPaste').addEventListener('click', async () => {
      appStatus('正在读剪贴板…', true);
      try {
        const text = await navigator.clipboard.readText();
        if (!text?.trim()) throw new Error('剪贴板是空的：先在' + label + '里选中消息复制，再点一次。');
        const res = await fetch('/api/import', {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('剪贴板.txt') },
          body: text,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? '这段内容没有认出来，试试直接在输入框里粘贴。');
        const added = appendLog(body.text);
        appStatus(`导入 ${added} 个字（${body.note ?? label}）。`);
        toast(`已从${label}导入`);
      } catch (e) { appStatus(e instanceof Error ? e.message : '没有读出来。'); }
    });
  }
  /* 不再解析聊天记录：导入入口已移除，这里保留空函数，避免旧引用报错 */
  function bindImports() {}
  let mode = 'agent';
  const avatars = { me: '', peer: '' };
  const photos = [];
  /** 把解码后的音频转成 16kHz 单声道 WAV，体积小、服务器也认。 */
  function encodeWav(buffer) {
    try {
      const src = buffer.getChannelData(0);
      const rate = 16000;
      const ratio = buffer.sampleRate / rate;
      const len = Math.floor(src.length / ratio);
      const out = new ArrayBuffer(44 + len * 2);
      const view = new DataView(out);
      const write = (offset, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
      write(0, 'RIFF'); view.setUint32(4, 36 + len * 2, true); write(8, 'WAVE');
      write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      write(36, 'data'); view.setUint32(40, len * 2, true);
      for (let i = 0; i < len; i += 1) {
        const v = Math.max(-1, Math.min(1, src[Math.floor(i * ratio)]));
        view.setInt16(44 + i * 2, v * 0x7fff, true);
      }
      return new Blob([out], { type: 'audio/wav' });
    } catch (e) { return null; }
  }
  /** 用使用者自己的 Key 把真人照片变成 Q 版；失败就保留原图。 */
  async function toChibi(dataUrl, kind) {
    if (!dataUrl) return '';
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const res = await fetch('/api/qstyle', {
        method: 'POST',
        headers: { 'content-type': blob.type || 'image/jpeg', 'x-kind': kind === 'scene' ? 'scene' : 'portrait' },
        body: blob,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return '';
      return body.url || '';
    } catch (e) { return ''; }
  }

  /** 把前几张照片并行转 Q 版。 */
  async function stylePhotos(state) {
    if (!photos.length) return;
    if (!key || !photos.length) return;
    const indexes = photos.map((_, i) => i).slice(0, 4);
    if (state) state.textContent = '正在把照片变成 Q 版…';
    const results = await Promise.all(indexes.map((i) => toChibi(photos[i], 'scene')));
    let ok = 0;
    results.forEach((url, k) => { if (url) { photos[indexes[k]] = url; ok += 1; } });
    if (state) state.textContent = '已选 ' + photos.length + ' 张' + (ok ? '（' + ok + ' 张 Q 版）' : '（Q 版生成失败，用原图）');
  }
  /** 从音频里找鼓点：20ms 一窗算能量，超过均值 1.6 倍且明显跃升就算一下。 */
  function detectBeats(buffer) {
    try {
      const data = buffer.getChannelData(0);
      const win = Math.floor(buffer.sampleRate * 0.02);
      const energies = [];
      for (let i = 0; i + win < data.length; i += win) {
        let sum = 0;
        for (let j = 0; j < win; j += 4) { const v = data[i + j]; sum += v * v; }
        energies.push(sum);
      }
      if (!energies.length) return [];
      const avg = energies.reduce((a, b) => a + b, 0) / energies.length;
      const out = [];
      let last = -1000;
      for (let i = 1; i < energies.length; i += 1) {
        const ms = i * 20;
        if (energies[i] > avg * 1.6 && energies[i] > energies[i - 1] * 1.25 && ms - last > 420) {
          out.push(ms);
          last = ms;
        }
      }
      return out.slice(0, 200);
    } catch (e) { return []; }
  }
  let musicUrl = '';
  let beats = [];
  let bgm = null;
  function stopBgm() { if (bgm) { try { bgm.pause(); } catch (e) { /* 忽略 */ } bgm = null; } }
  function startBgm(url) {
    stopBgm();
    if (!url) return;
    try { bgm = new Audio(url); bgm.loop = true; bgm.volume = 0.9; bgm.play().catch(() => {}); } catch (e) { bgm = null; }
  }


  /** 照片缩到 720px 的竖幅，够快剪用。 */
  function readPhoto(file) {
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const w = 720;
        const h = Math.round((img.height / img.width) * w) || 1280;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(cartoonify(canvas).toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => resolve('');
      img.src = url;
    });
  }

  /** Q 版滤镜：提饱和、压色阶（posterize），让真人照片变成偏卡通的大色块。 */
  function cartoonify(canvas) {
    try {
      const ctx = canvas.getContext('2d');
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = img.data;
      const step = 40;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        const sat = 1.35;
        const nr = gray + (r - gray) * sat;
        const ng = gray + (g - gray) * sat;
        const nb = gray + (b - gray) * sat;
        d[i] = Math.min(255, Math.round(Math.round(nr / step) * step));
        d[i + 1] = Math.min(255, Math.round(Math.round(ng / step) * step));
        d[i + 2] = Math.min(255, Math.round(Math.round(nb / step) * step));
      }
      ctx.putImageData(img, 0, 0);
      return canvas;
    } catch (e) { return canvas; }
  }
  /** 头像缩到 320px 的方形，省流量也够画。 */
  function readAvatar(file) {
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const s = 320;
        const canvas = document.createElement('canvas');
        canvas.width = s; canvas.height = s;
        const g = canvas.getContext('2d');
        const k = Math.max(s / img.width, s / img.height);
        g.drawImage(img, (s - img.width * k) / 2, (s - img.height * k) / 2, img.width * k, img.height * k);
        URL.revokeObjectURL(url);
        resolve(cartoonify(canvas).toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => resolve('');
      img.src = url;
    });
  }
  let agentReady = false;

  /** 智能体模式：没填 Key 时把输入框露出来，填了就去掉。 */
  /* 页面加载、上传、预览阶段一律不请求任何模型；这里只把 Key 区域藏起来 */
  function refreshAgent() {
    try {
      const field = $('agentKeyField');
      if (field) field.classList.add('hidden');
    } catch (e) { /* 忽略 */ }
  }  function bindModes() {
    document.querySelectorAll('.mode').forEach((el) => el.addEventListener('click', () => {
      mode = el.dataset.mode === 'agent' ? 'agent' : 'plain';
      document.querySelectorAll('.mode').forEach((n) => n.classList.toggle('on', n === el));
      void refreshAgent();
    }));
    agentSave?.addEventListener('click', async () => {
      const key = agentKey.value.trim();
      if (!key) return;
      localStorage.setItem('glue.agentKey', key);
      const idBox = document.getElementById('agentId');
      if (idBox && idBox.value.trim()) localStorage.setItem('glue.agentId', idBox.value.trim());
      agentReady = true;
      agentKeyField.classList.remove('hidden');
      agentState.textContent = '已用你自己的 Key，花的是你自己的 token';
      toast('Key 已存在这台设备');
    });
  }

  function home() {
    $('home').classList.remove('hidden');
    $('room').classList.add('hidden');
    /* 从充值弹窗点「否」回来时，把写好的故事放回输入框 */
    try {
      const back = JSON.parse(sessionStorage.getItem('glue.backlog') || 'null');
      if (back) {
        if (back.log) $('log').value = back.log;
        if (back.me) $('me').value = back.me;
        if (back.partner) $('partner').value = back.partner;
        sessionStorage.removeItem('glue.backlog');
      }
    } catch (e) { /* 忽略 */ }
    bindImports();
    bindModes();
    $('musicFile')?.addEventListener('change', async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      const state = document.getElementById('musicState');
      if (state) state.textContent = '正在处理音乐…';
      let payload = file;
      let name = file.name;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        const ac = new AC();
        const buf = await ac.decodeAudioData(await file.arrayBuffer());
        beats = detectBeats(buf);
        /* 视频或大文件：先在浏览器里转成 16k 单声道 WAV，传得更快 */
        if (file.size > 1.5 * 1024 * 1024 || /^video[/]/.test(file.type)) {
          const wav = encodeWav(buf);
          if (wav && wav.size < file.size) { payload = wav; name = 'music.wav'; }
        }
        if (ac.close) ac.close();
      } catch (e) { beats = []; }
      if (state) state.textContent = '上传中… ' + Math.round(payload.size / 1024) + ' KB';
      try {
        const res = await fetch('/api/music', { method: 'POST', headers: { 'content-type': payload.type || 'application/octet-stream', 'x-filename': encodeURIComponent(name) }, body: payload });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || '导入失败');
        musicUrl = body.url;
        if (state) state.textContent = '已导入：' + name + (beats.length ? '（' + beats.length + ' 个鼓点）' : '');
      } catch (e) {
        if (state) state.textContent = e instanceof Error ? e.message : '导入失败';
      }
    });

    $('soundBtn')?.addEventListener('click', () => {
      const video = $('filmVideo');
      const btn = $('soundBtn');
      /* 成片自带配乐：直接开视频的声音 */
      if (video && room.filmSrc) {
        video.muted = !video.muted;
        if (!video.muted) video.play().catch(() => {});
        if (btn) btn.textContent = video.muted ? '🔇 点一下开声音' : '🔊 声音已开';
        if (!video.muted) setTimeout(() => { if (btn) btn.classList.add('on'); }, 1200);
        return;
      }
      let ok = false;
      try { ok = window.GlueMusic ? window.GlueMusic.rearm(room.story, 0) : false; } catch (e) { ok = false; }
      if (bgm) { try { bgm.play(); ok = true; } catch (e) { /* 忽略 */ } }
      if (btn) btn.textContent = ok === false ? '🔇 浏览器拦了声音，点一次视频' : '🔊 声音已开';
      setTimeout(() => { const b = $('soundBtn'); if (b) b.classList.add('on'); }, 1200);
    });
    $('photos')?.addEventListener('change', async (event) => {
      const files = [...(event.target.files || [])].slice(0, 8);
      for (const file of files) {
        const src = await readPhoto(file);
        if (src) photos.push(src);
      }
      const state = document.getElementById('photoState');
      if (state) state.textContent = photos.length ? '已选 ' + photos.length + ' 张' : '';

    });
    /* 手机上：第一次触摸就把音频解锁，否则整片没声音 */
    document.getElementById('agentModel')?.addEventListener('change', (event) => { localStorage.setItem('glue.agentModel', event.target.value); });
    const unlockOnce = () => { try { window.GlueMusic && window.GlueMusic.unlock(); } catch (e) { /* 忽略 */ } };
    window.addEventListener('pointerdown', unlockOnce, { once: true });
    window.addEventListener('touchstart', unlockOnce, { once: true });
    $('agentTest')?.addEventListener('click', async () => {
      const key = localStorage.getItem('glue.agentKey') || (document.getElementById('agentKey')?.value ?? '').trim();
      const id = localStorage.getItem('glue.agentId') || (document.getElementById('agentId')?.value ?? '').trim();
      const state = document.getElementById('agentState');
      if (state) state.textContent = '正在试…';
      try {
        const res = await fetch('/api/agent/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, id, agentModel: (document.getElementById('agentModel')?.value || '') }) });
        const body = await res.json().catch(() => ({}));
        if (state) state.textContent = body.detail || (body.ok ? '通了' : '没通');
      } catch (e) { if (state) state.textContent = e instanceof Error ? e.message : '连不上'; }
    });

    $('exportVideo')?.addEventListener('click', async () => {
      const story = room.story;
      if (!story) { toast('先生成一支再导出。'); return; }
      const btn = $('exportVideo');
      btn.disabled = true;
      btn.textContent = '正在渲染…';
      try {
        const res = await fetch('/api/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ story }) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? '渲染失败');
        const a = document.createElement('a');
        a.href = body.url;
        a.download = '回忆短片.mp4';
        document.body.appendChild(a);
        a.click();
        a.remove();
        toast('做好了：' + body.seconds + ' 秒的 MP4');
      } catch (e) { toast(e instanceof Error ? e.message : '渲染失败'); }
      btn.disabled = false;
      btn.textContent = '导出 MP4';
    });
    avaMe?.addEventListener('change', async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      avatars.me = await readAvatar(file);
      if (avatars.me) { avaMeImg.src = avatars.me; avaMeBox.classList.add('has'); }
    });
    avaPeer?.addEventListener('change', async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      avatars.peer = await readAvatar(file);
      if (avatars.peer) { avaPeerImg.src = avatars.peer; avaPeerBox.classList.add('has'); }
    });
    void refreshAgent();
        /* 云端（Linux）没有本地应用可打开：把「从应用导入」收起来，只留粘贴/文件/截图 */
    fetch('/api/health').then((r) => r.json()).then((body) => {
      if (body.platform && body.platform !== 'win32') {
        const field = document.getElementById('appImportField');
        if (field) field.classList.add('hidden');
      }
      /* 手机就在同一个 Wi-Fi 里：把本机的局域网地址直接给出来 */
      if (!/^(localhost|127\.|\[::1\])/.test(location.hostname)) return;
      const lan = body.lan?.[0];
      if (!lan) return;
      const hint = $('lanHint');
      hint.textContent = `同一个 Wi-Fi 下，用手机打开：http://${lan}:${body.port}${location.pathname}`;
      hint.classList.remove('hidden');
    }).catch(() => {});
    /* 三种修复主题：付完款后播放对应的专属片子 */
  let kindPick = 'love';
  const KIND_STORY = {
    family: '我：妈，这周末我回家吃饭。\n妈：好，我给你做你爱吃的。\n我：爸的腿还疼吗？\n妈：老毛病了，你别惦记。\n我：以后我常回来。',
    love: '她：今天下雨，你带伞了吗？\n我：忘了，没事。\n她：我在楼下等你，给你送伞。\n我：那天的风很大，你把伞往我这边偏了偏。\n她：傻瓜，你半边肩膀都湿了。',
    friend: '老周：毕业十年了，你还记得那条街吗？\n我：记得，咱们在天台上喝过啤酒。\n老周：哪天回去，再走一遍。\n我：说定了，这次不许放我鸽子。',
  };
  document.querySelectorAll('.kind').forEach((el) => el.addEventListener('click', () => {
    kindPick = el.dataset.kind || 'love';
    document.querySelectorAll('.kind').forEach((n) => n.classList.toggle('on', n === el));
  }));
  $('create').addEventListener('submit', async (event) => {
      event.preventDefault();
      $('log').value = KIND_STORY[kindPick] || KIND_STORY.love;
      const log = $('log').value.trim();
      lastLog = log;
      lastMe = $('me').value.trim();
      lastPartner = $('partner').value.trim();
      const me = $('me').value.trim();
      const partner = $('partner').value.trim();
      const error = $('err');
      const button = $('go');
      error.classList.add('hidden');
      if (log.length < 20) { error.textContent = '故事太短了，再多写两句吧。'; error.classList.remove('hidden'); return; }
      button.disabled = true;
      const dense = log.split(String.fromCharCode(10)).filter((l) => l.trim()).length > 50;
      button.textContent = dense ? '信息密度较大，正在生成，请稍等…' : '正在为你生成你的专属视频…';
      try {
        const res = await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ log, storyText: log, kind: kindPick, me, partner, mode, theme: (document.getElementById('theme')?.value || 'miss'), agentKey: '', agentId: '', agentModel: (document.getElementById('agentModel')?.value || localStorage.getItem('glue.agentModel') || ''), avatars: [avatars.me, avatars.peer].filter(Boolean), images: photos.slice(0, 8), musicUrl, beats }) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? '再试一次吧。');
        remember(body.id, body.hostToken);
        location.href = `/r/${body.id}#h=${body.hostToken}`;
      } catch (e) {
        error.textContent = e instanceof Error ? e.message : String(e);
        error.classList.remove('hidden');
        button.disabled = false;
        button.textContent = '生成动漫小故事';
      }
    });
  }

  async function openRoom(id) {
    room.id = id;
    room.token = tokenFor(id);
    room.role = room.token ? 'host' : 'guest';
    /* 地址栏里的 #h= 只用于认领身份，认领完就抹掉：避免把带 token 的网址发给别人 */
    if (room.token) remember(id, room.token);
    if (location.hash) { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* 忽略 */ } }
    $('home').classList.add('hidden');
    $('room').classList.remove('hidden');
    /* 接收方不能生成视频，只能等发起人 */
    if (room.role !== 'host') {
      const mb = $('makeFilm');
      if (mb) { mb.disabled = true; mb.textContent = '等发起人生成视频…'; }
    }

    const link = `${location.origin}/r/${id}`;
    $('linkText').textContent = link;
    $('copyLink').addEventListener('click', () => copy(link).then(() => toast('链接已复制')));
    $('copyMain').addEventListener('click', () => copy(link).then(() => toast('专属链接已复制，发给 TA 吧')));
    $('readyCopy').addEventListener('click', () => copy(link).then(() => toast('链接已复制，发给 TA 吧')));


    try {
      const res = await fetch(`/api/rooms/${id}/join`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: room.role, token: room.token }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? '这扇门现在打不开。');
      room.joined = true;
      apply(body.state);
      listen();
      startStatePoll();
    } catch (e) {
      $('waitingText').textContent = e instanceof Error ? e.message : String(e);
      $('waitingText').classList.add('err');
    }
  }

  /* 从支付页切回来、或者页面重新可见时，主动拉一次状态：付款成功就不用再点任何按钮 */
  async function refreshState() {
    if (!room.id) return;
    try {
      const s = await (await fetch(`/api/rooms/${room.id}/state`)).json();
      if (s) apply(s);
    } catch (e) { /* 忽略 */ }
  }
  /* 4 秒兜底轮询：SSE 掉了、切了网络、切后台回来，都能自己追上房间状态 */
  function startStatePoll() {
    if (room.pollTimer) return;
    room.pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && room.id) void refreshState();
    }, 4000);
  }
  /* ── 实时 ─────────────────────────────────────────── */
  function listen() {
    if (room.sse) room.sse.close();
    const src = new EventSource(`/api/rooms/${room.id}/events?role=${room.role}&token=${encodeURIComponent(room.token)}`);
    src.addEventListener('state', (event) => { try { apply(JSON.parse(event.data)); } catch { /* ignore */ } });
    src.addEventListener('message', (event) => { try { push(JSON.parse(event.data)); } catch { /* ignore */ } });
    src.onerror = () => {
      try { src.close(); } catch (e) { /* 忽略 */ }
      if (room.id) setTimeout(() => { if (room.id && document.visibilityState === 'visible') listen(); }, 4000);
    };
    room.sse = src;
  }

  /* ── 状态 ─────────────────────────────────────────── */
  /* 关系复原胶：只有发起方能发起；接收方三选一 */
  let glueTimer = 0;
  async function glueAction(action, payload) {
    try {
      const res = await fetch('/api/rooms/' + room.id + '/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ role: room.role, token: room.token }, payload || {})),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) toast(body.error || '没成功');
      return res.ok;
    } catch (e) { toast('网络不太好，再试一次'); return false; }
  }
  function renderGlue(state) {
    const modal = $('glueModal');
    const card = $('glueCard');
    if (!modal || !card) return;
    const st = state.status;
    if (st !== 'offer' && st !== 'asking' && st !== 'result') {
      clearInterval(glueTimer);
      modal.classList.add('hidden');
      return;
    }
    modal.classList.remove('hidden');
    clearInterval(glueTimer);
    const isHost = room.role === 'host';
    const left = (deadline) => Math.max(0, Math.ceil((deadline - (Date.now() + room.offset)) / 1000));
    if (st === 'offer') {
      if (isHost) {
        card.innerHTML = '<h3>要使用关系复原胶吗？</h3><p>把裂开的关系重新粘好，再给彼此一次机会</p>'
          + '<div class="glue-actions"><button class="g-btn yes" id="glueOffer">使用复原胶</button></div>'
          + '<div class="glue-count" id="glueCount"></div>';
        const btn = $('glueOffer');
        if (btn) btn.onclick = async () => { btn.disabled = true; await glueAction('offer'); };
      } else {
        card.innerHTML = '<h3>等一等</h3><p>发起人正在决定，要不要用复原胶。</p>';
      }
      const tick = () => {
        const el = $('glueCount');
        if (el) el.textContent = '还剩 ' + left(state.offerDeadline || 0) + ' 秒';
      };
      tick();
      glueTimer = setInterval(tick, 1000);
      return;
    }
    if (st === 'asking') {
      if (isHost) {
        card.innerHTML = '<h3>等对方回应</h3><p>TA 有两分钟时间选择。</p>';
      } else {
        card.innerHTML = '<h3>要使用关系复原胶吗？</h3><p>把裂开的关系重新粘好，再给彼此一次机会</p>'
          + '<div class="glue-actions">'
          + '<button class="g-btn yes" data-choice="yes">使用复原胶</button>'
          + '<button class="g-btn think" data-choice="think">考虑考虑</button>'
          + '<button class="g-btn no" data-choice="no">暂不修复</button>'
          + '</div><div class="glue-count" id="glueCount"></div>';
        card.querySelectorAll('[data-choice]').forEach((b) => {
          b.onclick = async () => {
            card.querySelectorAll('[data-choice]').forEach((x) => { x.disabled = true; });
            await glueAction('answer', { choice: b.dataset.choice });
          };
        });
      }
      const tick2 = () => {
        const el = $('glueCount');
        if (el) el.textContent = '还剩 ' + left(state.askDeadline || 0) + ' 秒';
      };
      tick2();
      glueTimer = setInterval(tick2, 1000);
      return;
    }
    card.innerHTML = '<div class="glue-result">' + String(state.result || '好好爱自己，好好生活') + '</div>';
  }
  function apply(state) {
    if (!state) return;
    room.offset = state.serverNow - Date.now();
    if (state.story) room.story = state.story;
    /* 成片地址一出现：先装好画面，不自动播放 —— 等接收人进来，或者等满两分钟 */
    if (state.filmUrl) { loadFilm(state.filmUrl); closePay(); }
    renderGlue(state);
    const wasChat = room.state?.status === 'chat';
    room.state = state;
    $('names').innerHTML = `<i>${escape0(state.names.me)}</i> &nbsp;·&nbsp; <u>${escape0(state.names.partner)}</u>`;

    /* 付款状态：已到账 → 先出服务须知；确认后才开始生成 */
    if (state.order && room.role === 'host' && !state.filmUrl && state.order.status === 'review') {
      showPayWaiting('review');
    }
    if (state.order && room.role === 'host' && !state.filmUrl) {
      if (state.order.status === 'paid' && state.order.needsConsent) {
        showNotice();
      } else if (state.order.status === 'generating' || state.status === 'film') {
        showGenerating();
        startPayWatch();
      } else if (state.order.status === 'done' || state.order.status === 'failed' || state.order.status === 'cancelled') {
        closePay();
      }
    }

    if (state.status === 'waiting') {
      $('presence').textContent = state.joined.host && state.joined.guest ? '' : '等 TA 进来';
      show('waiting');
      if (!state.filmUrl) preview(state.story);
    } else if (state.status === 'ready') {
      /* 成片好了：先扣着不放，亮出链接和两分钟倒计时 */
      show('ready');
      stopFilm();
      pauseFilm();
      updateReady(state);
    } else if (state.status === 'film') {
      show('film');
      /* 每次新的观影窗口：两边都从头播同一支视频 */
      if (room.lastFilmStart !== state.filmStart) {
        room.lastFilmStart = state.filmStart;
        void playFilm(state);
      }
    } else if (state.status === 'confirm') {
      clearInterval(room.readyTick);
      pauseFilm();
      stopFilm();
      show('confirm');
      updateConfirm(state);
    } else if (state.status === 'declined') {
      pauseFilm();
      stopFilm();
      stopChatBgm();
      show('declined');
      if (room.sse) room.sse.close();
    } else if (state.status === 'chat') {
      pauseFilm();
      stopFilm();
      show('chat');
      if (!wasChat) { room.seen.clear(); $('messages').querySelectorAll('.msg').forEach((n) => n.remove()); }
      for (const message of state.messages) push(message, true);
      startClock(state);
      $('input').focus({ preventScroll: true });
    } else if (state.status === 'ended') {
      pauseFilm();
      stopFilm();
      stopChatBgm();
      show('ended');
      if (room.sse) { room.sse.close(); room.sse = null; }
    }
  }

  function show(view) {
    room.view = view;
    for (const name of ['waiting', 'ready', 'film', 'confirm', 'declined', 'chat', 'ended']) {
      $(`view-${name}`).classList.toggle('hidden', name !== view);
    }
    const veil = $('filmVeil');
    if (veil) veil.classList.toggle('hidden', view !== 'ready');
    const stage = $('stage');
    if (stage) stage.classList.toggle('compact', view === 'ready');
    const video = $('filmVideo');
    if (video) video.controls = view === 'film';
    const sb = $('soundBtn');
    if (sb) sb.classList.toggle('hidden', view === 'ready');
    $('stage').classList.toggle('hidden', view === 'chat' || view === 'declined' || view === 'ended' || view === 'confirm');
    $('presence').classList.toggle('hidden', view !== 'waiting');
  }

  /* ── 短片 ─────────────────────────────────────────── */
  function stopFilm() {
    stopBgm();
    if (room.raf) cancelAnimationFrame(room.raf);
    room.raf = 0;
    if (window.GlueMusic) window.GlueMusic.stop();
  }

  /* 成片只装不播：等接收人进来（或等满两分钟）再开演 */
  let lastLog = '';
  let lastMe = '';
  let lastPartner = '';

  function loadFilm(url) {
    const video = $('filmVideo');
    const canvas = $('film');
    if (!video || !url) return;
    if (room.filmSrc !== url) {
      room.filmSrc = url;
      video.src = url;
      try { video.load(); } catch (e) { /* 忽略 */ }
    }
    video.classList.remove('hidden');
    if (canvas) canvas.classList.add('hidden');
    const exp = $('exportFilm');
    if (exp) { exp.href = url; exp.classList.remove('hidden'); }
  }

  /** 成片已经在了：停住、回到第一帧，绝不自己播 */
  function pauseFilm() {
    const video = $('filmVideo');
    if (!video) return;
    try { video.pause(); } catch (e) { /* 忽略 */ }
    try { if (video.currentTime > 0.05) video.currentTime = 0; } catch (e) { /* 忽略 */ }
  }

  /** 一起看：t 由房间里同一个开始时刻算出来，晚进来的人也能接上 */
  async function playFilm(state) {
    const video = $('filmVideo');
    if (!video || !state.filmUrl) return;
    stopFilm();
    clearInterval(room.readyTick);
    loadFilm(state.filmUrl);
    const from = Math.max(0, ((Date.now() + room.offset) - state.filmStart) / 1000);
    const seek = () => { try { video.currentTime = from; } catch (e) { /* 忽略 */ } };
    if (video.readyState >= 1) seek();
    else video.addEventListener('loadedmetadata', seek, { once: true });
    video.muted = false;
    const btn = $('filmPlay');
    const playNow = async () => {
      video.muted = false;
      seek();
      try { await video.play(); } catch (e) { /* 忽略 */ }
      if (btn) { btn.classList.add('hidden'); btn.onclick = null; }
    };
    if (btn) {
      btn.classList.remove('hidden');
      btn.textContent = '▶ 播放（有声音）';
      btn.onclick = () => void playNow();
    }
    /* 能带声音自动播就直接播；被浏览器拦下就等用户点一下大按钮（保证有声音） */
    try {
      await video.play();
      if (btn) { btn.classList.add('hidden'); btn.onclick = null; }
    } catch (e) {
      if (btn) btn.classList.remove('hidden');
    }
  }

  function updateReady(state) {
    const link = `${location.origin}/r/${room.id}`;
    const code = $('readyLink');
    if (code) code.textContent = link;
    clearInterval(room.readyTick);
    const tick = () => {
      const left = Math.max(0, Math.ceil(((state.readyDeadline || 0) - (Date.now() + room.offset)) / 1000));
      const clock = $('readyClock');
      if (clock) clock.textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
      if (left <= 0) {
        clearInterval(room.readyTick);
        const tip = $('readyTip');
        if (tip) tip.textContent = '时间到了，先自己看。看完再问你们，要不要打开那扇门。';
      }
    };
    tick();
    room.readyTick = setInterval(tick, 500);
  }
  /* ── 充值 → 站长确认到账 → 才生成 ─────────────────── */
  let payPoll = 0;
  let payWatching = false;

  function openPay() {
    const modal = $('payModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    const cardO = document.querySelector('.pay-card'); if (cardO) cardO.classList.remove('generating');
    $('payStep1').classList.remove('hidden');
    $('payStep2').classList.add('hidden');
    $('payState').textContent = '';
    const x = Boolean(room.state && room.state.payXunhu);
    const qrs = document.querySelector('.pay-qrs');
    if (qrs) qrs.classList.toggle('hidden', x);
    const ch = document.querySelector('.pay-channels');
    if (ch) ch.classList.toggle('hidden', !x);
    const qr = $('payQr');
    if (qr) qr.classList.add('hidden');
  }
  function closePay() {
    const modal = $('payModal');
    if (modal) modal.classList.add('hidden');
    clearInterval(payPoll);
    payWatching = false;
    noticeOpen = false;
  }
  async function payYes() {
    $('payStep1').classList.add('hidden');
    $('payStep2').classList.remove('hidden');
    const x = Boolean(room.state && room.state.payXunhu);
    $('payState').textContent = x ? '选一种支付方式；付完自动到账，不用再操作。' : '扫码付 29.9 元。';
  }
  /** 选支付宝/微信：下单，拿到支付链接，跳过去付 */
  async function startChannel(channel) {
    const el = $('payState');
    if (el) el.textContent = '正在创建订单…';
    try {
      const res = await fetch(`/api/rooms/${room.id}/checkout`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: room.role, token: room.token, channel }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || '订单没建成');
      const pay = body.payment || {};
      if (pay.error) throw new Error(pay.error);
      if (!pay.url) throw new Error('没有拿到支付链接');
      /* 新标签页打开收银台：本页继续轮询，付款成功会自动跳转，不用再回来点按钮 */
      const win = window.open(pay.url, '_blank');
      if (!win) { location.href = pay.url; return; }
      if (el) el.textContent = '已打开支付页：付完回到这里，会自动到账。';
      startPayWatch();
    } catch (e) {
      if (el) el.textContent = e instanceof Error ? e.message : '下单失败';
    }
  }
  async function payDone() {
    const btn = $('payDone');
    if (btn) btn.disabled = true;
    $('payState').textContent = '已记录，等平台回调到账…';
    try {
      const res = await fetch(`/api/rooms/${room.id}/paid`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: room.role, token: room.token }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || '没提交上去');
      startPayWatch();
    } catch (e) {
      if (btn) btn.disabled = false;
      $('payState').textContent = e instanceof Error ? e.message : '没提交上去';
    }
  }
  function showPayWaiting(status) {
    const modal = $('payModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    $('payStep1').classList.add('hidden');
    $('payStep2').classList.remove('hidden');
    const el = $('payState');
    if (el) el.textContent = status === 'review' ? '已收到你的付款提示，正在核对到账…' : '等待到账…付款后会自动开始。';
    startPayWatch();
  }
  let noticeOpen = false;
  /** 已到账：先让客户看服务须知，确认后才开始烧算力 */
  function showNotice() {
    if (noticeOpen) return;
    const cardN = document.querySelector('.pay-card'); if (cardN) cardN.classList.remove('generating');
    const gnN = $('payGenNote'); if (gnN) gnN.classList.add('hidden');
    noticeOpen = true;
    const modal = $('payModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    $('payStep1').classList.add('hidden');
    $('payStep2').classList.remove('hidden');
    const ch = document.querySelector('.pay-channels'); if (ch) ch.classList.add('hidden');
    const qrs = document.querySelector('.pay-qrs'); if (qrs) qrs.classList.add('hidden');
    const fb = document.querySelector('.pay-fallback'); if (fb) fb.classList.add('hidden');
    const nt = $('payNotice'); if (nt) nt.classList.remove('hidden');
    $('payState').textContent = '';
    clearInterval(payPoll); payWatching = false;
  }
  function showGenerating(text) {
    noticeOpen = true;
    const card = document.querySelector('.pay-card');
    if (card) card.classList.add('generating');
    const nt = $('payNotice'); if (nt) nt.classList.add('hidden');
    const gn = $('payGenNote'); if (gn) gn.classList.remove('hidden');
    const el = $('payState');
    if (el) el.textContent = text || '视频正在生成中，由于使用人数过多，请耐心等待…';
  }
  async function acceptNotice() {
    showGenerating('视频正在生成中，由于使用人数过多，请耐心等待…');
    try {
      const res = await fetch(`/api/rooms/${room.id}/start`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: room.role, token: room.token }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || '启动失败');
      startPayWatch();
    } catch (e) {
      const el = $('payState');
      if (el) el.textContent = e instanceof Error ? e.message : '启动失败';
    }
  }
  function startPayWatch() {
    if (payWatching) return;
    payWatching = true;
    clearInterval(payPoll);
    payPoll = setInterval(async () => {
      let s = null;
      try { s = await (await fetch(`/api/rooms/${room.id}/state`)).json(); } catch (e) { return; }
      if (!s) return;
      const el = $('payState');
      if (s.filmUrl) { closePay(); apply(s); return; }
      const st = s.order && s.order.status;
      if (st === 'generating') { showGenerating(); return; }
      if (st === 'done') { closePay(); apply(s); return; }
      if (st === 'paid') {
        if (s.status === 'film' || noticeOpen || !(s.order && s.order.needsConsent)) showGenerating();
        else showNotice();
        return;
      }
      if (st === 'review') { if (el) el.textContent = '已收到你的付款提示，正在核对到账…'; return; }
      if (st === 'cancelled') {
        clearInterval(payPoll); payWatching = false;
        if (el) el.textContent = '这笔订单被取消了。如果你已经付过款，请点上面的链接联系站长。';
        return;
      }
      if (st === 'failed') {
        clearInterval(payPoll); payWatching = false;
        if (el) el.textContent = '生成失败了：' + ((s.order && s.order.error) || '未知原因') + '。';
      }
    }, 3000);
  }
  /** 点「否」：不扣费、不生成，带着写好的故事回到填写页面 */
  function payNo() {
    closePay();
    try {
      sessionStorage.setItem('glue.backlog', JSON.stringify({
        log: (room.story && room.story.storyText) || '',
        me: (room.state && room.state.names && room.state.names.me) || '',
        partner: (room.state && room.state.names && room.state.names.partner) || '',
      }));
    } catch (e) { /* 忽略 */ }
    location.href = '/';
  }

  function confirmFilm() {
    if (room.role !== 'host') { toast('只有发起链接的人可以充值生成。'); return; }
    if (!room.story) { toast('先生成一支小故事。'); return; }
    openPay();
  }

  /* 只有点这个按钮才会进充值流程 */
  document.addEventListener('click', (event) => {
    const el = event.target;
    if (el && el.id === 'makeFilm') { event.preventDefault(); void confirmFilm(); }
  });

  /** 还没开始的时候，先看一支循环的预告；成片好了就换成等 TA 的卡片 */
  function preview(story) {
    /* 已经在循环里就别重启，否则每来一次房间事件就闪一下 */
    if (room.raf) return;
    if (!story) return;
    room.story = story;
    stopFilm();
    if (story.musicUrl) startBgm(story.musicUrl);
    const canvas = $('film');
    const video = $('filmVideo');
    if (video) { try { video.pause(); } catch (e) { /* 忽略 */ } video.classList.add('hidden'); }
    if (canvas) canvas.classList.remove('hidden');
    const started = performance.now();
    const loop = () => {
      const total = film.durationOf ? film.durationOf(story) : DURATION;
      const t = (performance.now() - started) % total;
      film.draw(canvas, story, t);
      const note = document.getElementById('agentNote');
      if (note) note.textContent = story && story.agentNote && !/没填 ?Key/i.test(story.agentNote) ? story.agentNote : '';
      if (window.GlueMusic && !window.GlueMusic.playing) window.GlueMusic.start(story, t);
      $('filmTitle').textContent = film.titleOf(Math.floor(t / (total / 5)));
      room.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  /* ── 确认 ─────────────────────────────────────────── */
  function updateConfirm(state) {
    const role = room.role;
    const mine = state.confirm[role];
    const both = state.confirm.host === true && state.confirm.guest === true;
    $('accept').disabled = mine === true || both;
    $('decline').disabled = mine === false || both;
    $('confirmWait').textContent = both ? '复原胶正在注入…'
      : mine === true ? '等 TA 也按下「是」。'
        : mine === false ? '这一次，就先到这里。'
          : '等你们两个人的答案。';
  }

  async function answer(yes) {
    const state = room.state;
    if (!state || state.status !== 'confirm') return;
    $('accept').disabled = true;
    $('decline').disabled = true;
    $('confirmWait').textContent = yes ? '等 TA 也按下「是」。' : '这一次，就先到这里。';
    try {
      await fetch(`/api/rooms/${room.id}/confirm`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: room.role, token: room.token, yes }),
      });
    } catch {
      $('confirmWait').textContent = '刚才那一下没有送达，再按一次。';
      $('accept').disabled = false;
      $('decline').disabled = false;
    }
  }

  /* ── 聊天 ─────────────────────────────────────────── */
  function push(message, quiet = false) {
    if (!message || room.seen.has(message.id)) return;
    room.seen.add(message.id);
    const empty = $('chatEmpty');
    if (empty) empty.remove();
    const mine = (message.from === 'host') === (room.role === 'host');
    const el = document.createElement('div');
    el.className = `msg ${mine ? 'me' : 'you'}`;
    if (!mine) {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = message.name;
      el.appendChild(who);
    }
    el.appendChild(document.createTextNode(message.text));
    $('messages').appendChild(el);
    if (!quiet) $('messages').scrollTop = $('messages').scrollHeight;
  }

  /* 幻境聊天的背景音乐：用站长上传的 20 分钟音轨 */
  function chatBgmEl() { return $('chatBgm'); }
  function startChatBgm() {
    const a = chatBgmEl();
    if (!a) return;
    a.volume = 0.42;
    a.loop = true;
    /* 没有开关：进聊天就放；被浏览器拦了就等下一次点击/触摸继续放 */
    const resumeOnTouch = () => {
      const once = () => { try { a.play().catch(() => {}); } catch (e) { /* 忽略 */ } };
      document.addEventListener('pointerdown', once, { once: true });
      document.addEventListener('touchstart', once, { once: true });
    };
    const pr = a.play();
    if (pr && pr.catch) pr.catch(resumeOnTouch);
  }
  function stopChatBgm() {
    const a = chatBgmEl();
    if (a) { try { a.pause(); } catch (e) { /* 忽略 */ } }
  }
  function startClock(state) {
    clearInterval(room.tick);
    const tick = () => {
      const left = Math.max(0, state.chatEnd - (Date.now() + room.offset));
      const minutes = Math.floor(left / 60000);
      const seconds = Math.floor((left % 60000) / 1000);
      $('clock').textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
      if (left <= 0) clearInterval(room.tick);
    };
    tick();
    room.tick = setInterval(tick, 500);
  }

  /** 那句话没有过去：只有发送者看到这一张，没有按钮，不反复弹。 */
  function shiver() {
    if (Date.now() - room.tipAt < 4500) return;
    room.tipAt = Date.now();
    document.querySelectorAll('.shiver').forEach((n) => n.remove());
    const el = document.createElement('div');
    el.className = 'shiver';
    el.innerHTML = '<b>🧊 复原胶轻轻震颤</b><p>这句话带着后来的伤痕，不属于这个初见的时空。<br>静下心想一想，如果你们今天才刚刚遇见，会怎么开口？</p>';
    document.body.appendChild(el);
    clearTimeout(room.tipTimer);
    room.tipTimer = setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 420); }, 7200);
  }

  async function send(text) {
    const said = String(text ?? '').trim();
    if (!said || !room.state || room.state.status !== 'chat') return;
    $('input').value = '';
    $('input').style.height = '';
    try {
      const res = await fetch(`/api/rooms/${room.id}/message`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: room.role, token: room.token, text: said }),
      });
      const body = await res.json().catch(() => ({}));
      if (body.soft) { shiver(); return; }
      if (!res.ok) throw new Error(body.error ?? '没有送出去。');
    } catch (e) {
      toast(e instanceof Error ? e.message : '没有送出去。');
    }
  }

  function escape0(text) {
    return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ── 事件 ─────────────────────────────────────────── */
  $('payNo')?.addEventListener('click', payNo);
  $('payYes')?.addEventListener('click', () => void payYes());
  $('payDone')?.addEventListener('click', (e) => { e.preventDefault(); void payDone(); });
  $('payAlipay')?.addEventListener('click', (e) => { e.preventDefault(); void startChannel('alipay'); });
  $('payWechat')?.addEventListener('click', (e) => { e.preventDefault(); void startChannel('wechat'); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { void refreshState(); if (room.view === 'chat') startChatBgm(); } });
  window.addEventListener('pageshow', (e) => { if (e.persisted) void refreshState(); });
  window.addEventListener('focus', () => void refreshState());
;
  $('payNoticeOk')?.addEventListener('click', () => void acceptNotice());
  $('accept').addEventListener('click', () => void answer(true));
  $('decline').addEventListener('click', () => void answer(false));
  $('composer').addEventListener('submit', (event) => { event.preventDefault(); void send($('input').value); });
  $('input').addEventListener('input', (event) => {
    const el = event.currentTarget;
    el.style.height = 'auto';
    el.style.height = `${Math.min(120, el.scrollHeight)}px`;
  });
  $('input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send($('input').value); }
  });

  start();
})();
