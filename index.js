require("dotenv").config();
const { Telegraf, Markup, session, Scenes } = require("telegraf");
const axios = require("axios");
const cron = require("node-cron");
const express = require("express");
const mongoose = require("mongoose");
const fs = require("fs");
const i18n = require("./i18n");

// ============================================================
// ✅ MUHIT O'ZGARUVCHILARI
// ============================================================
if (!process.env.BOT_TOKEN) {
  console.error("❌ BOT_TOKEN topilmadi.");
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;

// ============================================================
// 💾 MONGODB BAZASI
// ============================================================
const userSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true },
  lang: { type: String, default: "uz" },
  subscribed: { type: Boolean, default: false },
  portfolio: { type: Object, default: {} },
  alerts: { type: Array, default: [] },
  scheduledAlerts: { type: Array, default: [] }
});
const User = mongoose.model("User", userSchema);

mongoose
  .connect(process.env.MONGODB_URI || "mongodb://localhost:27017/valyutabot")
  .then(() => console.log("✅ MongoDB bazasiga muvaffaqiyatli ulandi!"))
  .catch((err) => console.error("⚠️ MongoDB xatosi:", err.message));

async function getUser(userId) {
  let user = await User.findOne({ userId });
  if (!user) {
    user = await User.create({ userId });
  }
  return user;
}

async function t(userId, key, params = {}) {
  const user = await getUser(userId);
  const lang = user.lang || "uz";
  let text = i18n[lang]?.[key] || i18n["uz"][key] || key;
  for (const [k, v] of Object.entries(params)) {
    text = text.replace(new RegExp(`{${k}}`, "g"), v);
  }
  return text;
}

// ============================================================
// 🎨 DIZAYN VA YORDAMCHILAR
// ============================================================
const LINE = "✨ ———————————————————— ✨";

function formatMoney(amount, currencyCode = "") {
  if (isNaN(amount)) return "N/A";
  const formatted = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount);
  return currencyCode ? `${formatted} ${currencyCode}` : formatted;
}

function formatSmallMoney(amount) {
  if (isNaN(amount)) return "N/A";
  if (amount < 0.01) return new Intl.NumberFormat("en-US", { minimumFractionDigits: 6, maximumFractionDigits: 6 }).format(amount);
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(amount);
}

function getTimeStr() {
  return new Date().toLocaleString("uz-UZ", { timeZone: "Asia/Tashkent", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" });
}

async function axiosWithRetry(config, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try { return await axios({ ...config, timeout: config.timeout || 8000 }); } 
    catch (err) { if (i === retries - 1) throw err; await new Promise((r) => setTimeout(r, delay * (i + 1))); }
  }
}

// ============================================================
// 💱 KESHLAR (CBU, Crypto, Dollaruz)
// ============================================================
let cbuCache = null;
let lastCbuFetch = null;
async function updateCBU() {
  const now = Date.now();
  if (cbuCache && lastCbuFetch && now - lastCbuFetch < 5 * 60 * 1000) return cbuCache;
  try {
    const { data } = await axiosWithRetry({ method: "get", url: "https://cbu.uz/uz/arkhiv-kursov-valyut/json/" });
    if (data && data.length) { cbuCache = data; lastCbuFetch = now; }
    return cbuCache;
  } catch (e) { return cbuCache; }
}

async function getCurrency(code) {
  const data = await updateCBU();
  if (!data) return null;
  return data.find((item) => item.Ccy === code.toUpperCase()) || null;
}

let cryptoCache = {};
async function updateCryptoCache() {
  try {
    const { data } = await axiosWithRetry({ url: "https://api.kucoin.com/api/v1/market/allTickers" });
    const prices = {};
    if (data?.data?.ticker) {
      for (const item of data.data.ticker) {
        prices[item.symbol] = parseFloat(item.last);
      }
    }
    cryptoCache = prices;
  } catch(e) { console.error("Crypto kesh xatosi:", e.message); }
}
cron.schedule("*/2 * * * *", updateCryptoCache);
updateCryptoCache();

let dollaruzCache = null;
let lastDollaruzFetch = null;
async function fetchDollaruzBanks() {
  const now = Date.now();
  if (dollaruzCache && lastDollaruzFetch && now - lastDollaruzFetch < 5 * 60 * 1000) return dollaruzCache;
  try {
    const { data } = await axiosWithRetry({ url: "https://dollaruz.net/", timeout: 10000 });
    const regex = /<span class="tb-lead name-val">(.*?)<\/span>.*?<span class="num-val">([\d\s]+)<\/span>.*?<span class="num-val">([\d\s]+)<\/span>/gs;
    let match;
    const banks = [];
    while ((match = regex.exec(data)) !== null) {
      const name = match[1].replace(/<[^>]*>?/gm, '').trim();
      const buy = parseFloat(match[2].replace(/\s/g, ''));
      const sell = parseFloat(match[3].replace(/\s/g, ''));
      if (name && !isNaN(buy) && !isNaN(sell)) {
        banks.push({ name, buy, sell });
      }
      if (banks.length >= 12) break;
    }
    if (banks.length > 0) {
      dollaruzCache = banks;
      lastDollaruzFetch = now;
    }
    return dollaruzCache;
  } catch(e) { return dollaruzCache; }
}

// ============================================================
// 🧙 WIZARDS: Eslatma qo'shish & Admin Xabarnoma
// ============================================================
const scheduleWizard = new Scenes.WizardScene(
  'schedule-wizard',
  async (ctx) => {
    const userId = ctx.from.id;
    const msg = "🔔 *Qaysi valyuta bo'yicha eslatma o'rnatmoqchisiz?*\n\nTanlang yoki yozing (Masalan: `USD`, `EUR`, `BTC`, `Oltin`, `Barchasi`):";
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("🇺🇸 USD", "sched_USD"), Markup.button.callback("🇪🇺 EUR", "sched_EUR"), Markup.button.callback("🇷🇺 RUB", "sched_RUB")],
      [Markup.button.callback("🟠 BTC", "sched_BTC"), Markup.button.callback("🪙 Oltin", "sched_PAXG"), Markup.button.callback("📦 Barchasi", "sched_BARCHASI")],
      [Markup.button.callback("❌ Bekor qilish", "cancel_sched")]
    ]);
    if (ctx.callbackQuery) {
      await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: keyboard.reply_markup }).catch(()=>{});
    } else {
      await ctx.replyWithMarkdown(msg, keyboard);
    }
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (ctx.callbackQuery?.data === "cancel_sched") {
      await ctx.answerCbQuery("Bekor qilindi");
      ctx.scene.leave();
      return sendAlertsHub(ctx);
    }
    let code = "USD";
    if (ctx.callbackQuery?.data?.startsWith("sched_")) {
      code = ctx.callbackQuery.data.replace("sched_", "");
      await ctx.answerCbQuery().catch(()=>{});
    } else if (ctx.message?.text) {
      code = ctx.message.text.toUpperCase();
      if (code === "OLTIN") code = "PAXG";
    }
    ctx.wizard.state.currency = code;

    const promptMsg = `⏰ *${code === 'PAXG' ? 'Oltin' : code} uchun eslatma vaqtini kiriting:*\n\nFormat: *HH:MM* (Toshkent vaqti)\n_Misol: 09:00 yoki 18:30_`;
    const cancelKb = Markup.inlineKeyboard([[Markup.button.callback("❌ Bekor qilish", "cancel_sched")]]);
    
    if (ctx.callbackQuery) {
      await ctx.editMessageText(promptMsg, { parse_mode: "Markdown", reply_markup: cancelKb.reply_markup }).catch(()=>{});
    } else {
      await ctx.replyWithMarkdown(promptMsg, cancelKb);
    }
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (ctx.callbackQuery?.data === "cancel_sched") {
      await ctx.answerCbQuery("Bekor qilindi");
      ctx.scene.leave();
      return sendAlertsHub(ctx);
    }
    const time = ctx.message?.text?.trim();
    if (!time || !/^\d{2}:\d{2}$/.test(time)) {
      ctx.reply("❌ Vaqt formati noto'g'ri! Misol: `09:00` ko'rinishida yozing.", Markup.inlineKeyboard([[Markup.button.callback("❌ Bekor qilish", "cancel_sched")]]));
      return;
    }
    const [h, m] = time.split(":").map(Number);
    if (h < 0 || h > 23 || m < 0 || m > 59) {
      ctx.reply("❌ Soat 00:00 dan 23:59 gacha bo'lishi kerak. Qaytadan kiriting:", Markup.inlineKeyboard([[Markup.button.callback("❌ Bekor qilish", "cancel_sched")]]));
      return;
    }

    const code = ctx.wizard.state.currency || "USD";
    const user = await getUser(ctx.from.id);
    const scheduledAlerts = user.scheduledAlerts || [];
    
    const newAlert = { id: Date.now().toString(36), code, time };
    scheduledAlerts.push(newAlert);
    await User.updateOne({ userId: ctx.from.id }, { scheduledAlerts });

    const finishKb = Markup.inlineKeyboard([
      [Markup.button.callback("⏰ Eslatmalar Markazi", "alerts")],
      [Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
    ]);
    await ctx.reply(
      `✅ *Eslatma muvaffaqiyatli saqlandi!*\n\nHar kuni soat *${time}* da (Toshkent vaqti) ${code === 'BARCHASI' ? 'barcha asosiy valyutalar' : code === 'PAXG' ? 'Oltin' : code} narxlari avtomatik yuboriladi.`,
      { parse_mode: "Markdown", reply_markup: finishKb.reply_markup }
    );
    return ctx.scene.leave();
  }
);

const broadcastWizard = new Scenes.WizardScene(
  'broadcast-wizard',
  (ctx) => {
    ctx.reply("✉️ Barcha foydalanuvchilarga yuboriladigan xabarni kiriting (Rasm, video yoki matn):", Markup.inlineKeyboard([[Markup.button.callback("❌ Bekor qilish", "admin_cancel")]]));
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (ctx.message) {
      const msgId = ctx.message.message_id;
      const users = await User.find({});
      let success = 0;
      let fail = 0;
      const statusMsg = await ctx.reply("⏳ Xabar tarqatilmoqda... Bu biroz vaqt olishi mumkin.");
      
      for (const u of users) {
          try {
             await ctx.telegram.copyMessage(u.userId, ctx.chat.id, msgId);
             success++;
             await new Promise(r => setTimeout(r, 40));
          } catch(e) { fail++; }
      }
      
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, `✅ Xabar tarqatish tugatildi!\n\nYetib bordi: ${success} ta\nYetib bormadi (bloklaganlar): ${fail} ta`);
      return ctx.scene.leave();
    } else {
      ctx.reply("❌ Xatolik yuz berdi. Faqat matn yoki media yuboring.");
      return ctx.scene.leave();
    }
  }
);

const stage = new Scenes.Stage([scheduleWizard, broadcastWizard]);
bot.use(session());
bot.use(stage.middleware());

// ============================================================
// 🚀 ASOSIY MENYU VA NAVIGATSIYA
// ============================================================
async function sendMainMenu(ctx) {
  const userId = ctx.from.id;
  const name = ctx.from.first_name || "Foydalanuvchi";
  
  const menu = Markup.inlineKeyboard([
    [Markup.button.callback(await t(userId, "btn_usd"), "rate_USD"), Markup.button.callback(await t(userId, "btn_eur"), "rate_EUR"), Markup.button.callback(await t(userId, "btn_rub"), "rate_RUB")],
    [Markup.button.callback(await t(userId, "btn_gold"), "gold"), Markup.button.callback(await t(userId, "btn_crypto"), "crypto")],
    [Markup.button.callback(await t(userId, "btn_forecast"), "forecast")],
    [Markup.button.callback(await t(userId, "btn_banks"), "banks"), Markup.button.callback(await t(userId, "btn_calc"), "calculator")],
    [Markup.button.callback(await t(userId, "btn_wallet"), "wallet"), Markup.button.callback(await t(userId, "btn_alerts"), "alerts")],
    [Markup.button.callback(await t(userId, "btn_ai"), "ai_advisor"), Markup.button.callback(await t(userId, "btn_chart"), "chart_menu")],
    [Markup.button.callback("🌐 Tilni o'zgartirish", "cmd_lang"), Markup.button.callback(await t(userId, "btn_stats"), "stats")]
  ]);

  const msg = await t(userId, "start", { name });
  
  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: menu.reply_markup }); } 
    catch(e) { await ctx.replyWithMarkdown(msg, menu); }
  } else {
    await ctx.replyWithMarkdown(msg, menu);
  }
}

bot.start(async (ctx) => {
  await getUser(ctx.from.id);
  ctx.reply(
    "🌍 Iltimos, tilni tanlang:\n🇷🇺 Пожалуйста, выберите язык:\n🇬🇧 Please choose a language:",
    Markup.inlineKeyboard([
      [Markup.button.callback("🇺🇿 O'zbekcha", "lang_uz")],
      [Markup.button.callback("🇷🇺 Русский", "lang_ru")],
      [Markup.button.callback("🇬🇧 English", "lang_en")]
    ])
  );
});

bot.command("lang", (ctx) => {
  ctx.reply(
    "🌍 Tilni tanlang / Выберите язык / Choose language:",
    Markup.inlineKeyboard([
      [Markup.button.callback("🇺🇿 O'zbek", "lang_uz"), Markup.button.callback("🇷🇺 Рус", "lang_ru"), Markup.button.callback("🇬🇧 Eng", "lang_en")]
    ])
  );
});
bot.action("cmd_lang", (ctx) => ctx.reply(
  "🌍 Tilni tanlang / Выберите язык / Choose language:",
  Markup.inlineKeyboard([
    [Markup.button.callback("🇺🇿 O'zbek", "lang_uz"), Markup.button.callback("🇷🇺 Рус", "lang_ru"), Markup.button.callback("🇬🇧 Eng", "lang_en")]
  ])
));

bot.action(/lang_(uz|ru|en)/, async (ctx) => {
  const lang = ctx.match[1];
  await User.updateOne({ userId: ctx.from.id }, { lang });
  const text = await t(ctx.from.id, "lang_changed");
  await ctx.answerCbQuery(text).catch(()=>{});
  await sendMainMenu(ctx);
});

bot.command("menu", sendMainMenu);
bot.action("main_menu", sendMainMenu);

// ============================================================
// 💱 VALYUTALAR (USD, EUR, RUB)
// ============================================================
async function sendRate(ctx, code) {
  const userId = ctx.from.id;
  const flag = { USD: "🇺🇸", EUR: "🇪🇺", RUB: "🇷🇺" }[code] || "💱";
  if (ctx.callbackQuery) await ctx.answerCbQuery(await t(userId, "wait")).catch(()=>{});
  
  const currency = await getCurrency(code);
  if (!currency) return ctx.reply(await t(userId, "error"));

  const rate = parseFloat(currency.Rate);
  const diff = parseFloat(currency.Diff);
  let diffText = await t(userId, "same");
  if (diff > 0) diffText = await t(userId, "up", { amount: formatMoney(diff) });
  else if (diff < 0) diffText = await t(userId, "down", { amount: formatMoney(Math.abs(diff)) });

  const msg = await t(userId, "rate_msg", { flag, code, rate: formatMoney(rate), diffText, time: currency.Date });
  const markup = Markup.inlineKeyboard([
    [Markup.button.callback(await t(userId, "refresh"), `rate_${code}`)],
    [Markup.button.callback("🔮 Ertangi kutilayotgan kurs", "forecast")],
    [Markup.button.callback(await t(userId, "btn_menu"), "main_menu")]
  ]);

  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch (e) {}
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}

bot.action(/rate_(USD|EUR|RUB)/, (ctx) => sendRate(ctx, ctx.match[1]));
bot.hears(/^(🇺🇸 USD|🇺🇸|USD)$/i, (ctx) => sendRate(ctx, "USD"));
bot.hears(/^(🇪🇺 EUR|🇪🇺|EUR)$/i, (ctx) => sendRate(ctx, "EUR"));
bot.hears(/^(🇷🇺 RUB|🇷🇺|RUB)$/i, (ctx) => sendRate(ctx, "RUB"));

// ============================================================
// 🔮 ERTANGI KUTILAYOTGAN KURS & PROGNOZ
// ============================================================
async function sendForecast(ctx) {
  const userId = ctx.from.id;
  if (ctx.callbackQuery) await ctx.answerCbQuery("🔮 Prognoz tahlil qilinmoqda...").catch(()=>{});

  const usdData = await getCurrency("USD");
  const banks = await fetchDollaruzBanks();

  if (!usdData) {
    return ctx.reply("⚠️ Ma'lumotlarni tahlil qilishda xatolik yuz berdi.");
  }

  const currentRate = parseFloat(usdData.Rate);
  const diff = parseFloat(usdData.Diff);
  const cbuDate = usdData.Date;

  // Hozirgi sanani Toshkent vaqti bilan tekshiramiz
  const now = new Date();
  const tashkentDate = new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Tashkent", day: "2-digit", month: "2-digit", year: "numeric" }).format(now);

  // Banklar o'rtacha xarid/sotish bahosi
  let avgBuy = currentRate - 40;
  let avgSell = currentRate + 50;
  if (banks && banks.length > 0) {
    avgBuy = Math.round(banks.reduce((acc, b) => acc + b.buy, 0) / banks.length);
    avgSell = Math.round(banks.reduce((acc, b) => acc + b.sell, 0) / banks.length);
  }

  let msg = `🔮 *Ertangi kun uchun kutilayotgan taxminiy kurs*\n${LINE}\n\n`;

  // Agar CBU allaqachon ertangi kun sanasini e'lon qilgan bo'lsa (soat 16:00 dan keyin):
  if (cbuDate !== tashkentDate) {
    const diffSign = diff > 0 ? `📈 +${diff} so'm oshdi` : diff < 0 ? `📉 ${diff} so'm tushdi` : "➡️ o'zgarishsiz";
    msg += `⚡️ *RASMIY TASDIQLANDI (Ertaga uchun):*\n` +
           `🗓 Sana: *${cbuDate}*\n` +
           `💰 1 USD = *${formatMoney(currentRate)}* UZS\n` +
           `📊 O'zgarish: *${diffSign}*\n\n` +
           `💡 _Markaziy Bank birja savdolari yakuniga ko'ra ertangi kun kursini e'lon qildi!_\n`;
  } else {
    // Kunduzgi savdo tahlili va ehtimoliy oraliq:
    const expectedLow = Math.round((currentRate + (diff * 0.4) - 25) / 5) * 5;
    const expectedHigh = Math.round((currentRate + (diff * 0.4) + 25) / 5) * 5;
    const trendText = diff >= 0 
      ? `📈 *O'sish tendensiyasi* (Talab yuqori, birja savdolarida +10...+35 so'm ko'tarilish kutilmoqda)`
      : `📉 *Pasayish tendensiyasi* (Valyuta tushumi yuqori, -10...-35 so'm oraliqda pasayish ehtimoli)`;

    msg += `📊 *Kutilayotgan oraliq:* *${formatMoney(expectedLow)} — ${formatMoney(expectedHigh)}* UZS\n\n` +
           `🔍 *Bozor holati tahlili:*\n` +
           `• Joriy CBU kursi: *${formatMoney(currentRate)}* UZS\n` +
           `• Tijorat banklari o'rtacha xaridi: *${formatMoney(avgBuy)}* UZS\n` +
           `• Tijorat banklari o'rtacha sotishi: *${formatMoney(avgSell)}* UZS\n\n` +
           `🧭 *Trend prognozi:*\n${trendText}\n\n` +
           `💡 *Tavsiya & Maslahat:*\n` +
           (diff > 0 
             ? `_Dollar sotmoqchi bo'lsangiz, birja o'sishi hisobiga ertaga sotish biroz manfaatliroq bo'lishi mumkin._`
             : `_Dollar olmoqchi bo'lsangiz, narx tushishi hisobiga xarid uchun qulay fursat kutilmoqda._`) +
           `\n\n⏰ _Eslatma: O'zRVB birja savdolari yakunlangach, soat 16:00 dan so'ng aniq tasdiqlangan kurs yangilanadi._`;
  }

  const markup = Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Yangilash", "forecast")],
    [Markup.button.callback("🏦 Banklar kurslari", "banks"), Markup.button.callback("⏰ Eslatma yoqish", "alerts")],
    [Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
  ]);

  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("forecast", sendForecast);
bot.hears(/^(🔮 Ertangi kutilayotgan kurs|🔮|Prognoz|Прогноз|Forecast)$/i, sendForecast);

// ============================================================
// 🏦 BANKLAR VA VALYUTA ARBITRAJI
// ============================================================
async function sendBanks(ctx) {
  const userId = ctx.from.id;
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});
  
  const banks = await fetchDollaruzBanks();
  let msg = `🏦 *O'zbekiston Banklari & Valyuta Arbitraji* 🇺🇸\n${LINE}\n\n`;

  if (banks && banks.length > 0) {
    // Eng yaxshi sotib oluvchi bank (max buy)
    const sortedBuy = [...banks].sort((a, b) => b.buy - a.buy);
    const bestBuyBank = sortedBuy[0];
    
    // Eng arzon sotuvchi bank (min sell)
    const sortedSell = [...banks].sort((a, b) => a.sell - b.sell);
    const bestSellBank = sortedSell[0];

    const buyProfitDiff = bestBuyBank.buy - sortedBuy[sortedBuy.length - 1].buy;

    msg += `🌟 *ENG FOYDALI BANKLAR (Hozirgi vaqtda):*\n\n` +
           `🟢 *Dollar sotish uchun (Eng baland narxda oladi):*\n` +
           `🏛 *${bestBuyBank.name}:* *${formatMoney(bestBuyBank.buy)}* UZS\n\n` +
           `🔵 *Dollar xarid qilish uchun (Eng arzon sotadi):*\n` +
           `🏛 *${bestSellBank.name}:* *${formatMoney(bestSellBank.sell)}* UZS\n\n` +
           `💡 *Tejamkorlik hisob-kitobi:*\n` +
           `_Agar siz 1 000 $ almashtirsangiz, eng yaxshi bankni tanlash orqali **+${formatMoney(buyProfitDiff * 1000)} so'mgacha** ko'proq pul yutasiz!_\n\n` +
           `${LINE}\n` +
           `📋 *Barcha tijorat banklari kurslari:*\n\n`;

    banks.forEach(b => {
      msg += `🏛 *${b.name}*\n` +
             `   📥 Olish: *${formatMoney(b.buy)}* | 📤 Sotish: *${formatMoney(b.sell)}*\n`;
    });
  } else {
    msg += "⚠️ Bank ma'lumotlarini yuklashda xatolik yuz berdi. Iltimos keyinroq qayta urinib ko'ring.";
  }
  
  const markup = Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Yangilash", "banks")],
    [Markup.button.callback("🧮 Kalkulyatorda hisoblash", "calculator")],
    [Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
  ]);

  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("banks", sendBanks);
bot.hears(/^(🏦 Banklar|🏦 Banklar & Arbitraj|Bank|Банки)$/i, sendBanks);

// ============================================================
// ⏰ ESLATMALAR VA SIGNALLAR MARKAZI (TO'LIQ BOSHQARUV)
// ============================================================
async function sendAlertsHub(ctx) {
  const userId = ctx.from.id;
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});

  const user = await getUser(userId);
  const scheduledAlerts = user.scheduledAlerts || [];

  let msg = await t(userId, "alerts_hub_title") + "\n\n";

  if (scheduledAlerts.length === 0) {
    msg += await t(userId, "alerts_none") + "\n\n" +
           `📌 *Yangi eslatma qo'shish uchun quyidagi tugmani bosing:*`;
  } else {
    msg += `📋 *Sizning faol eslatmalaringiz (${scheduledAlerts.length} ta):*\n\n`;
    scheduledAlerts.forEach((a, idx) => {
      const codeName = a.code === 'BARCHASI' ? '📦 Barcha kurslar' : a.code === 'PAXG' ? '🪙 Oltin' : a.code;
      msg += `🔹 *${idx + 1}.* ${codeName} — Har kuni soat *${a.time}* da\n`;
    });
    msg += `\n_Eslatmani bekor qilish uchun pastdagi tegishli raqamni bosing:_`;
  }

  const buttons = [];
  // Har bir eslatma uchun o'chirish tugmasi
  if (scheduledAlerts.length > 0) {
    const deleteRow = [];
    scheduledAlerts.forEach((a, idx) => {
      deleteRow.push(Markup.button.callback(`❌ ${idx + 1}`, `del_alert_${idx}`));
    });
    // Tugmalarni 3 tadan joylaymiz
    for (let i = 0; i < deleteRow.length; i += 3) {
      buttons.push(deleteRow.slice(i, i + 3));
    }
    buttons.push([Markup.button.callback("🗑 Barchasini o'chirish", "clear_all_alerts")]);
  }

  buttons.push([Markup.button.callback("➕ Yangi eslatma qo'shish", "start_new_alert")]);
  buttons.push([Markup.button.callback("🏠 Asosiy menyu", "main_menu")]);

  const markup = Markup.inlineKeyboard(buttons);

  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("alerts", sendAlertsHub);
bot.hears(/^(⏰ Eslatmalar|⏰ Eslatma|Eslatma|Напоминание|Reminder)$/i, sendAlertsHub);

bot.action("start_new_alert", (ctx) => {
  ctx.scene.enter('schedule-wizard');
});

// Bitta eslatmani o'chirish
bot.action(/^del_alert_(\d+)$/, async (ctx) => {
  const index = parseInt(ctx.match[1]);
  const user = await getUser(ctx.from.id);
  const scheduledAlerts = user.scheduledAlerts || [];

  if (index >= 0 && index < scheduledAlerts.length) {
    scheduledAlerts.splice(index, 1);
    await User.updateOne({ userId: ctx.from.id }, { scheduledAlerts });
    await ctx.answerCbQuery(await t(ctx.from.id, "alert_deleted")).catch(()=>{});
  } else {
    await ctx.answerCbQuery("Eslatma topilmadi.").catch(()=>{});
  }
  return sendAlertsHub(ctx);
});

// Barcha eslatmalarni tozalash
bot.action("clear_all_alerts", async (ctx) => {
  await User.updateOne({ userId: ctx.from.id }, { scheduledAlerts: [] });
  await ctx.answerCbQuery(await t(ctx.from.id, "alerts_all_cleared")).catch(()=>{});
  return sendAlertsHub(ctx);
});

// ============================================================
// 🤖 AI MOLIYAVIY MASLAHATCHI
// ============================================================
async function sendAiAdvisor(ctx) {
  const userId = ctx.from.id;
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});

  const msg = `🤖 *AI Moliyaviy Tahlilchi va Maslahatchi*\n${LINE}\n\n` +
              `Sun'iy intellekt tahlili va bozor ekspertizasi yordamida eng oqilona moliyaviy qarorlarni qabul qiling.\n\n` +
              `Quyidagi mavzulardan birini tanlang yoki savolingizni yo'llang:`;

  const markup = Markup.inlineKeyboard([
    [Markup.button.callback("📊 Hozirgi bozor tahlili", "ai_trend_analysis")],
    [Markup.button.callback("💡 10 mln so'm bor, qayerga qo'yay?", "ai_invest_advice")],
    [Markup.button.callback("🪙 Oltinmi yoki Dollarlik jamg'arma?", "ai_gold_vs_usd")],
    [Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
  ]);

  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("ai_advisor", sendAiAdvisor);
bot.hears(/^(🤖 AI Maslahatchi|🤖 AI|AI|Maslahatchi)$/i, sendAiAdvisor);

bot.action("ai_trend_analysis", async (ctx) => {
  await ctx.answerCbQuery().catch(()=>{});
  const usd = await getCurrency("USD");
  const rate = usd ? parseFloat(usd.Rate) : 12840;
  const diff = usd ? parseFloat(usd.Diff) : 15;

  const msg = `📊 *AI Bozor Tahlili (O'zbekiston & Jahon)*\n${LINE}\n\n` +
              `• *Dollar kursi:* 1 USD = *${formatMoney(rate)}* UZS (${diff >= 0 ? '+' : ''}${diff} so'm)\n` +
              `• *Yillik devalvatsiya sur'ati:* So'm so'nggi 1 yilda dollarga nisbatan o'rtacha ~9-10% atrofida o'zgardi.\n` +
              `• *Oltin narxi:* Xalqaro geosiyosiy vaziyatlar va markaziy banklar zaxiralarni to'ldirishi sababli o'sishda davom etmoqda (+25-30% yillik o'sish).\n\n` +
              `🧠 *AI Xulosasi:*\n` +
              `Bozorda qisqa muddatli tebranishlar kuzatilayotgan bo'lsa-da, uzoq muddatda jamg'armaning bir qismini aktivlarda saqlash tavsiya etiladi.`;

  const markup = Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ AI Menyu", "ai_advisor")],
    [Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
  ]);
  try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
});

bot.action("ai_invest_advice", async (ctx) => {
  await ctx.answerCbQuery().catch(()=>{});
  const msg = `💡 *AI Tavsiyasi: 10 mln so'mni qanday taqsimlash kerak?*\n${LINE}\n\n` +
              `Moliyaviy xavfsizlikning eng oltin qoidasi — barcha tuxumlarni bitta savatga solmaslikdir (Diversifikatsiya):\n\n` +
              `1️⃣ *50% (5 mln so'm) — Milliy valyutadagi omonat:* O'zbekiston banklarida omonat stavkalari hozirda 21-23% gacha. Bu inflyatsiyani to'liq qoplaydi va barqaror passiv daromad beradi.\n\n` +
              `2️⃣ *30% (3 mln so'm) — Oltin / Valyuta:* Xarid quvvati tushib ketmasligi uchun jismoniy yombi oltin yoki naqd dollar zaxirasi.\n\n` +
              `3️⃣ *20% (2 mln so'm) — Likvid xavfsizlik yostig'i:* Har doim tezda ishlatish mumkin bo'lgan erkin mablag'.\n\n` +
              `⚠️ _Eslatma: Ushbu tahlil shaxsiy moliyaviy maslahat emas, tahliliy modellashtirishdir._`;

  const markup = Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ AI Menyu", "ai_advisor")],
    [Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
  ]);
  try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
});

bot.action("ai_gold_vs_usd", async (ctx) => {
  await ctx.answerCbQuery().catch(()=>{});
  const msg = `🪙 *Oltinmi yoki Dollar? (AI Qiyosiy Tahlili)*\n${LINE}\n\n` +
              `⚖️ *Dollar (USD):*\n` +
              `• *Afzalligi:* Juda yuqori likvidlik (istalgan soniyada almashtirish mumkin), xalqaro xaridlar uchun qulay.\n` +
              `• *Kamchiligi:* Yillik 2-3% AQSh inflyatsiyasi tufayli sekinlik bilan xarid qobiliyatini yo'qotadi.\n\n` +
              `🥇 *Oltin (999 proba):*\n` +
              `• *Afzalligi:* 3 000 yillik ishonchli boylik saqlagich. Inflyatsiya va inqirozlardan himoya qiladi.\n` +
              `• *Kamchiligi:* Qisqa muddatda (1-6 oy) sotilsa, bank spredi sababli foyda bermasligi mumkin (3 yildan ortiq muddatga tavsiya etiladi).\n\n` +
              `🎯 *Xulosa:* Qisqa muddatga — Dollar; Uzoq muddatli (2-5 yil) boylikni saqlashga — Oltin afzalroq!`;

  const markup = Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ AI Menyu", "ai_advisor")],
    [Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
  ]);
  try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
});

// ============================================================
// 🪙 OLTIN & KRIPTO
// ============================================================
async function sendGold(ctx) {
  const userId = ctx.from.id;
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});
  
  const uzsRate = await getCurrency("USD").then(c => c ? parseFloat(c.Rate) : 12840);
  const priceUsd = cryptoCache['PAXG-USDT'] || 2500;
  
  let msg = await t(userId, "gold_title") + "\n" + LINE + "\n" +
            `🏆 *1 Troy Unsiya (~31.1 gram):*\n` +
            `🔸 *$${formatMoney(priceUsd)}* USD 🇺🇸\n` +
            `🔸 *${formatMoney(priceUsd * uzsRate)}* UZS 🇺🇿\n\n` +
            `⚖️ *1 Gramm Oltin narxi:*\n` +
            `🔸 *$${formatMoney(priceUsd / 31.1035)}* USD\n` +
            `🔸 *${formatMoney((priceUsd / 31.1035) * uzsRate)}* UZS\n` +
            `${LINE}\n🕐 _${getTimeStr()} (Jonli Xalqaro Bozor)_`;

  const markup = Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Yangilash", "gold")],
    [Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
  ]);

  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("gold", sendGold);
bot.hears(/^(🪙 Oltin Narxi|🪙 Oltin|Oltin|Золото|Gold)$/i, sendGold);

async function sendCrypto(ctx) {
  const userId = ctx.from.id;
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});
  const data = cryptoCache || {};
  
  let msg = `🪙 *Asosiy Kriptovalyutalar (Jonli narxlar)* 💹\n${LINE}\n\n`;
  if (!data['BTC-USDT']) {
    msg += `⏳ Narxlar keshlanmoqda, iltimos birozdan so'ng yangilang...`;
  } else {
    msg += `🟠 *Bitcoin (BTC):*  *$${formatMoney(data['BTC-USDT'])}*\n` +
           `🔷 *Ethereum (ETH):*  *$${formatMoney(data['ETH-USDT'])}*\n` +
           `🟡 *BNB (Binance):*  *$${formatMoney(data['BNB-USDT'])}*\n` +
           `🟣 *Solana (SOL):*  *$${formatMoney(data['SOL-USDT'])}*\n` +
           `💎 *TON (Telegram):*  *$${formatSmallMoney(data['TON-USDT'])}*\n` +
           `🟢 *Tether (USDT):*  *$${formatSmallMoney(data['USDT-USDC'] ? 1.00 : 1.00)}*\n`;
  }
  msg += `\n${LINE}\n🕐 _${getTimeStr()}_`;

  const markup = Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Yangilash", "crypto")],
    [Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
  ]);

  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("crypto", sendCrypto);
bot.hears(/^(🪙 Kripto|Kripto|Крипто|Crypto)$/i, sendCrypto);

// ============================================================
// 📊 GRAFIKLAR
// ============================================================
async function sendChartMenu(ctx) {
  const userId = ctx.from.id;
  const msg = `📊 *Qaysi valyuta grafigini ko'rmoqchisiz?*\n_TradingView jonli shamchali grafiklari:_\n${LINE}`;
  const markup = Markup.inlineKeyboard([
    [Markup.button.url("📈 USD / UZS Grafigi", "https://ru.tradingview.com/symbols/USDUZS/")],
    [Markup.button.url("🟠 BTC / USD Grafigi", "https://ru.tradingview.com/symbols/BTCUSD/")],
    [Markup.button.url("🪙 Oltin (XAU/USD)", "https://ru.tradingview.com/symbols/XAUUSD/")],
    [Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
  ]);
  if(ctx.callbackQuery) {
     await ctx.answerCbQuery().catch(()=>{});
     try { await ctx.editMessageText(msg, {reply_markup: markup.reply_markup, parse_mode: "Markdown"}); } catch(e){}
  } else {
     await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("chart_menu", sendChartMenu);
bot.hears(/^(📊 Grafik|Grafik|График|Chart)$/i, sendChartMenu);

// ============================================================
// 🧮 TEZKOR VA AQLLI KALKULYATOR
// ============================================================
async function sendCalculatorMenu(ctx) {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});
  const msg = `🧮 *Aqlli & Tezkor Kalkulyator*\n${LINE}\n\n` +
              `Tezkor hisoblash uchun pastdagi tugmalardan birini bosing yoki chatga istalgan summani yozib yuboring:\n\n` +
              `_Misol: \`150 usd\`, \`500 000 som\`, \`0.05 btc\`_`;

  const markup = Markup.inlineKeyboard([
    [Markup.button.callback("💵 50 $", "qcalc_50_USD"), Markup.button.callback("💵 100 $", "qcalc_100_USD"), Markup.button.callback("💵 500 $", "qcalc_500_USD")],
    [Markup.button.callback("💵 1 000 $", "qcalc_1000_USD"), Markup.button.callback("💵 5 000 $", "qcalc_5000_USD")],
    [Markup.button.callback("🇺🇿 1 mln so'm", "qcalc_1000000_UZS"), Markup.button.callback("🇺🇿 5 mln so'm", "qcalc_5000000_UZS")],
    [Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
  ]);

  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("calculator", sendCalculatorMenu);
bot.hears(/^(🧮 Kalkulyator|Kalkulyator|Калькулятор|Calculator)$/i, sendCalculatorMenu);

bot.action(/^qcalc_(\d+)_(USD|UZS)$/, async (ctx) => {
  const amount = parseFloat(ctx.match[1]);
  const cur = ctx.match[2];
  await ctx.answerCbQuery().catch(()=>{});

  const usdData = await getCurrency("USD");
  const rate = usdData ? parseFloat(usdData.Rate) : 12840;

  let msg = `🧮 *Tezkor Hisob-Kitob Natijasi:*\n${LINE}\n\n`;
  if (cur === "USD") {
    msg += `💰 *${formatMoney(amount)} USD* = *${formatMoney(amount * rate)}* UZS 🇺🇿\n\n` +
           `_Rasmiy kurs: 1 USD = ${formatMoney(rate)} so'm_`;
  } else {
    msg += `💰 *${formatMoney(amount)} UZS* = *${formatMoney(amount / rate)}* USD 🇺🇸\n\n` +
           `_Rasmiy kurs: 1 USD = ${formatMoney(rate)} so'm_`;
  }

  const markup = Markup.inlineKeyboard([
    [Markup.button.callback("🧮 Boshqa miqdor", "calculator")],
    [Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
  ]);
  try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
});

// Universal matnli kalkulyator
const calcRegex = /^([\d\s\,\.]+)\s*(uzs|som|so'm|sum|usd|eur|rub|btc|eth|ton|bnb|sol|paxg|oltin)$/i;
bot.hears(calcRegex, async (ctx) => {
  const strAmount = ctx.match[1];
  let currency = ctx.match[2].toUpperCase();
  
  let cleaned = strAmount.replace(/\s/g, '');
  if (cleaned.includes(',') && cleaned.includes('.')) {
    const lastDot = cleaned.lastIndexOf('.');
    const lastComma = cleaned.lastIndexOf(',');
    cleaned = lastDot > lastComma ? cleaned.replace(/,/g, '') : cleaned.replace(/\./g, '').replace(/,/g, '.');
  } else if (cleaned.includes(',')) {
    cleaned = cleaned.replace(/,/g, '.');
  }
  const amount = parseFloat(cleaned);
  if (isNaN(amount) || amount <= 0) return;

  const [usdData, eurData, rubData] = await Promise.all([
     getCurrency("USD"), getCurrency("EUR"), getCurrency("RUB")
  ]);
  const cryptoData = cryptoCache || {};
  
  const rates = {
    USD: usdData ? parseFloat(usdData.Rate) : 12840,
    EUR: eurData ? parseFloat(eurData.Rate) : 13800,
    RUB: rubData ? parseFloat(rubData.Rate) : 142,
    BTC: cryptoData['BTC-USDT'] || 65000,
    ETH: cryptoData['ETH-USDT'] || 3500,
    TON: cryptoData['TON-USDT'] || 6.5,
    BNB: cryptoData['BNB-USDT'] || 580,
    SOL: cryptoData['SOL-USDT'] || 150,
    PAXG: cryptoData['PAXG-USDT'] || 2500,
  };

  if (['SO\'M', 'SOM', 'SUM'].includes(currency)) currency = 'UZS';
  if (currency === 'OLTIN') currency = 'PAXG';

  let usdValue = 0;
  if (currency === 'UZS') usdValue = amount / rates.USD;
  else if (['USD', 'EUR', 'RUB'].includes(currency)) usdValue = currency === 'USD' ? amount : (amount * rates[currency] / rates.USD);
  else if (['BTC', 'ETH', 'TON', 'BNB', 'SOL', 'PAXG'].includes(currency)) usdValue = amount * rates[currency];

  let msg = `🧮 *Kalkulyator Natijasi:*\n${LINE}\n\nKiritildi: *${formatMoney(amount)} ${currency}*\n\n`;
  if (currency !== 'UZS') msg += `🇺🇿 UZS: *${formatMoney(usdValue * rates.USD)}* so'm\n`;
  if (currency !== 'USD') msg += `🇺🇸 USD: *$${formatSmallMoney(usdValue)}*\n`;
  if (currency !== 'EUR') msg += `🇪🇺 EUR: *€${formatSmallMoney(usdValue * rates.USD / rates.EUR)}*\n`;
  if (currency !== 'RUB') msg += `🇷🇺 RUB: *₽${formatMoney(usdValue * rates.USD / rates.RUB)}*\n`;
  msg += `\n`;
  if (currency !== 'BTC') msg += `🟠 BTC: *${formatSmallMoney(usdValue / rates.BTC)}*\n`;
  if (currency !== 'ETH') msg += `🔷 ETH: *${formatSmallMoney(usdValue / rates.ETH)}*\n`;
  if (currency !== 'TON') msg += `💎 TON: *${formatSmallMoney(usdValue / rates.TON)}*\n`;

  const markup = Markup.inlineKeyboard([
    [Markup.button.callback("🧮 Kalkulyator menyusi", "calculator")],
    [Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
  ]);
  await ctx.replyWithMarkdown(msg, markup);
});

// ============================================================
// 💼 SHAXSIY HAMYON (PORTFOLIO)
// ============================================================
async function sendWallet(ctx) {
  const userId = ctx.from.id;
  const user = await getUser(userId);
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});

  const pf = user.portfolio || {};
  if (Object.keys(pf).length === 0) {
    const msg = await t(userId, "wallet_empty");
    const markup = Markup.inlineKeyboard([[Markup.button.callback("🏠 Asosiy menyu", "main_menu")]]);
    if (ctx.callbackQuery) {
      try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
    } else {
      await ctx.replyWithMarkdown(msg, markup);
    }
    return;
  }

  const usdData = await getCurrency("USD");
  const rateUsd = usdData ? parseFloat(usdData.Rate) : 12840;
  const cryptoData = cryptoCache || {};

  const prices = {
    usd: 1,
    btc: cryptoData['BTC-USDT'] || 0,
    eth: cryptoData['ETH-USDT'] || 0,
    ton: cryptoData['TON-USDT'] || 0,
    sol: cryptoData['SOL-USDT'] || 0,
    bnb: cryptoData['BNB-USDT'] || 0
  };

  let totalUsd = 0;
  let assetsText = "";
  for (const [coin, amount] of Object.entries(pf)) {
    const price = prices[coin.toLowerCase()] || 0;
    const valUsd = amount * price;
    totalUsd += valUsd;
    assetsText += `🔹 *${amount} ${coin.toUpperCase()}* (~$${formatSmallMoney(valUsd)})\n`;
  }

  const msg = await t(userId, "wallet_total", { assets: assetsText, totalUsd: formatMoney(totalUsd), totalUzs: formatMoney(totalUsd * rateUsd) });
  const markup = Markup.inlineKeyboard([
    [Markup.button.callback(await t(userId, "refresh"), "wallet")],
    [Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
  ]);
  
  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("wallet", sendWallet);
bot.hears(/^(💼 Hamyon|💼|Hamyon|Кошелек|Wallet)$/i, sendWallet);

bot.command("add", async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1);
  if (args.length < 2) return ctx.reply("Misol: `/add 100 usd` yoki `/add 0.5 btc`", {parse_mode:"Markdown"});
  const amount = parseFloat(args[0]);
  const coin = args[1].toLowerCase();
  
  if (isNaN(amount) || amount <= 0) return ctx.reply("❌ Noto'g'ri qiymat kiritildi.");
  
  const user = await getUser(ctx.from.id);
  const pf = user.portfolio || {};
  pf[coin] = (pf[coin] || 0) + amount;
  
  await User.updateOne({ userId: ctx.from.id }, { portfolio: pf });
  ctx.reply(await t(ctx.from.id, "wallet_added", {amount, currency: coin.toUpperCase()}), Markup.inlineKeyboard([[Markup.button.callback("💼 Hamyonni ko'rish", "wallet")]]));
});

// ============================================================
// 📈 STATISTIKA VA ADMIN
// ============================================================
async function sendStats(ctx) {
  const usersCount = await User.countDocuments();
  const alertsCount = await User.countDocuments({ "scheduledAlerts.0": { $exists: true } });
  const msg = `📊 *Bot Statistikasi (V3)*\n${LINE}\n\n` +
              `👥 *Jami foydalanuvchilar:* *${usersCount}* ta\n` +
              `⏰ *Faol eslatmalar:* *${alertsCount}* ta\n` +
              `⚡️ *Tizim holati:* 100% Onlayn (MongoDB & Render)\n` +
              `🕐 *Server vaqti:* ${getTimeStr()}`;

  const markup = Markup.inlineKeyboard([[Markup.button.callback("🏠 Asosiy menyu", "main_menu")]]);
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery().catch(()=>{});
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("stats", sendStats);
bot.hears(/^(📈 Statistika|Statistika|Статистика|Stats)$/i, sendStats);

bot.command("admin", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const msg = "👑 *Admin Panelga Xush Kelibsiz*\n\nAmaliyotni tanlang:";
  const markup = Markup.inlineKeyboard([
    [Markup.button.callback("📊 Statistika", "stats"), Markup.button.callback("✉️ Xabar Tarqatish", "admin_broadcast")]
  ]);
  await ctx.replyWithMarkdown(msg, markup);
});

bot.action("admin_broadcast", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  ctx.scene.enter("broadcast-wizard");
});

bot.action("admin_cancel", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  await ctx.answerCbQuery("Bekor qilindi");
  await ctx.editMessageText("❌ Xabar tarqatish bekor qilindi.");
  ctx.scene.leave();
});

// ============================================================
// ⏰ FONDA ISHLOVCHI CRON XIZMATI (ESLATMALAR)
// ============================================================
cron.schedule("* * * * *", async () => {
  const now = new Date();
  const options = { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false };
  const currentTime = now.toLocaleTimeString('en-GB', options).slice(0, 5);

  try {
    const users = await User.find({ "scheduledAlerts.time": currentTime });
    for (const user of users) {
      const alerts = user.scheduledAlerts.filter(a => a.time === currentTime);
      for (const a of alerts) {
        let msg = "";
        if (['USD', 'EUR', 'RUB'].includes(a.code)) {
          const currency = await getCurrency(a.code);
          if (currency) {
            msg = `⏰ *Kundalik Eslatma!* (${a.time})\n${LINE}\n` +
                  `💰 1 ${a.code} = *${formatMoney(parseFloat(currency.Rate))}* UZS\n` +
                  `📊 O'zgarish: ${currency.Diff > 0 ? '+' : ''}${currency.Diff} so'm\n` +
                  `🗓 Sana: ${currency.Date}`;
          }
        } else if (a.code === 'BARCHASI') {
          const usd = await getCurrency('USD');
          const eur = await getCurrency('EUR');
          const rub = await getCurrency('RUB');
          msg = `⏰ *Kundalik Valyuta Eslatmasi!* (${a.time})\n${LINE}\n\n`;
          if (usd) msg += `🇺🇸 1 USD = *${formatMoney(parseFloat(usd.Rate))}* UZS\n`;
          if (eur) msg += `🇪🇺 1 EUR = *${formatMoney(parseFloat(eur.Rate))}* UZS\n`;
          if (rub) msg += `🇷🇺 1 RUB = *${formatMoney(parseFloat(rub.Rate))}* UZS\n\n`;
          if (cryptoCache['BTC-USDT']) msg += `🟠 1 BTC = *$${formatMoney(cryptoCache['BTC-USDT'])}*\n`;
          if (cryptoCache['PAXG-USDT']) msg += `🪙 1 Gram Oltin = *$${formatMoney(cryptoCache['PAXG-USDT'] / 31.1035)}*\n`;
        } else if (a.code === 'PAXG') {
          const price = cryptoCache['PAXG-USDT'];
          if (price) {
            msg = `⏰ *Oltin Narxi Eslatmasi!* (${a.time})\n${LINE}\n` +
                  `🪙 1 Gram Oltin (999) = *$${formatMoney(price / 31.1035)}*\n` +
                  `🏆 1 Troy Unsiya = *$${formatMoney(price)}*`;
          }
        } else {
          const symbol = `${a.code}-USDT`;
          const price = cryptoCache[symbol];
          if (price) {
            msg = `⏰ *Kripto Eslatma!* (${a.time})\n${LINE}\n` +
                  `💰 1 ${a.code} = *$${formatMoney(price)}*`;
          }
        }
        if (msg) {
          const markup = Markup.inlineKeyboard([[Markup.button.callback("⏰ Eslatmalarni boshqarish", "alerts")]]);
          bot.telegram.sendMessage(user.userId, msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }).catch(()=>{});
        }
      }
    }
  } catch(e) {
    console.error("Cron eslatma xatosi:", e.message);
  }
});

// ============================================================
// 🌐 VEB-SERVER (Render Keep-Alive)
// ============================================================
const app = express();
app.get("/", (req, res) => {
  res.send("ValyutaUZ Bot V3 — 100% Onlayn va Faol!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Keep-Alive server ${PORT}-portda ishga tushdi.`);
  setTimeout(() => {
    bot.launch({ dropPendingUpdates: true })
      .then(() => console.log("✅ ValyutaUZ Bot V3 muvaffaqiyatli ishga tushdi!"))
      .catch((err) => console.error("Bot launch xatosi:", err.message));
  }, 3000);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));