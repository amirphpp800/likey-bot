# راهنمای استقرار ربات لایک تلگرام

## 🚀 مراحل استقرار روی Cloudflare Pages

### 1. آماده‌سازی پیش‌نیازها

#### ایجاد ربات تلگرام:
1. به @BotFather در تلگرام پیام دهید
2. دستور `/newbot` را اجرا کنید
3. نام ربات را وارد کنید (مثال: "ربات لایک من")
4. نام کاربری ربات را وارد کنید (مثال: `my_like_bot`)
5. توکن ربات را کپی و ذخیره کنید

#### ایجاد حساب Cloudflare:
1. به [cloudflare.com](https://cloudflare.com) بروید
2. حساب کاربری ایجاد کنید
3. دامنه خود را اضافه کنید (یا از subdomain رایگان استفاده کنید)

### 2. تنظیم Cloudflare KV

#### ایجاد KV Namespace:
1. در Cloudflare Dashboard، به بخش **Workers & Pages** بروید
2. روی **KV** کلیک کنید
3. **Create a namespace** را انتخاب کنید
4. نام مناسب وارد کنید (مثال: `telegram-bot-kv`)
5. ID ایجاد شده را کپی کنید

#### تنظیم KV در wrangler.toml:
```toml
[[kv_namespaces]]
binding = "BOT_KV"
id = "YOUR_KV_NAMESPACE_ID_HERE"
preview_id = "YOUR_PREVIEW_KV_NAMESPACE_ID_HERE"
```

### 3. نصب Wrangler CLI

```bash
npm install -g wrangler
```

#### ورود به Cloudflare:
```bash
wrangler login
```

### 4. تنظیم متغیرهای محیطی

#### تنظیم توکن ربات:
```bash
wrangler secret put BOT_TOKEN
# توکن ربات را وارد کنید
```

#### تنظیم متغیرهای دیگر:
```bash
wrangler secret put REQUIRED_CHANNEL
# @NoiDUsers
```

### 5. استقرار روی Cloudflare Pages

#### روش 1: از طریق Wrangler CLI
```bash
# در پوشه پروژه
wrangler pages deploy functions/
```

#### روش 2: از طریق GitHub Actions
1. پروژه را به GitHub push کنید
2. در Cloudflare Pages، **Create a project** را انتخاب کنید
3. **Connect to Git** را انتخاب کنید
4. repository را انتخاب کنید
5. تنظیمات build:
   - **Build command**: `npm run build` (یا خالی بگذارید)
   - **Build output directory**: `functions`
   - **Root directory**: `/` (یا خالی بگذارید)

### 6. تنظیم Webhook

#### دریافت آدرس webhook:
پس از استقرار، آدرس زیر را دریافت خواهید کرد:
```
https://your-project-name.pages.dev
```

#### تنظیم webhook در تلگرام:
```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url": "https://your-project-name.pages.dev"}'
```

یا از طریق پنل مدیریت:
1. فایل `admin.html` را باز کنید
2. توکن ربات و آدرس webhook را وارد کنید
3. روی "تنظیم Webhook" کلیک کنید

### 7. تست ربات

#### بررسی وضعیت webhook:
```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
```

#### تست ربات:
1. در تلگرام، ربات خود را پیدا کنید
2. دستور `/start` را اجرا کنید
3. بررسی کنید که ربات پاسخ می‌دهد

## 🔧 تنظیمات پیشرفته

### تنظیم دامنه سفارشی:
1. در Cloudflare Pages، به **Custom domains** بروید
2. دامنه مورد نظر را اضافه کنید
3. DNS records را تنظیم کنید

### تنظیم Environment Variables:
```bash
# برای محیط production
wrangler secret put BOT_TOKEN --env production

# برای محیط staging
wrangler secret put BOT_TOKEN --env staging
```

### تنظیم CORS (اگر نیاز باشد):
در `functions/main.js`:
```javascript
// اضافه کردن headers برای CORS
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: corsHeaders,
      });
    }
    
    // ... rest of your code
  }
};
```

## 🐛 عیب‌یابی

### مشکلات رایج:

#### 1. ربات پاسخ نمی‌دهد:
- بررسی کنید که webhook درست تنظیم شده باشد
- توکن ربات را بررسی کنید
- لاگ‌های Cloudflare Pages را چک کنید

#### 2. خطای KV:
- بررسی کنید که KV Namespace ID درست باشد
- بررسی کنید که KV binding درست تنظیم شده باشد

#### 3. خطای CORS:
- اگر از frontend جداگانه استفاده می‌کنید، CORS headers را اضافه کنید

#### 4. خطای Environment Variables:
- بررسی کنید که secrets درست تنظیم شده باشند
- از `wrangler secret list` برای بررسی استفاده کنید

### بررسی لاگ‌ها:
```bash
# لاگ‌های real-time
wrangler tail

# لاگ‌های Cloudflare Pages
# در Cloudflare Dashboard > Pages > Your Project > Functions > Logs
```

## 📊 مانیتورینگ

### Cloudflare Analytics:
1. در Cloudflare Dashboard، به **Analytics** بروید
2. **Web Analytics** را فعال کنید
3. آمار درخواست‌ها و عملکرد را مشاهده کنید

### Custom Monitoring:
می‌توانید از سرویس‌های خارجی مانند:
- UptimeRobot
- Pingdom
- StatusCake

برای مانیتورینگ استفاده کنید.

## 🔒 امنیت

### محدودیت‌های امنیتی:
1. توکن ربات را در کد قرار ندهید
2. از HTTPS استفاده کنید
3. Rate limiting اعمال کنید
4. ورودی‌های کاربر را اعتبارسنجی کنید

### Rate Limiting:
```javascript
// اضافه کردن rate limiting ساده
const rateLimit = new Map();

function checkRateLimit(userId) {
  const now = Date.now();
  const userLimit = rateLimit.get(userId) || 0;
  
  if (now - userLimit < 1000) { // 1 second
    return false;
  }
  
  rateLimit.set(userId, now);
  return true;
}
```

## 📱 بهینه‌سازی

### Performance:
1. از Cloudflare Cache استفاده کنید
2. تصاویر را بهینه کنید
3. از CDN استفاده کنید

### SEO:
1. Meta tags مناسب اضافه کنید
2. Structured data اضافه کنید
3. Sitemap ایجاد کنید

## 🚀 ارتقا و نگهداری

### بروزرسانی ربات:
1. کد جدید را push کنید
2. Cloudflare Pages به طور خودکار استقرار می‌کند
3. تغییرات را تست کنید

### Backup:
1. از KV data backup بگیرید
2. کد را در Git نگهداری کنید
3. تنظیمات را مستند کنید

## 📞 پشتیبانی

برای مشکلات و سوالات:
1. Cloudflare Documentation
2. Telegram Bot API Documentation
3. GitHub Issues
4. Community Forums

---

**نکته مهم**: همیشه قبل از استقرار در production، ربات را در محیط staging تست کنید.
