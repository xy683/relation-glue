import test from 'node:test';
import assert from 'node:assert/strict';
import { decode, detect, parseBlockLog, parseNameLog, stripHtml, toProjectLog } from '../lib/importers.mjs';

const WECHAT = [
  '2023-05-01 20:13:00 我',
  '在吗？',
  '2023-05-01 20:13:40 小满',
  '在呀，怎么啦',
  '2023-05-02 09:02:00 小满',
  '早呀，今天也要开心',
].join('\n');

const QQ = [
  '2023-05-01 20:13:00 我(10001)',
  '在吗？',
  '2023-05-01 20:13:40 小满(10002)',
  '在呀',
  '2023-05-02 09:02:00 小满(10002)',
  '早呀',
].join('\n');

test('微信导出的 txt：时间+名字一行，内容跟在后面', () => {
  const got = detect(WECHAT, '微信聊天记录.txt');
  assert.equal(got.app, 'wechat');
  assert.equal(got.messages.length, 3);
  assert.equal(got.messages[0].who, '我');
  assert.equal(got.messages[0].at, '2023-05-01 20:13');
  assert.equal(got.messages[0].text, '在吗？');
  assert.match(got.text, /^2023-05-01 20:13 我：在吗？$/m);
});

test('QQ 导出的 txt：名字后面带 QQ 号，去掉号留下人', () => {
  const got = detect(QQ, 'qq消息记录.txt');
  assert.equal(got.app, 'qq');
  assert.equal(got.messages.length, 3);
  assert.equal(got.messages[0].who, '我');
  assert.equal(got.messages[2].who, '小满');
  assert.equal(got.messages[0].text, '在吗？');
});

test('HTML 导出：先去标签，再按同一套规矩拆', () => {
  const html = `<html><body><div>2023-05-01 20:13:00 我</div><div>在吗？</div><div>2023-05-01 20:13:40 小满</div><div>在呀</div></body></html>`;
  const got = detect(html, 'chat.html');
  assert.equal(got.format, 'html-block');
  assert.equal(got.messages.length, 2);
  assert.equal(got.messages[1].who, '小满');
});

test('「名字：内容」的普通记录也认', () => {
  const got = detect('我：在吗？\n小满：在呀\n我：今天天气不错', 'chat.txt');
  assert.equal(got.messages.length, 3);
  assert.equal(got.messages[2].who, '我');
  assert.equal(toProjectLog(got.messages), '我：在吗？\n小满：在呀\n我：今天天气不错');
});

test('GBK 的老导出也能读，实体和标签都还原干净', () => {
  const gbk = Buffer.from([0xce, 0xd2, 0xa3, 0xba, 0xd4, 0xda, 0xc2, 0xf0, 0xa3, 0xbf]); /* 我：在吗？ */
  assert.equal(decode(gbk), '我：在吗？');
  assert.equal(stripHtml('<p>a &amp; b&nbsp;c</p><script>x()</script>'), 'a & b c');
});

test('一个文件里两条消息都拆得出来，内容里的空行不会把消息截断', () => {
  const lines = ['2023-05-01 20:13:00 我', '第一句', '', '第二句', '2023-05-01 20:14:00 小满', '好'];
  const got = parseBlockLog(lines.filter(Boolean));
  assert.equal(got.length, 2);
  assert.equal(got[0].text, '第一句\n第二句');
  assert.equal(parseNameLog(['没有冒号的一行']).length, 0);
});
