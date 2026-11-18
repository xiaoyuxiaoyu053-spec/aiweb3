# DeepLine Web 2.5.0

The DeepLine app as a web app: iMessage-style AI chat with glass UI, bounce animations, 信息 list, 动态 feed (AI likes / comments / posts), 增加AI, groups, red packets & transfers, tapback reactions, sounds, light/dark chat, backup ZIP (compatible with the Android app).

* **Zero dependencies** – plain Node.js (>= 18) server + static files. No build step.
* **No accounts, no database.** All chats, AI characters, API keys and images live in the visitor's own browser (IndexedDB).
* `POST /api/ai` is a tiny stateless relay to DeepSeek / Claude / 豆包 / ChatGPT so the browser does not hit CORS errors. The upstream URL comes from a fixed allow-list on the server (never from the client); keys are forwarded for that one request and never stored or logged. Per-IP rate limit (default 90/min, env `RATE_LIMIT_PER_MIN`) and 16 MB body limit.

## Deploy on Render (about 3 minutes)
1. Put this folder in a Git repository (GitHub / GitLab) and push it.
2. Render dashboard → **New + → Blueprint** → select the repo. `render.yaml` is picked up automatically (free web service, health check `/healthz`).
   *Or* **New + → Web Service** with: Runtime `Node`, Build Command `npm install --no-audit --no-fund`, Start Command `node server.js`, Health Check Path `/healthz`.
3. Open the `https://<name>.onrender.com` URL. On a phone use **Add to Home Screen** to install it as an app (it ships a web-app manifest).

Notes
* Render's free plan sleeps after ~15 min idle; the first request afterwards takes a few seconds. Any paid plan stays awake (the AI "auto post" timer only runs while the page is open anyway).
* HTTPS is provided by Render, which is required for microphone/speech recognition and for installing the PWA.
* Environment variables (all optional): `PORT` (Render sets it), `RATE_LIMIT_PER_MIN`.

## Run locally
```
node server.js        # http://localhost:3000   (PORT=8080 node server.js to change)
```

## Using it
1. **增加AI → 创建 AI**: name, persona, provider, model, API key (kept only in this browser).
2. Chat. Long-press (or right-click) a bubble for tapback / copy / quote / delete. Tap a bubble to show its time, model and token count. `+` opens image / GIF / 红包 / 转账.
3. **我的 → 数据与备份** to export/restore a ZIP. Android backups (`data.json` + `media/`) can be imported here and the other way round.
4. **我的 → 连接方式**: relay through this server (default, recommended) or call the provider directly from the browser (works only where the provider allows CORS).

## Differences from the Android app (browser limits)
* The **AI Smart Assistant** (AccessibilityService phone control) cannot exist in a web page – it is Android-only.
* Voice chat uses the browser's Web Speech API (Chrome / Edge / Safari); it is not available in every browser (e.g. Firefox). The 病娇 (Yandere) easter egg and shake sensor are not ported.
* Data is per browser. Clearing site data deletes it – export backups regularly.
* Because the default mode relays through your server, whoever operates the server could technically see requests in transit. This code does not store or log them; if you do not want that, use "浏览器直连" or self-host.

## Files
```
server.js              static server + /api/ai relay + /healthz
render.yaml            Render Blueprint
public/index.html      app shell, manifest, icons, sounds
public/css/app.css     glass / iMessage styling
public/js/*.js         lib (AI, ZIP, IndexedDB, sounds) · state · logic · core · home · chat · forms · settings
```

## DeepLine 2.5.0 新增能力

- 管理后台：访问 `/admin.html`。部署时必须设置 `DEEPLINE_ADMIN_PASSWORD`，否则管理员登录会被禁用。
- 免费 API：管理员在后台设置服务商、模型和 API Key；密钥保存在服务端 `data/admin-config.json`，不会下发给访客，也不会进入浏览器 ZIP 备份。也可用 `DEEPLINE_FREE_API_KEY`、`DEEPLINE_FREE_API_PROVIDER`、`DEEPLINE_FREE_API_MODEL` 提供初始配置。
- 公告：管理员后台发布后，用户打开网页时会显示公告条。
- 统计：服务端统计页面加载、API 请求和服务商返回的 Token 用量，聚合数据保存在 `data/metrics.json`。不保存访客 IP、聊天内容或用户自带 API Key。
- DeepSeek：在「我的 → 数据与备份」导入 DeepSeek 完整导出 ZIP；以追加方式导入会话，保留原始消息片段、思考内容、工具记录和时间戳，按源会话 ID 去重。
- 人设 TXT：编辑 AI 人设时可直接导入 `.txt`。
- 长期记忆：聊天历史完整保存在本机；上下文会优先携带已生成的阶段总结及最近消息。模型仍受服务商上下文窗口限制，不能承诺单次请求无限上下文。

### 部署环境变量

- `DEEPLINE_ADMIN_PASSWORD`：必填的管理员登录密码。
- `DEEPLINE_DATA_DIR`：可选，服务端配置和统计的持久化目录。生产环境应挂载持久化磁盘到该目录。
- `DEEPLINE_FREE_API_KEY`：可选，免费 API 初始密钥。
- `DEEPLINE_FREE_API_PROVIDER`：可选，默认 `DeepSeek`。
- `DEEPLINE_FREE_API_MODEL`：可选，默认 `deepseek-chat`。

管理员密码和 API Key 不要写入公开仓库、前端文件或 ZIP 包。无持久化磁盘的平台在重启/重新部署后可能丢失后台保存的配置和统计数据。

统计口径补充：用户若启用「浏览器直连」模式，AI 请求不会经过本站服务器，因此这类请求无法被服务器准确计入 API 次数和 Token；使用默认的「经服务器转发」模式时统计完整。网站访问量按页面 HTML 请求次数计数，不是去重后的独立访客。Token 以服务商实际返回的 usage 字段为准。
