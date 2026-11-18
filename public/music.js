/**
 * 现场合成的配乐：没有音频文件，全部用 Web Audio 算出来。
 * 五个镜头各一套和弦，情绪从稀疏到饱满，再到沉默时的低音，最后回到第一次说话的调子。
 * 和画面共用同一条时间轴：start(story, 已经播了多少毫秒)。
 */
(function () {
  'use strict';

  const ACT = 3000;
  const DURATION = 15000;
  const MIDI = (n) => 440 * Math.pow(2, (n - 69) / 12);

  /* A 小调：每个镜头一组和弦（MIDI 音高） */
  const CHORDS = [
    [45, 57, 60, 64],        // Am：初识，只有一点光
    [41, 53, 57, 60],        // F：靠近
    [48, 60, 64, 67],        // C：分享，最亮
    [40, 52, 55, 59],        // Em：沉默，压低
    [45, 57, 60, 64, 67],    // Am add9：重逢
  ];
  const MELODY = [69, 72, 74, 76, 79, 81]; // A 小调五声，随手挑都不会难听

  let ctx = null;
  let master = null;
  let wet = null;
  let noise = null;
  let timer = 0;
  let startedAt = 0;
  let seed = 7;
  let nextBeat = 0;
  let beat = 0.5;
  let chords = CHORDS;

  const rand = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  };

  /** 一段会衰减的噪声，当作混响的空间 */
  function impulse(seconds) {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch += 1) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i += 1) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
      }
    }
    return buf;
  }

  function build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    master.connect(comp);
    comp.connect(ctx.destination);

    /* 混响：一条干声，一条湿声 */
    const conv = ctx.createConvolver();
    conv.buffer = impulse(2.6);
    wet = ctx.createGain();
    wet.gain.value = 0.5;
    wet.connect(conv);
    conv.connect(master);

    /* 底噪，像旧磁带的沙沙声 */
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i += 1) d[i] = (Math.random() * 2 - 1) * 0.5;
    noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const ng = ctx.createGain();
    ng.gain.value = 0.02;
    noise.connect(lp);
    lp.connect(ng);
    ng.connect(master);
    noise.start();
  }

  /** 一个音：三角波 + 一点泛音，短促地亮一下就散进混响 */
  function pluck(midi, at, gain = 0.16, dur = 1.4) {
    const t = at;
    const osc = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    osc.type = 'triangle';
    osc2.type = 'sine';
    osc.frequency.value = MIDI(midi);
    osc2.frequency.value = MIDI(midi) * 2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const g2 = ctx.createGain();
    g2.gain.value = 0.35;
    osc.connect(g);
    osc2.connect(g2);
    g2.connect(g);
    g.connect(master);
    g.connect(wet);
    osc.start(t); osc2.start(t);
    osc.stop(t + dur + 0.1); osc2.stop(t + dur + 0.1);
  }

  /** 铺底：两把锯齿波经过低通，慢慢呼吸 */
  function pad(chord, at, dur, level = 0.06) {
    const t = at;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.9);
    g.gain.setValueAtTime(level, t + dur - 1.1);
    g.gain.linearRampToValueAtTime(0, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(700, t);
    lp.frequency.linearRampToValueAtTime(1500, t + dur * 0.6);
    lp.frequency.linearRampToValueAtTime(600, t + dur);
    lp.Q.value = 0.8;
    lp.connect(g);
    g.connect(master);
    g.connect(wet);
    chord.forEach((n, idx) => {
      [-6, 6].forEach((detune) => {
        const o = ctx.createOscillator();
        o.type = idx === 0 ? 'sine' : 'sawtooth';
        o.frequency.value = MIDI(n);
        o.detune.value = detune;
        const og = ctx.createGain();
        og.gain.value = idx === 0 ? 0.9 : 0.22;
        o.connect(og);
        og.connect(lp);
        o.start(t);
        o.stop(t + dur + 0.05);
      });
    });
  }

  /** 很轻的一下心跳，只在镜头切换时出现 */
  function thump(at, level = 0.12) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(96, at);
    o.frequency.exponentialRampToValueAtTime(42, at + 0.4);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(level, at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.6);
    o.connect(g);
    g.connect(master);
    o.start(at);
    o.stop(at + 0.7);
  }

  function actAt(elapsed) {
    return Math.max(0, Math.min(4, Math.floor(elapsed / ACT)));
  }

  /** 每 100 毫秒排一次接下来 300 毫秒的音符，节拍跟着画面走 */
  function schedule() {
    const now = ctx.currentTime;
    const elapsed = (performance.now() - startedAt);
    const remain = DURATION - elapsed;
    if (remain <= 0) { stop(); return; }

    const act = actAt(elapsed);
    const beat = 0.5;
    while (nextBeat < now + Math.max(0.3, beat * 1.4)) {
      const at = Math.max(now + 0.02, nextBeat);
      const into = elapsed + (at - now) * 1000;
      const actNow = actAt(into);
      const local = (into % ACT) / ACT;

      if (actNow === 0) {
        /* 初识：很空，只有一个高音偶尔落下 */
        if (Math.random() < 0.35) pluck(MELODY[Math.floor(rand() * MELODY.length)], at, 0.10, 2.0);
      } else if (actNow === 3) {
        /* 沉默：几乎只剩低音和一点点噪声 */
        if (Math.random() < 0.12) pluck(MELODY[0] - 12, at, 0.09, 2.4);
      } else {
        /* 靠近 / 分享 / 重逢：每半拍一个音，越往后越密 */
        const density = actNow === 2 ? 1 : 0.7;
        if (Math.random() < density) {
          const note = MELODY[Math.floor(rand() * MELODY.length)] + (actNow === 4 ? 12 : 0);
          pluck(note, at, actNow === 2 ? 0.15 : 0.12, 1.2 + rand() * 0.6);
        }
        if (Math.random() < 0.25) pluck(MELODY[0] - 12, at, 0.08, 1.6);
      }
      nextBeat += beat * (actNow === 2 ? 0.5 : 1);
    }
    timer = window.setTimeout(schedule, 100);
  }

  const state = { playing: false };

  /** 按豆包给的音乐性格调一次：调性、速度、和弦走向。 */
  function tune(story) {
    const music = (story && story.music) || {};
    if (!story || story.mode !== 'agent') { music.mood = 'warm'; music.tempo = 68; music.root = 'A'; }
    const roots = { A: 0, C: 3, D: 5, E: 7, F: 8, G: 10 };
    const shift = roots[String(music.root || 'A').toUpperCase()] ?? 0;
    const moods = {
      quiet: [[45, 57, 60, 64], [45, 57, 60, 64], [41, 53, 57, 60], [40, 52, 55, 59], [45, 57, 60, 64]],
      warm: CHORDS,
      hopeful: [[48, 60, 64, 67], [43, 55, 59, 62], [45, 57, 60, 64], [41, 53, 57, 60], [48, 60, 64, 67]],
      melancholic: [[45, 57, 60, 64], [40, 52, 55, 59], [41, 53, 57, 60], [43, 55, 59, 62], [45, 57, 60, 64]],
    };
    const shape = moods[music.mood] || CHORDS;
    chords = shape.map((chord) => chord.map((n) => n + shift));
    const tempo = Number(music.tempo) || 72;
    beat = Math.min(0.75, Math.max(0.36, 60 / tempo));
  }

  /** 手机上必须由一次真实触摸把 AudioContext 解锁，否则永远没声音。 */
  function unlock() {
    try {
      if (!ctx) build();
      if (ctx.state === 'suspended') ctx.resume();
      const g = ctx.createGain();
      g.gain.value = 0.0001;
      const o = ctx.createOscillator();
      o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.02);
      return true;
    } catch { return false; }
  }

  function start(story, fromMs = 0) {
    tune(story);
    try {
      if (!ctx) build();
      if (ctx.state === 'suspended') ctx.resume();
    } catch { return; }
    state.playing = true;
    seed = (story && story.seed ? story.seed : 7) | 0;
    startedAt = performance.now() - fromMs;

    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(0.0001, ctx.currentTime);
    master.gain.linearRampToValueAtTime(0.9, ctx.currentTime + 0.6);

    /* 五段铺底，按镜头排好 */
    const base = ctx.currentTime + 0.05;
    const offset = fromMs / 1000;
    for (let i = 0; i < 5; i += 1) {
      const at = base + Math.max(0, i * (ACT / 1000) - offset);
      const dur = ACT / 1000;
      if (at < base) continue;
      pad(chords[i], at, dur, i === 3 ? 0.035 : 0.06);
      thump(at, i === 3 ? 0.06 : 0.12);
    }

    nextBeat = ctx.currentTime + 0.05;
    schedule();
  }

  function stop() {
    state.playing = false;
    if (timer) { clearTimeout(timer); timer = 0; }
    if (!ctx) return;
    try {
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
      master.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
    } catch { /* ignore */ }
  }

  /** 解锁后被调用：如果之前在播但因为没解锁没声，这里补一次。 */
  function rearm(story, fromMs) {
    unlock();
    if (!story) return;
    try { start(story, fromMs || 0); } catch { /* 忽略 */ }
  }

  window.GlueMusic = { start, stop, unlock, rearm, get playing() { return state.playing; } };
})();
