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
  userChannelPrefix: 'user_channel:', // user_channel:<userId> => { id, username, title }
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
  // ردیف ۱: فقط ساخت لایک (تکی)
  // ردیف ۲: مدیریت کانال و آمار در یک ردیف
  const rows = [
    [{ text: '➕ ساخت لایک', callback_data: 'act:create_like' }],
    [
      { text: '📊 آمار', callback_data: 'act:stats' },
      { text: '📣 مدیریت کانال', callback_data: 'act:my_channel' },
    ],
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

// ===== Keyboards & UI =====
function bannerKeyboard(like, memberRequired) {
  const rows = [
    [{ text: `❤️ لایک (${like.count})`, callback_data: `like:${like.id}` }],
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

// کانال اختصاصی کاربر برای ارسال مستقیم
async function setUserChannel(env, userId, channel) {
  // channel: { id, username?, title? }
  await env.BOT_KV.put(KV_KEYS.userChannelPrefix + String(userId), JSON.stringify(channel));
}
async function getUserChannel(env, userId) {
  const raw = await env.BOT_KV.get(KV_KEYS.userChannelPrefix + String(userId));
  return raw ? JSON.parse(raw) : null;
}
async function clearUserChannel(env, userId) {
  await env.BOT_KV.delete(KV_KEYS.userChannelPrefix + String(userId));
}

// پیام خوش‌آمد و منو
async function sendHome(chatId, userId, env) {
  const forceChannel = await getForceChannel(env);
  const me = await resolveBotUsername(env);
  const text = `سلام! به ربات لایکی خوش اومدی ✨\n\n` +
    (forceChannel ? `عضویت اجباری: ${forceChannel}\n` : '') +
    `برای شروع از دکمه‌های زیر استفاده کن.\n` +
    (me ? `لینک دعوت ربات: https://t.me/${me.replace('@', '')}` : '');

  // منوی اصلی + اگر ادمین باشد دکمه تنظیم کانال را اضافه کن
  const base = mainMenu(forceChannel).inline_keyboard;
  if (String(userId) === String(env.ADMIN_ID)) {
    const adminRows = adminExtraMenu(forceChannel).inline_keyboard;
    for (const r of adminRows) base.push(r);
  }
  await tgApi(env).sendMessage({ chat_id: chatId, text, reply_markup: { inline_keyboard: base }, parse_mode: 'HTML' });
}

// ===== Handlers: Start, Text, Callback =====
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

  if (st?.state === 'await_user_channel_username') {
    const raw = (msg.text || '').trim();
    let channelIdOrUsername = raw;
    let channelInfo = null;
    // اگر پیام فورواردی از کانال باشد
    if (msg.forward_from_chat && msg.forward_from_chat.type === 'channel') {
      const ch = msg.forward_from_chat;
      channelInfo = { id: ch.id, username: ch.username ? `@${ch.username}` : undefined, title: ch.title };
    } else {
      // ورودی متنی: @username یا آیدی -100...
      if (channelIdOrUsername && !(channelIdOrUsername.startsWith('@') || /^-?\d+$/.test(channelIdOrUsername))) {
        channelIdOrUsername = `@${channelIdOrUsername}`;
      }
      channelInfo = { id: channelIdOrUsername, username: channelIdOrUsername.startsWith('@') ? channelIdOrUsername : undefined };
    }

    try {
      // تست ارسال یک پیام بی‌صدا به کانال تا اطمینان از دسترسی
      await tgApi(env).sendMessage({ chat_id: channelInfo.id, text: '🔗 اتصال ربات با موفقیت انجام شد.', disable_notification: true });
      await setUserChannel(env, userId, channelInfo);
      await tgApi(env).sendMessage({ chat_id: chatId, text: `کانال شما ثبت شد${channelInfo.username ? `: ${channelInfo.username}` : ''}.` });
    } catch (e) {
      await tgApi(env).sendMessage({ chat_id: chatId, text: '❗️ارسال به کانال ناموفق بود. لطفاً ربات را در کانالتان ادمین کنید و دوباره تلاش کنید.' });
    }
    await clearUserState(env, userId);
    return;
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
    // یادآوری ثبت کانال برای جلوگیری از مشکل در ارسال مستقیم
    const remindText = 'برای اینکه هنگام اشتراک بنر به مشکل برنخورید، کانال‌تان را ثبت کنید. اگر ربات ادمین نباشد، مجبور به ارسال دستی خواهید شد.';
    const remindMarkup = { inline_keyboard: [[{ text: '⚙️ مدیریت کانال', callback_data: 'act:my_channel' }]] };
    await tgApi(env).sendMessage({ chat_id: chatId, text: remindText, reply_markup: remindMarkup });
    // نمایش خودکار منوی اصلی در یک پیام جدید
    await sendHome(chatId, userId, env);
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

  // ثبت/تغییر کانال کاربر برای ارسال مستقیم
  if (data === 'act:my_channel') {
    await tgApi(env).answerCallbackQuery({ callback_query_id: cb.id });
    const current = await getUserChannel(env, userId);
    const helper = 'برای ارسال مستقیم پست در کانال‌تان:\n1) ربات را در کانالتان ادمین کنید.\n2) یوزرنیم کانال (مثل @YourChannel) را بفرستید یا یک پیام از کانال برای من فوروارد کنید.';
    const extra = current ? `\nکانال ثبت‌شده فعلی: ${current.username || current.title || current.id}` : '';
    const reply_markup = current ? { inline_keyboard: [[{ text: '❌ حذف کانال ثبت‌شده', callback_data: 'my_channel_clear' }]] } : undefined;
    await setUserState(env, userId, 'await_user_channel_username');
    return tgApi(env).sendMessage({ chat_id: chatId, text: helper + extra, reply_markup });
  }

  if (data === 'my_channel_clear') {
    await tgApi(env).answerCallbackQuery({ callback_query_id: cb.id });
    await clearUserChannel(env, userId);
    return tgApi(env).sendMessage({ chat_id: chatId, text: 'کانال ثبت‌شده شما حذف شد.' });
  }

  if (data.startsWith('share:')) {
    const likeId = data.split(':')[1];
    const like = await getLike(env, likeId);
    if (!like) {
      await tgApi(env).answerCallbackQuery({ callback_query_id: cb.id, text: 'این لایک دیگر وجود ندارد.', show_alert: true });
      return;
    }
    await tgApi(env).answerCallbackQuery({ callback_query_id: cb.id });

    const banner = `⭐️ لایک جدید!\n\n${like.title}\n\nبرای حمایت، روی دکمه لایک بزنید.`;
    // همه گزینه‌ها زیر همان پیام فعلی قرار گیرد
    const keyboard = [
      [{ text: `❤️ لایک (${like.count})`, callback_data: `like:${like.id}` }],
      [{ text: '📣 ارسال به کانال من', callback_data: `share_send:${like.id}` }],
      [{ text: '🧰 اشتراک دستی', callback_data: `share_manual:${like.id}` }],
      [{ text: '⚙️ مدیریت کانال', callback_data: 'act:my_channel' }],
    ];
    try {
      await tgApi(env).editMessageText({ chat_id: chatId, message_id: messageId, text: banner, reply_markup: { inline_keyboard: keyboard } });
    } catch {
      // اگر قابل ویرایش نبود، حداقل کیبورد را ویرایش کن
      try { await tgApi(env).editMessageReplyMarkup({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } }); } catch {}
    }
    return;
  }

  // ارسال مستقیم بنر به کانال ثبت‌شده کاربر
  if (data.startsWith('share_send:')) {
    const likeId = data.split(':')[1];
    const like = await getLike(env, likeId);
    await tgApi(env).answerCallbackQuery({ callback_query_id: cb.id });
    if (!like) return tgApi(env).sendMessage({ chat_id: chatId, text: 'این لایک دیگر وجود ندارد.' });
    const userCh = await getUserChannel(env, userId);
    if (!userCh) {
      return tgApi(env).sendMessage({ chat_id: chatId, text: 'ابتدا از «📣 مدیریت کانال» کانال خود را ثبت کنید.' });
    }
    const banner = `⭐️ لایک جدید!\n\n${like.title}\n\nبرای حمایت، روی دکمه لایک بزنید.`;
    try {
      await tgApi(env).sendMessage({ chat_id: userCh.id, text: banner, reply_markup: bannerKeyboard(like, !!like.requiredChannel) });
      return tgApi(env).sendMessage({ chat_id: chatId, text: '✅ پست با دکمه لایک در کانال شما ارسال شد.' });
    } catch (e) {
      return tgApi(env).sendMessage({ chat_id: chatId, text: '❗️ارسال مستقیم به کانال ناموفق بود. ربات را ادمین کنید یا از «🧰 ارسال دستی (راهنما)» استفاده کنید.' });
    }
  }

  // اشتراک دستی: نمایش انتخاب کانال کاربر زیر همان پیام
  if (data.startsWith('share_manual:')) {
    const likeId = data.split(':')[1];
    const like = await getLike(env, likeId);
    await tgApi(env).answerCallbackQuery({ callback_query_id: cb.id });
    if (!like) return tgApi(env).sendMessage({ chat_id: chatId, text: 'این لایک دیگر وجود ندارد.' });
    const userCh = await getUserChannel(env, userId);
    const rows = [];
    if (userCh) {
      const label = userCh.username || userCh.title || userCh.id;
      rows.push([{ text: `انتخاب: ${label}`, callback_data: `manual_choose:${like.id}` }]);
    } else {
      rows.push([{ text: '⚙️ مدیریت کانال (ابتدا کانال را ثبت کنید)', callback_data: 'act:my_channel' }]);
    }
    rows.push([{ text: '⬅️ بازگشت', callback_data: `share:${like.id}` }]);
    try {
      await tgApi(env).editMessageReplyMarkup({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [
        [{ text: `❤️ لایک (${like.count})`, callback_data: `like:${like.id}` }],
        ...rows,
      ] } });
    } catch {}
    return;
  }

  // کاربر یکی از کانال‌های خود را برای اشتراک دستی انتخاب می‌کند
  if (data.startsWith('manual_choose:')) {
    const likeId = data.split(':')[1];
    const like = await getLike(env, likeId);
    await tgApi(env).answerCallbackQuery({ callback_query_id: cb.id });
    if (!like) return;
    const userCh = await getUserChannel(env, userId);
    if (!userCh) {
      return tgApi(env).sendMessage({ chat_id: chatId, text: 'ابتدا کانال را در «مدیریت کانال» ثبت کنید.' });
    }
    // ابتدا پیام «اینجا کلیک کنید» سپس بنر لایک
    try {
      await tgApi(env).sendMessage({ chat_id: userCh.id, text: 'اینجا کلیک کنید' });
      await tgApi(env).sendMessage({ chat_id: userCh.id, text: `⭐️ لایک جدید!\n\n${like.title}\n\nبرای حمایت، روی دکمه لایک بزنید.`, reply_markup: bannerKeyboard(like, !!like.requiredChannel) });
      // تایید برای کاربر
      try { await tgApi(env).editMessageReplyMarkup({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [
        [{ text: `❤️ لایک (${like.count})`, callback_data: `like:${like.id}` }],
        [{ text: '✅ ارسال شد', callback_data: 'noop' }],
        [{ text: '⬅️ بازگشت', callback_data: `share:${like.id}` }],
      ] } }); } catch {}
    } catch (e) {
      await tgApi(env).sendMessage({ chat_id: chatId, text: 'ارسال به کانال ناموفق بود. ادمین‌کردن ربات را بررسی کنید.' });
    }
    return;
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
