require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const { Telegraf, Markup } = require("telegraf");
const mercadopago = require("mercadopago");
const cron = require("node-cron");

const app = express();
app.use(express.json());

const ADMIN_ID = Number(process.env.ADMIN_ID);

mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN
});

// =============================
// 🔌 MONGODB
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
  planType: String,
  lifetime: { type: Boolean, default: false },
  expiresAt: Date
});

const paymentSchema = new mongoose.Schema({
  telegramId: Number,
  planType: String,
  amount: Number,
  mpPaymentId: String,
  status: { type: String, default: "pending" },
  createdAt: { type: Date, default: Date.now },
  expiresAt: Date
});

const settingsSchema = new mongoose.Schema({
  groupId: String,
  monthlyPrice: Number,
  lifetimePrice: Number,
  monthlyDays: Number,
  startMessage: String,
  supportContact: String,
  approvedMessage: String,
  expiredMessage: String,
  totalRevenue: { type: Number, default: 0 }
});

const User = mongoose.model("User", userSchema);
const Payment = mongoose.model("Payment", paymentSchema);
const Settings = mongoose.model("Settings", settingsSchema);

// =============================
// 🤖 BOT
// =============================
const bot = new Telegraf(process.env.BOT_TOKEN);

// =============================
// 🚀 START
// =============================
bot.start(async (ctx) => {
  let user = await User.findOne({ telegramId: ctx.from.id });
  const settings = await Settings.findOne();
  if (!settings) return ctx.reply("⚙ Sistema não configurado.");

  if (!user) {
    await User.create({
      telegramId: ctx.from.id,
      username: ctx.from.username
    });
  }

  ctx.reply(
    settings.startMessage || "🔥 Bem-vindo ao VIP!",
    Markup.inlineKeyboard([
      [Markup.button.callback("📅 Mensal", "BUY_MONTHLY")],
      [Markup.button.callback("♾ Vitalício", "BUY_LIFETIME")],
      [Markup.button.callback("✅ Já paguei", "CHECK_PAYMENT")],
      [Markup.button.url("💬 Suporte", settings.supportContact || "https://t.me/")]
    ])
  );
});

// =============================
// 💳 CRIAR PAGAMENTO
// =============================
async function createPixPayment(ctx, planType, amount, description) {
  const expiration = new Date();
  expiration.setMinutes(expiration.getMinutes() + 30); // ⏳ 30 minutos limite

  const payment = await mercadopago.payment.create({
    transaction_amount: Number(amount),
    description,
    payment_method_id: "pix",
    date_of_expiration: expiration.toISOString(),
    payer: {
      email: `user${ctx.from.id}@vip.com`
    },
    metadata: {
      telegramId: ctx.from.id,
      planType
    }
  });

  const qr = payment.body.point_of_interaction.transaction_data.qr_code_base64;
  const pixCode = payment.body.point_of_interaction.transaction_data.qr_code;

  await Payment.create({
    telegramId: ctx.from.id,
    planType,
    amount,
    mpPaymentId: payment.body.id,
    expiresAt: expiration
  });

  await ctx.replyWithPhoto(
    Buffer.from(qr, "base64"),
    {
      caption:
`💳 ${description}
Valor: R$${amount}

⏳ Expira em 30 minutos

🔑 PIX Copia e Cola:
${pixCode}`
    }
  );
}

// =============================
// 📅 MENSAL
// =============================
bot.action("BUY_MONTHLY", async (ctx) => {
  const settings = await Settings.findOne();
  if (!settings) return ctx.reply("Sistema não configurado.");
  await createPixPayment(ctx, "monthly", settings.monthlyPrice, "Plano Mensal VIP");
});

// =============================
// ♾ VITALÍCIO
// =============================
bot.action("BUY_LIFETIME", async (ctx) => {
  const settings = await Settings.findOne();
  if (!settings) return ctx.reply("Sistema não configurado.");
  await createPixPayment(ctx, "lifetime", settings.lifetimePrice, "Plano Vitalício VIP");
});

// =============================
// ✅ BOTÃO JÁ PAGUEI
// =============================
bot.action("CHECK_PAYMENT", async (ctx) => {
  const payment = await Payment.findOne({
    telegramId: ctx.from.id,
    status: "pending"
  }).sort({ createdAt: -1 });

  if (!payment)
    return ctx.reply("❌ Nenhum pagamento pendente encontrado.");

  const mpPayment = await mercadopago.payment.findById(payment.mpPaymentId);

  if (mpPayment.body.status === "approved") {
    ctx.reply("✅ Pagamento confirmado automaticamente!");
  } else {
    ctx.reply("⏳ Pagamento ainda não foi identificado.");
  }
});

// =============================
// 💰 WEBHOOK MERCADO PAGO
// =============================
app.post("/payment-webhook", async (req, res) => {
  if (req.body.type !== "payment") return res.sendStatus(200);

  const paymentId = req.body.data.id;
  const mpPayment = await mercadopago.payment.findById(paymentId);

  if (mpPayment.body.status !== "approved")
    return res.sendStatus(200);

  const { telegramId, planType } = mpPayment.body.metadata;
  const payment = await Payment.findOne({ mpPaymentId: paymentId });

  if (!payment || payment.status === "approved")
    return res.sendStatus(200);

  const settings = await Settings.findOne();
  const user = await User.findOne({ telegramId });

  // 🔒 ANTI-FRAUDE
  if (mpPayment.body.transaction_amount !== payment.amount)
    return res.sendStatus(400);

  payment.status = "approved";
  await payment.save();

  settings.totalRevenue += payment.amount;
  await settings.save();

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
    settings.approvedMessage || "✅ Pagamento aprovado! Acesso liberado."
  );

  res.sendStatus(200);
});

// =============================
// ⏰ CRON EXPIRAÇÃO + LIMPEZA PIX
// =============================
cron.schedule("*/10 * * * *", async () => {
  const now = new Date();
  const settings = await Settings.findOne();
  if (!settings) return;

  // cancelar pagamentos expirados
  await Payment.deleteMany({
    status: "pending",
    expiresAt: { $lte: now }
  });

  // remover usuários vencidos
  const expiredUsers = await User.find({
    status: "active",
    lifetime: false,
    expiresAt: { $lte: now }
  });

  for (const user of expiredUsers) {
    await bot.telegram.banChatMember(settings.groupId, user.telegramId);
    await bot.telegram.sendMessage(
      user.telegramId,
      settings.expiredMessage || "❌ Seu plano expirou."
    );
    user.status = "inactive";
    await user.save();
  }

  console.log("⏰ Verificação automática executada.");
});

// =============================
// 🌍 WEBHOOK TELEGRAM
// =============================
app.use(bot.webhookCallback("/webhook"));

app.get("/", (req, res) => {
  res.send("🚀 VIP PRO rodando...");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  await bot.telegram.setWebhook(`${process.env.RENDER_URL}/webhook`);
  console.log("🚀 Servidor iniciado");
});
