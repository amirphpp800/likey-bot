/**
 * --- LIKEY BOT (Cloudflare Pages + KV + Telegram) ---
 * 
 * KV Namespace Binding:
 *   LIKEY_BOT     → برای ذخیره‌سازی داده‌ها (step کاربران، لایک‌ها، کانال اجباری، کاربران)
 *
 * Environment Variables (ENV):
 *   BOT_TOKEN     → توکن ربات تلگرام
 *
 * توضیحات:
 *   - همه دکمه‌ها شیشه‌ای (inline_keyboard)
 *   - قابلیت تنظیم کانال عضویت اجباری از طریق پنل ساده /admin
 *   - ذخیره‌سازی لایک‌ها با UUID
 *   - بررسی عضویت کاربر در کانال قبل از ثبت لایک
 *   - آمار کاربران و لایک‌ها (فقط برای ادمین اصلی 7240662021)
 */

const ADMIN_ID = 7240662021; // آیدی عددی ادمین اصلی

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- پنل مدیریت برای تنظیم کانال ---
    if (url.pathname.startsWith("/admin")) {
      return handleAdmin(request, env);
    }

    return new Response("✅ Likey Bot is running...");
  }
};

// -------------------- TELEGRAM HANDLER --------------------
export async function handleUpdate(update, env, ctx) {
  if (!update.message && !update.callback_query) return;

  const chatId = update.message?.chat.id || update.callback_query?.message.chat.id;
  const userId = update.message?.from.id || update.callback_query?.from.id;

  // --- دستور /start ---
  if (update.message?.text === "/start") {
    // ذخیره کاربر در KV
    await env.LIKEY_BOT.put(`user:${userId}`, "1");

    await sendMessage(env, chatId, "👋 به ربات لایکی خوش آمدید.\nبرای ساخت لایک دکمه زیر را بزنید:", {
      inline_keyboard: [
        [{ text: "➕ ساخت لایک", callback_data: "make_like" }]
      ]
    });
    return;
  }

  // --- دستور /stats (فقط برای ادمین اصلی) ---
  if (update.message?.text === "/stats" && userId === ADMIN_ID) {
    const users = await countKeys(env, "user:");
    const likesData = await getAllLikes(env);
    const totalLikes = likesData.reduce((sum, l) => sum + l.likes, 0);

    await sendMessage(env, chatId, `📊 آمار ربات:\n👥 کاربران: *${users}*\n👍 مجموع لایک‌ها: *${totalLikes}*`);
    return;
  }

  // --- وقتی کاربر دکمه «ساخت لایک» رو زد ---
  if (update.callback_query?.data === "make_like") {
    await sendMessage(env, chatId, "🔤 اسم مورد نظر برای لایک‌گیری رو بفرست:");
    await env.LIKEY_BOT.put(`step:${userId}`, "awaiting_name");
    return;
  }

  // --- وقتی اسم برای لایک‌گیری ارسال شد ---
  if (update.message?.text && await env.LIKEY_BOT.get(`step:${userId}`) === "awaiting_name") {
    const name = update.message.text;
    const likeId = crypto.randomUUID();

    // ذخیره اطلاعات لایک در KV
    await env.LIKEY_BOT.put(`like:${likeId}`, JSON.stringify({
      name,
      likes: 0
    }));
    await env.LIKEY_BOT.delete(`step:${userId}`);

    // ارسال دکمه اشتراک‌گذاری
    await sendMessage(env, chatId, `✅ لایک برای *${name}* ساخته شد!`, {
      inline_keyboard: [
        [{ text: "📢 اشتراک‌گذاری", switch_inline_query: likeId }]
      ]
    });
    return;
  }

  // --- وقتی کسی دکمه لایک رو زد ---
  if (update.callback_query?.data?.startsWith("like:")) {
    const likeId = update.callback_query.data.split(":")[1];
    const data = await env.LIKEY_BOT.get(`like:${likeId}`);
    if (!data) return;

    const like = JSON.parse(data);

    // بررسی عضویت در کانال (اگه تنظیم شده باشه)
    const forceChannel = await env.LIKEY_BOT.get("force_channel");
    if (forceChannel) {
      const isMember = await checkMembership(env, forceChannel, userId);
      if (!isMember) {
        await answerCallback(env, update.callback_query.id, "❌ اول باید عضو کانال بشی!", true);
        return;
      }
    }

    // ثبت لایک
    like.likes += 1;
    await env.LIKEY_BOT.put(`like:${likeId}`, JSON.stringify(like));

    // آپدیت پیام لایک
    await editMessage(env,
      update.callback_query.message.chat.id,
      update.callback_query.message.message_id,
      `👍 ${like.name} — ${like.likes} لایک`,
      {
        inline_keyboard: [
          [{ text: `👍 لایک (${like.likes})`, callback_data: `like:${likeId}` }]
        ]
      }
    );

    await answerCallback(env, update.callback_query.id, "✅ لایک ثبت شد!");
  }
}

// -------------------- ADMIN PANEL --------------------
async function handleAdmin(request, env) {
  const url = new URL(request.url);

  // ذخیره کانال اجباری
  if (url.searchParams.has("set")) {
    const channel = url.searchParams.get("set");
    await env.LIKEY_BOT.put("force_channel", channel);
    return new Response(`کانال اجباری تنظیم شد: ${channel}`);
  }

  // نمایش کانال فعلی
  const current = await env.LIKEY_BOT.get("force_channel");
  return new Response(`
    <h1>پنل مدیریت لایکی</h1>
    <p>کانال فعلی: ${current || "❌ ندارد"}</p>
    <form>
      <input name="set" placeholder="@channel" />
      <button type="submit">ذخیره</button>
    </form>
  `, { headers: { "content-type": "text/html; charset=UTF-8" } });
}

// -------------------- TELEGRAM HELPERS --------------------
async function sendMessage(env, chatId, text, keyboard) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: keyboard
  };
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function editMessage(env, chatId, msgId, text, keyboard) {
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: msgId,
      text,
      parse_mode: "Markdown",
      reply_markup: keyboard
    })
  });
}

async function answerCallback(env, cbId, text, alert=false) {
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: cbId, text, show_alert: alert })
  });
}

// -------------------- CHECK CHANNEL MEMBERSHIP --------------------
async function checkMembership(env, channel, userId) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getChatMember?chat_id=${channel}&user_id=${userId}`);
  const data = await res.json();
  if (!data.ok) return false;
  const status = data.result.status;
  return !["left", "kicked"].includes(status);
}

// -------------------- EXTRA HELPERS (STATS) --------------------
// شمارش تعداد کل کلیدهای یک prefix
async function countKeys(env, prefix) {
  let count = 0;
  let cursor = undefined;
  do {
    const list = await env.LIKEY_BOT.list({ prefix, cursor });
    count += list.keys.length;
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  return count;
}

// گرفتن همه لایک‌ها
async function getAllLikes(env) {
  let likes = [];
  let cursor = undefined;
  do {
    const list = await env.LIKEY_BOT.list({ prefix: "like:", cursor });
    for (const key of list.keys) {
      const data = await env.LIKEY_BOT.get(key.name);
      if (data) likes.push(JSON.parse(data));
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  return likes;
}
