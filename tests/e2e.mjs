import { chromium } from 'file:///C:/Users/Administrator/OpenFilm/app/packages/openfilm/node_modules/playwright-core/index.mjs';

const BASE = 'http://127.0.0.1:5178';
const OUT = 'C:/Users/Administrator/Documents/deepseek-harness/default-workspace';
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

const browser = await chromium.launch({ headless: true });
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

async function shot(page, name) { await page.screenshot({ path: `${OUT}/${name}.png` }); }

const host = await browser.newContext(phone);
const hostPage = await host.newPage();
const errors = [];
hostPage.on('pageerror', (e) => errors.push('host: ' + e.message));
await hostPage.goto(BASE, { waitUntil: 'networkidle' });
await shot(hostPage, 'glue-home');

await hostPage.fill('#log', LOG);
await hostPage.fill('#me', '我');
await hostPage.fill('#partner', '小满');
await hostPage.click('#go');
await hostPage.waitForURL(/\/r\/[A-Za-z0-9_-]+/, { timeout: 15000 });
await hostPage.waitForTimeout(1200);
await shot(hostPage, 'glue-waiting');

const roomUrl = hostPage.url().replace(/#.*$/, '');
const guest = await browser.newContext(phone);
const guestPage = await guest.newPage();
guestPage.on('pageerror', (e) => errors.push('guest: ' + e.message));
await guestPage.goto(roomUrl, { waitUntil: 'networkidle' });

/* 同步播放：等短片真的开始，抓一帧中段 */
await hostPage.waitForTimeout(5000);
await shot(hostPage, 'glue-film');
await shot(guestPage, 'glue-film-guest');

/* 短片结束 → 确认面板 */
await hostPage.waitForSelector('#view-confirm:not(.hidden)', { timeout: 20000 });
await hostPage.waitForTimeout(400);
await shot(hostPage, 'glue-confirm');
const confirmText = await hostPage.locator('#view-confirm').innerText();

/* 双方按「是」 */
await hostPage.click('#accept');
await guestPage.waitForSelector('#view-confirm:not(.hidden)', { timeout: 8000 });
await guestPage.click('#accept');
await hostPage.waitForSelector('#view-chat:not(.hidden)', { timeout: 10000 });
await guestPage.waitForSelector('#view-chat:not(.hidden)', { timeout: 10000 });
await hostPage.waitForTimeout(600);

/* 友好的一句 → 原样送达另一边 */
await hostPage.fill('#input', '你好呀，很高兴认识你');
await hostPage.click('#send');
await guestPage.waitForSelector('.msg.you', { timeout: 5000 });
await guestPage.fill('#input', '我也是，今天天气挺好的');
await guestPage.click('#send');
await guestPage.waitForSelector('.msg.me', { timeout: 5000 });
await hostPage.waitForTimeout(700);
await shot(hostPage, 'glue-chat');

/* 带着伤痕的一句 → 不转发，只有发送者看到那一张 */
await hostPage.fill('#input', '你上次为什么那样说，你总是这样');
await hostPage.click('#send');
await hostPage.waitForSelector('.shiver', { timeout: 5000 });
await hostPage.waitForTimeout(400);
await shot(hostPage, 'glue-shiver');
const guestMessages = await guestPage.locator('.messages').innerText();

/* 倒计时结束 */
await hostPage.waitForSelector('#view-ended:not(.hidden)', { timeout: 25000 });
await guestPage.waitForSelector('#view-ended:not(.hidden)', { timeout: 15000 });
await hostPage.waitForTimeout(300);
await shot(hostPage, 'glue-ended');
const endText = await hostPage.locator('#view-ended').innerText();

console.log(JSON.stringify({ roomUrl, errors, confirmText, guestMessages, endText }, null, 2));
await browser.close();
