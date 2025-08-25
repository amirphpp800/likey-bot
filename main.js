// main.js - Telegram Like Bot for Cloudflare Pages (ESM)

// Bot configuration
const REQUIRED_CHANNEL = '@NoiDUsers';
// Bot version (bump this on each update)
const BOT_VERSION = '1.3';

// -------------------- Telegram Utilities --------------------
const telegramAPI = (token, method, params = {}) => {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
};

const sendMessage = async (token, chatId, text, keyboard = null) => {
  const params = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (keyboard) params.reply_markup = keyboard;
  return telegramAPI(token, 'sendMessage', params);
};

const editMessage = async (token, chatId, messageId, text, keyboard = null) => {
  const params = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
  if (keyboard) params.reply_markup = keyboard;
  return telegramAPI(token, 'editMessageText', params);
};

// Resolve bot username automatically (cache in KV)
const resolveBotUsername = async (token, kv, fallbackEnvUsername) => {
  if (fallbackEnvUsername && fallbackEnvUsername !== 'your_bot') return fallbackEnvUsername;
  const cached = await kv.get('bot_username');
  if (cached) return cached;
  try {
    const resp = await telegramAPI(token, 'getMe');
    const data = await resp.json();
    const uname = data?.result?.username || '';
    if (uname) {
      await kv.put('bot_username', uname);
      return uname;
    }
  } catch (e) {
    // ignore
  }
  return fallbackEnvUsername || 'your_bot';
};

const checkChannelMembership = async (token, userId, channelUsername) => {
  try {
    const response = await telegramAPI(token, 'getChatMember', {
      chat_id: channelUsername,
      user_id: userId
    });
    const data = await response.json();
    return data.ok && ['member', 'administrator', 'creator'].includes(data.result.status);
  } catch {
    return false;
  }
};

// -------------------- Keyboards --------------------
const mainMenuKeyboard = () => ({
  inline_keyboard: [
    [{ text: '✨ ساخت لایک جدید', callback_data: 'create_like' }],
    [{ text: '⚙️ تنظیمات', callback_data: 'settings' }]
  ]
});

const settingsKeyboard = () => ({
  inline_keyboard: [
    [{ text: '📢 تعریف کانال من', callback_data: 'set_channel' }],
    [{ text: '⬅️ بازگشت به منو', callback_data: 'back_main' }]
  ]
});

// Deep link to open bot with a specific like payload (id or token)
const buildDeepLink = (botUsername, payload) => `https://t.me/${botUsername}?start=${payload}`;

/*
 createLikeKeyboard (for bot chats):
 - Like button with live count
 - Optional "Join Channel" if creator has a public @channel
 - Optional Share button (only if botUsername is set)
*/
const createLikeKeyboard = (like, botUsername, creatorChannel = '') => {
  const buttons = [];
  const likeBtn = { text: `👍 بزن لایک (${like.likes || 0})`, callback_data: like.id };

  // Row 1: Like
  buttons.push([likeBtn]);

  // Row 2: Join channel if exists and is public (@username)
  if (creatorChannel && creatorChannel.startsWith('@')) {
    buttons.push([{ text: '📢 عضویت در کانال', url: `https://t.me/${creatorChannel.replace('@', '')}` }]);
  }

  // Row 3: Share button only if botUsername provided and not placeholder
  if (botUsername && botUsername !== 'your_bot') {
    const payload = like.token || like.id;
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(buildDeepLink(botUsername, payload))}&text=${encodeURIComponent(`بیاین باهم لایک کنیم: ${like.name}`)}`;
    const shareBtn = { text: '🔗 ارسال برای دوستان', url: shareUrl };
    buttons.push([shareBtn]);
  }

  return { inline_keyboard: buttons };
};

/*
 createChannelLikeKeyboard (for posts inside channels):
 - Only Like button (and optional Join if public @channel)
 - No share button
*/
const createChannelLikeKeyboard = (like, creatorChannel = '') => {
  const buttons = [];
  const likeBtn = { text: `👍 بزن لایک (${like.likes || 0})`, callback_data: like.id };
  buttons.push([likeBtn]);
  if (creatorChannel && creatorChannel.startsWith('@')) {
    buttons.push([{ text: '📢 عضویت در کانال', url: `https://t.me/${creatorChannel.replace('@', '')}` }]);
  }
  return { inline_keyboard: buttons };
};

// Creator view keyboard: includes publish to channel button if a channel is set
const createCreatorLikeKeyboard = (like, botUsername, creatorChannel = '') => {
  const base = createLikeKeyboard(like, botUsername, creatorChannel);
  if (creatorChannel) {
    base.inline_keyboard.push([{ text: '📤 ارسال پست به کانال', callback_data: `publish_like:${like.id}` }]);
  }
  // Creator helper: get share link in bot chat
  base.inline_keyboard.push([{ text: '🔗 دریافت لینک اشتراک', callback_data: `get_share_link:${like.id}` }]);
  return base;
};

// -------------------- Telegram Update Handler --------------------
export const handleUpdate = async (update, env) => {
  const { BOT_TOKEN, BOT_KV, BOT_USERNAME } = env;

  try {
    const resolvedUsername = await resolveBotUsername(BOT_TOKEN, BOT_KV, BOT_USERNAME);
    if (update.message) {
      await handleMessage(update.message, BOT_TOKEN, BOT_KV, resolvedUsername);
    } else if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, BOT_TOKEN, BOT_KV, resolvedUsername);
    }
  } catch (err) {
    console.error('Error handling update:', err);
  }
};

// Message handler
const handleMessage = async (message, token, kv, botUsername = '') => {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text || '';
  const userState = await kv.get(`state:${userId}`);

  // Global required channel enforcement for bot usage (skip while in input states)
  if (!userState) {
    const isMember = await checkChannelMembership(token, userId, REQUIRED_CHANNEL);
    if (!isMember) {
      return sendMessage(
        token,
        chatId,
        `سلام! 💙\nبرای استفاده از بات، اول عضو کانال ${REQUIRED_CHANNEL} شو و برگرد.`,
        {
          inline_keyboard: [
            [{ text: '📢 عضویت در کانال', url: `https://t.me/${REQUIRED_CHANNEL.replace('@', '')}` }],
            [{ text: '🔄 عضوم شدم، بررسی کن', callback_data: 'check_membership' }]
          ]
        }
      );
    }
  }

  // Deep link payload: /start <likeId>
  if (text.startsWith('/start ')) {
    const payload = text.split(' ')[1]?.trim() || '';
    if (payload) {
      let likeId = '';
      if (payload.startsWith('like_')) {
        likeId = payload;
      } else {
        const mapped = await kv.get(`token:${payload}`);
        if (mapped) likeId = mapped;
      }
      if (likeId) {
        const likeData = await kv.get(`like:${likeId}`);
        if (likeData) {
          const like = JSON.parse(likeData);
          const creatorChannel = (await kv.get(`channel:${like.creator}`)) || '';
          const keyboard = (message.from?.id === like.creator)
            ? createCreatorLikeKeyboard(like, botUsername || 'your_bot', creatorChannel)
            : createLikeKeyboard(like, botUsername || 'your_bot', creatorChannel);
          await sendMessage(
            token,
            chatId,
            `👍 ${like.name}\n\n❤️ تعداد لایک: ${like.likes || 0}`,
            keyboard
          );
          return;
        }
      }
    }
  }

  // Default /start
  if (text === '/start') {
    await sendMessage(
      token,
      chatId,
      '🎉 خوش اومدی!\nبا این بات برای هر چیزی لایک جمع کن و رشدش رو ببین.👇\n\n' +
        `ℹ️ نسخه بات: ${BOT_VERSION}`,
      mainMenuKeyboard()
    );

    // Save user
    await kv.put(
      `user:${userId}`,
      JSON.stringify({
        id: userId,
        username: message.from.username || '',
        first_name: message.from.first_name || '',
        joined_at: Date.now()
      })
    );
    return;
  }

  // (Moved) Creator helper: get_share_link handled in handleCallbackQuery()

  // State handling

  // User typed like name
  if (userState === 'waiting_like_name') {
    const likeId = `like_${userId}_${Date.now()}`;
    const shareToken = Math.random().toString(36).slice(2, 10);

    const likeObj = {
      id: likeId,
      name: text,
      creator: userId,
      likes: 0,
      token: shareToken,
      created_at: Date.now()
    };

    await kv.put(`like:${likeId}`, JSON.stringify(likeObj));
    await kv.put(`token:${shareToken}`, likeId);
    await kv.delete(`state:${userId}`);

    const creatorChannel = (await kv.get(`channel:${userId}`)) || '';

    await sendMessage(
      token,
      chatId,
      `✅ آماده‌ست!\n\n` +
        `📝 نام: ${likeObj.name}\n` +
        `👍 لایک فعلی: 0\n\n` +
        `می‌تونی مستقیم به کانالت بفرستیش یا با دوستات به اشتراک بذاری.`,
      createCreatorLikeKeyboard(likeObj, botUsername || 'your_bot', creatorChannel)
    );
    return;
  }

  // User typed channel username
  if (userState === 'waiting_channel') {
    let channelUsername = text.trim();
    // Support private channels using numeric chat_id like -100xxxxxxxxxx
    const isNumericId = /^-100\d{5,}$/.test(channelUsername);
    if (!isNumericId && !channelUsername.startsWith('@')) channelUsername = '@' + channelUsername;

    await kv.put(`channel:${userId}`, channelUsername);
    await kv.delete(`state:${userId}`);

    await sendMessage(
      token,
      chatId,
      `✅ کانالت ثبت شد!\n\n` +
        `📢 ${channelUsername.startsWith('@') ? channelUsername : 'کانال خصوصی (chat_id ذخیره شد)'}\n\n` +
        `از این به بعد برای لایک پست‌های تو، اول عضویت توی این کانال چک می‌شه.`,
      settingsKeyboard()
    );
    return;
  }

  // Fallback
  await sendMessage(token, chatId, 'از دکمه‌های پایین استفاده کن 👇', mainMenuKeyboard());
};

// Callback query handler
const handleCallbackQuery = async (query, token, kv, botUsername = '') => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = query.from.id;
  const data = query.data;

  // Answer callback query immediately
  await telegramAPI(token, 'answerCallbackQuery', { callback_query_id: query.id });

  if (data === 'check_membership') {
    const isMember = await checkChannelMembership(token, userId, REQUIRED_CHANNEL);
    if (isMember) {
      await editMessage(token, chatId, messageId, '✅ عالی! عضویتت تأیید شد. بزن بریم! 🙌', mainMenuKeyboard());
    } else {
      await editMessage(
        token,
        chatId,
        messageId,
        `هنوز عضو نیستی!\nاول عضو ${REQUIRED_CHANNEL} شو، بعد اینجا رو بزن.`,
        {
          inline_keyboard: [
            [{ text: '📢 عضویت در کانال', url: `https://t.me/${REQUIRED_CHANNEL.replace('@', '')}` }],
            [{ text: '🔄 عضوم شدم، بررسی کن', callback_data: 'check_membership' }]
          ]
        }
      );
    }
    return;
  }

  if (data === 'settings') {
    await editMessage(
      token,
      chatId,
      messageId,
      '⚙️ تنظیمات:\nیک کانال معرفی کن تا قبل از لایک، عضویت در اون چک بشه.',
      settingsKeyboard()
    );
    return;
  }

  if (data === 'set_channel') {
    await kv.put(`state:${userId}`, 'waiting_channel');
    await editMessage(
      token,
      chatId,
      messageId,
      '📢 یوزرنیم کانالت رو بفرست (مثلاً @mychannel).\nیادت نره بات رو ادمین کانال کنی.'
    );
    return;
  }

  if (data === 'create_like') {
    await kv.put(`state:${userId}`, 'waiting_like_name');
    await editMessage(
      token,
      chatId,
      messageId,
      '📝 اسم چیزی که می‌خوای براش لایک جمع کنی رو بفرست (مثلاً: عکس جدیدم)'
    );
    return;
  }

  

  if (data === 'back_main') {
    await editMessage(
      token,
      chatId,
      messageId,
      '🎉 خوش اومدی! با این بات برای هر چیزی لایک جمع کن.👇\n\n' +
        `ℹ️ نسخه بات: ${BOT_VERSION}`,
      mainMenuKeyboard()
    );
    return;
  }

  // Publish like to creator's channel
  if (data.startsWith('publish_like:')) {
    const likeId = data.split(':')[1];
    const likeRaw = await kv.get(`like:${likeId}`);
    if (!likeRaw) {
      await telegramAPI(token, 'answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'این مورد پیدا نشد 🥲',
        show_alert: true
      });
      return;
    }
    const like = JSON.parse(likeRaw);
    if (like.creator !== userId) {
      await telegramAPI(token, 'answerCallbackQuery', {
        callback_query_id: query.id,
        text: '⛔️ فقط سازنده می‌تونه منتشرش کنه.',
        show_alert: true
      });
      return;
    }
    const creatorChannel = (await kv.get(`channel:${like.creator}`)) || '';
    if (!creatorChannel) {
      await telegramAPI(token, 'answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'اول کانالت رو در تنظیمات معرفی کن 🙂',
        show_alert: true
      });
      return;
    }
    // Try posting to channel (bot must be admin)
    const resp = await sendMessage(
      token,
      creatorChannel,
      `👍 ${like.name}\n\n❤️ تعداد لایک: ${like.likes || 0}`,
      createChannelLikeKeyboard(like, creatorChannel)
    );
    const ok = await resp.json().then(r => r.ok).catch(() => false);
    if (!ok) {
      await telegramAPI(token, 'answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'ارسال ناموفق بود. مطمئن شو بات ادمین کاناله ✅',
        show_alert: true
      });
      return;
    }

    await telegramAPI(token, 'answerCallbackQuery', {
      callback_query_id: query.id,
      text: '✅ منتشر شد! برو کانالت چک کن.'
    });

    // Optionally update creator's message keyboard/text
    const creatorChannelUsername = creatorChannel.startsWith('@') ? creatorChannel.replace('@', '') : '';
    await editMessage(
      token,
      chatId,
      messageId,
      (creatorChannelUsername
        ? `✅ به کانال @${creatorChannelUsername} فرستاده شد.\n\n`
        : `✅ به کانالت فرستاده شد.\n\n`) +
        `پست رو فوروارد کن تا لایک بیشتری جمع بشه.`,
      createCreatorLikeKeyboard(like, botUsername || '', creatorChannel)
    );
    return;
  }

  // Like button
  if (data.startsWith('like_')) {
    const likeId = data;
    const likeRaw = await kv.get(`like:${likeId}`);

    if (!likeRaw) {
      await telegramAPI(token, 'answerCallbackQuery', {
        callback_query_id: query.id,
        text: '❌ لایک پیدا نشد!',
        show_alert: true
      });
      return;
    }

    const like = JSON.parse(likeRaw);

    // If creator has a channel, require membership
    const creatorChannel = (await kv.get(`channel:${like.creator}`)) || '';
    if (creatorChannel) {
      const isMember = await checkChannelMembership(token, userId, creatorChannel);
      if (!isMember) {
        await telegramAPI(token, 'answerCallbackQuery', {
          callback_query_id: query.id,
          text: `برای لایک، اول عضو ${creatorChannel} شو ✨`,
          show_alert: true
        });
        return;
      }
    }

    // Check double-like by same user (30-day memory)
    const userLikeKey = `liked:${likeId}:${userId}`;
    const hasLiked = await kv.get(userLikeKey);
    if (hasLiked) {
      await telegramAPI(token, 'answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'قبلاً لایک کردی 💜',
        show_alert: true
      });
      return;
    }

    // Add like
    like.likes = (like.likes || 0) + 1;
    await kv.put(`like:${likeId}`, JSON.stringify(like));
    await kv.put(userLikeKey, 'true', { expirationTtl: 86400 * 30 });

    // Update message text + keyboard (live count)
    // Pick keyboard based on where the message lives (channel vs chat)
    const isChannel = (query.message.chat?.type === 'channel') || `${chatId}`.startsWith('-100');
    await editMessage(
      token,
      chatId,
      messageId,
      `👍 ${like.name}\n\n` + `❤️ تعداد لایک: ${like.likes}`,
      isChannel ? createChannelLikeKeyboard(like, creatorChannel) : createLikeKeyboard(like, botUsername || '', creatorChannel)
    );

    await telegramAPI(token, 'answerCallbackQuery', {
      callback_query_id: query.id,
      text: 'مرسی! لایکت ثبت شد 💜'
    });
    return;
  }
};

// -------------------- Pages HTTP Handler (Admin Panel + APIs) --------------------
const handleRequest = async (request, env) => {
  const url = new URL(request.url);
  const { BOT_KV } = env;

  // CORS
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Admin Panel (GET /)
  if (url.pathname === '/' || url.pathname === '') {
    const html = `
      <!DOCTYPE html>
      <html lang="fa" dir="rtl">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>پنل مدیریت ربات لایک</title>
          <style>
              * { margin: 0; padding: 0; box-sizing: border-box; }
              body { 
                  font-family: 'Segoe UI', Tahoma, Arial, sans-serif; 
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  min-height: 100vh;
                  padding: 20px;
              }
              .container { 
                  max-width: 1200px; 
                  margin: 0 auto; 
                  background: white; 
                  border-radius: 20px; 
                  box-shadow: 0 20px 40px rgba(0,0,0,0.1);
                  overflow: hidden;
              }
              .header { 
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  color: white; 
                  padding: 30px; 
                  text-align: center; 
              }
              .header h1 { font-size: 2.2rem; margin-bottom: 10px; }
              .header p { font-size: 1rem; opacity: 0.9; }
              .stats { 
                  display: grid; 
                  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); 
                  gap: 20px; 
                  padding: 30px; 
                  background: #f8f9fa;
              }
              .stat-card { 
                  background: white; 
                  padding: 25px; 
                  border-radius: 15px; 
                  text-align: center; 
                  box-shadow: 0 5px 15px rgba(0,0,0,0.08);
              }
              .stat-number { font-size: 2rem; font-weight: bold; color: #667eea; margin-bottom: 10px; }
              .stat-label { color: #666; font-size: 0.95rem; }
              .content { padding: 30px; }
              .btn { 
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  color: white; 
                  padding: 10px 20px; 
                  border: none; 
                  border-radius: 22px; 
                  cursor: pointer; 
                  font-size: 0.95rem;
                  text-decoration: none;
                  display: inline-block;
                  margin: 5px;
              }
              .section { margin-bottom: 30px; }
              .section h2 { color: #333; margin-bottom: 15px; font-size: 1.3rem; }
          </style>
      </head>
      <body>
          <div class="container">
              <div class="header">
                  <h1>🤖 پنل مدیریت ربات لایک</h1>
                  <p>نمایش سریع وضعیت ربات و پایگاه داده</p>
              </div>
              
              <div class="stats">
                  <div class="stat-card">
                      <div class="stat-number" id="total-users">0</div>
                      <div class="stat-label">👥 کل کاربران</div>
                  </div>
                  <div class="stat-card">
                      <div class="stat-number" id="total-likes">0</div>
                      <div class="stat-label">👍 کل لایک‌ها</div>
                  </div>
                  <div class="stat-card">
                      <div class="stat-number" id="total-posts">0</div>
                      <div class="stat-label">📝 کل پست‌ها</div>
                  </div>
                  <div class="stat-card">
                      <div class="stat-number" id="today-activity">0</div>
                      <div class="stat-label">📊 فعالیت امروز</div>
                  </div>
              </div>
              
              <div class="content">
                  <div class="section">
                      <h2>🔧 مدیریت</h2>
                      <a href="/api/stats" class="btn" target="_blank">📊 مشاهده آمار کامل</a>
                      <a href="/api/users" class="btn" target="_blank">👥 لیست کاربران</a>
                      <a href="/api/likes" class="btn" target="_blank">👍 لیست لایک‌ها</a>
                      <button class="btn" onclick="refreshStats()">🔄 بروزرسانی</button>
                  </div>
              </div>
          </div>
          
          <script>
              async function refreshStats() {
                  try {
                      const response = await fetch('/api/stats');
                      const stats = await response.json();
                      
                      document.getElementById('total-users').textContent = stats.totalUsers || 0;
                      document.getElementById('total-likes').textContent = stats.totalLikes || 0;
                      document.getElementById('total-posts').textContent = stats.totalPosts || 0;
                      document.getElementById('today-activity').textContent = stats.todayActivity || 0;
                  } catch (error) {
                      console.error('Error fetching stats:', error);
                  }
              }
              refreshStats();
          </script>
      </body>
      </html>
    `;

    return new Response(html, {
      headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  // API: /api/stats
  if (url.pathname === '/api/stats') {
    try {
      const userKeys = await BOT_KV.list({ prefix: 'user:' });
      const likeKeys = await BOT_KV.list({ prefix: 'like:' });

      let totalLikes = 0;
      let todayActivity = 0;
      const today = new Date().toDateString();

      for (const key of likeKeys.keys) {
        const likeData = await BOT_KV.get(key.name);
        if (!likeData) continue;
        const like = JSON.parse(likeData);
        totalLikes += like.likes || 0;
        if (new Date(like.created_at).toDateString() === today) todayActivity++;
      }

      const stats = {
        totalUsers: userKeys.keys.length,
        totalPosts: likeKeys.keys.length,
        totalLikes,
        todayActivity
      };

      return new Response(JSON.stringify(stats), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Failed to fetch stats' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }

  // API: /api/users
  if (url.pathname === '/api/users') {
    try {
      const userKeys = await BOT_KV.list({ prefix: 'user:' });
      const users = [];
      for (const key of userKeys.keys) {
        const userData = await BOT_KV.get(key.name);
        if (userData) users.push(JSON.parse(userData));
      }
      return new Response(JSON.stringify(users), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Failed to fetch users' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }

  // API: /api/likes
  if (url.pathname === '/api/likes') {
    try {
      const likeKeys = await BOT_KV.list({ prefix: 'like:' });
      const likes = [];
      for (const key of likeKeys.keys) {
        const likeData = await BOT_KV.get(key.name);
        if (likeData) likes.push(JSON.parse(likeData));
      }
      return new Response(JSON.stringify(likes), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Failed to fetch likes' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }

  // Health
  if (url.pathname === '/health') {
    return new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // 404
  return new Response('Not Found', { status: 404, headers: corsHeaders });
};

// Default export for Cloudflare Pages
export default {
  fetch: handleRequest
};
