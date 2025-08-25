// main.js - Telegram Like Bot with Cloudflare Pages & KV
import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

// Middleware
app.use('*', cors());

// Bot Configuration
const BOT_COMMANDS = [
  { command: 'start', description: '🚀 شروع کار با ربات' },
  { command: 'help', description: '❓ راهنما' },
  { command: 'create', description: '➕ ساخت لایک جدید' },
  { command: 'settings', description: '⚙️ تنظیمات' },
  { command: 'admin', description: '👑 پنل مدیریت' }
];

// Keyboard layouts
const MAIN_KEYBOARD = {
  reply_markup: {
    keyboard: [
      [{ text: '➕ ساخت لایک' }, { text: '⚙️ تنظیمات' }],
      [{ text: '❓ راهنما' }, { text: '📊 آمار' }]
    ],
    resize_keyboard: true,
    persistent: true
  }
};

const ADMIN_KEYBOARD = {
  reply_markup: {
    keyboard: [
      [{ text: '📊 آمار کل' }, { text: '👥 کاربران' }],
      [{ text: '📢 ارسال پیام همگانی' }, { text: '⚙️ تنظیمات کانال' }],
      [{ text: '🔙 بازگشت' }]
    ],
    resize_keyboard: true
  }
};

const SETTINGS_KEYBOARD = {
  reply_markup: {
    keyboard: [
      [{ text: '📢 تنظیم کانال' }, { text: '❌ حذف کانال' }],
      [{ text: '🔙 بازگشت به منو اصلی' }]
    ],
    resize_keyboard: true
  }
};

// Utility functions
async function sendTelegramMessage(botToken, chatId, text, extra = {}) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    ...extra
  };
  
  return await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function checkChannelMembership(botToken, userId, channelId) {
  try {
    const url = `https://api.telegram.org/bot${botToken}/getChatMember`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: channelId,
        user_id: userId
      })
    });
    
    const data = await response.json();
    if (!data.ok) return false;
    
    const status = data.result.status;
    return ['creator', 'administrator', 'member'].includes(status);
  } catch (error) {
    console.error('Error checking membership:', error);
    return false;
  }
}

async function getChannelInfo(botToken, channelId) {
  try {
    const url = `https://api.telegram.org/bot${botToken}/getChat`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: channelId })
    });
    
    const data = await response.json();
    return data.ok ? data.result : null;
  } catch (error) {
    console.error('Error getting channel info:', error);
    return null;
  }
}

// Main bot handler
export async function handleUpdate(update, env, ctx) {
  const { BOT_TOKEN, ADMIN_ID, CHANNEL_ID, KV } = env;
  
  if (!update.message && !update.callback_query) return;
  
  const message = update.message || update.callback_query.message;
  const user = update.message?.from || update.callback_query?.from;
  const chatId = message.chat.id;
  const userId = user.id;
  const text = update.message?.text || '';
  const callbackData = update.callback_query?.data || '';
  
  // Save user data
  const userData = {
    id: userId,
    first_name: user.first_name,
    username: user.username,
    last_activity: Date.now()
  };
  await KV.put(`user:${userId}`, JSON.stringify(userData));
  
  // Check mandatory channel membership
  if (CHANNEL_ID && userId.toString() !== ADMIN_ID) {
    const isMember = await checkChannelMembership(BOT_TOKEN, userId, CHANNEL_ID);
    if (!isMember) {
      const channelInfo = await getChannelInfo(BOT_TOKEN, CHANNEL_ID);
      const channelLink = channelInfo?.invite_link || `https://t.me/${CHANNEL_ID.replace('@', '')}`;
      
      await sendTelegramMessage(BOT_TOKEN, chatId, 
        `❌ برای استفاده از ربات ابتدا باید در کانال ما عضو شوید:\n\n` +
        `👤 نام کانال: ${channelInfo?.title || 'کانال ما'}\n` +
        `🔗 لینک کانال: ${channelLink}\n\n` +
        `پس از عضویت، دوباره /start را بزنید.`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '🔗 عضویت در کانال', url: channelLink },
              { text: '✅ عضو شدم', callback_data: 'check_membership' }
            ]]
          }
        }
      );
      return;
    }
  }
  
  // Handle callback queries
  if (update.callback_query) {
    await handleCallback(update.callback_query, env);
    return;
  }
  
  // Command handlers
  if (text.startsWith('/start')) {
    await sendTelegramMessage(BOT_TOKEN, chatId,
      `🎉 سلام ${user.first_name} عزیز!\n\n` +
      `به ربات لایک خوش آمدید 🚀\n\n` +
      `📋 امکانات ربات:\n` +
      `• ➕ ساخت لایک جدید\n` +
      `• ⚙️ تنظیمات کانال برای لایک\n` +
      `• 📊 مشاهده آمار لایک ها\n\n` +
      `برای شروع، یکی از دکمه های زیر را انتخاب کنید:`,
      MAIN_KEYBOARD
    );
    
    // Update user stats
    const stats = await KV.get('bot_stats');
    const currentStats = stats ? JSON.parse(stats) : { total_users: 0, total_likes: 0 };
    currentStats.total_users += 1;
    await KV.put('bot_stats', JSON.stringify(currentStats));
    
  } else if (text.startsWith('/admin')) {
    if (userId.toString() !== ADMIN_ID) {
      await sendTelegramMessage(BOT_TOKEN, chatId, '❌ شما دسترسی به پنل مدیریت ندارید!');
      return;
    }
    
    const stats = await KV.get('bot_stats');
    const currentStats = stats ? JSON.parse(stats) : { total_users: 0, total_likes: 0 };
    
    await sendTelegramMessage(BOT_TOKEN, chatId,
      `👑 پنل مدیریت\n\n` +
      `📊 آمار کلی:\n` +
      `👥 تعداد کاربران: ${currentStats.total_users}\n` +
      `❤️ تعداد لایک ها: ${currentStats.total_likes}\n` +
      `📅 تاریخ: ${new Date().toLocaleDateString('fa-IR')}`,
      ADMIN_KEYBOARD
    );
    
  } else if (text === '➕ ساخت لایک' || text.startsWith('/create')) {
    await KV.put(`user_state:${userId}`, 'waiting_for_like_name');
    await sendTelegramMessage(BOT_TOKEN, chatId,
      `📝 لطفاً نام مورد نظر برای لایک گیری را وارد کنید:\n\n` +
      `مثال: محمد، سارا، تیم فوتبال و...\n\n` +
      `💡 نکته: نام وارد شده روی دکمه لایک نمایش داده خواهد شد.`
    );
    
  } else if (text === '⚙️ تنظیمات') {
    await sendTelegramMessage(BOT_TOKEN, chatId,
      `⚙️ تنظیمات ربات\n\n` +
      `در این بخش می‌توانید کانال خود را برای لایک گیری تنظیم کنید.\n` +
      `اگر کانالی تنظیم کنید، فقط اعضای آن کانال می‌توانند لایک بدهند.`,
      SETTINGS_KEYBOARD
    );
    
  } else if (text === '📢 تنظیم کانال') {
    await KV.put(`user_state:${userId}`, 'waiting_for_channel');
    await sendTelegramMessage(BOT_TOKEN, chatId,
      `📢 لطفاً آیدی کانال خود را وارد کنید:\n\n` +
      `مثال: @mychannel\n\n` +
      `⚠️ توجه:\n` +
      `• ربات باید در کانال ادمین باشد\n` +
      `• آیدی کانال باید با @ شروع شود\n` +
      `• پس از تنظیم، فقط اعضای کانال می‌توانند لایک بدهند`
    );
    
  } else if (text === '❌ حذف کانال') {
    await KV.delete(`user_channel:${userId}`);
    await sendTelegramMessage(BOT_TOKEN, chatId,
      `✅ تنظیمات کانال حذف شد!\n\n` +
      `حالا همه می‌توانند بدون نیاز به عضویت در کانال، لایک بدهند.`,
      SETTINGS_KEYBOARD
    );
    
  } else if (text === '🔙 بازگشت به منو اصلی' || text === '🔙 بازگشت') {
    await sendTelegramMessage(BOT_TOKEN, chatId,
      `🏠 منوی اصلی\n\n` +
      `یکی از گزینه های زیر را انتخاب کنید:`,
      MAIN_KEYBOARD
    );
    
  } else if (text === '❓ راهنما' || text.startsWith('/help')) {
    await sendTelegramMessage(BOT_TOKEN, chatId,
      `📖 راهنمای استفاده از ربات\n\n` +
      `🔹 ساخت لایک:\n` +
      `• روی "➕ ساخت لایک" کلیک کنید\n` +
      `• نام مورد نظر را وارد کنید\n` +
      `• لینک لایک دریافت کنید\n\n` +
      `🔹 تنظیمات کانال:\n` +
      `• برای محدود کردن لایک به اعضای کانال\n` +
      `• آیدی کانال را تنظیم کنید\n\n` +
      `🔹 اشتراک گذاری:\n` +
      `• لینک دریافتی را در هر جا ارسال کنید\n` +
      `• دیگران می‌توانند لایک بدهند\n\n` +
      `❓ سوال یا مشکل؟ با @NoiDUsers در تماس باشید.`
    );
    
  } else if (text === '📊 آمار') {
    const userLikes = await KV.get(`user_likes:${userId}`);
    const likes = userLikes ? JSON.parse(userLikes) : [];
    
    let message = `📊 آمار شما\n\n`;
    if (likes.length === 0) {
      message += `❌ هنوز لایکی نساخته‌اید!\n\nبرای ساخت لایک جدید روی "➕ ساخت لایک" کلیک کنید.`;
    } else {
      message += `📈 تعداد لایک های ساخته شده: ${likes.length}\n\n`;
      likes.forEach((like, index) => {
        message += `${index + 1}. ${like.name} - ${like.count} لایک\n`;
      });
    }
    
    await sendTelegramMessage(BOT_TOKEN, chatId, message);
    
  } else {
    // Handle user input based on state
    const userState = await KV.get(`user_state:${userId}`);
    
    if (userState === 'waiting_for_like_name') {
      const likeName = text.trim();
      if (likeName.length < 2) {
        await sendTelegramMessage(BOT_TOKEN, chatId, '❌ نام باید حداقل 2 کاراکتر باشد!');
        return;
      }
      
      // Generate unique like ID
      const likeId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
      
      // Save like data
      const likeData = {
        id: likeId,
        name: likeName,
        creator: userId,
        count: 0,
        created_at: Date.now(),
        users: []
      };
      
      await KV.put(`like:${likeId}`, JSON.stringify(likeData));
      
      // Update user likes
      const userLikes = await KV.get(`user_likes:${userId}`);
      const likes = userLikes ? JSON.parse(userLikes) : [];
      likes.push({ id: likeId, name: likeName, count: 0 });
      await KV.put(`user_likes:${userId}`, JSON.stringify(likes));
      
      // Clear user state
      await KV.delete(`user_state:${userId}`);
      
      const shareUrl = `https://t.me/share/url?url=https://t.me/${(await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`)).json().then(r => r.result.username)}?start=like_${likeId}`;
      
      await sendTelegramMessage(BOT_TOKEN, chatId,
        `✅ لایک شما ساخته شد!\n\n` +
        `📝 نام: ${likeName}\n` +
        `❤️ تعداد لایک: 0\n` +
        `🆔 شناسه: ${likeId}\n\n` +
        `برای اشتراک گذاری لایک خود از دکمه زیر استفاده کنید:`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📤 اشتراک بنر', url: shareUrl }],
              [{ text: '🔗 مشاهده لایک', callback_data: `view_like_${likeId}` }]
            ]
          }
        }
      );
      
    } else if (userState === 'waiting_for_channel') {
      const channelId = text.trim();
      
      if (!channelId.startsWith('@')) {
        await sendTelegramMessage(BOT_TOKEN, chatId, '❌ آیدی کانال باید با @ شروع شود!\nمثال: @mychannel');
        return;
      }
      
      // Check if bot is admin in channel
      const channelInfo = await getChannelInfo(BOT_TOKEN, channelId);
      if (!channelInfo) {
        await sendTelegramMessage(BOT_TOKEN, chatId, '❌ کانال پیدا نشد! لطفاً آیدی کانال را درست وارد کنید.');
        return;
      }
      
      // Save channel setting
      await KV.put(`user_channel:${userId}`, channelId);
      await KV.delete(`user_state:${userId}`);
      
      await sendTelegramMessage(BOT_TOKEN, chatId,
        `✅ کانال با موفقیت تنظیم شد!\n\n` +
        `📢 کانال: ${channelInfo.title}\n` +
        `🆔 آیدی: ${channelId}\n\n` +
        `حالا فقط اعضای این کانال می‌توانند لایک بدهند.`,
        SETTINGS_KEYBOARD
      );
    }
  }
}

// Handle callback queries
async function handleCallback(callbackQuery, env) {
  const { BOT_TOKEN, ADMIN_ID, KV } = env;
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  
  // Answer callback query
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQuery.id })
  });
  
  if (data === 'check_membership') {
    // Re-check membership and redirect to start
    const isMember = await checkChannelMembership(BOT_TOKEN, userId, env.CHANNEL_ID);
    if (isMember) {
      await sendTelegramMessage(BOT_TOKEN, chatId,
        `✅ عضویت شما تأیید شد! خوش آمدید 🎉\n\n` +
        `برای شروع از دکمه های زیر استفاده کنید:`,
        MAIN_KEYBOARD
      );
    } else {
      await sendTelegramMessage(BOT_TOKEN, chatId, '❌ هنوز در کانال عضو نشده‌اید! لطفاً ابتدا عضو شوید.');
    }
  } else if (data.startsWith('like_')) {
    const likeId = data.replace('like_', '');
    const likeData = await KV.get(`like:${likeId}`);
    
    if (!likeData) {
      await sendTelegramMessage(BOT_TOKEN, chatId, '❌ لایک پیدا نشد!');
      return;
    }
    
    const like = JSON.parse(likeData);
    const userChannel = await KV.get(`user_channel:${like.creator}`);
    
    let keyboard = [];
    
    if (userChannel) {
      // Check channel membership
      const isMember = await checkChannelMembership(BOT_TOKEN, userId, userChannel);
      if (isMember) {
        keyboard = [
          [{ text: `❤️ لایک (${like.count})`, callback_data: `give_like_${likeId}` }]
        ];
      } else {
        const channelInfo = await getChannelInfo(BOT_TOKEN, userChannel);
        const channelLink = channelInfo?.invite_link || `https://t.me/${userChannel.replace('@', '')}`;
        
        keyboard = [
          [{ text: '📢 عضویت در کانال', url: channelLink }],
          [{ text: `❤️ لایک (${like.count})`, callback_data: `give_like_${likeId}` }]
        ];
      }
    } else {
      keyboard = [
        [{ text: `❤️ لایک (${like.count})`, callback_data: `give_like_${likeId}` }]
      ];
    }
    
    await sendTelegramMessage(BOT_TOKEN, chatId,
      `❤️ لایک برای: ${like.name}\n\n` +
      `👥 تعداد لایک: ${like.count}\n` +
      `📅 تاریخ ساخت: ${new Date(like.created_at).toLocaleDateString('fa-IR')}\n\n` +
      `برای لایک دادن دکمه زیر را بزنید:`,
      {
        reply_markup: {
          inline_keyboard: keyboard
        }
      }
    );
  } else if (data.startsWith('give_like_')) {
    const likeId = data.replace('give_like_', '');
    const likeData = await KV.get(`like:${likeId}`);
    
    if (!likeData) {
      await sendTelegramMessage(BOT_TOKEN, chatId, '❌ لایک پیدا نشد!');
      return;
    }
    
    const like = JSON.parse(likeData);
    const userChannel = await KV.get(`user_channel:${like.creator}`);
    
    // Check channel membership if required
    if (userChannel) {
      const isMember = await checkChannelMembership(BOT_TOKEN, userId, userChannel);
      if (!isMember) {
        const channelInfo = await getChannelInfo(BOT_TOKEN, userChannel);
        const channelLink = channelInfo?.invite_link || `https://t.me/${userChannel.replace('@', '')}`;
        
        await sendTelegramMessage(BOT_TOKEN, chatId,
          `❌ برای لایک دادن ابتدا باید در کانال عضو شوید:\n\n${channelInfo?.title || userChannel}`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: '📢 عضویت در کانال', url: channelLink }
              ]]
            }
          }
        );
        return;
      }
    }
    
    // Check if user already liked
    if (like.users.includes(userId)) {
      await sendTelegramMessage(BOT_TOKEN, chatId, '⚠️ شما قبلاً لایک داده‌اید!');
      return;
    }
    
    // Add like
    like.users.push(userId);
    like.count += 1;
    
    await KV.put(`like:${likeId}`, JSON.stringify(like));
    
    // Update user likes count
    const userLikes = await KV.get(`user_likes:${like.creator}`);
    if (userLikes) {
      const likes = JSON.parse(userLikes);
      const likeIndex = likes.findIndex(l => l.id === likeId);
      if (likeIndex !== -1) {
        likes[likeIndex].count = like.count;
        await KV.put(`user_likes:${like.creator}`, JSON.stringify(likes));
      }
    }
    
    // Update bot stats
    const stats = await KV.get('bot_stats');
    const currentStats = stats ? JSON.parse(stats) : { total_users: 0, total_likes: 0 };
    currentStats.total_likes += 1;
    await KV.put('bot_stats', JSON.stringify(currentStats));
    
    await sendTelegramMessage(BOT_TOKEN, chatId,
      `✅ لایک شما ثبت شد!\n\n❤️ ${like.name} - ${like.count} لایک`
    );
  } else if (data.startsWith('view_like_')) {
    const likeId = data.replace('view_like_', '');
    const likeData = await KV.get(`like:${likeId}`);
    
    if (!likeData) {
      await sendTelegramMessage(BOT_TOKEN, chatId, '❌ لایک پیدا نشد!');
      return;
    }
    
    const like = JSON.parse(likeData);
    
    await sendTelegramMessage(BOT_TOKEN, chatId,
      `📊 اطلاعات لایک\n\n` +
      `📝 نام: ${like.name}\n` +
      `❤️ تعداد لایک: ${like.count}\n` +
      `🆔 شناسه: ${like.id}\n` +
      `📅 تاریخ ساخت: ${new Date(like.created_at).toLocaleDateString('fa-IR')}\n` +
      `👤 سازنده: ${like.creator === userId ? 'شما' : 'کاربر دیگر'}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: `❤️ لایک (${like.count})`, callback_data: `give_like_${likeId}` }]
          ]
        }
      }
    );
  }
}

// Web interface routes
app.get('/', (c) => {
  return c.html(`
<!DOCTYPE html>
<html dir="rtl" lang="fa">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ربات لایک تلگرام</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Tahoma', sans-serif; background: linear-gradient(135deg, #2c3e50 0%, #3498db 100%); min-height: 100vh; }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        .header { text-align: center; color: white; margin-bottom: 30px; }
        .card { background: white; border-radius: 15px; padding: 30px; margin: 20px 0; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; }
        .stat-card { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 25px; border-radius: 15px; text-align: center; }
        .stat-number { font-size: 36px; font-weight: bold; margin-bottom: 10px; }
        .stat-label { font-size: 16px; opacity: 0.9; }
        .btn { display: inline-block; background: #667eea; color: white; padding: 12px 25px; border-radius: 8px; text-decoration: none; margin: 10px; }
        .table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        .table th, .table td { padding: 12px; text-align: right; border-bottom: 1px solid #eee; }
        .table th { background: #f8f9fa; font-weight: bold; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>👑 پنل مدیریت ربات لایک</h1>
            <p>آمار و اطلاعات کامل ربات</p>
        </div>
        
        <div class="stats">
            <div class="stat-card">
                <div class="stat-number">${currentStats.total_users}</div>
                <div class="stat-label">👥 تعداد کاربران</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">${currentStats.total_likes}</div>
                <div class="stat-label">❤️ تعداد لایک ها</div linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; }
        .container { max-width: 800px; margin: 0 auto; padding: 20px; }
        .header { text-align: center; color: white; margin-bottom: 30px; }
        .card { background: white; border-radius: 15px; padding: 30px; margin: 20px 0; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
        .feature { display: flex; align-items: center; margin: 15px 0; }
        .feature span { font-size: 24px; margin-left: 10px; }
        .btn { display: inline-block; background: #667eea; color: white; padding: 12px 25px; border-radius: 8px; text-decoration: none; margin: 10px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; }
        .stat-card { background: #f8f9fa; padding: 20px; border-radius: 10px; text-align: center; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 ربات لایک تلگرام</h1>
            <p>بهترین ربات برای ساخت لایک در تلگرام</p>
        </div>
        
        <div class="card">
            <h2>✨ ویژگی های ربات</h2>
            <div class="feature"><span>➕</span> ساخت لایک جدید</div>
            <div class="feature"><span>⚙️</span> تنظیمات کانال</div>
            <div class="feature"><span>📊</span> مشاهده آمار</div>
            <div class="feature"><span>🔒</span> عضویت اجباری کانال</div>
            <div class="feature"><span>📤</span> اشتراک گذاری آسان</div>
        </div>
        
        <div class="card">
            <h2>🚀 شروع کنید</h2>
            <p>برای استفاده از ربات، روی دکمه زیر کلیک کنید:</p>
            <a href="https://t.me/YourBotUsername" class="btn">🤖 شروع چت با ربات</a>
        </div>
        
        <div class="card">
            <h2>📞 پشتیبانی</h2>
            <p>برای مشکلات و سوالات با ما در تماس باشید:</p>
            <a href="https://t.me/NoiDUsers" class="btn">💬 تماس با پشتیبانی</a>
        </div>
    </div>
</body>
</html>
  `);
});

app.get('/admin', async (c) => {
  const { KV } = c.env;
  
  // Get bot statistics
  const stats = await KV.get('bot_stats');
  const currentStats = stats ? JSON.parse(stats) : { total_users: 0, total_likes: 0 };
  
  return c.html(`
<!DOCTYPE html>
<html dir="rtl" lang="fa">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>پنل مدیریت - ربات لایک</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Tahoma', sans-serif; background:
