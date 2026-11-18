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
  let room = { id: '', role: 'guest', token: '', state: null, offset: 0, sse: null, joined: false, raf: 0, tick: 0, seen: new Set(), tipTimer: 0, tipAt: 0, view: '' };

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
  function bindImports() {
    $('fileText').addEventListener('change', (event) => { void importFiles(event.target.files); event.target.value = ''; });
    $('fileImage').addEventListener('change', (event) => { void importFiles(event.target.files); event.target.value = ''; });
    document.querySelectorAll('.app').forEach((el) => el.addEventListener('click', () => showGuide(el.dataset.app)));
    const form = $('create');
    form.addEventListener('dragover', (event) => { event.preventDefault(); form.classList.add('dropping'); });
    form.addEventListener('dragleave', () => form.classList.remove('dropping'));
    form.addEventListener('drop', (event) => {
      event.preventDefault();
      form.classList.remove('dropping');
      if (event.dataTransfer?.files?.length) void importFiles(event.dataTransfer.files);
    });
    /* 截图直接粘进输入框也可以 */
    $('log').addEventListener('paste', (event) => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (!files.length) return;
      event.preventDefault();
      void importFiles(files);
    });
  }

  let mode = 'plain';
  const avatars = { me: '', peer: '' };

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
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => resolve('');
      img.src = url;
    });
  }
  let agentReady = false;

  /** 智能体模式：没填 Key 时把输入框露出来，填了就去掉。 */
  async function refreshAgent() {
    try {
      agentReady = Boolean(localStorage.getItem('glue.agentKey'));
      const res = await fetch('/api/agent');
      const body = await res.json().catch(() => ({}));
      const field = $('agentKeyField');
      if (field) field.classList.toggle('hidden', !(mode === 'agent' && !agentReady));
      const state = $('agentState');
      if (state) state.textContent = agentReady
        ? ('已用你自己的 Key（' + (body.model || 'doubao') + '），花的是你自己的 token')
        : '还没填 Key：填了就走豆包，不填就走本地分镜。Key 只存在你的浏览器里。';
    } catch { /* 网络不好先不管 */ }
  }
  function bindModes() {
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
      agentKeyField.classList.add('hidden');
      agentState.textContent = '已用你自己的 Key，花的是你自己的 token';
      toast('Key 已存在这台设备');
    });
  }

  function home() {
    $('home').classList.remove('hidden');
    $('room').classList.add('hidden');
    bindImports();
    bindModes();
    /* 手机上：第一次触摸就把音频解锁，否则整片没声音 */
    const unlockOnce = () => { try { window.GlueMusic && window.GlueMusic.unlock(); } catch (e) { /* 忽略 */ } };
    window.addEventListener('pointerdown', unlockOnce, { once: true });
    window.addEventListener('touchstart', unlockOnce, { once: true });
    $('agentTest')?.addEventListener('click', async () => {
      const key = localStorage.getItem('glue.agentKey') || (document.getElementById('agentKey')?.value ?? '').trim();
      const id = localStorage.getItem('glue.agentId') || (document.getElementById('agentId')?.value ?? '').trim();
      const state = document.getElementById('agentState');
      if (state) state.textContent = '正在试…';
      try {
        const res = await fetch('/api/agent/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, id }) });
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
    $('create').addEventListener('submit', async (event) => {
      event.preventDefault();
      const log = $('log').value.trim();
      const me = $('me').value.trim();
      const partner = $('partner').value.trim();
      const error = $('err');
      const button = $('go');
      error.classList.add('hidden');
      if (log.length < 20) { error.textContent = '记录太短了，再多贴几句吧。'; error.classList.remove('hidden'); return; }
      button.disabled = true;
      button.textContent = '正在把故事读成十五秒…';
      try {
        const res = await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ log, me, partner, mode, theme: (document.getElementById('theme')?.value || 'miss'), agentKey: localStorage.getItem('glue.agentKey') || '', agentId: localStorage.getItem('glue.agentId') || '', avatars: [avatars.me, avatars.peer].filter(Boolean) }) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? '再试一次吧。');
        remember(body.id, body.hostToken);
        location.href = `/r/${body.id}#h=${body.hostToken}`;
      } catch (e) {
        error.textContent = e instanceof Error ? e.message : String(e);
        error.classList.remove('hidden');
        button.disabled = false;
        button.textContent = '生成回忆闪片';
      }
    });
  }

  async function openRoom(id) {
    room.id = id;
    room.token = tokenFor(id);
    room.role = room.token ? 'host' : 'guest';
    $('home').classList.add('hidden');
    $('room').classList.remove('hidden');

    const link = `${location.origin}/r/${id}`;
    $('linkText').textContent = link;
    $('copyLink').addEventListener('click', () => copy(link).then(() => toast('链接已复制')));
    $('copyMain').addEventListener('click', () => copy(link).then(() => toast('专属链接已复制，发给 TA 吧')));

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
    } catch (e) {
      $('waitingText').textContent = e instanceof Error ? e.message : String(e);
      $('waitingText').classList.add('err');
    }
  }

  /* ── 实时 ─────────────────────────────────────────── */
  function listen() {
    if (room.sse) room.sse.close();
    const src = new EventSource(`/api/rooms/${room.id}/events?role=${room.role}&token=${encodeURIComponent(room.token)}`);
    src.addEventListener('state', (event) => { try { apply(JSON.parse(event.data)); } catch { /* ignore */ } });
    src.addEventListener('message', (event) => { try { push(JSON.parse(event.data)); } catch { /* ignore */ } });
    src.onerror = () => { /* 浏览器自己会重连 */ };
    room.sse = src;
  }

  /* ── 状态 ─────────────────────────────────────────── */
  function apply(state) {
    if (!state) return;
    const wasChat = room.state?.status === 'chat';
    room.state = state;
    room.offset = state.serverNow - Date.now();
    $('names').innerHTML = `<i>${escape0(state.names.me)}</i> &nbsp;·&nbsp; <u>${escape0(state.names.partner)}</u>`;

    if (state.status === 'waiting') {
      $('presence').textContent = state.joined.host && state.joined.guest ? '' : '等 TA 进来';
      show('waiting');
      preview(state.story);
    } else if (state.status === 'film') {
      show('film');
      play(state);
    } else if (state.status === 'confirm') {
      stopFilm();
      show('confirm');
      updateConfirm(state);
    } else if (state.status === 'declined') {
      stopFilm();
      show('declined');
      if (room.sse) room.sse.close();
    } else if (state.status === 'chat') {
      stopFilm();
      show('chat');
      if (!wasChat) { room.seen.clear(); $('messages').querySelectorAll('.msg').forEach((n) => n.remove()); }
      for (const message of state.messages) push(message, true);
      startClock(state);
      $('input').focus({ preventScroll: true });
    } else if (state.status === 'ended') {
      stopFilm();
      show('ended');
      if (room.sse) { room.sse.close(); room.sse = null; }
    }
  }

  function show(view) {
    room.view = view;
    for (const name of ['waiting', 'film', 'confirm', 'declined', 'chat', 'ended']) {
      $(`view-${name}`).classList.toggle('hidden', name !== view);
    }
    $('stage').classList.toggle('hidden', view === 'chat' || view === 'declined' || view === 'ended' || view === 'confirm');
    $('presence').classList.toggle('hidden', view !== 'waiting');
  }

  /* ── 短片 ─────────────────────────────────────────── */
  function stopFilm() {
    if (room.raf) cancelAnimationFrame(room.raf);
    room.raf = 0;
    if (window.GlueMusic) window.GlueMusic.stop();
  }

  /** 等待的时候，房主先看一支循环的预告；另一个人进来就换成同步的正式播放。 */
  function preview(story) {
    stopFilm();
    const canvas = $('film');
    const started = performance.now();
    const loop = () => {
      const total = film.durationOf ? film.durationOf(story) : DURATION;
      const t = (performance.now() - started) % total;
      film.draw(canvas, story, t);
      const note = document.getElementById('agentNote');
      if (note) note.textContent = story && story.agentNote ? story.agentNote : '';
      if (window.GlueMusic && !window.GlueMusic.playing) window.GlueMusic.start(story, t);
      $('filmTitle').textContent = film.titleOf(Math.floor(t / (total / 5)));
      room.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  /** 两边同步：t 由房间给的开始时刻算出来，不是各自点播放的时间。 */
  function play(state) {
    stopFilm();
    const canvas = $('film');
    const total = film.durationOf ? film.durationOf(state.story) : DURATION;
    const from = state.filmStart - (Date.now() + room.offset);
    const startAt = performance.now() + Math.max(0, from);
    if (window.GlueMusic) window.GlueMusic.start(state.story, Math.max(0, from));
    const tick = () => {
      const t = performance.now() - startAt;
      if (t >= total) {
        film.draw(canvas, state.story, total - 1);
        room.raf = 0;
        return;
      }
      film.draw(canvas, state.story, Math.max(0, t));
      $('filmTitle').textContent = film.titleOf(Math.max(0, Math.floor(t / (total / 5))));
      room.raf = requestAnimationFrame(tick);
    };
    tick();
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
