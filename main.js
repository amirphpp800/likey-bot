// main.js — Cloudflare Pages/Workers Telegram Like Bot with KV storage

// Data model (in KV):
// keys:
// - cfg:global => { forcedChannel: string | null, botUsername: string | null }
// - admin:set => { admins: number[] } from ENV.ADMINS
// - user:<userId> => { id, first_name, username, createdAt }
// - pending:<userId> => { step: string, data: any }  // FSM for users
// - like:<likeId> => { id, ownerId, title, createdAt, channelRequired: string|null, counts: number, voters: Set (as array) }
// - index:likes:<ownerId> => string[] of likeIds (for management list, optional)
// - stats:global => { totalLikes, totalButtons }
// Note: sets are stored as arrays to be JSON-friendly.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Optional health check or landing
    if (url.pathname === "/") {
      return new Response("Telegram Like Bot is running.", { status: 200 });
    }
    // You can mount other routes here if needed.
    return new Response("Not Found", { status: 404 });
  },
};

export async function handleUpdate(update, env, { waitUntil } = {}) {
  const token = env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN missing");
  const kv = env.BOT_KV;

  // Ensure admin list is cached in KV (from ENV.ADMINS)
  await ensureAdmins(env, kv);

  // Lazy fetch and cache bot username for deep-linking or diagnostics
  await ensureBotUsername(env, kv);

  try {
    if (update.message) {
      return await onMessage(update.message, env, kv);
    }
    if (update.callback_query) {
      return await onCallback(update.callback_query, env, kv);
    }
    // ignore other updates
  } catch (err) {
    console.error("handleUpdate error:", err);
  }
}

/* --------------- Helpers for Telegram API --------------- */

function apiUrl(env, method) {
  return `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
}

async function tgSendChatAction(env, chat_id, action = "typing") {
  try {
    await fetch(apiUrl(env, "sendChatAction"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id, action }),
    });
  } catch {}
}

async function tgSendMessage(env, chat_id, text, options = {}) {
  const body = { chat_id, text, parse_mode: "HTML", ...options };
  const res = await fetch(apiUrl(env, "sendMessage"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    console.error("sendMessage error", res.status, data);
  }
  return data;
}

async function tgEditMessageReplyMarkup(env, chat_id, message_id, reply_markup) {
  const res = await fetch(apiUrl(env, "editMessageReplyMarkup"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id, message_id, reply_markup }),
  });
  return res.json().catch(() => ({}));
}

async function tgAnswerCallback(env, callback_query_id, text, show_alert = false) {
  try {
    await fetch(apiUrl(env, "answerCallbackQuery"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id, text, show_alert }),
    });
  } catch {}
}

async function tgGetChatMember(env, chatUsernameOrId, userId) {
  // chat can be @channelusername
  const res = await fetch(apiUrl(env, "getChatMember"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatUsernameOrId, user_id: userId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    return null;
  }
  return data.result;
}

async function tgGetMe(env) {
  const res = await fetch(apiUrl(env, "getMe"));
  const data = await res.json().catch(() => ({}));
  return data.ok ? data.result : null;
}

/* --------------- KV helpers --------------- */

async function ensureAdmins(env, kv) {
  const key = "admin:set";
  const existing = await kv.get(key, { type: "json" });
  if (existing && Array.isArray(existing.admins)) return existing;
  const admins = String(env.ADMINS || "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  const payload = { admins };
  await kv.put(key, JSON.stringify(payload));
  return payload;
}

async function getAdmins(kv) {
  const data = await kv.get("admin:set", { type: "json" });
  return data && Array.isArray(data.admins) ? data.admins : [];
}

async function ensureBotUsername(env, kv) {
  const cfg = (await kv.get("cfg:global", { type: "json" })) || {};
  if (cfg.botUsername) return cfg;
  const me = await tgGetMe(env);
  const botUsername = me?.username || null;
  const forcedChannel = cfg.forcedChannel ?? "@NoiDUsers";
  const merged = { botUsername, forcedChannel };
  await kv.put("cfg:global", JSON.stringify(merged));
  return merged;
}

async function getGlobalConfig(kv) {
  const cfg = (await kv.get("cfg:global", { type: "json" })) || {};
  if (typeof cfg.forcedChannel === "undefined") cfg.forcedChannel = "@NoiDUsers";
  return cfg;
}

async function setForcedChannel(kv, chan) {
  const cfg = await getGlobalConfig(kv);
  cfg.forcedChannel = chan;
  await kv.put("cfg:global", JSON.stringify(cfg));
}

async function getUser(kv, id) {
  return (await kv.get(`user:${id}`, { type: "json" })) || null;
}
async function setUser(kv, user) {
  await kv.put(`user:${user.id}`, JSON.stringify(user));
}

async function getPending(kv, userId) {
  return (await kv.get(`pending:${userId}`, { type: "json" })) || null;
}
async function setPending(kv, userId, obj) {
  await kv.put(`pending:${userId}`, JSON.stringify(obj));
}
async function clearPending(kv, userId) {
  await kv.delete(`pending:${userId}`);
}

function makeLikeId() {
  // simple unique ID
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function getLike(kv, likeId) {
  return (await kv.get(`like:${likeId}`, { type: "json" })) || null;
}
async function setLike(kv, likeObj) {
  await kv.put(`like:${likeObj.id}`, JSON.stringify(likeObj));
}
async function addLikeIndex(kv, ownerId, likeId) {
  const key = `index:likes:${ownerId}`;
  const list = (await kv.get(key, { type: "json" })) || [];
  if (!list.includes(likeId)) {
    list.push(likeId);
    await kv.put(key, JSON.stringify(list));
  }
}
async function getLikeIndex(kv, ownerId) {
  return (await kv.get(`index:likes:${ownerId}`, { type: "json" })) || [];
}

async function bumpStats(kv, field, inc = 1) {
  const key = "stats:global";
  const stats = (await kv.get(key, { type: "json" })) || {
    totalLikes: 0,
    totalButtons: 0,
  };
  if (field in stats) stats[field] += inc;
  await kv.put(key, JSON.stringify(stats));
  return stats;
}

/* --------------- Bot logic --------------- */

const MENU = {
  main: [
    [{ text: "ساخت لایک" }],
    [{ text: "تنظیمات" }],
  ],
  admin: [
    [{ text: "تنظیم کانال اجباری" }],
    [{ text: "لیست لایک‌های من" }],
    [{ text: "بازگشت" }],
  ],
};

function kbReply(keyboard) {
  return {
    reply_markup: {
      keyboard,
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}

function inlineLikeKeyboard(likeId, count, channelRequired) {
  const row = [];
  row.push({
    text: `❤️ لایک (${count})`,
    callback_data: `like:${likeId}`,
  });
  const rows = [row];
  if (channelRequired) {
    rows.push([
      {
        text: "اشتراک بنر",
        switch_inline_query: likeId, // quick share via inline mode (requires enabling inline in @BotFather)
      },
    ]);
  } else {
    rows.push([
      {
        text: "اشتراک بنر",
        switch_inline_query: likeId,
      },
    ]);
  }
  return { inline_keyboard: rows };
}

function shareBannerText(title, channelRequired) {
  let txt = `بنر لایک برای: <b>${escapeHtml(title)}</b>\n`;
  if (channelRequired) {
    txt += `برای ثبت لایک باید عضو کانال شوید: ${channelRequired}`;
  } else {
    txt += `برای ثبت لایک روی دکمه لایک بزنید.`;
  }
  return txt;
}

function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function onMessage(message, env, kv) {
  const chat_id = message.chat.id;
  const from = message.from;
  await tgSendChatAction(env, chat_id);

  // register user if not exists
  const u = (await getUser(kv, from.id)) || {
    id: from.id,
    first_name: from.first_name,
    username: from.username || null,
    createdAt: Date.now(),
  };
  await setUser(kv, u);

  const text = (message.text || "").trim();

  // FSM continuation
  const pending = await getPending(kv, from.id);
  if (pending) {
    if (pending.step === "await_like_title") {
      const title = text;
      const cfg = await getGlobalConfig(kv);
      const likeId = makeLikeId();
      const likeObj = {
        id: likeId,
        ownerId: from.id,
        title,
        createdAt: Date.now(),
        channelRequired: cfg.forcedChannel || null,
        counts: 0,
        voters: [],
      };
      await setLike(kv, likeObj);
      await addLikeIndex(kv, from.id, likeId);
      await bumpStats(kv, "totalButtons", 1);
      await clearPending(kv, from.id);

      const bannerText = shareBannerText(title, likeObj.channelRequired);
      await tgSendMessage(env, chat_id, `${bannerText}\n\nلایک شما ساخته شد ✅`, {
        reply_markup: inlineLikeKeyboard(likeId, likeObj.counts, likeObj.channelRequired),
      });
      return;
    }
  }

  // Commands or menu
  if (text === "/start") {
    return tgSendMessage(
      env,
      chat_id,
      "سلام! من ربات لایک هستم.\nاز منو یکی رو انتخاب کن:",
      kbReply(MENU.main)
    );
  }

  if (text === "ساخت لایک" || text === "/new") {
    await setPending(kv, from.id, { step: "await_like_title" });
    return tgSendMessage(env, chat_id, "اسم/عنوان موردی که می‌خوای لایک‌گیری بشه رو بفرست:");
  }

  if (text === "تنظیمات" || text === "/settings") {
    const admins = await getAdmins(kv);
    if (!admins.includes(from.id)) {
      return tgSendMessage(env, chat_id, "تنها ادمین‌ها به تنظیمات دسترسی دارند.");
    }
    return tgSendMessage(env, chat_id, "پنل مدیریت:", kbReply(MENU.admin));
  }

  if (text === "تنظیم کانال اجباری") {
    const admins = await getAdmins(kv);
    if (!admins.includes(from.id)) {
      return tgSendMessage(env, chat_id, "دسترسی ندارید.");
    }
    await setPending(kv, from.id, { step: "await_forced_channel" });
    return tgSendMessage(
      env,
      chat_id,
      "نام کاربری کانال را با @ بفرست (مثال: @NoiDUsers) یا بنویس off برای غیرفعال شدن:"
    );
  }

  if (text === "لیست لایک‌های من") {
    const list = await getLikeIndex(kv, from.id);
    if (!list.length) {
      return tgSendMessage(env, chat_id, "شما هنوز هیچ لایکی نساختی.");
    }
    let out = "لیست لایک‌های شما:\n";
    for (const id of list) {
      const l = await getLike(kv, id);
      if (!l) continue;
      out += `• ${l.title} — ID: <code>${l.id}</code> — ❤️ ${l.counts}\n`;
    }
    return tgSendMessage(env, chat_id, out, { parse_mode: "HTML" });
  }

  if (text === "بازگشت") {
    return tgSendMessage(env, chat_id, "بازگشت به منوی اصلی.", kbReply(MENU.main));
  }

  // Admin pending handler
  const pend2 = await getPending(kv, from.id);
  if (pend2 && pend2.step === "await_forced_channel") {
    const admins = await getAdmins(kv);
    if (!admins.includes(from.id)) {
      await clearPending(kv, from.id);
      return tgSendMessage(env, chat_id, "دسترسی ندارید.");
    }
    const val = text.toLowerCase();
    if (val === "off" || val === "خاموش" || val === "تعطیل") {
      await setForcedChannel(kv, null);
      await clearPending(kv, from.id);
      return tgSendMessage(env, chat_id, "عضویت اجباری غیرفعال شد.");
    }
    const chan = text.startsWith("@") ? text : "@" + text;
    await setForcedChannel(kv, chan);
    await clearPending(kv, from.id);
    return tgSendMessage(env, chat_id, `کانال اجباری تنظیم شد: ${chan}`);
  }

  // Fallback
  return tgSendMessage(env, chat_id, "دستور نامعتبر. از منو استفاده کن.", kbReply(MENU.main));
}

async function onCallback(cb, env, kv) {
  const from = cb.from;
  const message = cb.message;
  const data = cb.data || "";

  if (!data || !data.startsWith("like:")) {
    await tgAnswerCallback(env, cb.id, "دستور نامعتبر");
    return;
  }
  const likeId = data.split(":")[1];
  const likeObj = await getLike(kv, likeId);
  if (!likeObj) {
    await tgAnswerCallback(env, cb.id, "این بنر یافت نشد یا حذف شده است.");
    return;
  }

  // Membership check if required
  if (likeObj.channelRequired) {
    const member = await tgGetChatMember(env, likeObj.channelRequired, from.id);
    const status = member?.status;
    const ok =
      status === "creator" ||
      status === "administrator" ||
      status === "member";
    if (!ok) {
      await tgAnswerCallback(
        env,
        cb.id,
        `برای ثبت لایک ابتدا عضو کانال شوید: ${likeObj.channelRequired}`,
        true
      );
      return;
    }
  }

  // Prevent duplicate likes
  const voters = new Set(likeObj.voters || []);
  if (voters.has(from.id)) {
    await tgAnswerCallback(env, cb.id, "قبلاً لایک کرده‌ای!");
    return;
  }
  voters.add(from.id);
  likeObj.voters = Array.from(voters);
  likeObj.counts = (likeObj.counts || 0) + 1;
  await setLike(kv, likeObj);
  await bumpStats(kv, "totalLikes", 1);

  // Update the inline keyboard counter in-place (if possible)
  if (message && message.chat && message.message_id) {
    const reply_markup = inlineLikeKeyboard(likeId, likeObj.counts, likeObj.channelRequired);
    await tgEditMessageReplyMarkup(env, message.chat.id, message.message_id, reply_markup);
  }

  await tgAnswerCallback(env, cb.id, "لایک ثبت شد ✅");
}

/* --------------- Notes --------------- */
// Optional: You can enable inline mode in @BotFather so that the "اشتراک بنر" button
// opens a share composer. Alternatively, users can just forward the banner message.
