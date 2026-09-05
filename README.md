# Liberty Forum（Cloudflare Pages 完整版）

前后端一体：前端 `index.html` + 后端 `_worker.js`（Cloudflare Pages Functions）。
部署后所有用户数据走 KV 云端同步，注册/登录支持手机号 + 邮箱验证码。

## 文件
- `index.html`  前端（UI + 业务逻辑，云端同步层已内置）
- `_worker.js`   后端（处理 `/api/state` 云端读写 + `/api/verifycode` 验证码）

## 部署步骤（Cloudflare Pages）

1. 把本目录所有文件推到 GitHub 仓库 `Xiaoyuxianxian/liberty-forum`（main 分支）
   - `index.html` 与 `_worker.js` 必须在**同一目录**（仓库根目录）
2. Cloudflare → Workers & Pages → liberty-forum → **Settings**
3. **Functions → KV namespace bindings** 添加绑定：
   - Variable name: `FORUM_KV`
   - KV namespace: 选一个（没有就新建，名随意，如 `liberty-forum-data`）
4. **Environment variables** 添加（可选，用于真实发邮件）：
   - `RESEND_API_KEY` = `re_你的密钥`
   - `RESEND_FROM`    = `Liberty Forum <onboarding@resend.dev>`
   - `SITE`           = `https://liberty-forum.com`
5. 保存 → 自动重新部署 → 访问 `https://liberty-forum.pages.dev`

## 验证
- 打开网站能注册/登录/发帖/私信 = 云端同步成功（页面底部不会再提示纯本地）
- 邮箱验证码：配了 `RESEND_API_KEY` 即真实发信；未配则自动演示模式（页面直接显示 6 位码）
- 手机号验证码：始终演示模式（页面直接显示 6 位码）

## 说明
- 前端自动探测 `/api/state`：能连上 Worker 就用云端，连不上自动降级为 localStorage 本地模式。
- 务必绑定 KV（变量名必须是 `FORUM_KV`），否则云端读写会失败。
