require("dotenv").config();
const { Telegraf, Markup, session, Scenes } = require("telegraf");
const axios = require("axios");
const cron = require("node-cron");
const express = require("express");
const mongoose = require("mongoose");
const fs = require("fs");
const i18n = require("./i18n"); // Ko'p tillilik

// ============================================================
// ✅ MUHIT O'ZGARUVCHILARINI TEKSHIRISH
// ============================================================
if (!process.env.BOT_TOKEN) {
  console.error("❌ BOT_TOKEN topilmadi.");
  process.exit(1);
}
if (!process.env.MONGODB_URI) {
  console.error("❌ MONGODB_URI topilmadi. Baza ulanmaydi!");
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;

const scheduleWizard = new Scenes.WizardScene(
  'schedule-wizard',
  (ctx) => {
    ctx.reply("🔔 Qaysi valyuta bo'yicha eslatma olmoqchisiz?\nMasalan: USD, EUR, BTC, ETH yoki Oltin", Markup.keyboard([['USD', 'EUR', 'RUB'], ['BTC', 'ETH', 'Oltin'], ['Barchasi']]).oneTime().resize());
    return ctx.wizard.next();
  },
  (ctx) => {
    ctx.wizard.state.currency = ctx.message.text.toUpperCase();
    ctx.reply("⏰ Soat nechada eslatma kelsin? (Toshkent vaqti)\nFormat: HH:MM\nMisol: 09:00 yoki 15:30", Markup.removeKeyboard());
    return ctx.wizard.next();
  },
  async (ctx) => {
    const time = ctx.message.text;
    if (!/^\d{2}:\d{2}$/.test(time)) {
      ctx.reply("❌ Vaqt formati noto'g'ri! Iltimos qaytadan urining.");
      return ctx.scene.leave();
    }
    const code = ctx.wizard.state.currency === 'OLTIN' ? 'PAXG' : ctx.wizard.state.currency;
    const user = await getUser(ctx.from.id);
    const scheduledAlerts = user.scheduledAlerts || [];
    
    // Eski shu valyutadagi eslatmani o'chirib yangisini yozamiz
    const filteredAlerts = scheduledAlerts.filter(a => a.code !== code);
    filteredAlerts.push({ code, time });
    await User.updateOne({ userId: ctx.from.id }, { scheduledAlerts: filteredAlerts });
    
    const markup = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Asosiy menyuga qaytish", "main_menu")]]);
    ctx.reply(`✅ Eslatma muvaffaqiyatli saqlandi!\n\nHar kuni soat ${time} da ${code === 'BARCHASI' ? 'barcha valyutalar' : code === 'PAXG' ? 'Oltin' : code} narxi yuboriladi.`, markup);
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
// 💾 MONGODB BAZASI (Mongoose)
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
  .then(() => {
    console.log("✅ MongoDB bazasiga muvaffaqiyatli ulandi!");
    migrateLocalDatabase();
  })
  .catch((err) => console.error("⚠️ MongoDB xatosi:", err));

// MIGRATSIYA: Eski database.json dagi userlarni MongoDB ga ko'chirish
async function migrateLocalDatabase() {
  const dbFile = "./database.json";
  if (fs.existsSync(dbFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(dbFile, "utf8"));
      if (raw.users && typeof raw.users === "object") {
        for (const [idStr, data] of Object.entries(raw.users)) {
          const userId = Number(idStr);
          const exists = await User.findOne({ userId });
          if (!exists) {
            await User.create({
              userId,
              lang: data.lang || "uz",
              subscribed: !!data.subscribed,
              portfolio: data.portfolio || {},
              alerts: data.alerts || []
            });
            console.log(`Migratsiya qilindi: ${userId}`);
          }
        }
      }
      fs.renameSync(dbFile, "./database.old.json");
      console.log("✅ Eski baza migratsiya qilinib arxivlandi.");
    } catch (e) {
      console.error("⚠️ Migratsiya xatosi:", e.message);
    }
  }
}

// Baza bilan ishlash yordamchilari
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
// 🎨 DIZAYN VA YORDAMCHI FUNKSIYALAR
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
    if (data && data.data && data.data.ticker) {
      for (const item of data.data.ticker) {
        prices[item.symbol] = parseFloat(item.last);
      }
    }
    cryptoCache = prices;
  } catch(e) { console.error("Crypto kesh xatosi:", e.message); }
}
cron.schedule("*/2 * * * *", updateCryptoCache);
updateCryptoCache();

// ============================================================
// 🚀 BOT LOGIKASI
// ============================================================
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

bot.action(/lang_(uz|ru|en)/, async (ctx) => {
  const lang = ctx.match[1];
  await User.updateOne({ userId: ctx.from.id }, { lang });
  
  const text = await t(ctx.from.id, "lang_changed");
  await ctx.answerCbQuery(text);
  await sendMainMenu(ctx);
});

async function sendMainMenu(ctx) {
  const userId = ctx.from.id;
  const name = ctx.from.first_name;
    const menu = Markup.inlineKeyboard([
      [Markup.button.callback(await t(userId, "btn_usd"), "rate_USD"), Markup.button.callback(await t(userId, "btn_eur"), "rate_EUR"), Markup.button.callback(await t(userId, "btn_rub"), "rate_RUB")],
      [Markup.button.callback(await t(userId, "btn_gold"), "gold"), Markup.button.callback(await t(userId, "btn_crypto"), "crypto")],
      [Markup.button.callback(await t(userId, "btn_chart"), "chart_menu"), Markup.button.callback(await t(userId, "btn_wallet"), "wallet")],
      [Markup.button.callback(await t(userId, "btn_banks"), "banks"), Markup.button.callback(await t(userId, "btn_alerts"), "alerts")],
      [Markup.button.callback("🧮 Kalkulyator", "calculator")]
    ]);

  const msg = await t(userId, "start", { name });
  
  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: menu.reply_markup }); } 
    catch(e) { await ctx.replyWithMarkdown(msg, menu); }
  } else {
    await ctx.replyWithMarkdown(msg, menu);
  }
}

bot.command("menu", sendMainMenu);
bot.action("main_menu", sendMainMenu);

// ============================================================
// 📊 YANGI FUNKSIYALAR VA HANDLERLAR
// ============================================================
async function sendRate(ctx, code) {
  const userId = ctx.from.id;
  const flag = { USD: "🇺🇸", EUR: "🇪🇺", RUB: "🇷🇺" }[code];
  if (ctx.callbackQuery) await ctx.answerCbQuery(await t(userId, "wait")).catch(()=>{});
  
  const currency = await getCurrency(code);
  if (!currency) return ctx.reply(await t(userId, "error"));

  const rate = parseFloat(currency.Rate);
  const diff = parseFloat(currency.Diff);
  let diffText = await t(userId, "same");
  if (diff > 0) diffText = await t(userId, "up", { amount: formatMoney(diff) });
  else if (diff < 0) diffText = await t(userId, "down", { amount: formatMoney(Math.abs(diff)) });

  const msg = await t(userId, "rate_msg", { flag, code, rate: formatMoney(rate), diffText, time: getTimeStr() });
  const markup = Markup.inlineKeyboard([
    [Markup.button.callback(await t(userId, "refresh"), `rate_${code}`)],
    [Markup.button.callback("⬅️", "main_menu")]
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
      banks.push({ name: match[1].replace(/<[^>]*>?/gm, '').trim(), buy: match[2].replace(/\s/g, ''), sell: match[3].replace(/\s/g, '') });
      if(banks.length >= 10) break;
    }
    if (banks.length > 0) {
      dollaruzCache = banks;
      lastDollaruzFetch = now;
    }
    return dollaruzCache;
  } catch(e) { return dollaruzCache; }
}

async function sendBanks(ctx) {
  const userId = ctx.from.id;
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});
  
  const banks = await fetchDollaruzBanks();
  let msg = "🏦 *O'zbekiston banklari kursi (dollaruz.net)*\n\n";
  if (banks && banks.length > 0) {
     msg += "🇺🇸 *1 AQSh dollari (USD):*\n\n";
     banks.forEach(b => {
        msg += `🏛 *${b.name}:*\nOlish: ${formatMoney(parseFloat(b.buy))} | Sotish: ${formatMoney(parseFloat(b.sell))}\n\n`;
     });
  } else {
     msg += "❌ Xatolik yuz berdi yoki sayt ishlamayapti.";
  }
  
  const markup = Markup.inlineKeyboard([[Markup.button.callback("⬅️", "main_menu")]]);
  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("banks", sendBanks);
bot.hears(/^(🏦 Banklar|🏦|Bank)$/i, sendBanks);

async function sendGold(ctx) {
  const userId = ctx.from.id;
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});
  
  const uzsRate = await getCurrency("USD").then(c => c ? parseFloat(c.Rate) : 12600);
  const priceUsd = cryptoCache['PAXG-USDT'] || 0;
  
  let msg = await t(userId, "gold_title") + "\n";
  if (priceUsd) {
    const gramUsd = priceUsd / 31.1035;
    msg += `${await t(userId, "gold_ounce")} $${formatMoney(priceUsd)} / ${formatMoney(priceUsd * uzsRate)} UZS\n`;
    msg += `${await t(userId, "gold_gram")} $${formatMoney(gramUsd)} / ${formatMoney(gramUsd * uzsRate)} UZS\n`;
  } else {
    msg += await t(userId, "error") + " (Keshlanmoqda, kuting...)";
  }
  const markup = Markup.inlineKeyboard([[Markup.button.callback("⬅️", "main_menu")]]);
  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("gold", sendGold);
bot.hears(/^(🪙 Oltin|🪙 Золото|🪙 Gold|Oltin|Золото)$/i, sendGold);

async function sendCrypto(ctx) {
  const userId = ctx.from.id;
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});
  const data = cryptoCache || {};
  let msg = await t(userId, "crypto_title") + "\n\n";
  
  if (!data['BTC-USDT']) {
      msg += await t(userId, "error") + " (Keshlanmoqda, kuting...)";
  } else {
      msg += `🟠 *Bitcoin (BTC):* $${formatMoney(data['BTC-USDT'])}\n`;
      msg += `🔷 *Ethereum (ETH):* $${formatMoney(data['ETH-USDT'])}\n`;
      msg += `🟡 *Binance (BNB):* $${formatMoney(data['BNB-USDT'])}\n`;
      msg += `🟣 *Solana (SOL):* $${formatMoney(data['SOL-USDT'])}\n`;
      msg += `💎 *TON (TON):* $${formatMoney(data['TON-USDT'])}\n`;
  }
  
  const markup = Markup.inlineKeyboard([[Markup.button.callback("⬅️", "main_menu")]]);
  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("crypto", sendCrypto);
bot.hears(/^(🪙 Kripto|🪙 Крипто|🪙 Crypto|Kripto|Крипто)$/i, sendCrypto);

async function sendChartMenu(ctx) {
  const userId = ctx.from.id;
  const msg = await t(userId, "chart_prompt");
  const markup = Markup.inlineKeyboard([
    [Markup.button.callback("🇺🇸 USD / UZS", "chart_USD"), Markup.button.callback("🟠 BTC / USD", "chart_BTC")],
    [Markup.button.callback("⬅️", "main_menu")]
  ]);
  if(ctx.callbackQuery) {
     await ctx.answerCbQuery().catch(()=>{});
     try { await ctx.editMessageText(msg, {reply_markup: markup.reply_markup, parse_mode: "Markdown"}); } catch(e){}
  } else {
     await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("chart_menu", sendChartMenu);
bot.hears(/^(📊 Grafik|📊 График|📊 Chart|📊|Grafik|График|Chart)$/i, sendChartMenu);

bot.action("chart_USD", async (ctx) => {
  const msg = "📈 *USD/UZS haqiqiy interaktiv grafigini ko'rish uchun quyidagi tugmani bosing:*";
  const markup = Markup.inlineKeyboard([
    [Markup.button.url("📈 TradingView orqali ko'rish", "https://ru.tradingview.com/symbols/USDUZS/")],
    [Markup.button.callback("⬅️ Orqaga", "main_menu")]
  ]);
  if (ctx.callbackQuery) {
      await ctx.editMessageText(msg, {parse_mode: "Markdown", reply_markup: markup.reply_markup}).catch(()=>{});
  } else {
      await ctx.replyWithMarkdown(msg, markup);
  }
});

bot.action("chart_BTC", async (ctx) => {
  const msg = "📈 *BTC/USD haqiqiy interaktiv grafigini ko'rish uchun quyidagi tugmani bosing:*";
  const markup = Markup.inlineKeyboard([
    [Markup.button.url("📈 TradingView orqali ko'rish", "https://ru.tradingview.com/symbols/BTCUSD/")],
    [Markup.button.callback("⬅️ Orqaga", "main_menu")]
  ]);
  if (ctx.callbackQuery) {
      await ctx.editMessageText(msg, {parse_mode: "Markdown", reply_markup: markup.reply_markup}).catch(()=>{});
  } else {
      await ctx.replyWithMarkdown(msg, markup);
  }
});

async function sendStats(ctx) {
  const usersCount = await User.countDocuments();
  const alertsCount = await User.countDocuments({ "scheduledAlerts.0": { $exists: true } });
  const msg = `📊 *Bot Statistikasi:*\n\n👥 *Jami foydalanuvchilar:* ${usersCount} ta\n⏰ *Eslatmalar o'rnatilgan:* ${alertsCount} ta\n⚡️ *Holati:* 100% Onlayn (MongoDB)`;
  const markup = Markup.inlineKeyboard([[Markup.button.callback("⬅️", "main_menu")]]);
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery().catch(()=>{});
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("stats", sendStats);
bot.hears(/^(📈 Statistika|📈 Статистика|📈 Stats|📈|Statistika|Статистика|Stats)$/i, sendStats);
// ============================================================
// 👑 ADMIN PANEL
// ============================================================
bot.command("admin", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const msg = "👑 *Admin Panelga Xush Kelibsiz*\n\nNima amaliyot bajaramiz?";
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
  await ctx.answerCbQuery("Bekor qilindi.");
  await ctx.editMessageText("❌ Xabar tarqatish bekor qilindi.");
  ctx.scene.leave();
});

// ============================================================
// 🧮 KALKULYATOR (Universal Regex)
// ============================================================
bot.action("calculator", async (ctx) => {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});
  const msg = "🧮 *Kalkulyatorga xush kelibsiz!*\n\nIstalgan summani va valyutani yozib yuboring.\nMisol uchun:\n`100 USD`\n`50000 UZS`\n`0.5 BTC`\n\nMen uni barcha asosiy valyutalarga o'girib beraman!";
  const markup = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Orqaga", "main_menu")]]);
  if (ctx.callbackQuery) {
      await ctx.editMessageText(msg, {parse_mode: "Markdown", reply_markup: markup.reply_markup}).catch(()=>{});
  } else {
      await ctx.replyWithMarkdown(msg, markup);
  }
});

const calcRegex = /^([\d\s\,\.]+)\s*(uzs|som|so'm|sum|usd|eur|rub|btc|eth|ton|bnb|sol|paxg|oltin)$/i;
bot.hears(calcRegex, async (ctx) => {
  const strAmount = ctx.match[1];
  let currency = ctx.match[2].toUpperCase();
  
  let cleaned = strAmount.replace(/\s/g, '');
  if (cleaned.includes(',') && cleaned.includes('.')) {
      const lastComma = cleaned.lastIndexOf(',');
      const lastDot = cleaned.lastIndexOf('.');
      if (lastDot > lastComma) {
          cleaned = cleaned.replace(/,/g, '');
      } else {
          cleaned = cleaned.replace(/\./g, '').replace(/,/g, '.');
      }
  } else if (cleaned.includes(',') || cleaned.includes('.')) {
      const sep = cleaned.includes(',') ? ',' : '.';
      const parts = cleaned.split(sep);
      if (parts[parts.length - 1].length === 3) {
          cleaned = cleaned.replace(new RegExp('\\' + sep, 'g'), '');
      } else {
          cleaned = cleaned.replace(new RegExp('\\' + sep, 'g'), '.');
          const p = cleaned.split('.');
          if (p.length > 2) cleaned = p.slice(0, -1).join('') + '.' + p[p.length - 1];
      }
  }
  const amount = parseFloat(cleaned);
  if (isNaN(amount) || amount <= 0) return;

  const [usdData, eurData, rubData] = await Promise.all([
     getCurrency("USD"), getCurrency("EUR"), getCurrency("RUB")
  ]);
  const cryptoData = cryptoCache || {};
  
  const rates = {
    USD: usdData ? parseFloat(usdData.Rate) : 12600,
    EUR: eurData ? parseFloat(eurData.Rate) : 13600,
    RUB: rubData ? parseFloat(rubData.Rate) : 140,
    BTC: cryptoData['BTC-USDT'] || 64000,
    ETH: cryptoData['ETH-USDT'] || 3500,
    TON: cryptoData['TON-USDT'] || 7.5,
    BNB: cryptoData['BNB-USDT'] || 600,
    SOL: cryptoData['SOL-USDT'] || 140,
    PAXG: cryptoData['PAXG-USDT'] || 2300,
  };

  if (['SO\'M', 'SOM', 'SUM'].includes(currency)) currency = 'UZS';
  if (currency === 'OLTIN') currency = 'PAXG';

  let usdValue = 0;
  if (currency === 'UZS') {
      usdValue = amount / rates.USD;
  } else if (['USD', 'EUR', 'RUB'].includes(currency)) {
      usdValue = currency === 'USD' ? amount : (amount * rates[currency] / rates.USD);
  } else if (['BTC', 'ETH', 'TON', 'BNB', 'SOL', 'PAXG'].includes(currency)) {
      usdValue = amount * rates[currency];
  }

  let msg = `🧮 *Kalkulyator Natijasi:*\n\nKiritildi: *${formatMoney(amount)} ${currency}*\n\n`;
  if (currency !== 'UZS') msg += `🇺🇿 UZS: *${formatMoney(usdValue * rates.USD)}* so'm\n`;
  if (currency !== 'USD') msg += `🇺🇸 USD: *$${formatSmallMoney(usdValue)}*\n`;
  if (currency !== 'EUR') msg += `🇪🇺 EUR: *€${formatSmallMoney(usdValue * rates.USD / rates.EUR)}*\n`;
  if (currency !== 'RUB') msg += `🇷🇺 RUB: *₽${formatMoney(usdValue * rates.USD / rates.RUB)}*\n`;
  msg += `\n`;
  if (currency !== 'BTC') msg += `🟠 BTC: *${formatSmallMoney(usdValue / rates.BTC)}*\n`;
  if (currency !== 'ETH') msg += `🔷 ETH: *${formatSmallMoney(usdValue / rates.ETH)}*\n`;
  if (currency !== 'TON') msg += `💎 TON: *${formatSmallMoney(usdValue / rates.TON)}*\n`;

  const markup = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Asosiy menyuga qaytish", "main_menu")]]);
  await ctx.replyWithMarkdown(msg, markup);
});

// ============================================================
// 💼 HAMYON & SIGNALLAR (DB bilan ishlaydi)
// ============================================================
async function sendWallet(ctx) {
  const userId = ctx.from.id;
  const user = await getUser(userId);
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});

  const pf = user.portfolio || {};
  if (Object.keys(pf).length === 0) {
    const msg = await t(userId, "wallet_empty");
    const markup = Markup.inlineKeyboard([[Markup.button.callback("⬅️", "main_menu")]]);
    if (ctx.callbackQuery) {
      try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
    } else {
      await ctx.replyWithMarkdown(msg, markup);
    }
    return;
  }

  const [usdData] = await Promise.all([
    getCurrency("USD")
  ]);
  const cryptoData = cryptoCache || {};

  const rateUsd = usdData ? parseFloat(usdData.Rate) : 12600;
  const prices = { usd: 1, btc: cryptoData['BTC-USDT'] || 0, eth: cryptoData['ETH-USDT'] || 0, ton: cryptoData['TON-USDT'] || 0 };

  let totalUsd = 0;
  let assetsText = "";
  for (const [coin, amount] of Object.entries(pf)) {
    const price = prices[coin.toLowerCase()] || 0;
    const valUsd = amount * price;
    totalUsd += valUsd;
    assetsText += `🔹 *${amount} ${coin.toUpperCase()}* (~$${formatSmallMoney(valUsd)})\n`;
  }

  const msg = await t(userId, "wallet_total", { assets: assetsText, totalUsd: formatMoney(totalUsd), totalUzs: formatMoney(totalUsd * rateUsd) });
  const markup = Markup.inlineKeyboard([[Markup.button.callback(await t(userId, "refresh"), "wallet")], [Markup.button.callback("⬅️", "main_menu")]]);
  
  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("wallet", sendWallet);
bot.hears(/^(💼 Hamyon|💼 Кошелек|💼 Wallet|💼|Hamyon|Кошелек|Wallet)$/i, sendWallet);
bot.action("alerts", (ctx) => ctx.scene.enter('schedule-wizard'));
bot.hears(/^(⏰ Eslatma|⏰ Напоминание|⏰ Reminder|⏰|Eslatma|Напоминание|Reminder)$/i, (ctx) => ctx.scene.enter('schedule-wizard'));

bot.command("add", async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1);
  if (args.length < 2) return ctx.reply("Misol: `/add 100 usd` yoki `/add 0.5 btc`", {parse_mode:"Markdown"});
  const amount = parseFloat(args[0]);
  const coin = args[1].toLowerCase();
  
  if (isNaN(amount) || amount <= 0) return ctx.reply("Notog'ri qiymat");
  
  const user = await getUser(ctx.from.id);
  const pf = user.portfolio || {};
  pf[coin] = (pf[coin] || 0) + amount;
  
  await User.updateOne({ userId: ctx.from.id }, { portfolio: pf });
  ctx.reply(await t(ctx.from.id, "wallet_added", {amount, currency: coin.toUpperCase()}));
});

cron.schedule("* * * * *", async () => {
    const now = new Date();
    const options = { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false };
    const currentTime = now.toLocaleTimeString('en-GB', options).slice(0,5); 

    const users = await User.find({ "scheduledAlerts.time": currentTime });
    for (const user of users) {
        const alerts = user.scheduledAlerts.filter(a => a.time === currentTime);
        for(const a of alerts) {
           let msg = "";
           if (['USD', 'EUR', 'RUB'].includes(a.code)) {
               const currency = await getCurrency(a.code);
               if(currency) msg = `⏰ *Eslatma!* (${a.time})\n\n💰 1 ${a.code} = *${currency.Rate}* UZS\n📊 O'zgarish: ${currency.Diff > 0 ? '+' : ''}${currency.Diff}`;
           } else if (a.code === 'BARCHASI') {
               const usd = await getCurrency('USD');
               const eur = await getCurrency('EUR');
               const rub = await getCurrency('RUB');
               msg = `⏰ *Barcha Valyutalar Eslatmasi!* (${a.time})\n\n`;
               if(usd) msg += `🇺🇸 1 USD = *${usd.Rate}* UZS\n`;
               if(eur) msg += `🇪🇺 1 EUR = *${eur.Rate}* UZS\n`;
               if(rub) msg += `🇷🇺 1 RUB = *${rub.Rate}* UZS\n\n`;
               if(cryptoCache && cryptoCache['BTC-USDT']) msg += `🟠 1 BTC = *$${formatMoney(cryptoCache['BTC-USDT'])}*\n`;
               if(cryptoCache && cryptoCache['ETH-USDT']) msg += `🔷 1 ETH = *$${formatMoney(cryptoCache['ETH-USDT'])}*\n`;
               if(cryptoCache && cryptoCache['PAXG-USDT']) msg += `🪙 1 Gram Oltin (999 proba) = *$${formatMoney(cryptoCache['PAXG-USDT'] / 31.1035)}*\n`;
           } else {
               const price = (a.code === 'BTC' ? cryptoCache['BTC-USDT'] : null) || (a.code === 'ETH' ? cryptoCache['ETH-USDT'] : null) || (a.code === 'PAXG' ? cryptoCache['PAXG-USDT'] : null);
               if(price) {
                  if (a.code === 'PAXG') {
                     msg = `⏰ *Eslatma!* (${a.time})\n\n🪙 1 Gram Oltin (999 proba) = *$${formatMoney(price / 31.1035)}*\n⚖️ 1 Unsiya (Troy) = *$${formatMoney(price)}*`;
                  } else {
                     msg = `⏰ *Eslatma!* (${a.time})\n\n💰 1 ${a.code} = *$${formatMoney(price)}*`;
                  }
               }
           }
           if (msg) bot.telegram.sendMessage(user.userId, msg, {parse_mode: "Markdown"}).catch(()=>{});
        }
    }
});

// ============================================================
// 🌐 VEB-SERVER (Bot uxlamasligi uchun Keep-Alive)
// ============================================================
const app = express();
app.get("/", (req, res) => {
  res.send("Bot ishlamoqda. Real-Time ValyutaUZ v2. (Uyg'otuvchi server faol)");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Keep-Alive server ${PORT}-portda ishga tushdi.`);
});

// ============================================================
// 🚀 BOTNI ISHGA TUSHURISH
// ============================================================
bot.launch().then(() => {
  console.log("✅ ValyutaUZ Bot (MongoDB) ishga tushdi!");
});
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));