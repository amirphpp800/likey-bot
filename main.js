/*
نام KV: BOT_KV
ENV های موردنیاز:
- BOT_TOKEN: توکن ربات تلگرام
- ADMIN_ID: آیدی عددی ادمین (مثال: 7240662021)
- FORCE_CHANNEL: یوزرنیم کانال برای عضویت اجباری (مثال: @NoiDUsers) — مقدار اولیه؛ قابل تغییر توسط ادمین و در KV ذخیره می‌شود.

توضیح عملکرد:
این ماژول هسته ربات «لایکی» است که روی Cloudflare Pages + Functions اجرا می‌شود.
- مدیریت پیام‌های ورودی و کلیدهای شیشه‌ای
- الزام عضویت در کانال (در صورت تنظیم)
- ساخت «لایک» توسط کاربر و شمارش آن
- ذخیره کاربران و لایک‌ها در KV برای آمار
- متدهای اصلی: handleUpdate(update, env, ctx) و app.fetch(request, env, ctx)
*/

// ESM

// نام کلیدها در KV
const KV_KEYS = {
  forceChannel: 'config:force_channel',
  userPrefix: 'user:', // user:<id> => '1'
  usersCount: 'stats:users_count',
  likesCount: 'stats:likes_created',
  likePrefix: 'like:', // like:<id> => {id,title,count,requiredChannel,creatorId,createdAt}
  botMe: 'cache:bot_me',
};

// ابزارها و کمک‌متدها
const tgApi = (env) => {
  const base = `https://api.telegram.org/bot${env.BOT_TOKEN}`;
  return {
    call: async (method, payload) => {
      const res = await fetch(`${base}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json;charset=UTF-8' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(`Telegram API error: ${method}: ${res.status} ${JSON.stringify(data)}`);
      return data.result;
    },
    sendMessage: (payload) => tgApi(env).call('sendMessage', payload),
    editMessageText: (payload) => tgApi(env).call('editMessageText', payload),
    editMessageReplyMarkup: (payload) => tgApi(env).call('editMessageReplyMarkup', payload),
    answerCallbackQuery: (payload) => tgApi(env).call('answerCallbackQuery', payload),
    getChatMember: (payload) => tgApi(env).call('getChatMember', payload),
    getMe: () => tgApi(env).call('getMe', {}),
  };
};

// خواندن/نوشتن KV با کمترین فراخوانی
async function getForceChannel(env) {
  // اولویت با KV. اگر نبود، از ENV مقدار اولیه را می‌گیرد.
  const fromKv = await env.BOT_KV.get(KV_KEYS.forceChannel);
  if (fromKv) return fromKv;
  return env.FORCE_CHANNEL || '';
}

async function setForceChannel(env, username) {
  if (username && !username.startsWith('@')) username = `@${username}`;
  if (!username) {
    await env.BOT_KV.delete(KV_KEYS.forceChannel);
    return '';
  }
  await env.BOT_KV.put(KV_KEYS.forceChannel, username);
  return username;
}

async function ensureUserCount(env, userId) {
  const key = KV_KEYS.userPrefix + String(userId);
  const exists = await env.BOT_KV.get(key);
  if (!exists) {
    await env.BOT_KV.put(key, '1');
    const current = Number((await env.BOT_KV.get(KV_KEYS.usersCount)) || '0');
    await env.BOT_KV.put(KV_KEYS.usersCount, String(current + 1));
  }
}

async function incLikesCreated(env) {
  const current = Number((await env.BOT_KV.get(KV_KEYS.likesCount)) || '0');
  await env.BOT_KV.put(KV_KEYS.likesCount, String(current + 1));
}

async function saveLike(env, like) {
  await env.BOT_KV.put(KV_KEYS.likePrefix + like.id, JSON.stringify(like));
}

async function getLike(env, likeId) {
  const raw = await env.BOT_KV.get(KV_KEYS.likePrefix + likeId);
  return raw ? JSON.parse(raw) : null;
}

function uid() {
  // شناسه ساده و کوتاه برای لایک
  return Math.random().toString(36).slice(2, 10);
}

async function resolveBotUsername(env) {
  // کش برای 6 ساعت
  const cached = await env.BOT_KV.get(KV_KEYS.botMe);
  if (cached) {
    try {
      const obj = JSON.parse(cached);
      if (obj.username && (Date.now() - obj.cachedAt < 6 * 60 * 60 * 1000)) return obj.username;
    } catch {}
  }
  const me = await tgApi(env).getMe();
  const username = me.username ? `@${me.username}` : '';
  await env.BOT_KV.put(KV_KEYS.botMe, JSON.stringify({ username, cachedAt: Date.now() }));
  return username;
}

async function isMemberOfRequired(env, userId) {
  const ch = await getForceChannel(env);
  if (!ch) return { ok: true, channel: '' };
  try {
    const member = await tgApi(env).getChatMember({ chat_id: ch, user_id: userId });
    const status = member.status; // creator, administrator, member, restricted, left, kicked
    const ok = ['creator', 'administrator', 'member'].includes(status);
    return { ok, channel: ch };
  } catch (e) {
    // اگر ربات دسترسی نداشته باشد یا کانال اشتباه باشد، اجازه دهید کاربر پیش برود (تا تجربه خراب نشود)
    return { ok: false, channel: ch, error: String(e) };
  }
}

function mainMenu(forceChannel) {
  const rows = [
    [{ text: '➕ ساخت لایک', callback_data: 'act:create_like' }],
    [{ text: '📊 آمار', callback_data: 'act:stats' }],
  ];
  // دکمه تنظیم کانال فقط برای ادمین در زمان نمایش، کنترل می‌شود
  return { inline_keyboard: rows };
}

function adminExtraMenu(forceChannel) {
  const rows = [
    [{ text: '🛠 تنظیم کانال', callback_data: 'act:set_channel' }],
  ];
  if (forceChannel) rows.push([{ text: `کانال فعلی: ${forceChannel}`, callback_data: 'noop' }]);
  return { inline_keyboard: rows };
}

function bannerKeyboard(like, memberRequired) {
  const rows = [
    [{ text: `👍 لایک (${like.count})`, callback_data: `like:${like.id}` }],
  ];
  if (memberRequired && like.requiredChannel) {
    const url = `https://t.me/${like.requiredChannel.replace('@', '')}`;
    rows.push([{ text: '📥 عضویت در کانال', url }]);
  }
  return { inline_keyboard: rows };
}

function joinRequiredText(channel) {
  return `برای انجام این کار، ابتدا عضو کانال زیر شوید:\n${channel}`;
}

// حالت‌های مکالمه ساده در KV (برای فرایند تنظیم کانال و گرفتن عنوان لایک)
function userStateKey(userId) { return `state:${userId}`; }
async function setUserState(env, userId, state, data = {}) {
  await env.BOT_KV.put(userStateKey(userId), JSON.stringify({ state, data, at: Date.now() }), { expirationTtl: 900 });
}
async function getUserState(env, userId) {
  const raw = await env.BOT_KV.get(userStateKey(userId));
  return raw ? JSON.parse(raw) : null;
}
async function clearUserState(env, userId) {
  await env.BOT_KV.delete(userStateKey(userId));
}

// پیام خوش‌آمد و منو
async function sendHome(chatId, userId, env) {
  const forceChannel = await getForceChannel(env);
  const me = await resolveBotUsername(env);
  const text = `سلام! به ربات لایکی خوش اومدی ✨\n\n` +
    (forceChannel ? `عضویت اجباری: ${forceChannel}\n` : '') +
    `برای شروع از دکمه‌های زیر استفاده کن.\n` +
    (me ? `لینک دعوت ربات: https://t.me/${me.replace('@', '')}` : '');

  const reply_markup = mainMenu(forceChannel);
  await tgApi(env).sendMessage({ chat_id: chatId, text, reply_markup, parse_mode: 'HTML' });
}

async function handleStart(update, env) {
  const msg = update.message;
  const userId = msg.from.id;
  await ensureUserCount(env, userId);

  const membership = await isMemberOfRequired(env, userId);
  if (!membership.ok && membership.channel) {
    await tgApi(env).sendMessage({
      chat_id: msg.chat.id,
      text: joinRequiredText(membership.channel),
      reply_markup: { inline_keyboard: [[{ text: '📥 عضویت در کانال', url: `https://t.me/${membership.channel.replace('@','')}` }]] },
    });
    return;
  }

  return sendHome(msg.chat.id, userId, env);
}

async function handleTextMessage(update, env) {
  const msg = update.message;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  await ensureUserCount(env, userId);

  const st = await getUserState(env, userId);
  if (st?.state === 'await_channel_username') {
    // فقط ادمین اجازه دارد
    if (String(userId) !== String(env.ADMIN_ID)) {
      await tgApi(env).sendMessage({ chat_id: chatId, text: 'فقط ادمین می‌تواند کانال را تنظیم کند.' });
      await clearUserState(env, userId);
      return;
    }
    const raw = (msg.text || '').trim();
    if (raw === '-' || raw === 'حذف' || raw === 'خاموش') {
      await setForceChannel(env, '');
      await tgApi(env).sendMessage({ chat_id: chatId, text: 'عضویت اجباری حذف شد.' });
    } else {
      const normalized = raw.startsWith('@') ? raw : `@${raw}`;
      await setForceChannel(env, normalized);
      await tgApi(env).sendMessage({ chat_id: chatId, text: `کانال عضویت اجباری تنظیم شد: ${normalized}` });
    }
    await clearUserState(env, userId);
    return sendHome(chatId, userId, env);
  }

  if (st?.state === 'await_like_title') {
    const title = (msg.text || '').trim().slice(0, 100);
    if (!title) {
      await tgApi(env).sendMessage({ chat_id: chatId, text: 'لطفاً یک عنوان معتبر وارد کنید.' });
      return;
    }
    const forceChannel = await getForceChannel(env);
    const like = { id: uid(), title, count: 0, requiredChannel: forceChannel || '', creatorId: userId, createdAt: Date.now() };
    await saveLike(env, like);
    await incLikesCreated(env);

    const bannerText = `بنر لایک ساخته شد!\n\nعنوان: ${like.title}\nشناسه: <code>${like.id}</code>`;
    const reply_markup = { inline_keyboard: [[{ text: '📤 اشتراک بنر', callback_data: `share:${like.id}` }]] };
    await tgApi(env).sendMessage({ chat_id: chatId, text: bannerText, reply_markup, parse_mode: 'HTML' });
    await clearUserState(env, userId);
    return;
  }

  // موارد عمومی
  if ((msg.text || '').startsWith('/start')) return handleStart(update, env);
  return sendHome(chatId, userId, env);
}

async function handleCallback(update, env) {
  const cb = update.callback_query;
  const userId = cb.from.id;
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const data = cb.data || '';

  await ensureUserCount(env, userId);

  if (data === 'noop') {
    return tgApi(env).answerCallbackQuery({ callback_query_id: cb.id });
  }

  if (data === 'act:stats') {
    const users = Number((await env.BOT_KV.get(KV_KEYS.usersCount)) || '0');
    const likesCreated = Number((await env.BOT_KV.get(KV_KEYS.likesCount)) || '0');
    const text = `📊 آمار کلی:\n- کاربران: ${users}\n- لایک‌های ساخته‌شده: ${likesCreated}`;
    await tgApi(env).answerCallbackQuery({ callback_query_id: cb.id });
    return tgApi(env).sendMessage({ chat_id: chatId, text });
  }

  if (data === 'act:set_channel') {
    if (String(userId) !== String(env.ADMIN_ID)) {
      await tgApi(env).answerCallbackQuery({ callback_query_id: cb.id, text: 'فقط ادمین!', show_alert: true });
      return;
    }
    await tgApi(env).answerCallbackQuery({ callback_query_id: cb.id });
    await setUserState(env, userId, 'await_channel_username');
    const current = await getForceChannel(env);
    return tgApi(env).sendMessage({ chat_id: chatId, text: `یوزرنیم کانال را بفرست (مثلاً @YourChannel).\nبرای حذف، یکی از این‌ها را بفرست: - / حذف / خاموش\nکانال فعلی: ${current || '—'}` });
  }

  if (data === 'act:create_like') {
    const membership = await isMemberOfRequired(env, userId);
    if (!membership.ok && membership.channel) {
      await tgApi(env).answerCallbackQuery({ callback_query_id: cb.id, text: 'اول عضو کانال شو بعد دوباره امتحان کن.', show_alert: true });
      return;
    }
    await tgApi(env).answerCallbackQuery({ callback_query_id: cb.id });
    await setUserState(env, userId, 'await_like_title');
    return tgApi(env).sendMessage({ chat_id: chatId, text: 'عنوان لایک را ارسال کن (حداکثر ۱۰۰ کاراکتر):' });
  }

  if (data.startsWith('share:')) {
    const likeId = data.split(':')[1];
    const like = await getLike(env, likeId);
    if (!like) {
      await tgApi(env).answerCallbackQuery({ callback_query_id: cb.id, text: 'این لایک پیدا نشد.', show_alert: true });
      return;
    }
    await tgApi(env).answerCallbackQuery({ callback_query_id: cb.id, text: 'بنر آماده شد.' });

    const banner = `⭐️ لایک جدید!\n\n${like.title}\n\nبرای حمایت، روی دکمه لایک بزنید.`;
    const needMembership = !!like.requiredChannel;
    const reply_markup = bannerKeyboard(like, needMembership);
    return tgApi(env).sendMessage({ chat_id: chatId, text: banner, reply_markup });
  }

  if (data.startsWith('like:')) {
    const likeId = data.split(':')[1];
    const like = await getLike(env, likeId);
    if (!like) {
      await tgApi(env).answerCallbackQuery({ callback_query_id: cb.id, text: 'این لایک دیگر وجود ندارد.', show_alert: true });
      return;
    }

    // الزام عضویت اگر تنظیم شده
    if (like.requiredChannel) {
      const membership = await isMemberOfRequired(env, userId);
      if (!membership.ok) {
        await tgApi(env).answerCallbackQuery({ callback_query_id: cb.id, text: 'برای لایک، اول عضو کانال شو.', show_alert: true });
        return;
      }
    }

    like.count += 1;
    await saveLike(env, like);

    // به‌روزرسانی دکمه لایک در همان پیام (اگر پیام قابل ویرایش باشد)
    try {
      await tgApi(env).editMessageReplyMarkup({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: bannerKeyboard(like, !!like.requiredChannel),
      });
    } catch {}

    return tgApi(env).answerCallbackQuery({ callback_query_id: cb.id, text: `❤️ ${like.count} تا شد!` });
  }

  // دکمه‌های دیگر
  return tgApi(env).answerCallbackQuery({ callback_query_id: cb.id });
}

export async function handleUpdate(update, env, ctx) {
  try {
    if (!env || !env.BOT_TOKEN || !env.BOT_KV) throw new Error('ENV یا KV به‌درستی تنظیم نشده است.');

    if (update.message) {
      const txt = update.message.text || '';
      if (txt.startsWith('/start')) return handleStart(update, env);
      return handleTextMessage(update, env);
    }
    if (update.callback_query) {
      return handleCallback(update, env);
    }
  } catch (e) {
    // لاگ خطا؛ در Cloudflare می‌توان از console.error استفاده کرد
    console.error('handleUpdate error', e);
  }
}

// Entry برای سازگاری با Workers (اختیاری). Pages Functions از onRequest استفاده می‌کند.
export const app = {
  async fetch(request, env, ctx) {
    // این ورودی برای سازگاری اضافه شده و در Pages Functions مستقیماً استفاده نمی‌شود.
    return new Response('OK');
  }
};
