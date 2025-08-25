// Telegram Like Bot - Cloudflare Workers Version (Fixed)
import { Bot, webhookCallback } from "https://esm.sh/grammy";

// Bot configuration
const bot = new Bot("");

// Channel ID for mandatory subscription
const REQUIRED_CHANNEL = "@NoiDUsers";

// Bot commands
bot.command("start", async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name;
  
  // Check if user is subscribed to required channel
  const isSubscribed = await checkSubscription(ctx, REQUIRED_CHANNEL);
  if (!isSubscribed) {
    return ctx.reply(
      `سلام ${username}! 👋\n\nبرای استفاده از ربات لایک، ابتدا باید عضو کانال ما شوید:\n\n${REQUIRED_CHANNEL}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "عضویت در کانال 📢", url: `https://t.me/${REQUIRED_CHANNEL.slice(1)}` }],
            [{ text: "بررسی عضویت ✅", callback_data: "check_subscription" }]
          ]
        }
      }
    );
  }

  // Main menu
  await showMainMenu(ctx);
});

// Check subscription callback
bot.callbackQuery("check_subscription", async (ctx) => {
  const isSubscribed = await checkSubscription(ctx, REQUIRED_CHANNEL);
  if (isSubscribed) {
    await ctx.answerCallbackQuery();
    await showMainMenu(ctx);
  } else {
    await ctx.answerCallbackQuery("هنوز عضو کانال نشده‌اید! لطفاً ابتدا عضو شوید.", { show_alert: true });
  }
});

// Main menu
async function showMainMenu(ctx) {
  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name;
  
  // Check if user has set up a channel
  const userChannel = await getKV(`user_channel:${userId}`);
  
  const buttons = [
    [{ text: "ساخت لایک 🎯", callback_data: "create_like" }],
    [{ text: "تنظیمات کانال ⚙️", callback_data: "channel_settings" }],
    [{ text: "آمار لایک‌ها 📊", callback_data: "like_stats" }]
  ];

  if (userChannel) {
    buttons.push([{ text: "کانال تنظیم شده: " + userChannel, callback_data: "view_channel" }]);
  }

  const message = `سلام ${username}! 👋\n\nبه ربات لایک خوش آمدید!\n\nچه کاری می‌خواهید انجام دهید؟`;

  if (ctx.callbackQuery) {
    await ctx.editMessageText(message, {
      reply_markup: {
        inline_keyboard: buttons
      }
    });
  } else {
    await ctx.reply(message, {
      reply_markup: {
        inline_keyboard: buttons
      }
    });
  }
}

// Create like
bot.callbackQuery("create_like", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    "لطفاً نام لایک مورد نظر خود را وارد کنید:\n\nمثال: لایک من، محصول جدید، ویدیو و...",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 بازگشت", callback_data: "back_to_menu" }]
        ]
      }
    }
  );
  
  // Set user state to waiting for like name
  await setKV(`user_state:${ctx.from.id}`, "waiting_like_name");
});

// Handle text messages for like creation and channel setup
bot.on("message:text", async (ctx) => {
  const userId = ctx.from.id;
  const userState = await getKV(`user_state:${userId}`);
  
  if (userState === "waiting_like_name") {
    await handleLikeCreation(ctx);
  } else if (userState === "waiting_channel_name") {
    await handleChannelSetup(ctx);
  }
});

// Handle like creation
async function handleLikeCreation(ctx) {
  const userId = ctx.from.id;
  const likeName = ctx.message.text;
  
  // Generate unique like ID
  const likeId = `like_${Date.now()}_${userId}`;
  
  // Save like data
  const likeData = {
    name: likeName,
    userId: userId,
    username: ctx.from.username || ctx.from.first_name,
    createdAt: Date.now(),
    likes: 0
  };
  
  await setKV(`like:${likeId}`, likeData);
  
  // Add to user's likes list
  let userLikes = await getKV(`user_likes:${userId}`) || [];
  userLikes.push(likeId);
  await setKV(`user_likes:${userId}`, userLikes);
  
  // Clear user state
  await deleteKV(`user_state:${userId}`);
  
  // Check if user has set up a channel
  const userChannel = await getKV(`user_channel:${userId}`);
  
  const buttons = [
    [{ text: "اشتراک بنر 📢", callback_data: `share_banner:${likeId}` }]
  ];
  
  if (userChannel) {
    buttons.push([
      { text: "لایک (نیاز به عضویت) 👍", callback_data: `like_with_sub:${likeId}` }
    ]);
  } else {
    buttons.push([
      { text: "لایک 👍", callback_data: `like_simple:${likeId}` }
    ]);
  }
  
  buttons.push([{ text: "🔙 بازگشت به منو", callback_data: "back_to_menu" }]);
  
  await ctx.reply(
    `✅ لایک شما با موفقیت ساخته شد!\n\n📝 نام: ${likeName}\n🆔 شناسه: ${likeId}\n\nحالا می‌توانید بنر لایک را اشتراک‌گذاری کنید:`,
    {
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
}

// Handle channel setup
async function handleChannelSetup(ctx) {
  const userId = ctx.from.id;
  let channelName = ctx.message.text.trim();
  
  // Add @ if not present
  if (!channelName.startsWith('@')) {
    channelName = '@' + channelName;
  }
  
  // Validate channel name
  if (channelName.length < 4) {
    await ctx.reply("نام کانال باید حداقل 3 کاراکتر باشد!");
    return;
  }
  
  // Save channel
  await setKV(`user_channel:${userId}`, channelName);
  
  // Clear user state
  await deleteKV(`user_state:${userId}`);
  
  await ctx.reply(
    `✅ کانال ${channelName} با موفقیت تنظیم شد!\n\nحالا لایک‌های شما نیاز به عضویت در این کانال خواهند داشت.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔙 بازگشت به منو", callback_data: "back_to_menu" }]
        ]
      }
    }
  );
}

// Share banner
bot.callbackQuery(/^share_banner:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const likeId = ctx.match[1];
  const likeData = await getKV(`like:${likeId}`);
  
  if (!likeData) {
    return ctx.answerCallbackQuery("لایک مورد نظر یافت نشد!", { show_alert: true });
  }
  
  const userChannel = await getKV(`user_channel:${likeData.userId}`);
  
  let buttons = [
    [{ text: "🔙 بازگشت", callback_data: "back_to_menu" }]
  ];
  
  if (userChannel) {
    buttons.unshift([
      { text: "لایک (نیاز به عضویت) 👍", callback_data: `like_with_sub:${likeId}` }
    ]);
  } else {
    buttons.unshift([
      { text: "لایک 👍", callback_data: `like_simple:${likeId}` }
    ]);
  }
  
  await ctx.editMessageText(
    `🎯 لایک: ${likeData.name}\n\n👤 سازنده: ${likeData.username}\n❤️ تعداد لایک: ${likeData.likes}\n\nبرای لایک کردن روی دکمه زیر کلیک کنید:`,
    {
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
});

// Simple like (no subscription required)
bot.callbackQuery(/^like_simple:(.+)$/, async (ctx) => {
  const likeId = ctx.match[1];
  const userId = ctx.from.id;
  
  const likeData = await getKV(`like:${likeId}`);
  
  if (!likeData) {
    return ctx.answerCallbackQuery("لایک مورد نظر یافت نشد!", { show_alert: true });
  }
  
  // Check if user already liked
  const alreadyLiked = await getKV(`user_liked:${userId}:${likeId}`);
  
  if (alreadyLiked) {
    return ctx.answerCallbackQuery("شما قبلاً این لایک را کرده‌اید!", { show_alert: true });
  }
  
  // Increment like count
  likeData.likes += 1;
  await setKV(`like:${likeId}`, likeData);
  
  // Save user's like
  await setKV(`user_liked:${userId}:${likeId}`, Date.now());
  
  await ctx.answerCallbackQuery("✅ لایک شما ثبت شد!");
  
  // Update the message
  await ctx.editMessageText(
    `🎯 لایک: ${likeData.name}\n\n👤 سازنده: ${likeData.username}\n❤️ تعداد لایک: ${likeData.likes}\n\nبرای لایک کردن روی دکمه زیر کلیک کنید:`,
    {
      reply_markup: ctx.callbackQuery.message.reply_markup
    }
  );
});

// Like with subscription required
bot.callbackQuery(/^like_with_sub:(.+)$/, async (ctx) => {
  const likeId = ctx.match[1];
  const userId = ctx.from.id;
  
  const likeData = await getKV(`like:${likeId}`);
  
  if (!likeData) {
    return ctx.answerCallbackQuery("لایک مورد نظر یافت نشد!", { show_alert: true });
  }
  
  const userChannel = await getKV(`user_channel:${likeData.userId}`);
  
  if (!userChannel) {
    return ctx.answerCallbackQuery("کانال تنظیم نشده است!", { show_alert: true });
  }
  
  // Check if user is subscribed to the channel
  const isSubscribed = await checkSubscription(ctx, userChannel);
  
  if (!isSubscribed) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText(
      `برای لایک کردن باید عضو کانال ${userChannel} باشید!`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "عضویت در کانال 📢", url: `https://t.me/${userChannel.slice(1)}` }],
            [{ text: "بررسی عضویت ✅", callback_data: `check_sub_for_like:${likeId}` }],
            [{ text: "🔙 بازگشت", callback_data: `share_banner:${likeId}` }]
          ]
        }
      }
    );
  }
  
  // Check if user already liked
  const alreadyLiked = await getKV(`user_liked:${userId}:${likeId}`);
  
  if (alreadyLiked) {
    return ctx.answerCallbackQuery("شما قبلاً این لایک را کرده‌اید!", { show_alert: true });
  }
  
  // Increment like count
  likeData.likes += 1;
  await setKV(`like:${likeId}`, likeData);
  
  // Save user's like
  await setKV(`user_liked:${userId}:${likeId}`, Date.now());
  
  await ctx.answerCallbackQuery("✅ لایک شما ثبت شد!");
  
  // Update the message
  await ctx.editMessageText(
    `🎯 لایک: ${likeData.name}\n\n👤 سازنده: ${likeData.username}\n❤️ تعداد لایک: ${likeData.likes}\n\nبرای لایک کردن روی دکمه زیر کلیک کنید:`,
    {
      reply_markup: ctx.callbackQuery.message.reply_markup
    }
  );
});

// Check subscription for like
bot.callbackQuery(/^check_sub_for_like:(.+)$/, async (ctx) => {
  const likeId = ctx.match[1];
  const userId = ctx.from.id;
  
  const likeData = await getKV(`like:${likeId}`);
  
  if (!likeData) {
    return ctx.answerCallbackQuery("لایک مورد نظر یافت نشد!", { show_alert: true });
  }
  
  const userChannel = await getKV(`user_channel:${likeData.userId}`);
  const isSubscribed = await checkSubscription(ctx, userChannel);
  
  if (isSubscribed) {
    // Check if user already liked
    const alreadyLiked = await getKV(`user_liked:${userId}:${likeId}`);
    
    if (alreadyLiked) {
      return ctx.answerCallbackQuery("شما قبلاً این لایک را کرده‌اید!", { show_alert: true });
    }
    
    // Process the like
    likeData.likes += 1;
    await setKV(`like:${likeId}`, likeData);
    await setKV(`user_liked:${userId}:${likeId}`, Date.now());
    
    await ctx.answerCallbackQuery("✅ لایک شما ثبت شد!");
    
    // Return to banner view
    await ctx.editMessageText(
      `🎯 لایک: ${likeData.name}\n\n👤 سازنده: ${likeData.username}\n❤️ تعداد لایک: ${likeData.likes}\n\nبرای لایک کردن روی دکمه زیر کلیک کنید:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "لایک (نیاز به عضویت) 👍", callback_data: `like_with_sub:${likeId}` }],
            [{ text: "🔙 بازگشت", callback_data: "back_to_menu" }]
          ]
        }
      }
    );
  } else {
    await ctx.answerCallbackQuery("هنوز عضو کانال نشده‌اید!", { show_alert: true });
  }
});

// Channel settings
bot.callbackQuery("channel_settings", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from.id;
  const userChannel = await getKV(`user_channel:${userId}`);
  
  let message = "⚙️ تنظیمات کانال\n\n";
  
  if (userChannel) {
    message += `کانال فعلی: ${userChannel}\n\nبرای تغییر کانال، نام کانال جدید را وارد کنید (بدون @):`;
  } else {
    message += "هیچ کانالی تنظیم نشده است.\n\nبرای تنظیم کانال، نام کانال را وارد کنید (بدون @):";
  }
  
  await ctx.editMessageText(message, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔙 بازگشت", callback_data: "back_to_menu" }]
      ]
    }
  });
  
  // Set user state to waiting for channel name
  await setKV(`user_state:${userId}`, "waiting_channel_name");
});

// Like statistics
bot.callbackQuery("like_stats", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from.id;
  
  // Get user's likes
  const userLikes = await getKV(`user_likes:${userId}`) || [];
  
  let message = "📊 آمار لایک‌های شما\n\n";
  
  if (userLikes.length === 0) {
    message += "هنوز هیچ لایکی نساخته‌اید.";
  } else {
    message += `تعداد لایک‌های ساخته شده: ${userLikes.length}\n\n`;
    
    let totalLikes = 0;
    for (let i = 0; i < Math.min(userLikes.length, 5); i++) {
      const likeData = await getKV(`like:${userLikes[i]}`);
      if (likeData) {
        message += `${i + 1}. ${likeData.name} - ${likeData.likes} لایک\n`;
        totalLikes += likeData.likes;
      }
    }
    
    if (userLikes.length > 5) {
      message += `\nو ${userLikes.length - 5} لایک دیگر...`;
    }
    
    message += `\n\nمجموع لایک‌های دریافتی: ${totalLikes}`;
  }
  
  await ctx.editMessageText(message, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔙 بازگشت", callback_data: "back_to_menu" }]
      ]
    }
  });
});

// Back to menu
bot.callbackQuery("back_to_menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showMainMenu(ctx);
});

// Check if user is subscribed to a channel
async function checkSubscription(ctx, channel) {
  try {
    const chatMember = await ctx.api.getChatMember(channel, ctx.from.id);
    return chatMember.status !== "left" && chatMember.status !== "kicked";
  } catch (error) {
    console.error("Error checking subscription:", error);
    return false;
  }
}

// KV Storage functions for Cloudflare Workers
async function getKV(key, env = null) {
  try {
    if (env && env.BOT_KV) {
      // Use Cloudflare KV in production
      const value = await env.BOT_KV.get(key);
      return value ? JSON.parse(value) : null;
    } else {
      // Use in-memory storage for development
      return globalThis.__BOT_KV__?.[key] || null;
    }
  } catch (error) {
    console.error("Error getting KV:", error);
    return null;
  }
}

async function setKV(key, value, env = null) {
  try {
    if (env && env.BOT_KV) {
      // Use Cloudflare KV in production
      await env.BOT_KV.put(key, JSON.stringify(value));
    } else {
      // Use in-memory storage for development
      if (!globalThis.__BOT_KV__) {
        globalThis.__BOT_KV__ = {};
      }
      globalThis.__BOT_KV__[key] = value;
    }
    return true;
  } catch (error) {
    console.error("Error setting KV:", error);
    return false;
  }
}

async function deleteKV(key, env = null) {
  try {
    if (env && env.BOT_KV) {
      // Use Cloudflare KV in production
      await env.BOT_KV.delete(key);
    } else {
      // Use in-memory storage for development
      if (globalThis.__BOT_KV__ && globalThis.__BOT_KV__[key]) {
        delete globalThis.__BOT_KV__[key];
      }
    }
    return true;
  } catch (error) {
    console.error("Error deleting KV:", error);
    return false;
  }
}

// Error handling
bot.catch((err) => {
  console.error("Bot error:", err);
});

// Export for Cloudflare Workers
export default {
  async fetch(request, env, ctx) {
    // Set bot token from environment
    if (env.BOT_TOKEN) {
      bot.token = env.BOT_TOKEN;
    }
    
    // Make env available to KV functions
    globalThis.__BOT_ENV__ = env;
    
    try {
      // Handle webhook
      return await webhookCallback(bot, "cloudflare-mod")(request);
    } catch (error) {
      console.error("Webhook error:", error);
      return new Response("Error", { status: 500 });
    }
  }
};
