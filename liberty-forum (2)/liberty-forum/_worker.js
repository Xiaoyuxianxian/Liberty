/**
 * Liberty Forum - Cloudflare Worker（完整后端）
 * ---------------------------------------------------------------
 * 与前端 index.html 的云端同步层完全对接。
 * 前端只通过 /api/* 与本文件通信，业务逻辑仍留在前端；
 * 本 Worker 只负责两件事：
 *
 *   1) /api/state       用 KV 做全站数据的云端读写（GET 拉 / POST 推）
 *   2) /api/verifycode  手机号/邮箱验证码：发码 + 校验
 *                       · type=email 且已配置 RESEND_API_KEY → 真实邮件
 *                       · 其余情况 → 演示模式，直接返回 6 位码（前端自行校验）
 *
 * ---------------------------------------------------------------
 * 部署方式（Cloudflare Pages + Functions）：
 *   本文件放在仓库根目录，命名为  _worker.js  （Pages Functions 约定）
 *   与前端的 index.html 在同一目录。
 *
 * 绑定（Cloudflare 控制台 → liberty-forum → Settings → Functions → KV namespace bindings）：
 *   变量名（Variable name）:  FORUM_KV
 *   绑定到一个 KV 命名空间（没有就新建一个，名字随意，如 liberty-forum-data）
 *
 * 环境变量（Settings → Environment variables）：
 *   RESEND_API_KEY  = re_xxxxxxxx          （可选；填了 email 才会真实发信）
 *   RESEND_FROM     = "Liberty Forum" <onboarding@resend.dev>  （可选；默认用 resend 的测试发件人）
 *   SITE            = https://liberty-forum.com   （可选；仅用于邮件里的链接展示）
 * ---------------------------------------------------------------
 */

// 配置从每次请求的 env 中读取（Cloudflare Pages Functions 会把 bindings / env vars 注入 fetch 的第二个参数）
const STATE_KEY = 'forum:state';     // KV 里存全站 state 的 key
const CODE_TTL = 5 * 60;             // 验证码有效期（秒），前端约定 5 分钟

function getKV(env) { return env && (env.FORUM_KV || env.FORUM_KV); }
function getResendKey(env) { return env && (env.RESEND_API_KEY || env.resend_api_key); }
function getResendFrom(env) { return (env && (env.RESEND_FROM || env.resend_from)) || 'Liberty Forum <onboarding@resend.dev>'; }
function getSite(env) { return (env && (env.SITE || env.site)) || 'https://liberty-forum.pages.dev'; }

// ---------- 工具 ----------
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }

// ---------- KV 读写（云端 state）----------
async function readState(env) {
  const kv = getKV(env); if (!kv) return {};
  try { const txt = await kv.get(STATE_KEY); return txt ? JSON.parse(txt) : {}; } catch (e) { return {}; }
}
async function writeState(env, state) {
  const kv = getKV(env); if (!kv) return false;
  try { await kv.put(STATE_KEY, JSON.stringify(state)); return true; } catch (e) { return false; }
}

// ---------- Resend 发邮件 ----------
async function sendResendEmail(env, { to, subject, html, text }) {
  const apiKey = getResendKey(env);
  if (!apiKey) return { ok: false, reason: 'no_key' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: getResendFrom(env), to: [to], subject, html, text })
  });
  if (!res.ok) { const b = await res.text().catch(() => ''); throw new Error('Resend ' + res.status + ': ' + b); }
  return { ok: true, data: await res.json() };
}
function emailHTML(env, { code, target }) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1f2937">
    <h2 style="color:#7c3aed">Liberty Forum</h2>
    <p>你好，你的 ${target} 正在请求登录/注册验证码：</p>
    <div style="font-size:32px;font-weight:800;letter-spacing:6px;color:#7c3aed;background:#f3f0ff;padding:12px;border-radius:12px;text-align:center;margin:16px 0">${code}</div>
    <p style="color:#6b7280;font-size:13px">该验证码 5 分钟内有效。若非本人操作，请忽略。</p>
    <p style="color:#9ca3af;font-size:12px">${SITE}</p>
  </div>`;
}

// ---------- 验证码：存/取 ----------
async function saveCode(env, type, target, code) {
  // 用 KV 存；若没绑 KV，则只走演示（内存不持久，多实例不一致，故务必绑 KV）
  const map = await readState(env);
  map.__codes = map.__codes || {};
  map.__codes[type + ':' + target] = { code, expire: Date.now() + CODE_TTL * 1000 };
  await writeState(env, map);
}
async function checkCode(env, type, target, code) {
  const map = await readState(env);
  const c = (map.__codes && map.__codes[type + ':' + target]) || null;
  if (!c) return { ok: false, error: '验证码不存在或已过期' };
  if (Date.now() > c.expire) return { ok: false, error: '验证码已过期，请重新获取' };
  if (c.code !== String(code)) return { ok: false, error: '验证码错误' };
  // 校验成功后一次性消费
  delete map.__codes[type + ':' + target];
  await writeState(env, map);
  return { ok: true };
}

// ============================================================
// 路由入口
// ============================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ---- /api/state ：云端数据读写 ----
    if (path === '/api/state') {
      if (request.method === 'GET') {
        // 探测接口：返回 {ok:true, state:{...}}；未绑 KV 也返回空 state（前端会降级）
        const state = await readState(env);
        // 不把内部验证码表暴露给前端
        const { __codes, ...publicState } = state;
        return json({ ok: true, state: publicState });
      }
      if (request.method === 'POST') {
        if (!getKV(env)) return json({ ok: false, error: 'KV 未绑定（请绑定 FORUM_KV）' }, 500);
        try {
          const body = await request.json();
          const incoming = (body && body.state) || {};
          // 合并策略：以云端为准，但允许前端增量推送覆盖
          const cur = await readState(env);
          const { __codes, ...safeCur } = cur;
          const merged = { ...safeCur, ...incoming };
          const ok = await writeState(env, merged);
          return json({ ok, state: incoming });
        } catch (e) { return json({ ok: false, error: e.message }, 400); }
      }
      return json({ error: 'Method Not Allowed' }, 405);
    }

    // ---- /api/verifycode ：发码 / 校验 ----
    if (path === '/api/verifycode') {
      let body = {};
      try { body = await request.json(); } catch (e) {}
      const action = body.action;          // 'send' | 'verify'
      const type = body.type;              // 'phone' | 'email'
      const target = (body.target || '').trim();

      if (action === 'send') {
        if (!target) return json({ ok: false, error: '缺少 target' });
        if (type === 'phone' && !/^1[3-9]\d{9}$/.test(target)) return json({ ok: false, error: '手机号格式错误' });
        if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) return json({ ok: false, error: '邮箱格式错误' });

        const code = genCode();
        await saveCode(env, type, target, code);

        // 邮箱 + 已配 Resend → 真实发信
        if (type === 'email' && getResendKey(env)) {
          try {
            await sendResendEmail(env, {
              to: target,
              subject: 'Liberty Forum - 邮箱验证码',
              html: emailHTML(env, { code, target }),
              text: `你的 Liberty Forum 验证码是 ${code}（5 分钟内有效）`
            });
            return json({ ok: true, demo: false, message: '邮件已发送' });
          } catch (e) {
            // 发信失败也不影响演示回退：仍把码返回给前端
            return json({ ok: true, demo: true, code, message: '邮件发送失败，已降级为演示码：' + e.message });
          }
        }
        // 手机号 或 未配 Resend → 演示模式（前端会显示演示码）
        return json({ ok: true, demo: true, code, message: '演示模式：请将此码填入即可' });
      }

      if (action === 'verify') {
        const code = (body.code || '').trim();
        if (!code) return json({ ok: false, error: '请输入验证码' });
        const r = await checkCode(env, type, target, code);
        return json(r.ok ? { valid: true } : { valid: false, error: r.error });
      }

      return json({ error: 'action 必须为 send 或 verify' }, 400);
    }

    // 其它路径交给前端（SPA / 静态资源），让 Pages 正常托管 index.html
    return env && env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not Found', { status: 404 });
  }
};
