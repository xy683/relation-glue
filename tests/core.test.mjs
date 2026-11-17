import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, bubbleOf, parseLog, span, timeOf, warmth } from '../lib/analyzer.mjs';
import { FORBIDDEN_TONES, judge } from '../lib/filter.mjs';
import { bubbleLines, cleanOcrText, logFromOcr, toLog } from '../lib/ocr.mjs';

const LOG = [
  '2023-05-01 20:13 我：在吗？',
  '2023-05-01 20:14 小满：在呀，怎么啦',
  '2023-05-01 20:15 我：没什么，就是今天天气很好',
  '2023-05-02 09:02 小满：早呀，今天也要开心',
  '2023-05-02 12:30 我：路过一家很好吃的店，下次带你去',
  '2023-05-03 22:10 小满：今天好累',
  '2023-05-03 22:11 我：早点睡',
  '2023-05-20 23:40 小满：算了，随便你',
  '2023-05-20 23:41 我：哦',
].join('\n');

test('the log is read into messages: who, when, what', () => {
  const messages = parseLog(LOG);
  assert.equal(messages.length, 9);
  assert.equal(messages[0].who, '我');
  assert.equal(messages[0].text, '在吗？');
  assert.ok(messages[0].at > 0);
  /* a line with no speaker continues the one before it */
  const joined = parseLog('A：今天去了\n海边，风很大\nB：真好');
  assert.equal(joined.length, 2);
  assert.equal(joined[0].text, '今天去了 海边，风很大');
});

test('a timestamp is read as a time, and a gap as a person says it', () => {
  assert.ok(Number.isFinite(timeOf('2023-05-01 20:13')));
  assert.ok(Number.isFinite(timeOf('[2023/5/1 20:13]')));
  assert.equal(span(3 * 3600_000), '3 小时');
  assert.equal(span(2 * 24 * 3600_000), '2 天');
});

test('a bubble is short, one line, and keeps the person’s words', () => {
  assert.equal(bubbleOf('在吗？'), '在吗？');
  assert.ok(bubbleOf('今天路过一家很好吃的店，下次带你去', 10).length <= 11);
  assert.equal(bubbleOf('看看这个 https://example.com/x 好不好'), '看看这个 好不好');
});

test('the five acts come from the log, and every bubble is a real line', () => {
  const story = analyze(LOG, { me: '我', partner: '小满' });
  assert.equal(story.acts.length, 5);
  assert.deepEqual(story.acts.map((a) => a.key), ['hello', 'closer', 'sweet', 'cold', 'again']);
  assert.equal(story.me, '我');
  assert.equal(story.partner, '小满');
  const lines = parseLog(LOG).map((m) => m.text).join('\n');
  for (const act of story.acts) {
    for (const bubble of act.bubbles) {
      if (!bubble?.text || bubble.text === '……') continue;
      const head = bubble.text.replace(/…$/, '');
      assert.ok(lines.includes(head), `"${head}" is from the log`);
    }
  }
  assert.equal(story.stats.messages, 9);
});

test('a warm line and a cold line are told apart', () => {
  assert.ok(warmth('今天也要开心呀') > 0.5);
  assert.ok(warmth('算了，随便你') < 0.5);
  assert.equal(warmth('今天天气不错'), null);
});

test('a line of the first meeting crosses; a line carrying the later hurt does not', () => {
  for (const ok of ['你好呀，很高兴认识你', '今天路过一家店，想带你去', '你总是这么可爱', '在吗？', '嗯', '晚安，做个好梦']) {
    assert.equal(judge(ok).ok, true, ok);
  }
  for (const held of ['你上次为什么那样说', '你总是这样，从来不改', '凭什么都是我在让步', '我们分手吧', '呵呵，随便你', '你上次答应我的事又忘了', '你根本不在乎我']) {
    assert.equal(judge(held).ok, false, held);
  }
});

test('no hard system word is ever put on this page', () => {
  for (const word of FORBIDDEN_TONES) assert.ok(!judge(`这是${word}内容`).why?.includes(word));
});

test('a chat screenshot becomes a log: spaces cleaned, left and right told apart, wrapping joined', () => {
  assert.equal(cleanOcrText('在 吗 ？'), '在吗？');
  assert.equal(cleanOcrText('今 天 路 过 一 家 店 ， 下 次 带 你 去'), '今天路过一家店，下次带你去');
  assert.equal(cleanOcrText('OK 好 的'), 'OK 好的');
  const bubbles = bubbleLines([
    { x: 40, y: 60, w: 120, h: 30, text: '在 吗 ？' },
    { x: 500, y: 140, w: 200, h: 30, text: '在 呀 ， 怎 么 啦' },
    /* 同一个气泡折行 */
    { x: 40, y: 96, w: 260, h: 30, text: '今天路过一家店' },
  ], 840);
  assert.equal(bubbles.length, 2);
  assert.equal(bubbles[0].right, false);
  assert.equal(bubbles[0].text, '在吗？今天路过一家店');
  assert.equal(bubbles[1].right, true);
  const log = toLog(bubbles, { me: '我', partner: '小满' });
  assert.equal(log, '小满：在吗？今天路过一家店\n我：在呀，怎么啦');
  const fromJson = logFromOcr(JSON.stringify({ width: 840, lines: [{ x: 40, y: 10, w: 100, h: 30, text: '嗨' }] }), { me: '我', partner: '小满' });
  assert.equal(fromJson, '小满：嗨');
  assert.equal(logFromOcr('not json', {}), '');
});
