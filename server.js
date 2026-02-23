require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const { Telegraf, Markup } = require("telegraf");
const cron = require("node-cron");

const app = express();
app.use(express.json());

// =============================
// 🔌 CONEXÃO MONGODB
// =============================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB conectado"))
  .catch(err => console.log(err));

// =============================
// 📦 MODELS
// =============================

const userSchema = new mongoose.Schema({
  telegramId: Number,
  username: String,
  status: { type: String, default: "inactive" },
  planType: { type: String, enum: ["monthly", "lifetime"], default: "monthly" },
  lifetime: { type: Boolean, default: false },
  expiresAt: Date
});

const paymentSchema = new mongoose.Schema({
  telegramId: Number,
  planType: String,
  amount: Number,
  status: String,
  createdAt: { type: Date, default: Date.now }
});

const settingsSchema = new mongoose.Schema({
  groupId: String,
  monthlyPrice: Number,
  lifetimePrice: Number,
  monthlyDays: Number
});

const User = mongoose.model("User", userSchema);
const Payment = mongoose.model("Payment", paymentSchema);
const Settings = mongoose.model("Settings", settingsSchema);

// =============================
// 🤖 BOT
// =============================

const bot = new Telegraf(process.env.BOT_TOKEN);

// START
bot.start(async (ctx) => {
  let user = await User.findOne({ telegramId: ctx.from.id });

  if (!user) {
    await User.create({
      telegramId: ctx.from.id,
      username: ctx.from.username
    });
  }

  ctx.reply(
    "🔥 Bem-vindo ao VIP!\nEscolha um plano:",
    Markup.inlineKeyboard([
      [Markup.button.callback("📅 Mensal", "BUY_MONTHLY")],
      [Markup.button.callback("♾ Vitalício", "BUY_LIFETIME")]
    ])
  );
});

// =============================
// COMPRA MENSAL
// =============================
bot.action("BUY_MONTHLY", async (ctx) => {
  const settings = await Settings.findOne();
  if (!settings) return ctx.reply("Sistema não configurado.");

  await Payment.create({
    telegramId: ctx.from.id,
    planType: "monthly",
    amount: settings.monthlyPrice,
    status: "pending"
  });

  ctx.reply(`💳 Plano Mensal\nValor: R$${settings.monthlyPrice}\n\nApós pagar, aguarde confirmação.`);
});

// =============================
// COMPRA VITALÍCIO
// =============================
bot.action("BUY_LIFETIME", async (ctx) => {
  const settings = await Settings.findOne();
  if (!settings) return ctx.reply("Sistema não configurado.");

  await Payment.create({
    telegramId: ctx.from.id,
    planType: "lifetime",
    amount: settings.lifetimePrice,
    status: "pending"
  });

  ctx.reply(`💎 Plano Vitalício\nValor: R$${settings.lifetimePrice}\n\nApós pagar, aguarde confirmação.`);
});

// =============================
// 💳 WEBHOOK PAGAMENTO
// =============================
app.post("/payment-webhook", async (req, res) => {
  const { telegramId, status, planType } = req.body;

  if (status !== "approved") return res.sendStatus(200);

  const settings = await Settings.findOne();
  const user = await User.findOne({ telegramId });

  if (!user) return res.sendStatus(404);

  if (planType === "monthly") {
    const expiration = new Date();
    expiration.setDate(expiration.getDate() + settings.monthlyDays);

    user.status = "active";
    user.planType = "monthly";
    user.lifetime = false;
    user.expiresAt = expiration;
  }

  if (planType === "lifetime") {
    user.status = "active";
    user.planType = "lifetime";
    user.lifetime = true;
    user.expiresAt = null;
  }

  await user.save();

  await bot.telegram.unbanChatMember(settings.groupId, telegramId);

  await bot.telegram.sendMessage(
    telegramId,
    "✅ Pagamento aprovado! Seu acesso foi liberado."
  );

  res.sendStatus(200);
});

// =============================
// ⏰ CRON EXPIRAÇÃO
// =============================
cron.schedule("0 * * * *", async () => {
  const now = new Date();
  const settings = await Settings.findOne();
  if (!settings) return;

  const expiredUsers = await User.find({
    status: "active",
    lifetime: false,
    expiresAt: { $lte: now }
  });

  for (const user of expiredUsers) {
    await bot.telegram.banChatMember(settings.groupId, user.telegramId);
    user.status = "inactive";
    await user.save();
  }

  console.log("⏰ Verificação de expiração executada.");
});

// =============================
// 🌍 WEBHOOK TELEGRAM
// =============================
app.use(bot.webhookCallback("/webhook"));

app.get("/", (req, res) => {
  res.send("🚀 Bot VIP PRO rodando...");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  await bot.telegram.setWebhook(`${process.env.RENDER_URL}/webhook`);
  console.log("🚀 Servidor iniciado");
});