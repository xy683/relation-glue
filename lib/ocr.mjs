/**
 * 聊天截图 → 一串可以当成聊天记录的文字。
 *
 * Windows 自带的中文 OCR 给出每一行的位置；一张聊天截图里，气泡靠左是一个人说，靠右是另一个人说。
 * 这里把同一侧、挨得近的几行合成一句，去掉汉字之间被 OCR 加进来的空格，再写成 `我：…` / `TA：…`
 * 这样的聊天记录——和直接粘进来的文本一个格式，后面读五个镜头的代码不需要知道它来自图片。
 *
 * 认错的字、认错的左右，都交给贴进来的人自己看一眼再改：导入只是开头，不是定稿。
 */

/** 汉字、全角标点之间被 OCR 加的空格去掉；英文单词之间的空格留着。 */
export function cleanOcrText(text) {
  return String(text ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/(?<=[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])\s+(?=[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])/g, '')
    .replace(/\s+(?=[，。！？、；：）】》”’])/g, '')
    .replace(/(?<=[（【《“‘])\s+/g, '')
    .trim();
}

/**
 * 一页 OCR 的行 → 一颗颗气泡。同一侧、竖直方向挨得近的行算一句（一个气泡里折行）。
 * @param {{ x: number, y: number, w: number, h: number, text: string }[]} lines
 * @param {number} width 图片宽度，用来判断左右
 */
export function bubbleLines(lines, width) {
  const rows = (lines ?? [])
    .map((l) => ({ ...l, text: cleanOcrText(l.text) }))
    .filter((l) => l.text && l.h > 0)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  if (!rows.length) return [];
  const mid = width / 2;
  const out = [];
  for (const row of rows) {
    const right = row.x + row.w / 2 > mid;
    const last = out.at(-1);
    /* 同一个气泡里的第二行：同一侧，竖直距离小于行高的一半左右 */
    if (last && last.right === right && row.y - (last.y + last.h) < Math.max(10, row.h * 0.55) && row.x >= last.x - 40) {
      last.text = `${last.text}${/[A-Za-z0-9]$/.test(last.text) ? ' ' : ''}${row.text}`;
      last.y = row.y;
      last.h = Math.max(last.h, row.h);
      continue;
    }
    out.push({ right, x: row.x, y: row.y, h: row.h, text: row.text });
  }
  return out;
}

/**
 * 气泡 → 聊天记录的文字。`names` 是表单上填的昵称与备注：靠右的算「我」，靠左的算对方。
 * 一条时间都没有，所以不带时间戳；读五个镜头的那段代码不需要时间也能分出节奏。
 */
export function toLog(bubbles, names = {}) {
  const me = String(names.me ?? '').trim() || '我';
  const partner = String(names.partner ?? '').trim() || 'TA';
  return bubbles.map((b) => `${b.right ? me : partner}：${b.text}`).join('\n');
}

/** 一段 OCR 的结果（ocr.ps1 写出的 JSON 文字）→ 聊天记录。认不出东西时返回空串。 */
export function logFromOcr(jsonText, names) {
  let payload;
  try { payload = JSON.parse(String(jsonText ?? '').replace(/^\uFEFF/, '')); } catch { return ''; }
  if (!payload || !Array.isArray(payload.lines) || !payload.lines.length) return '';
  const width = Number(payload.width) || 0;
  return toLog(bubbleLines(payload.lines, width || 1), names);
}
