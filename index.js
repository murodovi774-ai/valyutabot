require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
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
    const { data } = await axiosWithRetry({ url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,the-open-network,solana,binancecoin,tether-gold&vs_currencies=usd" });
    if(data) cryptoCache = data;
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
    [Markup.button.callback(await t(userId, "btn_banks"), "banks"), Markup.button.callback(await t(userId, "btn_alerts"), "alerts")]
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
bot.hears(/(🇺🇸|USD)/i, (ctx) => sendRate(ctx, "USD"));
bot.hears(/(🇪🇺|EUR)/i, (ctx) => sendRate(ctx, "EUR"));
bot.hears(/(🇷🇺|RUB)/i, (ctx) => sendRate(ctx, "RUB"));

async function sendBanks(ctx) {
  const userId = ctx.from.id;
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});
  
  const nbuReq = await axiosWithRetry({ url: "https://nbu.uz/uz/exchange-rates/json/" }).catch(()=>null);
  let msg = "🏦 *O'zbekiston banklari kursi (NBU)*\n\n";
  if (nbuReq && nbuReq.data) {
     const usd = nbuReq.data.find(c => c.code === "USD");
     const eur = nbuReq.data.find(c => c.code === "EUR");
     if(usd) msg += `🇺🇸 *USD:*\nSotib olish: ${usd.cb_price} so'm\nSotish: ${usd.nbu_cell_price} so'm\n\n`;
     if(eur) msg += `🇪🇺 *EUR:*\nSotib olish: ${eur.cb_price} so'm\nSotish: ${eur.nbu_cell_price} so'm\n\n`;
  } else {
     const usdCbu = await getCurrency("USD");
     if (usdCbu) {
         const rate = parseFloat(usdCbu.Rate);
         msg += `🇺🇸 *USD (Taxminiy tijorat):*\nSotib olish: ${formatMoney(rate - 50)} so'm\nSotish: ${formatMoney(rate + 50)} so'm\n\n`;
     } else {
         msg += "❌ Xatolik yuz berdi.";
     }
  }
  
  const markup = Markup.inlineKeyboard([[Markup.button.callback("⬅️", "main_menu")]]);
  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("banks", sendBanks);
bot.hears(/(🏦|Bank)/i, sendBanks);

async function sendGold(ctx) {
  const userId = ctx.from.id;
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});
  
  const uzsRate = await getCurrency("USD").then(c => c ? parseFloat(c.Rate) : 12600);
  const priceUsd = cryptoCache['tether-gold']?.usd || 0;
  
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
bot.hears(/(🪙 Oltin|🪙 Золото|🪙 Gold|Oltin|Золото)/i, sendGold);

async function sendCrypto(ctx) {
  const userId = ctx.from.id;
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});
  const data = cryptoCache || {};
  let msg = await t(userId, "crypto_title") + "\n\n";
  
  if (!data.bitcoin) {
      msg += await t(userId, "error") + " (Keshlanmoqda, kuting...)";
  } else {
      msg += `🟠 *Bitcoin (BTC):* $${formatMoney(data.bitcoin?.usd)}\n`;
      msg += `🔷 *Ethereum (ETH):* $${formatMoney(data.ethereum?.usd)}\n`;
      msg += `🟡 *Binance (BNB):* $${formatMoney(data.binancecoin?.usd)}\n`;
      msg += `🟣 *Solana (SOL):* $${formatMoney(data.solana?.usd)}\n`;
      msg += `💎 *TON (TON):* $${formatMoney(data['the-open-network']?.usd)}\n`;
  }
  
  const markup = Markup.inlineKeyboard([[Markup.button.callback("⬅️", "main_menu")]]);
  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("crypto", sendCrypto);
bot.hears(/(🪙 Kripto|🪙 Крипто|🪙 Crypto|Kripto|Крипто)/i, sendCrypto);

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
bot.hears(/(📊|Grafik|График|Chart)/i, sendChartMenu);

bot.action("chart_USD", async (ctx) => {
  const userId = ctx.from.id;
  await ctx.answerCbQuery(await t(userId, "wait")).catch(()=>{});
  const { data } = await axiosWithRetry({ url: "https://cbu.uz/uz/arkhiv-kursov-valyut/json/all/USD/" }).catch(()=>({data:[]}));
  if (!data || data.length === 0) return ctx.reply(await t(userId, "error"));
  
  const last7 = data.slice(0, 7).reverse();
  const labels = last7.map(d => d.Date.slice(0,5));
  const rates = last7.map(d => parseFloat(d.Rate));
  
  const chartObj = { 
    type: 'line', 
    data: { 
      labels: labels, 
      datasets: [{ 
        label: 'USD/UZS', 
        data: rates, 
        borderColor: '#00e676', 
        backgroundColor: 'rgba(0, 230, 118, 0.1)',
        fill: true,
        pointBackgroundColor: '#fff',
        pointBorderColor: '#00e676',
        pointRadius: 4,
        tension: 0.4
      }] 
    },
    options: {
      plugins: { legend: { labels: { color: '#fff' } } },
      scales: { 
        x: { ticks: { color: '#fff' }, grid: { color: 'rgba(255, 255, 255, 0.1)' } },
        y: { ticks: { color: '#fff' }, grid: { color: 'rgba(255, 255, 255, 0.1)' } }
      }
    }
  };
  const chartUrl = `https://quickchart.io/chart?w=600&h=400&bkg=1e1e1e&c=${encodeURIComponent(JSON.stringify(chartObj))}`;
  const msg = await t(userId, "chart_caption", { code: "USD", days: 7, changeText: "", lastRate: formatMoney(rates[rates.length-1]) });
  const markup = Markup.inlineKeyboard([[Markup.button.callback("⬅️", "main_menu")]]);
  await ctx.deleteMessage().catch(()=>{});
  await ctx.replyWithPhoto({ url: chartUrl }, { caption: msg, parse_mode: "Markdown", reply_markup: markup.reply_markup });
});

bot.action("chart_BTC", async (ctx) => {
  const userId = ctx.from.id;
  await ctx.answerCbQuery(await t(userId, "wait")).catch(()=>{});
  const req = await axiosWithRetry({ url: "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=30" }).catch(()=>null);
  if (!req || !req.data) return ctx.reply(await t(userId, "error"));
  
  const klines = req.data;
  const chartData = klines.map(k => ({
      t: new Date(k[0]).toISOString().slice(0,10),
      o: parseFloat(k[1]),
      h: parseFloat(k[2]),
      l: parseFloat(k[3]),
      c: parseFloat(k[4])
  }));
  
  const chartConfig = {
      type: 'candlestick',
      data: { datasets: [{ label: 'BTC/USDT', data: chartData }] },
      options: {
          legend: { display: false },
          scales: {
              x: { ticks: { color: '#fff' }, grid: { color: 'rgba(255, 255, 255, 0.1)' } },
              y: { ticks: { color: '#fff' }, grid: { color: 'rgba(255, 255, 255, 0.1)' } }
          }
      }
  };
  const url = `https://quickchart.io/chart?w=600&h=400&bkg=1e1e1e&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
  const markup = Markup.inlineKeyboard([[Markup.button.callback("⬅️", "main_menu")]]);
  await ctx.deleteMessage().catch(()=>{});
  await ctx.replyWithPhoto({url}, {caption: "📊 *BTC/USD* (30 kunlik haqiqiy shamcha grafik)", parse_mode: "Markdown", reply_markup: markup.reply_markup});
});

async function sendStats(ctx) {
  const usersCount = await User.countDocuments();
  const alertsCount = await User.countDocuments({ "alerts.0": { $exists: true } });
  const msg = `📊 *Bot Statistikasi:*\n\n👥 *Jami foydalanuvchilar:* ${usersCount} ta\n🔔 *Signallar o'rnatilgan:* ${alertsCount} ta\n⚡️ *Holati:* 100% Onlayn (MongoDB)`;
  const markup = Markup.inlineKeyboard([[Markup.button.callback("⬅️", "main_menu")]]);
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery().catch(()=>{});
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("stats", sendStats);
bot.hears(/(📈|Statistika|Статистика|Stats)/i, sendStats);

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
  const prices = { usd: 1, btc: cryptoData.bitcoin?.usd || 0, eth: cryptoData.ethereum?.usd || 0, ton: cryptoData["the-open-network"]?.usd || 0 };

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
bot.hears(/(💼|Hamyon|Кошелек|Wallet)/i, sendWallet);

async function sendAlertsMenu(ctx) {
  const userId = ctx.from.id;
  const user = await getUser(userId);
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});

  const alerts = user.alerts || [];
  const markup = Markup.inlineKeyboard([[Markup.button.callback("⬅️", "main_menu")]]);
  
  if (alerts.length === 0) {
    const msg = await t(userId, "alert_prompt");
    if (ctx.callbackQuery) {
      try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
    } else {
      await ctx.replyWithMarkdown(msg, markup);
    }
    return;
  }

  let list = alerts.map((a, i) => `${i+1}. ${a.code.toUpperCase()} 🎯 ${a.target}`).join("\n");
  const msg = await t(userId, "alert_list", {list});
  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: markup.reply_markup }); } catch(e){}
  } else {
    await ctx.replyWithMarkdown(msg, markup);
  }
}
bot.action("alerts", sendAlertsMenu);
bot.hears(/(🔔|Xabarnoma|Signal|Alert)/i, sendAlertsMenu);

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

bot.command("alert", async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1);
  if (args.length < 2) return ctx.reply("Misol: `/alert btc 70000`", {parse_mode:"Markdown"});
  
  const code = args[0].toLowerCase();
  const target = parseFloat(args[1]);
  if (isNaN(target)) return;

  const user = await getUser(ctx.from.id);
  const alerts = user.alerts || [];
  alerts.push({ code, target });
  
  await User.updateOne({ userId: ctx.from.id }, { alerts });
  ctx.reply(await t(ctx.from.id, "alert_added", {code: code.toUpperCase(), target}));
});

bot.command("schedule", async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1);
  if (args.length < 2) return ctx.reply("Misol: `/schedule USD 09:00`", {parse_mode:"Markdown"});
  
  const code = args[0].toUpperCase();
  const time = args[1]; // format HH:MM
  if (!/^\d{2}:\d{2}$/.test(time)) return ctx.reply("Vaqt formati noto'g'ri. Misol: 09:00 yoki 15:30");

  const user = await getUser(ctx.from.id);
  const scheduledAlerts = user.scheduledAlerts || [];
  
  if(!scheduledAlerts.some(a => a.code === code && a.time === time)) {
      scheduledAlerts.push({ code, time });
      await User.updateOne({ userId: ctx.from.id }, { scheduledAlerts });
  }
  ctx.reply(`✅ Xabarnoma belgilandi: Har kuni soat ${time} da ${code} kursi yuboriladi.`);
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
               if(currency) msg = `⏰ *Belgilangan xabarnoma!* (${a.time})\n\n💰 1 ${a.code} = *${currency.Rate}* UZS\n📊 O'zgarish: ${currency.Diff > 0 ? '+' : ''}${currency.Diff}`;
           } else {
               const price = cryptoCache[a.code.toLowerCase()]?.usd || (a.code === 'BTC' ? cryptoCache.bitcoin?.usd : null) || (a.code === 'ETH' ? cryptoCache.ethereum?.usd : null);
               if(price) msg = `⏰ *Belgilangan xabarnoma!* (${a.time})\n\n💰 1 ${a.code} = *$${price}*`;
           }
           if (msg) bot.telegram.sendMessage(user.userId, msg, {parse_mode: "Markdown"}).catch(()=>{});
        }
    }
});

cron.schedule("*/5 * * * *", async () => {
  console.log("🔔 Signallar tekshirilmoqda (Kesh orqali)...");
  try {
    const users = await User.find({ "alerts.0": { $exists: true } });
    if (users.length === 0) return;

    const usdData = await getCurrency("USD");
    const cryptoData = cryptoCache || {};
    const prices = { usd: usdData ? parseFloat(usdData.Rate) : 0, btc: cryptoData.bitcoin?.usd || 0 };

    for (const user of users) {
      let triggered = [];
      let newAlerts = user.alerts.filter(a => {
        const currentPrice = prices[a.code] || 0;
        if (currentPrice === 0) return true;
        if (Math.abs(currentPrice - a.target) / a.target < 0.01) {
          triggered.push({ code: a.code, target: a.target, current: currentPrice });
          return false;
        }
        return true;
      });

      for (const trig of triggered) {
        const msg = await t(user.userId, "alert_triggered", { code: trig.code.toUpperCase(), current: formatMoney(trig.current), target: trig.target });
        bot.telegram.sendMessage(user.userId, msg, { parse_mode: "Markdown" }).catch(()=>{});
      }
      if (triggered.length > 0) await User.updateOne({ userId: user.userId }, { alerts: newAlerts });
    }
  } catch(e) { console.error("Alert Cron xatosi:", e.message); }
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