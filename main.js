// main.js - Telegram Like Bot for Cloudflare Pages (Without Hono)

// Bot configuration
const REQUIRED_CHANNEL = '@NoiDUsers';
const ADMIN_IDS = []; // Add admin user IDs here

// Utility functions
const telegramAPI = (token, method, params = {}) => {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
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

// Keyboard generators
const mainMenuKeyboard = () => ({
  inline_keyboard: [
    [{ text: '🔧 تنظیمات', callback_data: 'settings' }],
    [{ text: '👍 ساخت لایک', callback_data: 'create_like' }],
    [{ text: '📊 آمار', callback_data: 'stats' }]
  ]
});

const settingsKeyboard = () => ({
  inline_keyboard: [
    [{ text: '📢 تنظیم کانال', callback_data: 'set_channel' }],
    [{ text: '🏠 بازگشت', callback_data: 'back_main' }]
  ]
});

// Build deep-link to open bot with a specific like payload
const buildDeepLink = (botUsername, likeId) => `https://t.me/${botUsername}?start=${likeId}`;

// Keyboard for a like object with live count and share button
// like: { id, name, likes, creator }
const createLikeKeyboard = (like, botUsername, hasChannel = false) => {
  const buttons = [];
  const likeBtn = { text: `👍 لایک (${like.likes || 0})`, callback_data: like.id };
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(buildDeepLink(botUsername, like.id))}&text=${encodeURIComponent(`برای حمایت، این مورد را لایک کنید: ${like.name}`)}`;
  const shareBtn = { text: '🔗 اشتراک‌گذاری', url: shareUrl };

  if (hasChannel) {
    buttons.push([likeBtn, shareBtn]);
  } else {
    buttons.push([likeBtn, shareBtn]);
  }
  return { inline_keyboard: buttons };
};

// Main update handler
export const handleUpdate = async (update, env, ctx) => {
  const { BOT_TOKEN, BOT_KV, BOT_USERNAME } = env;
  
  try {
    if (update.message) {
      await handleMessage(update.message, BOT_TOKEN, BOT_KV, BOT_USERNAME);
    } else if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, BOT_TOKEN, BOT_KV, BOT_USERNAME);
    }
  } catch (error) {
    console.error('Error handling update:', error);
  }
};

// Message handler
const handleMessage = async (message, token, kv, botUsername = '') => {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text || '';

  // Check channel membership
  const isMember = await checkChannelMembership(token, userId, REQUIRED_CHANNEL);
  if (!isMember) {
    return sendMessage(token, chatId, 
      `❌ برای استفاده از ربات باید عضو کانال ${REQUIRED_CHANNEL} باشید.\n\n` +
      `لطفاً ابتدا عضو شوید سپس دوباره تلاش کنید.`,
      {
        inline_keyboard: [
          [{ text: '📢 عضویت در کانال', url: `https://t.me/${REQUIRED_CHANNEL.replace('@', '')}` }],
          [{ text: '🔄 بررسی عضویت', callback_data: 'check_membership' }]
        ]
      }
    );
  }

  // Handle deep-link payload: /start <likeId>
  if (text.startsWith('/start ') || text.startsWith('/start@')) {
    // Extract payload after /start or /start@BotName
    const parts = text.split(' ');
    const payload = parts.length > 1 ? parts[1].trim() : '';
    if (payload && payload.startsWith('like_')) {
      const likeData = await kv.get(`like:${payload}`);
      if (likeData) {
        const like = JSON.parse(likeData);
        const creatorChannel = await kv.get(`channel:${like.creator}`);
        const hasChannel = !!creatorChannel;
        await sendMessage(token, chatId,
          `👍 ${like.name}\n\n❤️ تعداد لایک: ${like.likes || 0}`,
          createLikeKeyboard(like, botUsername || 'your_bot', hasChannel)
        );
        return;
      }
    }
  }

  if (text === '/start') {
    await sendMessage(token, chatId, 
      '🎉 سلام! به ربات لایک خوش آمدید\n\n' +
      'با این ربات می‌تونید لایک‌های جعلی برای پست‌هاتون بسازید!\n\n' +
      '🔹 ساخت لایک: برای ساخت لایک جدید\n' +
      '🔹 تنظیمات: برای تنظیم کانال اجباری\n' +
      '🔹 آمار: مشاهده آمار لایک‌ها',
      mainMenuKeyboard()
    );
    
    // Save user
    await kv.put(`user:${userId}`, JSON.stringify({
      id: userId,
      username: message.from.username || '',
      first_name: message.from.first_name || '',
      joined_at: Date.now()
    }));
    
    return;
  }

  // Handle waiting for like name
  const userState = await kv.get(`state:${userId}`);
  if (userState === 'waiting_like_name') {
    const likeId = `like_${userId}_${Date.now()}`;
    await kv.put(`like:${likeId}`, JSON.stringify({
      id: likeId,
      name: text,
      creator: userId,
      likes: 0,
      created_at: Date.now()
    }));
    
    await kv.delete(`state:${userId}`);
    
    // Check if user has set a channel
    const userChannel = await kv.get(`channel:${userId}`);
    const hasChannel = !!userChannel;
    
    const likeObj = { id: likeId, name: text, creator: userId, likes: 0 };
    await sendMessage(token, chatId,
      `✅ لایک شما ساخته شد!\n\n` +
      `📝 نام: ${text}\n` +
      `👍 تعداد لایک: 0\n\n` +
      `این پیام رو به هر جایی که می‌خواهید بفرستید تا دیگران بتوانند لایک کنند!`,
      createLikeKeyboard(likeObj, botUsername || 'your_bot', hasChannel)
    );
    return;
  }

  // Handle waiting for channel username
  if (userState === 'waiting_channel') {
    let channelUsername = text.trim();
    if (!channelUsername.startsWith('@')) {
      channelUsername = '@' + channelUsername;
    }
    
    await kv.put(`channel:${userId}`, channelUsername);
    await kv.delete(`state:${userId}`);
    
    await sendMessage(token, chatId,
      `✅ کانال شما تنظیم شد!\n\n` +
      `📢 کانال: ${channelUsername}\n\n` +
      `از حالا برای لایک کردن لایک‌های شما، کاربران باید عضو این کانال باشند.`,
      settingsKeyboard()
    );
    return;
  }

  // Default response
  await sendMessage(token, chatId, 
    'لطفاً از منوی زیر استفاده کنید:', 
    mainMenuKeyboard()
  );
};

// Callback query handler
const handleCallbackQuery = async (query, token, kv, botUsername = '') => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = query.from.id;
  const data = query.data;

  // Answer callback query
  await telegramAPI(token, 'answerCallbackQuery', { callback_query_id: query.id });

  if (data === 'check_membership') {
    const isMember = await checkChannelMembership(token, userId, REQUIRED_CHANNEL);
    if (isMember) {
      await editMessage(token, chatId, messageId,
        '✅ عضویت شما تأیید شد! حالا می‌تونید از ربات استفاده کنید.',
        mainMenuKeyboard()
      );
    } else {
      await editMessage(token, chatId, messageId,
        `❌ هنوز عضو کانال نشدید!\n\nلطفاً ابتدا عضو کانال ${REQUIRED_CHANNEL} شوید.`,
        {
          inline_keyboard: [
            [{ text: '📢 عضویت در کانال', url: `https://t.me/${REQUIRED_CHANNEL.replace('@', '')}` }],
            [{ text: '🔄 بررسی مجدد', callback_data: 'check_membership' }]
          ]
        }
      );
    }
    return;
  }

  if (data === 'settings') {
    await editMessage(token, chatId, messageId,
      '🔧 تنظیمات ربات:\n\n' +
      'می‌تونید کانال اجباری برای لایک‌هاتون تنظیم کنید.',
      settingsKeyboard()
    );
    return;
  }

  if (data === 'set_channel') {
    await kv.put(`state:${userId}`, 'waiting_channel');
    await editMessage(token, chatId, messageId,
      '📢 لطفاً username کانال خود را وارد کنید:\n\n' +
      'مثال: @mychannel یا mychannel\n\n' +
      '⚠️ حتماً ربات را در کانال ادمین کنید!'
    );
    return;
  }

  if (data === 'create_like') {
    await kv.put(`state:${userId}`, 'waiting_like_name');
    await editMessage(token, chatId, messageId,
      '📝 لطفاً نام مطلبی که می‌خواهید براش لایک بگیرید را وارد کنید:\n\n' +
      'مثال: عکس جدیدم، ویدیوی باحالم، نظرتون چیه؟'
    );
    return;
  }

  if (data === 'stats') {
    // Get user's likes
    const allKeys = await kv.list({ prefix: 'like:' });
    let userLikes = 0;
    let totalLikes = 0;

    for (const key of allKeys.keys) {
      const likeData = await kv.get(key.name);
      if (likeData) {
        const like = JSON.parse(likeData);
        if (like.creator === userId) {
          userLikes++;
        }
        totalLikes += like.likes || 0;
      }
    }

    await editMessage(token, chatId, messageId,
      `📊 آمار شما:\n\n` +
      `🎯 لایک‌های ساخته شده: ${userLikes}\n` +
      `👍 مجموع لایک‌های دریافتی: ${totalLikes}\n\n` +
      `📈 همچنان در حال رشد!`,
      { inline_keyboard: [[{ text: '🏠 بازگشت', callback_data: 'back_main' }]] }
    );
    return;
  }

  if (data === 'back_main') {
    await editMessage(token, chatId, messageId,
      '🎉 سلام! به ربات لایک خوش آمدید\n\n' +
      'با این ربات می‌تونید لایک‌های جعلی برای پست‌هاتون بسازید!\n\n' +
      '🔹 ساخت لایک: برای ساخت لایک جدید\n' +
      '🔹 تنظیمات: برای تنظیم کانال اجباری\n' +
      '🔹 آمار: مشاهده آمار لایک‌ها',
      mainMenuKeyboard()
    );
    return;
  }

  // Handle like button
  if (data.startsWith('like_')) {
    const likeId = data;
    const likeData = await kv.get(`like:${likeId}`);
    
    if (!likeData) {
      await telegramAPI(token, 'answerCallbackQuery', {
        callback_query_id: query.id,
        text: '❌ لایک پیدا نشد!',
        show_alert: true
      });
      return;
    }

    const like = JSON.parse(likeData);
    
    // Check if user already liked
    const userLikeKey = `liked:${likeId}:${userId}`;
    const hasLiked = await kv.get(userLikeKey);
    
    if (hasLiked) {
      await telegramAPI(token, 'answerCallbackQuery', {
        callback_query_id: query.id,
        text: '⚠️ شما قبلاً لایک کرده‌اید!',
        show_alert: true
      });
      return;
    }

    // Check channel membership for like creator's channel
    const creatorChannel = await kv.get(`channel:${like.creator}`);
    if (creatorChannel) {
      const isMember = await checkChannelMembership(token, userId, creatorChannel);
      if (!isMember) {
        await telegramAPI(token, 'answerCallbackQuery', {
          callback_query_id: query.id,
          text: `❌ برای لایک باید عضو کانال ${creatorChannel} باشید!`,
          show_alert: true
        });
        return;
      }
    }

    // Add like
    like.likes = (like.likes || 0) + 1;
    await kv.put(`like:${likeId}`, JSON.stringify(like));
    await kv.put(userLikeKey, 'true', { expirationTtl: 86400 * 30 }); // 30 days

    // Update message
    const hasChannel = !!creatorChannel;
    await editMessage(token, chatId, messageId,
      `👍 ${like.name}\n\n` +
      `❤️ تعداد لایک: ${like.likes}`,
      createLikeKeyboard(like, botUsername || 'your_bot', hasChannel)
    );

    await telegramAPI(token, 'answerCallbackQuery', {
      callback_query_id: query.id,
      text: '✅ لایک شما ثبت شد!'
    });
    return;
  }
};

// Handle HTTP requests (for admin panel and API)
const handleRequest = async (request, env) => {
  const url = new URL(request.url);
  const { BOT_KV } = env;

  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Admin Panel
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
              .header h1 { font-size: 2.5rem; margin-bottom: 10px; }
              .header p { font-size: 1.1rem; opacity: 0.9; }
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
                  transition: transform 0.3s ease;
              }
              .stat-card:hover { transform: translateY(-5px); }
              .stat-number { font-size: 2.5rem; font-weight: bold; color: #667eea; margin-bottom: 10px; }
              .stat-label { color: #666; font-size: 1rem; }
              .content { padding: 30px; }
              .btn { 
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  color: white; 
                  padding: 12px 25px; 
                  border: none; 
                  border-radius: 25px; 
                  cursor: pointer; 
                  font-size: 1rem;
                  transition: all 0.3s ease;
                  text-decoration: none;
                  display: inline-block;
                  margin: 5px;
              }
              .btn:hover { 
                  transform: translateY(-2px); 
                  box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
              }
              .section { margin-bottom: 30px; }
              .section h2 { color: #333; margin-bottom: 15px; font-size: 1.5rem; }
          </style>
      </head>
      <body>
          <div class="container">
              <div class="header">
                  <h1>🤖 پنل مدیریت ربات لایک</h1>
                  <p>مدیریت و نظارت بر عملکرد ربات تلگرام</p>
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
                      <a href="/api/stats" class="btn">📊 مشاهده آمار کامل</a>
                      <a href="/api/users" class="btn">👥 لیست کاربران</a>
                      <a href="/api/likes" class="btn">👍 لیست لایک‌ها</a>
                      <button class="btn" onclick="refreshStats()">🔄 بروزرسانی</button>
                  </div>
                  
                  <div class="section">
                      <h2>📈 آمار سریع</h2>
                      <p>ربات در حال حاضر فعال است و آماده پاسخگویی به کاربران می‌باشد.</p>
                      <p>برای مشاهده جزئیات بیشتر از لینک‌های بالا استفاده کنید.</p>
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
              
              // Load stats on page load
              refreshStats();
          </script>
      </body>
      </html>
    `;
    
    return new Response(html, {
      headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  // API Routes
  if (url.pathname === '/api/stats') {
    try {
      const userKeys = await BOT_KV.list({ prefix: 'user:' });
      const likeKeys = await BOT_KV.list({ prefix: 'like:' });
      
      let totalLikes = 0;
      let todayActivity = 0;
      const today = new Date().toDateString();
      
      for (const key of likeKeys.keys) {
        const likeData = await BOT_KV.get(key.name);
        if (likeData) {
          const like = JSON.parse(likeData);
          totalLikes += like.likes || 0;
          
          if (new Date(like.created_at).toDateString() === today) {
            todayActivity++;
          }
        }
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

  if (url.pathname === '/api/users') {
    try {
      const userKeys = await BOT_KV.list({ prefix: 'user:' });
      const users = [];
      
      for (const key of userKeys.keys) {
        const userData = await BOT_KV.get(key.name);
        if (userData) {
          users.push(JSON.parse(userData));
        }
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

  if (url.pathname === '/api/likes') {
    try {
      const likeKeys = await BOT_KV.list({ prefix: 'like:' });
      const likes = [];
      
      for (const key of likeKeys.keys) {
        const likeData = await BOT_KV.get(key.name);
        if (likeData) {
          likes.push(JSON.parse(likeData));
        }
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

  // Health check
  if (url.pathname === '/health') {
    return new Response(JSON.stringify({ 
      status: 'ok', 
      timestamp: new Date().toISOString() 
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // 404
  return new Response('Not Found', { 
    status: 404, 
    headers: corsHeaders 
  });
};

// Export default handler for Cloudflare Pages
export default {
  fetch: handleRequest
};
