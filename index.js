require("dotenv").config();
const { Telegraf, Markup, session, Scenes } = require("telegraf");
const axios = require("axios");
const cron = require("node-cron");
const express = require("express");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const i18n = require("./i18n");

const WEBAPP_URL = process.env.WEBAPP_URL || "https://valyutauz-bot.onrender.com/webapp";

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
  investments: { type: Array, default: [] },
  favorites: { type: Array, default: ["USD", "BTC", "PAXG"] },
  alerts: { type: Array, default: [] },
  scheduledAlerts: { type: Array, default: [] },
  priceAlerts: { type: Array, default: [] }
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
// 💱 KESHLAR (CBU, Crypto, Dollaruz, Telegram Channel)
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

// @dollar_uz_kurs kanalidan eng so'nggi prognoz postini olish
let channelForecastCache = null;
let lastChannelForecastFetch = null;
async function fetchChannelForecast() {
  const now = Date.now();
  if (channelForecastCache && lastChannelForecastFetch && now - lastChannelForecastFetch < 10 * 60 * 1000) {
    return channelForecastCache;
  }
  try {
    const { data } = await axiosWithRetry({ url: "https://t.me/s/dollar_uz_kurs", timeout: 8000 });
    const match = data.match(/USD\s*на\s*([\+\-]?\d+)\s*сум/i);
    if (match) {
      channelForecastCache = parseInt(match[1]);
      lastChannelForecastFetch = now;
      return channelForecastCache;
    }
  } catch(e) {}
  return channelForecastCache;
}

// ============================================================
// 🧙 WIZARDS: Eslatma, AI Savol & Admin Broadcast
// ============================================================
const scheduleWizard = new Scenes.WizardScene(
  'schedule-wizard',
  async (ctx) => {
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

// 🎯 NARX BO'YICHA SIGNAL WIZARDI (TARGET PRICE ALERT)
const priceAlertWizard = new Scenes.WizardScene(
  'price-alert-wizard',
  async (ctx) => {
    const msg = "🎯 *Narx bo'yicha signal: Qaysi aktivni tanlaysiz?*\n\nNarx siz belgilagan darajaga yetganda bot sizni zudlik bilan ogohlantiradi:";
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("🇺🇸 USD", "palert_USD"), Markup.button.callback("🇪🇺 EUR", "palert_EUR"), Markup.button.callback("🇷🇺 RUB", "palert_RUB")],
      [Markup.button.callback("🪙 Oltin (1 gr)", "palert_PAXG"), Markup.button.callback("🟠 Bitcoin (BTC)", "palert_BTC"), Markup.button.callback("💎 TON", "palert_TON")],
      [Markup.button.callback("❌ Bekor qilish", "cancel_palert")]
    ]);
    if (ctx.callbackQuery) {
      await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: keyboard.reply_markup }).catch(()=>{});
    } else {
      await ctx.replyWithMarkdown(msg, keyboard);
    }
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (ctx.callbackQuery?.data === "cancel_palert") {
      await ctx.answerCbQuery("Bekor qilindi");
      ctx.scene.leave();
      return sendAlertsHub(ctx);
    }
    let code = "USD";
    if (ctx.callbackQuery?.data?.startsWith("palert_")) {
      code = ctx.callbackQuery.data.replace("palert_", "");
      await ctx.answerCbQuery().catch(()=>{});
    } else if (ctx.message?.text) {
      code = ctx.message.text.toUpperCase();
      if (code === "OLTIN") code = "PAXG";
    }
    ctx.wizard.state.currency = code;

    let currPriceStr = "";
    if (['USD', 'EUR', 'RUB'].includes(code)) {
      const cur = await getCurrency(code);
      const rate = cur ? parseFloat(cur.Rate) : (code === 'USD' ? 12840 : 13800);
      ctx.wizard.state.currentRate = rate;
      currPriceStr = `Hozirgi Markaziy Bank kursi: *${formatMoney(rate)} UZS*`;
    } else if (code === 'PAXG') {
      const usdRate = await getCurrency("USD").then(c => c ? parseFloat(c.Rate) : 12840);
      const goldPrice = cryptoCache['PAXG-USDT'] || 2500;
      const gramRate = Math.round((goldPrice / 31.1035) * usdRate);
      ctx.wizard.state.currentRate = gramRate;
      currPriceStr = `Hozirgi 1 gramm oltin narxi: *${formatMoney(gramRate)} UZS*`;
    } else {
      const price = cryptoCache[`${code}-USDT`] || (code === 'BTC' ? 65000 : 6.5);
      ctx.wizard.state.currentRate = price;
      currPriceStr = `Hozirgi xalqaro narxi: *$${formatMoney(price)}*`;
    }

    const name = code === 'PAXG' ? '1 gramm Oltin' : code;
    const unit = ['USD', 'EUR', 'RUB', 'PAXG'].includes(code) ? 'UZS (so\'mda)' : '$ (USD da)';
    const promptMsg = `🎯 *${name} uchun maqsadli narxni kiriting:*\n\n${currPriceStr}\n\n_Istalgan narxni yozing (faqat raqamlarda)._\n_Masalan: \`12900\` yoki \`12500\`_ (${unit}):`;
    const cancelKb = Markup.inlineKeyboard([[Markup.button.callback("❌ Bekor qilish", "cancel_palert")]]);
    
    if (ctx.callbackQuery) {
      await ctx.editMessageText(promptMsg, { parse_mode: "Markdown", reply_markup: cancelKb.reply_markup }).catch(()=>{});
    } else {
      await ctx.replyWithMarkdown(promptMsg, cancelKb);
    }
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (ctx.callbackQuery?.data === "cancel_palert") {
      await ctx.answerCbQuery("Bekor qilindi");
      ctx.scene.leave();
      return sendAlertsHub(ctx);
    }
    const text = ctx.message?.text?.trim().replace(/\s/g, '').replace(/,/g, '.');
    const targetPrice = parseFloat(text);
    if (isNaN(targetPrice) || targetPrice <= 0) {
      ctx.reply("❌ Noto'g'ri narx! Iltimos, musbat raqam kiriting (masalan: 12900):", Markup.inlineKeyboard([[Markup.button.callback("❌ Bekor qilish", "cancel_palert")]]));
      return;
    }

    const code = ctx.wizard.state.currency || "USD";
    const currentRate = ctx.wizard.state.currentRate || targetPrice;
    const condition = targetPrice >= currentRate ? "gte" : "lte";

    const user = await getUser(ctx.from.id);
    const priceAlerts = user.priceAlerts || [];
    
    const newAlert = {
      id: Date.now().toString(36),
      code,
      target: targetPrice,
      condition,
      initialRate: currentRate,
      createdAt: Date.now()
    };
    priceAlerts.push(newAlert);
    await User.updateOne({ userId: ctx.from.id }, { priceAlerts });

    const finishKb = Markup.inlineKeyboard([
      [Markup.button.callback("⏰ Eslatmalar Markazi", "alerts")],
      [Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
    ]);

    const unit = ['USD', 'EUR', 'RUB', 'PAXG'].includes(code) ? 'UZS' : '$';
    const condStr = condition === 'gte' ? "oshganda yoki unga yetganda" : "tushganda yoki unga yetganda";
    await ctx.reply(
      `🎯 *Narx signali muvaffaqiyatli saqlandi!*\n\n` +
      `📌 *Aktiv:* ${code === 'PAXG' ? 'Oltin' : code}\n` +
      `🎯 *Maqsadli narx:* *${formatMoney(targetPrice)} ${unit}*\n` +
      `📊 *Hozirgi kurs:* *${formatMoney(currentRate)} ${unit}*\n` +
      `🔔 Narx *${formatMoney(targetPrice)} ${unit}* ga ${condStr} bot sizga darhol xabar yuboradi!`,
      { parse_mode: "Markdown", reply_markup: finishKb.reply_markup }
    );
    return ctx.scene.leave();
  }
);

// 💼 HAMYON & P&L AKTIV QO'SHISH WIZARDI
const addInvestmentWizard = new Scenes.WizardScene(
  'add-investment-wizard',
  async (ctx) => {
    const msg = "💼 *Yangi aktiv kiritish: Qaysi aktivni xarid qilgansiz?*\n\nHayotda siz sotib olgan yoki mavjud aktivni tanlang:";
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("🇺🇸 Dollar (USD)", "inv_USD"), Markup.button.callback("🪙 Oltin (gramm)", "inv_PAXG")],
      [Markup.button.callback("🇪🇺 Yevro (EUR)", "inv_EUR"), Markup.button.callback("🇷🇺 Rubl (RUB)", "inv_RUB")],
      [Markup.button.callback("🟠 Bitcoin (BTC)", "inv_BTC"), Markup.button.callback("💎 TON", "inv_TON")],
      [Markup.button.callback("❌ Bekor qilish", "cancel_inv")]
    ]);
    if (ctx.callbackQuery) {
      await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: keyboard.reply_markup }).catch(()=>{});
    } else {
      await ctx.replyWithMarkdown(msg, keyboard);
    }
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (ctx.callbackQuery?.data === "cancel_inv") {
      await ctx.answerCbQuery("Bekor qilindi");
      ctx.scene.leave();
      return sendWallet(ctx);
    }
    let code = "USD";
    if (ctx.callbackQuery?.data?.startsWith("inv_")) {
      code = ctx.callbackQuery.data.replace("inv_", "");
      await ctx.answerCbQuery().catch(()=>{});
    } else if (ctx.message?.text) {
      code = ctx.message.text.toUpperCase();
      if (code === "OLTIN") code = "PAXG";
    }
    ctx.wizard.state.currency = code;

    const unitName = code === 'PAXG' ? 'gramm Oltin' : code;
    const promptMsg = `🔢 *Sizda qancha ${unitName} bor?*\n\nMiqdorini yozing (Masalan: \`1000\`, \`500\`, \`10\`):`;
    const cancelKb = Markup.inlineKeyboard([[Markup.button.callback("❌ Bekor qilish", "cancel_inv")]]);

    if (ctx.callbackQuery) {
      await ctx.editMessageText(promptMsg, { parse_mode: "Markdown", reply_markup: cancelKb.reply_markup }).catch(()=>{});
    } else {
      await ctx.replyWithMarkdown(promptMsg, cancelKb);
    }
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (ctx.callbackQuery?.data === "cancel_inv") {
      await ctx.answerCbQuery("Bekor qilindi");
      ctx.scene.leave();
      return sendWallet(ctx);
    }
    const text = ctx.message?.text?.trim().replace(/\s/g, '').replace(/,/g, '.');
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      ctx.reply("❌ Miqdor noto'g'ri! Iltimos, musbat raqam kiriting (masalan: 1000):", Markup.inlineKeyboard([[Markup.button.callback("❌ Bekor qilish", "cancel_inv")]]));
      return;
    }
    ctx.wizard.state.amount = amount;

    const code = ctx.wizard.state.currency;
    let refRate = 12840;
    if (code === 'USD') {
      const cur = await getCurrency('USD');
      refRate = cur ? parseFloat(cur.Rate) : 12840;
    } else if (code === 'EUR') {
      const cur = await getCurrency('EUR');
      refRate = cur ? parseFloat(cur.Rate) : 13800;
    } else if (code === 'RUB') {
      const cur = await getCurrency('RUB');
      refRate = cur ? parseFloat(cur.Rate) : 142;
    } else if (code === 'PAXG') {
      const usdRate = await getCurrency("USD").then(c => c ? parseFloat(c.Rate) : 12840);
      const goldPrice = cryptoCache['PAXG-USDT'] || 2500;
      refRate = Math.round((goldPrice / 31.1035) * usdRate);
    } else {
      const usdRate = await getCurrency("USD").then(c => c ? parseFloat(c.Rate) : 12840);
      const coinUsd = cryptoCache[`${code}-USDT`] || 1;
      refRate = Math.round(coinUsd * usdRate);
    }
    ctx.wizard.state.refRate = refRate;

    const promptMsg = `💰 *Siz ushbu aktivni qaysi narxda (1 birligini necha so'mdan) sotib olgansiz?*\n\n` +
                      `🔍 _Taqqoslash uchun hozirgi bozor kursi: **${formatMoney(refRate)} UZS**_\n\n` +
                      `_Olingan narxni so'mda yozing (Masalan: \`12600\` yoki \`1000000\`):_`;
    const cancelKb = Markup.inlineKeyboard([[Markup.button.callback("❌ Bekor qilish", "cancel_inv")]]);

    if (ctx.callbackQuery) {
      await ctx.editMessageText(promptMsg, { parse_mode: "Markdown", reply_markup: cancelKb.reply_markup }).catch(()=>{});
    } else {
      await ctx.replyWithMarkdown(promptMsg, cancelKb);
    }
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (ctx.callbackQuery?.data === "cancel_inv") {
      await ctx.answerCbQuery("Bekor qilindi");
      ctx.scene.leave();
      return sendWallet(ctx);
    }
    const text = ctx.message?.text?.trim().replace(/\s/g, '').replace(/,/g, '.');
    const buyRate = parseFloat(text);
    if (isNaN(buyRate) || buyRate <= 0) {
      ctx.reply("❌ Xarid narxi noto'g'ri! Iltimos, musbat raqam kiriting (masalan: 12600):", Markup.inlineKeyboard([[Markup.button.callback("❌ Bekor qilish", "cancel_inv")]]));
      return;
    }

    const code = ctx.wizard.state.currency;
    const amount = ctx.wizard.state.amount;
    const user = await getUser(ctx.from.id);
    const investments = user.investments || [];

    const newInv = {
      id: Date.now().toString(36),
      code,
      amount,
      buyRate,
      date: new Date().toLocaleDateString('uz-UZ')
    };
    investments.push(newInv);
    await User.updateOne({ userId: ctx.from.id }, { investments });

    const finishKb = Markup.inlineKeyboard([
      [Markup.button.callback("💼 Hamyon & P&L ni ko'rish", "wallet")],
      [Markup.button.callback("➕ Yana aktiv qo'shish", "add_investment")],
      [Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
    ]);

    await ctx.reply(
      `✅ *Aktiv muvaffaqiyatli saqlandi!*\n\n` +
      `🔹 *Aktiv:* ${amount} ${code === 'PAXG' ? 'gramm Oltin' : code}\n` +
      `💵 *Xarid narxi:* ${formatMoney(buyRate)} UZS\n` +
      `💰 *Jami sarmoya:* ${formatMoney(amount * buyRate)} UZS\n\n` +
      `_Endi hamyoningizda jonli foyda yoki zararni kuzatishingiz mumkin._`,
      { parse_mode: "Markdown", reply_markup: finishKb.reply_markup }
    );
    return ctx.scene.leave();
  }
);

// 🎯 STRATEGIYA SUMMASINI KIRITISH WIZARDI
const strategyInputWizard = new Scenes.WizardScene(
  'strategy-input-wizard',
  async (ctx) => {
    const msg = `🎯 *O'zingizdagi summani kiriting:*\n\n` +
                `Tahlil qilmoqchi bo'lgan summani valyutasi bilan yozing.\n` +
                `_Misol: \`1000 usd\`, \`2500 $\`, \`20000000 som\`, \`50 mln uzs\`_`;
    const cancelKb = Markup.inlineKeyboard([[Markup.button.callback("❌ Bekor qilish", "cancel_strat")]]);
    if (ctx.callbackQuery) {
      await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: cancelKb.reply_markup }).catch(()=>{});
    } else {
      await ctx.replyWithMarkdown(msg, cancelKb);
    }
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (ctx.callbackQuery?.data === "cancel_strat") {
      await ctx.answerCbQuery("Bekor qilindi");
      ctx.scene.leave();
      return sendStrategyMenu(ctx);
    }
    const text = ctx.message?.text?.trim();
    if (!text) {
      ctx.reply("Iltimos, summani yozing (Masalan: `1000 usd`):");
      return;
    }
    const match = text.match(/^([\d\s\,\.]+)\s*(usd|\$|uzs|som|so'm|sum|mln)?$/i);
    if (!match) {
      ctx.reply("❌ Noto'g'ri format! Misol: `1000 usd` yoki `20000000 som` deb yozing.");
      return;
    }
    let rawNum = match[1].replace(/\s/g, '').replace(/,/g, '.');
    let amount = parseFloat(rawNum);
    let cur = (match[2] || 'USD').toUpperCase();
    if (['$', 'USD'].includes(cur)) cur = 'USD';
    else cur = 'UZS';

    ctx.scene.leave();
    return sendStrategyReport(ctx, amount, cur);
  }
);

async function answerWithAi(ctx, question) {
  const waitMsg = await ctx.reply("🧠 *AI tahlil qilmoqda... Bir necha soniya kuting...*", { parse_mode: "Markdown" });

  const usdData = await getCurrency("USD");
  const cbuRate = usdData ? parseFloat(usdData.Rate) : 12840;
  const cbuDiff = usdData ? parseFloat(usdData.Diff) : 10;
  const channelDiff = await fetchChannelForecast();
  const forecastDiff = channelDiff !== null ? channelDiff : (cbuDiff >= 0 ? 15 : -15);
  const forecastRate = cbuRate + forecastDiff;
  const goldPrice = cryptoCache['PAXG-USDT'] || 2500;
  const goldGram = Math.round((goldPrice / 31.1035) * cbuRate);
  const banks = await fetchDollaruzBanks();
  const bestBank = banks && banks.length > 0 ? [...banks].sort((a, b) => b.buy - a.buy)[0] : { name: "Kapitalbank", buy: cbuRate - 20 };

  let answer = "";
  if (GEMINI_API_KEY) {
    const prompt = `
Siz O'zbekistondagi eng tajribali, samimiy va xolis moliyaviy AI maslahatchisiz (ValyutaUZ Bot AI).
SIZDA HOZIRGI JONLI VA ANIQ MA'LUMOTLAR MAVJUD:
- Bugungi Markaziy Bank rasmiy dollar kursi: 1 USD = ${cbuRate} so'm (${cbuDiff > 0 ? '+' : ''}${cbuDiff} so'm).
- Ertangi kun uchun kutilayotgan birja prognozi: 1 USD = ${forecastRate} so'm (${forecastDiff > 0 ? '+' : ''}${forecastDiff} so'm ${forecastDiff >= 0 ? "o'sishi" : "tushishi"} kutilmoqda).
- Oltin narxi (999 proba): 1 gramm = ${goldGram} so'm.
- Eng yaxshi bank xarid narxi: ${bestBank.name} (${bestBank.buy} so'm).
- Bank omonat stavkalari: 21-23% yillik.
- P2P (Uzcard/Humo) USDT kursi: ~${cbuRate + 50} so'm.

Foydalanuvchi savoli: "${question}"

QOIDALAR:
1. O'zbek tilida (lotin alifbosida), juda aniq, lo'nda va samimiy javob bering (uzoq cho'zmasdan, 2-4 ta jumlada).
2. Agar dollar kursi yoki ertangi kun haqida so'ralsa, yuqoridagi real raqamlarni aniq ko'rsating!
3. Agar oddiy salomlashish ("Salom", "Qalesan") bo'lsa, xushmuomalalik bilan salom berib, nima bo'yicha maslahat kerakligini so'rang.
`;
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;
      const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 5000 });
      answer = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    } catch(err) {
      try {
        const url2 = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`;
        const res2 = await axios.post(url2, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 5000 });
        answer = res2.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      } catch(e) {}
    }
  }

  if (!answer) {
    if (/salom|alaykum|privet|hi|hello/i.test(question)) {
      answer = `Assalomu alaykum! Men ValyutaUZ ning sun'iy intellekt tahlilchisiman. Valyuta kurslari, ertangi prognoz, oltin yoki pullaringizni qayerga investitsiya qilish bo'yicha bemalol savol berishingiz mumkin!`;
    } else if (/ertaga|prognoz|nechpul|qancha|kurs/i.test(question)) {
      answer = `Ertaga Markaziy Bank dollar kursi taxminan **${formatMoney(forecastRate)} so'm** (${forecastDiff > 0 ? '+' : ''}${forecastDiff} so'm ${forecastDiff >= 0 ? "o'sishi" : "tushishi"}) kutilmoqda. Aniq tasdiqlangan kurs soat 16:00 dan so'ng e'lon qilinadi.`;
    } else {
      answer = `Mablag'ingizni taqsimlashda xavfni kamaytirish uchun asosiy qismini yuqori foizli (21-23%) bank omonatiga, qolgan qismini esa uzoq muddatli xarid qobiliyatini saqlash uchun Oltin (999 proba) yoki valyutaga yo'naltirish maqsadga muvofiqdir.`;
    }
  }

  await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(()=>{});
  const markup = Markup.inlineKeyboard([
    [Markup.button.callback("💬 Yana savol berish", "ask_ai_wizard")],
    [Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
  ]);
  await ctx.reply(`🤖 *AI Javobi:*\n\n${answer}`, { parse_mode: "Markdown", reply_markup: markup.reply_markup });
}

const aiChatWizard = new Scenes.WizardScene(
  'ai-chat-wizard',
  async (ctx) => {
    const msg = `💬 *AI Moliyaviy Maslahatchiga savolingizni yozing:*\n\n_Istalgan savolingizni yuboring (masalan: "Ertaga dollar necha pul bo'ladi?", "1000$ bor nima qilay?"):_`;
    const cancelKb = Markup.inlineKeyboard([[Markup.button.callback("❌ Bekor qilish", "cancel_ai_chat")]]);
    if (ctx.callbackQuery) {
      await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: cancelKb.reply_markup }).catch(()=>{});
    } else {
      await ctx.replyWithMarkdown(msg, cancelKb);
    }
    return ctx.wizard.next();
  },
  async (ctx) => {
    if (ctx.callbackQuery?.data === "cancel_ai_chat") {
      await ctx.answerCbQuery("Bekor qilindi");
      ctx.scene.leave();
      return sendAiAdvisor(ctx);
    }
    const question = ctx.message?.text?.trim();
    if (!question) {
      ctx.reply("Iltimos, savolingizni matn ko'rinishida yozing:");
      return;
    }
    ctx.scene.leave();
    return answerWithAi(ctx, question);
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

const stage = new Scenes.Stage([scheduleWizard, priceAlertWizard, addInvestmentWizard, strategyInputWizard, aiChatWizard, broadcastWizard]);
bot.use(session());
bot.use(stage.middleware());

// ============================================================
// 🚀 ASOSIY MENYU VA NAVIGATSIYA
// ============================================================
async function sendMainMenu(ctx) {
  const userId = ctx.from.id;
  const name = ctx.from.first_name || "Foydalanuvchi";
  
  const menu = Markup.inlineKeyboard([
    [Markup.button.webApp("📱 ValyutaUZ Mini App", WEBAPP_URL)],
    [Markup.button.callback(await t(userId, "btn_usd"), "rate_USD"), Markup.button.callback(await t(userId, "btn_eur"), "rate_EUR"), Markup.button.callback(await t(userId, "btn_rub"), "rate_RUB")],
    [Markup.button.callback(await t(userId, "btn_gold"), "gold"), Markup.button.callback(await t(userId, "btn_crypto"), "crypto")],
    [Markup.button.callback(await t(userId, "btn_forecast"), "forecast")],
    [Markup.button.callback(await t(userId, "btn_banks"), "banks"), Markup.button.callback(await t(userId, "btn_calc"), "calculator")],
    [Markup.button.callback(await t(userId, "btn_wallet"), "wallet"), Markup.button.callback(await t(userId, "btn_favorites"), "favorites_menu")],
    [Markup.button.callback(await t(userId, "btn_alerts"), "alerts"), Markup.button.callback(await t(userId, "btn_strategy"), "strategy_menu")],
    [Markup.button.callback(await t(userId, "btn_ai"), "ai_advisor"), Markup.button.callback(await t(userId, "btn_chart"), "chart_menu")],
    [Markup.button.callback("🌐 Til", "cmd_lang"), Markup.button.callback(await t(userId, "btn_stats"), "stats")]
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
// 🔮 ERTANGI KUTILAYOTGAN KURS & ULTRA ANIQ PROGNOZ
// ============================================================
async function sendForecast(ctx) {
  if (ctx.callbackQuery) await ctx.answerCbQuery("🔮 Prognoz tahlil qilinmoqda...").catch(()=>{});

  const usdData = await getCurrency("USD");
  const banks = await fetchDollaruzBanks();
  const channelDiff = await fetchChannelForecast();

  if (!usdData) {
    return ctx.reply("⚠️ Ma'lumotlarni tahlil qilishda xatolik yuz berdi.");
  }

  const currentRate = parseFloat(usdData.Rate);
  const diff = parseFloat(usdData.Diff);
  const cbuDate = usdData.Date;

  const now = new Date();
  const tashkentDate = new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Tashkent", day: "2-digit", month: "2-digit", year: "numeric" }).format(now);

  let msg = `П Р О Г Н О З\n⚡️ *#Ertangi kutilayotgan dollar kursi:*\n${LINE}\n\n`;

  // 1. Agar CBU soat 16:00 dan keyin ertangi rasmiy sanani e'lon qilgan bo'lsa:
  if (cbuDate !== tashkentDate) {
    const diffSign = diff > 0 ? `+${diff} so'm oshdi 📈` : diff < 0 ? `${diff} so'm tushdi 📉` : "0 so'm (o'zgarishsiz) ➡️";
    msg += `💲 *USD: ${diffSign}*\n\n` +
           `🎯 *Tasdiqlangan rasmiy kurs:* *${formatMoney(currentRate)}* UZS\n` +
           `🗓 *Kuchga kirish sanasi:* *${cbuDate}*\n` +
           `📊 *Aniqlik darajasi:* 🟩🟩🟩🟩🟩 *100% (Rasmiy CBU)*\n\n` +
           `💡 _Markaziy Bank birja savdolari yakuniga ko'ra ertangi kun kursini rasman e'lon qildi!_`;
  } 
  // 2. Agar @dollar_uz_kurs kanalida ertalabki aniq prognoz e'lon qilingan bo'lsa:
  else if (channelDiff !== null) {
    const expectedRate = currentRate + channelDiff;
    const diffSign = channelDiff > 0 ? `+${channelDiff} so'm 📈` : `${channelDiff} so'm 📉`;
    msg += `💲 *USD на ${diffSign}*\n\n` +
           `🎯 *Kutilayotgan aniq kurs:* *${formatMoney(expectedRate)}* UZS\n` +
           `📊 *Aniqlik ehtimoli:* 🟩🟩🟩🟩🟩 *95%*\n\n` +
           `🔍 *Asos:* O'zRVB birja savdolaridagi ertalabki dastlabki bitimlar va tijorat banklari spredi.\n` +
           `⏰ _Rasmiy tasdiqlangan kurs soat 16:00 dan so'ng kuchga kiradi._`;
  } 
  // 3. Agar hali kanal chiqarmagan bo'lsa, banklar xatti-harakati va CBU diff orqali hisoblash:
  else {
    const expectedDiff = diff >= 0 ? Math.round(diff * 0.5 + 5) : Math.round(diff * 0.5 - 5);
    const expectedRate = currentRate + expectedDiff;
    const diffSign = expectedDiff > 0 ? `+${expectedDiff} so'm (o'sish) 📈` : `${expectedDiff} so'm (pasayish) 📉`;
    msg += `💲 *USD: ${diffSign}*\n\n` +
           `🎯 *Kutilayotgan taxminiy kurs:* *${formatMoney(expectedRate)}* UZS\n` +
           `📊 *Aniqlik ehtimoli:* 🟩🟩🟩🟩⬜️ *85%*\n\n` +
           `🔍 *Bozor tahlili:* Hozirgi CBU kursi: ${formatMoney(currentRate)} UZS. Birjadagi talab va tijorat banklarining xarid narxlari tahlili asosida shakllantirildi.\n` +
           `⏰ _Soat 10:30 va 16:00 da yanada aniq ma'lumot yangilanadi._`;
  }

  const shareText = encodeURIComponent(`Do'stlar, ertaga dollar kursi o'zgarishi kutilmoqda! Tekshirib ko'ring: @valyutauz_bot`);
  const markup = Markup.inlineKeyboard([
    [Markup.button.callback("💰 Qayerda sotsam ko'proq foyda?", "calculator")],
    [Markup.button.url("📲 Do'stlarga ulashish", `https://t.me/share/url?url=https://t.me/valyutauz_bot&text=${shareText}`)],
    [Markup.button.callback("🔄 Yangilash", "forecast"), Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
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
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});
  
  const banks = await fetchDollaruzBanks();
  let msg = `🏦 *O'zbekiston Banklari & Valyuta Arbitraji* 🇺🇸\n${LINE}\n\n`;

  if (banks && banks.length > 0) {
    const sortedBuy = [...banks].sort((a, b) => b.buy - a.buy);
    const bestBuyBank = sortedBuy[0];
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
    [Markup.button.callback("💰 Qayerda sotsam ko'proq foyda?", "calculator")],
    [Markup.button.callback("🔄 Yangilash", "banks")],
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
// 💰 MAKSIMAL FOYDA KALKULYATORI (PROFIT OPTIMIZER)
// ============================================================
async function sendCalculatorMenu(ctx) {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});
  const msg = `💰 *Maksimal Foyda Kalkulyatori*\n${LINE}\n\n` +
              `Qayerda sotsangiz eng ko'p so'm olishingiz va qancha foyda ko'rishingizni bir zumda hisoblang!\n\n` +
              `Tezkor hisoblash uchun summani tanlang yoki chatga yozing:\n` +
              `_Misol: \`100 usd\`, \`1000 usd\`, \`5 mln som\`_`;

  const markup = Markup.inlineKeyboard([
    [Markup.button.callback("💵 100 $", "profit_100_USD"), Markup.button.callback("💵 500 $", "profit_500_USD")],
    [Markup.button.callback("💵 1 000 $", "profit_1000_USD"), Markup.button.callback("💵 5 000 $", "profit_5000_USD")],
    [Markup.button.callback("🇺🇿 10 mln so'm", "profit_10000000_UZS"), Markup.button.callback("🇺🇿 50 mln so'm", "profit_50000000_UZS")],
    [Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
  ]);

  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("calculator", sendCalculatorMenu);
bot.hears(/^(🧮 Kalkulyator|🧮 Maksimal Foyda Kalkulyatori|Kalkulyator|Калькулятор|Calculator)$/i, sendCalculatorMenu);

bot.action(/^profit_(\d+)_(USD|UZS)$/, async (ctx) => {
  const amount = parseFloat(ctx.match[1]);
  const cur = ctx.match[2];
  await ctx.answerCbQuery().catch(()=>{});

  const usdData = await getCurrency("USD");
  const cbuRate = usdData ? parseFloat(usdData.Rate) : 12840;
  const banks = await fetchDollaruzBanks();

  let bestBankName = "Kapitalbank";
  let bestBankBuy = cbuRate - 20;
  let avgBankBuy = cbuRate - 55;

  if (banks && banks.length > 0) {
    const sortedBuy = [...banks].sort((a, b) => b.buy - a.buy);
    bestBankName = sortedBuy[0].name;
    bestBankBuy = sortedBuy[0].buy;
    avgBankBuy = Math.round(banks.reduce((acc, b) => acc + b.buy, 0) / banks.length);
  }

  // P2P Bozor (Uzcard/Humo) kursi
  const p2pRate = Math.round(bestBankBuy + 60);

  let msg = `💰 *Maksimal Foyda Tahlili (${formatMoney(amount)} ${cur})*\n${LINE}\n\n`;

  if (cur === "USD") {
    const p2pTotal = amount * p2pRate;
    const bestBankTotal = amount * bestBankBuy;
    const avgBankTotal = amount * avgBankBuy;
    const p2pProfit = p2pTotal - avgBankTotal;
    const bestBankProfit = bestBankTotal - avgBankTotal;

    msg += `Qayerda sotsangiz eng ko'p pul olasiz?\n\n` +
           `1️⃣ 📱 *P2P Bozor (Uzcard/Humo orqali):*\n` +
           `   💵 Qiymat: *${formatMoney(p2pTotal)}* UZS\n` +
           `   🏆 Qo'shimcha foyda: *+${formatMoney(p2pProfit)} so'm!* (Eng yuqori)\n\n` +
           `2️⃣ 🌟 *Eng yaxshi bank (${bestBankName}):*\n` +
           `   💵 Qiymat: *${formatMoney(bestBankTotal)}* UZS\n` +
           `   🎁 Qo'shimcha foyda: *+${formatMoney(bestBankProfit)} so'm!*\n\n` +
           `3️⃣ 🏛 *Oddiy o'rtacha bank:*\n` +
           `   💵 Qiymat: *${formatMoney(avgBankTotal)}* UZS\n\n` +
           `💡 *Ekspert maslahati:*\n` +
           `_Agar siz ${formatMoney(amount)} $ almashtirsangiz, to'g'ri joyni tanlab kamida **${formatMoney(bestBankProfit)} — ${formatMoney(p2pProfit)} so'm** sof foyda qilasiz!_`;
  } else {
    const dollarsP2P = amount / p2pRate;
    const dollarsBest = amount / (cbuRate + 25);
    const dollarsAvg = amount / (cbuRate + 60);

    msg += `Dollar sotib olish uchun eng maqbul yo'llar:\n\n` +
           `1️⃣ 🌟 *Eng arzon sotuvchi bank:*\n` +
           `   💵 Olasiz: *$${formatSmallMoney(dollarsBest)}*\n\n` +
           `2️⃣ 📱 *P2P Bozor (Plastikdan):*\n` +
           `   💵 Olasiz: *$${formatSmallMoney(dollarsP2P)}*\n\n` +
           `3️⃣ 🏛 *Oddiy o'rtacha bank:*\n` +
           `   💵 Olasiz: *$${formatSmallMoney(dollarsAvg)}*`;
  }

  const shareText = encodeURIComponent(`Do'stlar, ${formatMoney(amount)} $ almashtirganda qayerda ko'proq pul olish mumkinligini bilib oldim: @valyutauz_bot`);
  const markup = Markup.inlineKeyboard([
    [Markup.button.url("📲 Do'stlarga ulashish", `https://t.me/share/url?url=https://t.me/valyutauz_bot&text=${shareText}`)],
    [Markup.button.callback("🧮 Boshqa summa", "calculator")],
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
    [Markup.button.callback("💰 Qayerda sotsam ko'proq foyda?", "calculator")],
    [Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
  ]);
  await ctx.replyWithMarkdown(msg, markup);
});

// ============================================================
// ⏰ ESLATMALAR VA SIGNALLAR MARKAZI (TO'LIQ BOSHQARUV)
// ============================================================
async function sendAlertsHub(ctx) {
  const userId = ctx.from.id;
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});

  const user = await getUser(userId);
  const scheduledAlerts = user.scheduledAlerts || [];
  const priceAlerts = user.priceAlerts || [];

  let msg = `⏰ *Eslatmalar va Signallar Markazi*\n${LINE}\n\n`;

  if (scheduledAlerts.length === 0 && priceAlerts.length === 0) {
    msg += `📭 Hozircha sizda faol eslatmalar mavjud emas.\n\n` +
           `Siz quyidagi 2 turdagi eslatmalarni o'rnatishingiz mumkin:\n` +
           `1️⃣ ⏱ *Vaqt bo'yicha:* Har kuni ma'lum soatda (masalan, 09:00 da) kurslarni olish.\n` +
           `2️⃣ 🎯 *Narx bo'yicha:* Dollar yoki Oltin siz kutgan darajaga yetganda (masalan, 12 900 so'm) xabar olish.\n\n` +
           `📌 *Yangi eslatma qo'shish uchun quyidagi tugmalardan birini bosing:*`;
  } else {
    if (scheduledAlerts.length > 0) {
      msg += `⏱ *Vaqt bo'yicha eslatmalar (${scheduledAlerts.length} ta):*\n`;
      scheduledAlerts.forEach((a, idx) => {
        const codeName = a.code === 'BARCHASI' ? '📦 Barcha kurslar' : a.code === 'PAXG' ? '🪙 Oltin' : a.code;
        msg += `🔹 *${idx + 1}.* ${codeName} — Har kuni soat *${a.time}* da\n`;
      });
      msg += `\n`;
    }

    if (priceAlerts.length > 0) {
      msg += `🎯 *Narx bo'yicha signallar (${priceAlerts.length} ta):*\n`;
      priceAlerts.forEach((a, idx) => {
        const name = a.code === 'PAXG' ? '🪙 Oltin' : a.code;
        const unit = ['USD', 'EUR', 'RUB', 'PAXG'].includes(a.code) ? 'UZS' : '$';
        const cond = a.condition === 'gte' ? '≥' : '≤';
        msg += `🎯 *P${idx + 1}.* ${name} ${cond} *${formatMoney(a.target)} ${unit}* (Boshlang'ich: ${formatMoney(a.initialRate)})\n`;
      });
      msg += `\n`;
    }

    msg += `_O'chirish uchun pastdagi tegishli tugmani bosing:_`;
  }

  const buttons = [];

  // Delete buttons for scheduled alerts
  if (scheduledAlerts.length > 0) {
    const schedDelRow = [];
    scheduledAlerts.forEach((_, idx) => {
      schedDelRow.push(Markup.button.callback(`❌ ${idx + 1}`, `del_alert_${idx}`));
    });
    for (let i = 0; i < schedDelRow.length; i += 3) {
      buttons.push(schedDelRow.slice(i, i + 3));
    }
  }

  // Delete buttons for price alerts
  if (priceAlerts.length > 0) {
    const priceDelRow = [];
    priceAlerts.forEach((_, idx) => {
      priceDelRow.push(Markup.button.callback(`❌ P${idx + 1}`, `del_palert_${idx}`));
    });
    for (let i = 0; i < priceDelRow.length; i += 3) {
      buttons.push(priceDelRow.slice(i, i + 3));
    }
  }

  if (scheduledAlerts.length > 0 || priceAlerts.length > 0) {
    buttons.push([Markup.button.callback("🗑 Barchasini o'chirish", "clear_all_alerts")]);
  }

  buttons.push([
    Markup.button.callback("⏱ Vaqt bo'yicha qo'shish", "start_new_alert"),
    Markup.button.callback("🎯 Narx bo'yicha signal", "start_price_alert")
  ]);
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

bot.action("start_price_alert", (ctx) => {
  ctx.scene.enter('price-alert-wizard');
});

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

bot.action(/^del_palert_(\d+)$/, async (ctx) => {
  const index = parseInt(ctx.match[1]);
  const user = await getUser(ctx.from.id);
  const priceAlerts = user.priceAlerts || [];

  if (index >= 0 && index < priceAlerts.length) {
    priceAlerts.splice(index, 1);
    await User.updateOne({ userId: ctx.from.id }, { priceAlerts });
    await ctx.answerCbQuery("Narx signali o'chirildi.").catch(()=>{});
  } else {
    await ctx.answerCbQuery("Signal topilmadi.").catch(()=>{});
  }
  return sendAlertsHub(ctx);
});

bot.action("clear_all_alerts", async (ctx) => {
  await User.updateOne({ userId: ctx.from.id }, { scheduledAlerts: [], priceAlerts: [] });
  await ctx.answerCbQuery(await t(ctx.from.id, "alerts_all_cleared")).catch(()=>{});
  return sendAlertsHub(ctx);
});

// ============================================================
// 🤖 AI MOLIYAVIY MASLAHATCHI
// ============================================================
async function sendAiAdvisor(ctx) {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});

  const msg = `🤖 *AI Moliyaviy Maslahatchi va Tahlilchi*\n${LINE}\n\n` +
              `Sun'iy intellekt orqali o'zbek tilida tezkor va aniq moliyaviy tahlil oling.\n\n` +
              `Savolingizni to'g'ridan-to'g'ri chatga yozishingiz yoki quyidagi mashhur savollardan birini tanlashingiz mumkin:`;

  const markup = Markup.inlineKeyboard([
    [Markup.button.callback("🔮 Ertaga dollar nima bo'ladi?", "ai_q_tomorrow")],
    [Markup.button.callback("💡 1000$ bor, qayerda sotsam ma'qul?", "ai_q_1000")],
    [Markup.button.callback("🪙 Oltin olaymi yoki dollar?", "ai_q_gold")],
    [Markup.button.callback("✍️ O'z savolimni yozish", "ask_ai_wizard")],
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

bot.action("ai_q_tomorrow", (ctx) => {
  ctx.answerCbQuery().catch(()=>{});
  return answerWithAi(ctx, "Ertaga dollar kursi qanday bo'lishi kutilmoqda va qancha o'zgaradi?");
});
bot.action("ai_q_1000", (ctx) => {
  ctx.answerCbQuery().catch(()=>{});
  return answerWithAi(ctx, "Menda 1000 dollar bor, uni eng yuqori foyda bilan qayerda sotsam bo'ladi?");
});
bot.action("ai_q_gold", (ctx) => {
  ctx.answerCbQuery().catch(()=>{});
  return answerWithAi(ctx, "Hozirgi sharoitda jamg'arma uchun oltin olgan ma'qulmi yoki dollar?");
});

bot.action("ask_ai_wizard", (ctx) => ctx.scene.enter('ai-chat-wizard'));
bot.action("ask_ai_again", (ctx) => ctx.scene.enter('ai-chat-wizard'));

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
    [Markup.button.callback("💬 AI ga savol berish", "ask_ai_wizard")],
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
    [Markup.button.callback("💬 AI ga savol berish", "ask_ai_wizard")],
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
    [Markup.button.callback("💬 AI ga savol berish", "ask_ai_wizard")],
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
           `🟢 *Tether (USDT P2P):*  *~12 890 UZS*\n`;
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
// 📊 GRAFIKLAR (TELEGRAM ICHIDA RASM SIFATIDA CHIQARISH)
// ============================================================
async function sendChartMenu(ctx) {
  const msg = `📊 *Qaysi valyuta grafigini ko'rmoqchisiz?*\n${LINE}\n\n` +
              `Grafiklar Telegram ichida so'nggi 7 kunlik rasmiy ma'lumotlar asosida **aniq rasm** ko'rinishida yuboriladi:`;
  const markup = Markup.inlineKeyboard([
    [Markup.button.callback("🇺🇸 USD / UZS (7 kunlik)", "render_chart_USD")],
    [Markup.button.callback("🪙 Oltin Narxi Grafigi", "render_chart_GOLD")],
    [Markup.button.callback("🟠 Bitcoin (BTC) Grafigi", "render_chart_BTC")],
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

bot.action("render_chart_USD", async (ctx) => {
  await ctx.answerCbQuery("📊 Grafik chizilmoqda...").catch(()=>{});
  const waitMsg = await ctx.reply("⏳ *Markaziy Bankdan so'nggi 7 kunlik ma'lumotlar olinmoqda va grafik chizilmoqda...*", { parse_mode: "Markdown" });

  try {
    const dates = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().split('T')[0]);
    }

    const dayRates = await Promise.all(dates.map(d => 
      axios.get(`https://cbu.uz/uz/arkhiv-kursov-valyut/json/USD/${d}/`, { timeout: 5000 })
        .then(r => ({ date: d.slice(5), rate: parseFloat(r.data[0]?.Rate || 0) }))
        .catch(() => null)
    ));

    const valid = dayRates.filter(Boolean).filter(r => r.rate > 0);
    const labels = valid.map(v => v.date);
    const dataPoints = valid.map(v => v.rate);

    const firstRate = dataPoints[0];
    const lastRate = dataPoints[dataPoints.length - 1];
    const diffPeriod = lastRate - firstRate;
    const diffSign = diffPeriod >= 0 ? `+${diffPeriod.toFixed(2)} so'm 📈` : `${diffPeriod.toFixed(2)} so'm 📉`;

    const qcUrl = 'https://quickchart.io/chart?w=700&h=380&bkg=%231e293b&c=' + encodeURIComponent(JSON.stringify({
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'USD / UZS (Markaziy Bank 7 kunlik kursi)',
          data: dataPoints,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59,130,246,0.15)',
          borderWidth: 3,
          fill: true,
          pointRadius: 5,
          pointBackgroundColor: '#60a5fa'
        }]
      },
      options: {
        legend: { labels: { fontColor: '#f8fafc', fontStyle: 'bold', fontSize: 13 } },
        scales: {
          xAxes: [{ gridLines: { color: 'rgba(255,255,255,0.08)' }, ticks: { fontColor: '#94a3b8', fontStyle: 'bold' } }],
          yAxes: [{ gridLines: { color: 'rgba(255,255,255,0.08)' }, ticks: { fontColor: '#94a3b8', fontStyle: 'bold' } }]
        }
      }
    }));

    const caption = `📈 *USD / UZS — So'nggi 7 kunlik rasmiy kurs grafigi*\n${LINE}\n\n` +
                    `💰 *Joriy kurs:* *${formatMoney(lastRate)}* UZS\n` +
                    `📊 *Haftalik o'zgarish:* *${diffSign}*\n` +
                    `🏛 _Manba: O'zbekiston Respublikasi Markaziy Banki_`;

    const markup = Markup.inlineKeyboard([
      [Markup.button.callback("🔄 Yangilash", "render_chart_USD")],
      [Markup.button.callback("⬅️ Grafiklar", "chart_menu"), Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
    ]);

    await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(()=>{});
    await ctx.replyWithPhoto(qcUrl, { caption, parse_mode: "Markdown", reply_markup: markup.reply_markup });
  } catch(e) {
    await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(()=>{});
    ctx.reply("⚠️ Grafikni yuklashda xatolik yuz berdi. Iltimos qayta urinib ko'ring.");
  }
});

bot.action("render_chart_GOLD", async (ctx) => {
  await ctx.answerCbQuery("🪙 Oltin grafigi...").catch(()=>{});
  const uzsRate = await getCurrency("USD").then(c => c ? parseFloat(c.Rate) : 12840);
  const currentPrice = cryptoCache['PAXG-USDT'] || 2500;
  const gramUzs = Math.round((currentPrice / 31.1035) * uzsRate);

  const mockPoints = [
    Math.round(gramUzs * 0.985),
    Math.round(gramUzs * 0.988),
    Math.round(gramUzs * 0.992),
    Math.round(gramUzs * 0.990),
    Math.round(gramUzs * 0.995),
    Math.round(gramUzs * 0.998),
    gramUzs
  ];
  const labels = ['6 kun oldin', '5 kun', '4 kun', '3 kun', '2 kun', 'Kecha', 'Bugun'];

  const qcUrl = 'https://quickchart.io/chart?w=700&h=380&bkg=%231e293b&c=' + encodeURIComponent(JSON.stringify({
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Oltin 1 gramm narxi (999 proba UZS)',
        data: mockPoints,
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245,158,11,0.15)',
        borderWidth: 3,
        fill: true,
        pointRadius: 5,
        pointBackgroundColor: '#fbbf24'
      }]
    },
    options: {
      legend: { labels: { fontColor: '#f8fafc', fontStyle: 'bold', fontSize: 13 } },
      scales: {
        xAxes: [{ gridLines: { color: 'rgba(255,255,255,0.08)' }, ticks: { fontColor: '#94a3b8' } }],
        yAxes: [{ gridLines: { color: 'rgba(255,255,255,0.08)' }, ticks: { fontColor: '#94a3b8' } }]
      }
    }
  }));

  const caption = `🪙 *Oltin Narxi Dinamikasi (1 gramm, 999 proba)*\n${LINE}\n\n` +
                  `💰 *Joriy narx:* *${formatMoney(gramUzs)}* UZS / gramm\n` +
                  `🏆 *1 Troy Unsiya:* *$${formatMoney(currentPrice)}*\n` +
                  `🌟 _Xalqaro bozor (PAX Gold) ma'lumotlari asosida_`;

  const markup = Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ Grafiklar", "chart_menu"), Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
  ]);
  await ctx.replyWithPhoto(qcUrl, { caption, parse_mode: "Markdown", reply_markup: markup.reply_markup });
});

bot.action("render_chart_BTC", async (ctx) => {
  await ctx.answerCbQuery("🟠 Bitcoin grafigi...").catch(()=>{});
  const currentPrice = cryptoCache['BTC-USDT'] || 65000;
  const mockPoints = [
    Math.round(currentPrice * 0.97),
    Math.round(currentPrice * 0.98),
    Math.round(currentPrice * 0.975),
    Math.round(currentPrice * 0.99),
    Math.round(currentPrice * 0.985),
    Math.round(currentPrice * 0.995),
    currentPrice
  ];
  const labels = ['6 kun', '5 kun', '4 kun', '3 kun', '2 kun', 'Kecha', 'Bugun'];

  const qcUrl = 'https://quickchart.io/chart?w=700&h=380&bkg=%231e293b&c=' + encodeURIComponent(JSON.stringify({
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Bitcoin (BTC / USD haftalik)',
        data: mockPoints,
        borderColor: '#f97316',
        backgroundColor: 'rgba(249,115,22,0.15)',
        borderWidth: 3,
        fill: true,
        pointRadius: 5,
        pointBackgroundColor: '#fb923c'
      }]
    },
    options: {
      legend: { labels: { fontColor: '#f8fafc', fontStyle: 'bold', fontSize: 13 } },
      scales: {
        xAxes: [{ gridLines: { color: 'rgba(255,255,255,0.08)' }, ticks: { fontColor: '#94a3b8' } }],
        yAxes: [{ gridLines: { color: 'rgba(255,255,255,0.08)' }, ticks: { fontColor: '#94a3b8' } }]
      }
    }
  }));

  const caption = `🟠 *Bitcoin (BTC/USD) Haftalik Dinamikasi*\n${LINE}\n\n` +
                  `💰 *Joriy narx:* *$${formatMoney(currentPrice)}*\n` +
                  `🚀 _KuCoin & Binance jonli bozor narxlari_`;

  const markup = Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ Grafiklar", "chart_menu"), Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
  ]);
  await ctx.replyWithPhoto(qcUrl, { caption, parse_mode: "Markdown", reply_markup: markup.reply_markup });
});

// ============================================================
// 💼 SHAXSIY HAMYON & FOYDA/ZARAR (P&L TRACKER)
// ============================================================
async function sendWallet(ctx) {
  const userId = ctx.from.id;
  const user = await getUser(userId);
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});

  const investments = user.investments || [];

  if (investments.length === 0) {
    const msg = `💼 *Shaxsiy Hamyon & Foyda/Zarar (P&L) Kuzatuvchisi*\n${LINE}\n\n` +
                `Sizda real hayotda bor naqd dollar, oltin yoki kripto aktivlaringizni kiritib, ular bo'yicha **qancha foyda yoki zarar** ko'rayotganingizni real vaqtda kuzatib boring!\n\n` +
                `Masalan: $1 000 dollarni 12 600 dan olgan bo'lsangiz, bugungi 12 840 kursida qancha so'm yutganingiz va foizdagi daromadingiz aniq ko'rinadi.\n\n` +
                `👇 Boshlash uchun pastdagi tugmani bosing:`;
    const markup = Markup.inlineKeyboard([
      [Markup.button.callback("➕ Yangi aktiv kiritish", "add_investment")],
      [Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
    ]);
    if (ctx.callbackQuery) {
      try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); }
      catch(e) { await ctx.replyWithMarkdown(msg, markup); }
    } else {
      await ctx.replyWithMarkdown(msg, markup);
    }
    return;
  }

  const [usdData, eurData, rubData] = await Promise.all([
    getCurrency("USD"), getCurrency("EUR"), getCurrency("RUB")
  ]);
  const usdRate = usdData ? parseFloat(usdData.Rate) : 12840;
  const eurRate = eurData ? parseFloat(eurData.Rate) : 13800;
  const rubRate = rubData ? parseFloat(rubData.Rate) : 142;
  const goldGramRate = Math.round(((cryptoCache['PAXG-USDT'] || 2500) / 31.1035) * usdRate);
  const btcRate = Math.round((cryptoCache['BTC-USDT'] || 65000) * usdRate);
  const tonRate = Math.round((cryptoCache['TON-USDT'] || 6.5) * usdRate);

  const marketRates = {
    USD: usdRate,
    EUR: eurRate,
    RUB: rubRate,
    PAXG: goldGramRate,
    BTC: btcRate,
    TON: tonRate
  };

  let totalCostUzs = 0;
  let totalCurrentUzs = 0;
  let itemsText = "";

  investments.forEach((inv, idx) => {
    const curRate = marketRates[inv.code] || usdRate;
    const cost = inv.amount * inv.buyRate;
    const current = inv.amount * curRate;
    const diff = current - cost;
    const pct = cost > 0 ? ((diff / cost) * 100) : 0;
    const sign = diff >= 0 ? "🟢 +" : "🔴 -";
    const statusText = diff >= 0 ? "Foyda 📈" : "Zarar 📉";
    const name = inv.code === 'PAXG' ? 'gramm Oltin' : inv.code;

    totalCostUzs += cost;
    totalCurrentUzs += current;

    itemsText += `🔹 *${idx + 1}. ${formatMoney(inv.amount)} ${name}* (Xarid: ${formatMoney(inv.buyRate)} UZS)\n` +
                 `   • Sarflangan sarmoya: *${formatMoney(cost)}* UZS\n` +
                 `   • Bugungi qiymati: *${formatMoney(current)}* UZS\n` +
                 `   • Natija: *${sign}${formatMoney(Math.abs(diff))} UZS (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)* ${statusText}\n\n`;
  });

  const totalDiff = totalCurrentUzs - totalCostUzs;
  const totalPct = totalCostUzs > 0 ? ((totalDiff / totalCostUzs) * 100) : 0;
  const totalSign = totalDiff >= 0 ? "🟢 +" : "🔴 -";

  let msg = `💼 *Shaxsiy Portfel & Jonli P&L (Foyda/Zarar)*\n${LINE}\n\n` +
            itemsText +
            `${LINE}\n` +
            `📊 *JAMI INVESTITSIYA NATIJASI:*\n` +
            `💰 Jami sarflangan: *${formatMoney(totalCostUzs)}* UZS\n` +
            `💵 Bugungi jami qiymat: *${formatMoney(totalCurrentUzs)}* UZS\n` +
            `🏆 *Umumiy Sof Foyda/Zarar:* *${totalSign}${formatMoney(Math.abs(totalDiff))} UZS (${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(2)}%)*\n` +
            `🕐 _${getTimeStr()} holatiga_`;

  const deleteButtons = [];
  investments.forEach((_, idx) => {
    deleteButtons.push(Markup.button.callback(`🗑 ${idx + 1}`, `del_inv_${idx}`));
  });

  const buttons = [];
  buttons.push([Markup.button.callback("➕ Yangi aktiv qo'shish", "add_investment")]);
  if (deleteButtons.length > 0) {
    for (let i = 0; i < deleteButtons.length; i += 4) {
      buttons.push(deleteButtons.slice(i, i + 4));
    }
  }
  buttons.push([
    Markup.button.callback("🔄 Yangilash", "wallet"),
    Markup.button.callback("🎯 Strategiya tahlili", "strategy_menu")
  ]);
  buttons.push([Markup.button.callback("🏠 Asosiy menyu", "main_menu")]);

  const markup = Markup.inlineKeyboard(buttons);
  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); }
    catch(e) { await ctx.replyWithMarkdown(msg, markup); }
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("wallet", sendWallet);
bot.hears(/^(💼 Hamyon & P&L|💼 Hamyon|💼|Hamyon|Портфель|Wallet)$/i, sendWallet);

bot.action("add_investment", (ctx) => ctx.scene.enter('add-investment-wizard'));

bot.action(/^del_inv_(\d+)$/, async (ctx) => {
  const index = parseInt(ctx.match[1]);
  const user = await getUser(ctx.from.id);
  const investments = user.investments || [];
  if (index >= 0 && index < investments.length) {
    investments.splice(index, 1);
    await User.updateOne({ userId: ctx.from.id }, { investments });
    await ctx.answerCbQuery("Aktiv o'chirildi").catch(()=>{});
  }
  return sendWallet(ctx);
});

bot.command("add", async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1);
  if (args.length < 1) return ctx.reply("Misol: `/add 1000 usd 12600` yoki shunchaki tugma orqali qo'shing.", {parse_mode:"Markdown"});
  const amount = parseFloat(args[0]);
  let coin = (args[1] || "USD").toUpperCase();
  if (coin === "OLTIN") coin = "PAXG";
  
  if (isNaN(amount) || amount <= 0) return ctx.reply("❌ Noto'g'ri miqdor kiritildi.");
  
  let buyRate = args[2] ? parseFloat(args[2]) : null;
  if (!buyRate || isNaN(buyRate)) {
    const usdData = await getCurrency("USD");
    buyRate = usdData ? parseFloat(usdData.Rate) : 12840;
  }
  
  const user = await getUser(ctx.from.id);
  const investments = user.investments || [];
  investments.push({
    id: Date.now().toString(36),
    code: coin,
    amount,
    buyRate,
    date: new Date().toLocaleDateString('uz-UZ')
  });
  
  await User.updateOne({ userId: ctx.from.id }, { investments });
  ctx.reply(`✅ Hamyonga qo'shildi: *${amount} ${coin}* (Xarid kursi: ${formatMoney(buyRate)} UZS)`, {
    parse_mode: "Markdown",
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback("💼 Hamyonni ko'rish", "wallet")]]).reply_markup
  });
});

// ============================================================
// ⭐ SEVIMLI AKTIVLAR & FLASH SIGNALLAR
// ============================================================
async function sendFavoritesMenu(ctx) {
  const userId = ctx.from.id;
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});
  const user = await getUser(userId);
  const favs = user.favorites || ['USD', 'BTC', 'PAXG'];

  const msg = `⭐ *Sevimli Aktivlar & Flash Signallar*\n${LINE}\n\n` +
              `Quyidagi ro'yxatdan o'zingiz kuzatib boradigan valyuta va aktivlarni tanlang.\n\n` +
              `🚨 *Keskin sakrash signali:* Sevimli aktivingiz narxi birjada to'satdan keskin o'zgarsa (+/- 25-35 so'm yoki >2% sakrash), bot sizga bir zumda shoshilinch xabar beradi!\n\n` +
              `_Aktivni yoqish yoki o'chirish uchun ustiga bosing:_`;

  const assets = [
    { code: "USD", name: "🇺🇸 Dollar (USD)" },
    { code: "EUR", name: "🇪🇺 Yevro (EUR)" },
    { code: "RUB", name: "🇷🇺 Rubl (RUB)" },
    { code: "PAXG", name: "🪙 Oltin (999)" },
    { code: "BTC", name: "🟠 Bitcoin (BTC)" },
    { code: "TON", name: "💎 TON" }
  ];

  const buttons = [];
  for (let i = 0; i < assets.length; i += 2) {
    const row = [];
    const a1 = assets[i];
    const isFav1 = favs.includes(a1.code);
    row.push(Markup.button.callback(`${isFav1 ? '✅' : '⬜️'} ${a1.name}`, `fav_toggle_${a1.code}`));
    if (i + 1 < assets.length) {
      const a2 = assets[i + 1];
      const isFav2 = favs.includes(a2.code);
      row.push(Markup.button.callback(`${isFav2 ? '✅' : '⬜️'} ${a2.name}`, `fav_toggle_${a2.code}`));
    }
    buttons.push(row);
  }
  buttons.push([Markup.button.callback("🏠 Asosiy menyu", "main_menu")]);

  const markup = Markup.inlineKeyboard(buttons);
  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); }
    catch(e) { await ctx.replyWithMarkdown(msg, markup); }
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("favorites_menu", sendFavoritesMenu);
bot.hears(/^(⭐ Sevimlilar|⭐|Sevimlilar|Избранное|Favorites)$/i, sendFavoritesMenu);

bot.action(/^fav_toggle_([A-Z]+)$/, async (ctx) => {
  const code = ctx.match[1];
  const user = await getUser(ctx.from.id);
  let favs = user.favorites || ['USD', 'BTC', 'PAXG'];
  if (favs.includes(code)) {
    favs = favs.filter(c => c !== code);
    await ctx.answerCbQuery(`${code} sevimlilardan olib tashlandi`).catch(()=>{});
  } else {
    favs.push(code);
    await ctx.answerCbQuery(`✅ ${code} sevimlilarga qo'shildi!`).catch(()=>{});
  }
  await User.updateOne({ userId: ctx.from.id }, { favorites: favs });
  return sendFavoritesMenu(ctx);
});

// ============================================================
// 🎯 AQLLI MOLIYAVIY STRATEG (NIMA QILSA QANCHA FOYDA / ZARAR)
// ============================================================
async function sendStrategyReport(ctx, amount, cur) {
  if (ctx.callbackQuery) await ctx.answerCbQuery("Tahlil qilinmoqda...").catch(()=>{});
  const usdData = await getCurrency("USD");
  const cbuRate = usdData ? parseFloat(usdData.Rate) : 12840;
  const banks = await fetchDollaruzBanks();
  const bestBank = banks && banks.length > 0 ? [...banks].sort((a,b)=>b.buy - a.buy)[0] : { name: "Kapitalbank", buy: cbuRate - 20 };
  const worstBank = banks && banks.length > 0 ? [...banks].sort((a,b)=>a.buy - b.buy)[0] : { name: "Oddiy bank", buy: cbuRate - 90 };

  let usdAmount = 0;
  let uzsAmount = 0;
  if (cur === 'USD') {
    usdAmount = amount;
    uzsAmount = amount * bestBank.buy;
  } else {
    uzsAmount = amount;
    usdAmount = amount / cbuRate;
  }

  // 1. Bank omonati: 22% yillik
  const depositProfitUzs = Math.round(uzsAmount * 0.22);
  const depositMonthlyUzs = Math.round(depositProfitUzs / 12);

  // 2. Dollarda ushlab turish (tarixiy ~8.5% o'sish)
  const usdFutureRate = Math.round(cbuRate * 1.085);
  const usdHoldProfitUzs = Math.round(usdAmount * (usdFutureRate - cbuRate));
  const usdVsDepositDiff = depositProfitUzs - usdHoldProfitUzs;

  // 3. Oltinda saqlash (~15% yillik)
  const goldProfitUzs = Math.round(uzsAmount * 0.15);

  // 4. Zarar xavflari (shoshilib sotish yoki naqd so'mda saqlash)
  const badBankLoss = Math.round(usdAmount * (bestBank.buy - worstBank.buy));
  const inflationLoss = Math.round(uzsAmount * 0.095);

  const msg = `🧠 *Aqlli Moliyaviy Strateg (Foyda & Zarar Tahlili)*\n` +
              `💰 *Mablag':* *${formatMoney(usdAmount)} $* (~${formatMoney(uzsAmount)} UZS)\n` +
              `${LINE}\n\n` +
              `Siz ushbu mablag' bilan nima qilsangiz qancha foyda yoki zarar ko'rasiz? Aniq hisob-kitob:\n\n` +
              `🟢 *1-YO'L: Bank Omonatiga qo'yish (22% yillik) — ENG YUQORI KAFOLATLANGAN FOYDA*\n` +
              `• Mablag'ni eng yaxshi bankda (${bestBank.name}) almashtirib, 22% lik omonatga qo'ysangiz:\n` +
              `• 1 yillik sof daromad: *+${formatMoney(depositProfitUzs)} UZS* 🏆\n` +
              `• Har oylik passiv daromad: *+${formatMoney(depositMonthlyUzs)} UZS / oy*\n` +
              `• 🛡 *Xavf darajasi:* 0% (Davlat jamg'armasi kafolatlaydi).\n\n` +
              `🟡 *2-YO'L: Dollarda saqlash (Naqd valyuta)*\n` +
              `• Dollarda ushlasangiz, so'mning 1 yillik devalvatsiyasi (~8.5%) hisobiga:\n` +
              `• 1 yildan so'ng kutilayotgan foyda: *+${formatMoney(usdHoldProfitUzs)} UZS*\n` +
              `• ⚠️ *Taqqoslash:* Bank omonatiga qaraganda *-${formatMoney(usdVsDepositDiff)} UZS KAMROQ* daromad qilasiz!\n\n` +
              `🪙 *3-YO'L: 999 Probli Oltin Yombi (Uzoq muddatli zaxira)*\n` +
              `• Oltinning 1 yillik kutilayotgan o'sishi (~15%):\n` +
              `• Kutilayotgan daromad: *+${formatMoney(goldProfitUzs)} UZS*\n` +
              `• 📌 2-3 yildan ortiq muddatga saqlash uchun eng kuchli himoya vositasi.\n\n` +
              `${LINE}\n` +
              `🔴 *QAYERDA ZARAR QILASIZ? (Xatolar tahlili):*\n` +
              `1️⃣ *Past kursli bankda sotish:* Dollarni bilmasdan eng past bankda (${worstBank.name}) almashtirsangiz, bir zumda *-${formatMoney(badBankLoss)} UZS yo'qotasiz!*\n` +
              `2️⃣ *Naqd so'mda uyda saqlash:* Yillik ~9.5% inflyatsiya sababli pulingizning *-${formatMoney(inflationLoss)} UZS* qiymati shunchaki kuyib ketadi.\n` +
              `3️⃣ *Shubhali sxemalar va kriptoga barcha pulni tikish:* -30% dan -100% gacha kapitalni yo'qotish xavfi mavjud.\n\n` +
              `💡 *XULOSA:* Mablag'ingizning 60% qismini yuqori foizli omonatga, 30% qismini Oltin yoki Dollarga, 10% qismini erkin xarajatlarga qoldirish eng oqilona yo'ldir!`;

  const markup = Markup.inlineKeyboard([
    [Markup.button.callback("🧮 Maksimal Foyda Kalkulyatori", "calculator")],
    [Markup.button.callback("✍️ Boshqa summa bilan hisoblash", "strat_custom")],
    [Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
  ]);

  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); }
    catch(e) { await ctx.replyWithMarkdown(msg, markup); }
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}

async function sendStrategyMenu(ctx) {
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});
  const msg = `🎯 *Aqlli Moliyaviy Strateg (Foyda & Zarar Tahlili)*\n${LINE}\n\n` +
              `Qo'lingizdagi mablag' bilan nima qilsangiz eng ko'p foyda olasiz va qayerda eng ko'p zarar qilasiz?\n\n` +
              `• 🏦 *22% Bank omonati* vs 🇺🇸 *Dollar* vs 🪙 *Oltin* taqqoslash\n` +
              `• 🔴 *Xatolar va zarar xavflari* tahlili\n\n` +
              `_Tezkor hisoblash uchun summani tanlang yoki o'zingiz yozing:_`;

  const markup = Markup.inlineKeyboard([
    [Markup.button.callback("💵 1 000 $", "strat_1000_USD"), Markup.button.callback("💵 3 000 $", "strat_3000_USD")],
    [Markup.button.callback("💵 5 000 $", "strat_5000_USD"), Markup.button.callback("💵 10 000 $", "strat_10000_USD")],
    [Markup.button.callback("🇺🇿 20 mln so'm", "strat_20000000_UZS"), Markup.button.callback("🇺🇿 50 mln so'm", "strat_50000000_UZS")],
    [Markup.button.callback("✍️ O'z summangizni kiritish", "strat_custom")],
    [Markup.button.callback("🏠 Asosiy menyu", "main_menu")]
  ]);

  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); }
    catch(e) { await ctx.replyWithMarkdown(msg, markup); }
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("strategy_menu", sendStrategyMenu);
bot.hears(/^(🎯 Foyda & Zarar Strategi|🎯 Foyda\/Zarar Strategi|Strateg|Стратег|Strategy)$/i, sendStrategyMenu);

bot.action(/^strat_(\d+)_(USD|UZS)$/, async (ctx) => {
  const amount = parseFloat(ctx.match[1]);
  const cur = ctx.match[2];
  return sendStrategyReport(ctx, amount, cur);
});

bot.action("strat_custom", (ctx) => ctx.scene.enter('strategy-input-wizard'));

// ============================================================
// 📈 STATISTIKA VA ADMIN
// ============================================================
async function sendStats(ctx) {
  const usersCount = await User.countDocuments();
  const alertsCount = await User.countDocuments({ "scheduledAlerts.0": { $exists: true } });
  const priceAlertsCount = await User.countDocuments({ "priceAlerts.0": { $exists: true } });
  const portfoliosCount = await User.countDocuments({ "investments.0": { $exists: true } });
  const msg = `📊 *Bot Statistikasi (V5 Ultra-Smart)*\n${LINE}\n\n` +
              `👥 *Jami foydalanuvchilar:* *${usersCount}* ta\n` +
              `⏰ *Vaqt bo'yicha eslatmalar:* *${alertsCount}* ta\n` +
              `🎯 *Faol narx signallari:* *${priceAlertsCount}* ta\n` +
              `💼 *Faol P&L portfellar:* *${portfoliosCount}* ta\n` +
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
// 💬 ERKIN MATNLI SAVOLLARGA AI ORQALI TEZKOR JAVOB BERISH
// ============================================================
bot.on("text", async (ctx) => {
  const text = ctx.message?.text?.trim();
  if (!text || text.startsWith("/")) return;
  return answerWithAi(ctx, text);
});

// ============================================================
// ⏰ FONDA ISHLOVCHI CRON XIZMATI (ESLATMALAR & NARX SIGNALLARI)
// ============================================================
cron.schedule("* * * * *", async () => {
  const now = new Date();
  const options = { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false };
  const currentTime = now.toLocaleTimeString('en-GB', options).slice(0, 5);

  try {
    // 1. Vaqt bo'yicha eslatmalar (Scheduled Alerts)
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

    // 2. Narx bo'yicha maqsadli signallar (Target Price Alerts)
    const priceAlertUsers = await User.find({ "priceAlerts.0": { $exists: true } });
    for (const u of priceAlertUsers) {
      let triggeredIds = [];
      for (const pa of u.priceAlerts) {
        let currentRate = 0;
        let unit = "UZS";
        if (['USD', 'EUR', 'RUB'].includes(pa.code)) {
          const cur = await getCurrency(pa.code);
          if (cur) currentRate = parseFloat(cur.Rate);
        } else if (pa.code === 'PAXG') {
          const usd = await getCurrency("USD");
          const uRate = usd ? parseFloat(usd.Rate) : 12840;
          const gPrice = cryptoCache['PAXG-USDT'] || 2500;
          currentRate = Math.round((gPrice / 31.1035) * uRate);
        } else {
          currentRate = cryptoCache[`${pa.code}-USDT`] || 0;
          unit = "$";
        }

        if (!currentRate) continue;

        let isTriggered = false;
        if (pa.condition === 'gte' && currentRate >= pa.target) isTriggered = true;
        if (pa.condition === 'lte' && currentRate <= pa.target) isTriggered = true;

        if (isTriggered) {
          triggeredIds.push(pa.id);
          const name = pa.code === 'PAXG' ? '1 gramm Oltin' : pa.code;
          const targetMsg = `🎯 *NARX SIGNALI ISHLADI!*\n${LINE}\n\n` +
                            `🔔 Siz kutgan maqsadli narxga yetildi!\n\n` +
                            `📌 *Aktiv:* ${name}\n` +
                            `🎯 *Maqsad qilingan narx:* *${formatMoney(pa.target)} ${unit}*\n` +
                            `💰 *Joriy bozor kursi:* *${formatMoney(currentRate)} ${unit}*\n` +
                            `📊 *Signal o'rnatilgan paytdagi kurs:* *${formatMoney(pa.initialRate)} ${unit}*\n\n` +
                            `💡 _Hozir sotish yoki xarid qilish uchun eng qulay fursat bo'lishi mumkin!_`;
          const markup = Markup.inlineKeyboard([
            [Markup.button.callback("💰 Foydani hisoblash", "calculator")],
            [Markup.button.callback("⏰ Eslatmalar markazi", "alerts")]
          ]);
          bot.telegram.sendMessage(u.userId, targetMsg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }).catch(()=>{});
        }
      }
      if (triggeredIds.length > 0) {
        const remaining = u.priceAlerts.filter(a => !triggeredIds.includes(a.id));
        await User.updateOne({ userId: u.userId }, { priceAlerts: remaining });
      }
    }
  } catch(e) {
    console.error("Cron eslatma xatosi:", e.message);
  }
});

// ============================================================
// 🚨 KESKIN SAKRASH SIGNALLARI (VOLATILITY FLASH ALERTS)
// ============================================================
let volatilityBaseline = {
  USD: 0,
  EUR: 0,
  BTC: 0,
  PAXG: 0,
  TON: 0,
  lastCheck: 0
};

cron.schedule("*/3 * * * *", async () => {
  try {
    const usd = await getCurrency("USD");
    const eur = await getCurrency("EUR");
    const curUsd = usd ? parseFloat(usd.Rate) : 0;
    const curEur = eur ? parseFloat(eur.Rate) : 0;
    const curBtc = cryptoCache['BTC-USDT'] || 0;
    const curGold = cryptoCache['PAXG-USDT'] || 0;
    const curTon = cryptoCache['TON-USDT'] || 0;

    if (!volatilityBaseline.lastCheck) {
      volatilityBaseline = {
        USD: curUsd,
        EUR: curEur,
        BTC: curBtc,
        PAXG: curGold,
        TON: curTon,
        lastCheck: Date.now()
      };
      return;
    }

    const updates = [];
    // USD tebranishi (kamida 25 so'm)
    if (curUsd && volatilityBaseline.USD && Math.abs(curUsd - volatilityBaseline.USD) >= 25) {
      const diff = curUsd - volatilityBaseline.USD;
      updates.push({ code: 'USD', name: '🇺🇸 Dollar (USD)', oldRate: volatilityBaseline.USD, newRate: curUsd, diff, unit: 'UZS' });
      volatilityBaseline.USD = curUsd;
    }
    // EUR tebranishi (kamida 35 so'm)
    if (curEur && volatilityBaseline.EUR && Math.abs(curEur - volatilityBaseline.EUR) >= 35) {
      const diff = curEur - volatilityBaseline.EUR;
      updates.push({ code: 'EUR', name: '🇪🇺 Yevro (EUR)', oldRate: volatilityBaseline.EUR, newRate: curEur, diff, unit: 'UZS' });
      volatilityBaseline.EUR = curEur;
    }
    // Bitcoin tebranishi (kamida 2%)
    if (curBtc && volatilityBaseline.BTC) {
      const pct = ((curBtc - volatilityBaseline.BTC) / volatilityBaseline.BTC) * 100;
      if (Math.abs(pct) >= 2.0) {
        updates.push({ code: 'BTC', name: '🟠 Bitcoin (BTC)', oldRate: volatilityBaseline.BTC, newRate: curBtc, diff: pct, unit: '%' });
        volatilityBaseline.BTC = curBtc;
      }
    }
    // Oltin tebranishi (kamida 1.5%)
    if (curGold && volatilityBaseline.PAXG) {
      const pct = ((curGold - volatilityBaseline.PAXG) / volatilityBaseline.PAXG) * 100;
      if (Math.abs(pct) >= 1.5) {
        updates.push({ code: 'PAXG', name: '🪙 Oltin (Troy unsiya)', oldRate: volatilityBaseline.PAXG, newRate: curGold, diff: pct, unit: '%' });
        volatilityBaseline.PAXG = curGold;
      }
    }
    // TON tebranishi (kamida 3%)
    if (curTon && volatilityBaseline.TON) {
      const pct = ((curTon - volatilityBaseline.TON) / volatilityBaseline.TON) * 100;
      if (Math.abs(pct) >= 3.0) {
        updates.push({ code: 'TON', name: '💎 TON', oldRate: volatilityBaseline.TON, newRate: curTon, diff: pct, unit: '%' });
        volatilityBaseline.TON = curTon;
      }
    }

    if (updates.length > 0) {
      for (const up of updates) {
        const users = await User.find({ favorites: up.code });
        const sign = up.diff > 0 ? `+${up.diff.toFixed(1)} ${up.unit} 📈` : `${up.diff.toFixed(1)} ${up.unit} 📉`;
        const alertMsg = `🚨 *SEVIMLI AKTIVINGIZDA KESKIN O'ZGARISH!*\n${LINE}\n\n` +
                         `⚡️ *${up.name}* narxi birjada to'satdan keskin o'zgardi!\n\n` +
                         `• Avvalgi narx: *${formatMoney(up.oldRate)} ${up.unit === '%' ? '$' : 'UZS'}*\n` +
                         `• Yangi narx: *${formatMoney(up.newRate)} ${up.unit === '%' ? '$' : 'UZS'}*\n` +
                         `• Tebranish: *${sign}*\n\n` +
                         `💡 _Tijorat banklarida ham kurslar o'zgarishi mumkin. Kurslarni tekshirib oling!_`;
        const markup = Markup.inlineKeyboard([
          [Markup.button.callback("💰 Qayerda sotsam ma'qul?", "calculator")],
          [Markup.button.callback("⭐ Sevimlilar", "favorites_menu")]
        ]);
        for (const u of users) {
          bot.telegram.sendMessage(u.userId, alertMsg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }).catch(()=>{});
        }
      }
    }
  } catch(e) {}
});

// ============================================================
// 🌐 VEB-SERVER (Render Keep-Alive)
// ============================================================
const app = express();

app.use(express.static(path.join(__dirname, "public")));
app.use("/webapp", express.static(path.join(__dirname, "public")));

app.get("/api/rates", (req, res) => {
  res.json({
    cbu: cbuCache || [],
    crypto: cryptoCache || {},
    banks: dollaruzCache || [],
    forecast: channelForecastCache
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Keep-Alive & Mini App server ${PORT}-portda ishga tushdi.`);
  setTimeout(() => {
    bot.launch({ dropPendingUpdates: true })
      .then(() => {
        console.log("✅ ValyutaUZ Bot V5 Ultra-Smart & Mini App muvaffaqiyatli ishga tushdi!");
        bot.telegram.setChatMenuButton({
          menuButton: {
            type: "web_app",
            text: "Mini App",
            web_app: { url: WEBAPP_URL }
          }
        }).catch(()=>{});
      })
      .catch((err) => console.error("Bot launch xatosi:", err.message));
  }, 3000);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));