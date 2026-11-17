# 关系复原胶 · 部署成一个真正的网站（电脑关机也能用）

这个目录可以直接跑成一个 Node 服务。房间在内存里，所以**只能单实例**（不要开多副本）。

## 方式 A：Render（免费档，不用信用卡，最省事）

1. 用一个 Git 仓库（GitHub / Gitee 都行）放这个目录，或者把仓库地址给 Render。
2. 打开 https://render.com → 用 GitHub 或邮箱登录 → **New → Web Service**。
3. 选仓库，Runtime 选 **Docker**（本目录有 Dockerfile），Instance Type 选 **Free**。
4. 点 **Create Web Service**。等两三分钟，Render 给你一个固定地址：
   `https://<你的名字>.onrender.com`
5. 这个地址就是永久网站：手机、电脑、在任何网络都能打开，电脑关机也不影响。

> 免费档 15 分钟没人访问会休眠，第一次打开会慢 20~30 秒；之后正常。要一直醒着，选 Starter（约 $7/月）。

## 方式 B：Fly.io / Railway / 任意 Docker 主机

```sh
docker build -t relation-glue .
docker run -p 5178:5178 -e PORT=5178 relation-glue
```

把 5178 端口映射出去即可。平台会注入 `PORT`，服务会照着监听。

## 方式 C：自己的服务器

```sh
node server.mjs        # 需要 Node 22+
```
用 nginx/caddy 反代到 5178。注意 **SSE 不能缓冲**：反代要关掉响应缓冲（`proxy_buffering off;`），否则倒计时和消息不会实时到。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 5178 | 监听端口 |
| `GLUE_CHAT_MS` | 1200000 | 幻境时长（毫秒），测试时可改小 |
| `GLUE_FILM_MS` | 15000 | 短片时长 |

## 注意

- 房间在进程内存里：**重启/重新部署会清空所有房间**，正在聊的两个人的链接会失效（页面会显示“这间房已经不在了”）。
- 微信/QQ 的窗口抓取、Windows OCR 依赖 Windows：部署到 Linux 服务器时，这三样（打开应用 / 截图识别 / 窗口导入）不可用；粘贴导入、文件导入、截图导入（在用户自己电脑上）不受影响。**如果要保留“打开微信导入”，得跑在 Windows 主机上。**
