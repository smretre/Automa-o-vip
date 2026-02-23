require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const { Telegraf, Markup } = require("telegraf");
const { MercadoPagoConfig, Payment: MpPayment } = require("mercadopago");
const cron = require("node-cron");

const app = express();
app.use(express.json());

const ADMIN_ID = Number(process.env.ADMIN_ID);

// ✅ SDK NOVO
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
});

const paymentClient = new MpPayment(mpClient);

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
// 👑 PAINEL ADMIN (NOVO)
// =============================
bot.command("admin", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID)
    return ctx.reply("❌ Você não é administrador.");

  ctx.reply(
`⚙️ Painel Administrador ⚙️

Status: O bot está pronto para venda ✅

Olá, ${ctx.from.first_name}!
Aqui, você pode fazer todas as configurações do seu bot, desde a gestão de grupos e planos até a personalização de mensagens e opções de pagamento.
Transforme a experiência dos seus usuários e alcance novos patamares de eficiência e sucesso!

💡 Você pode voltar para esse menu a qualquer momento digitando /admin.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("💳 Gateways de pagamento", "ADMIN_GATEWAYS")],
      [Markup.button.callback("💸 Métodos de pagamento", "ADMIN_METHODS")],
      [Markup.button.callback("📦 Meus Produtos", "ADMIN_PRODUCTS")],
      [Markup.button.callback("🏷 Meus Cupons", "ADMIN_COUPONS")],
      [Markup.button.callback("⚙️ Configurações", "ADMIN_SETTINGS")],
      [Markup.button.callback("❓ Ajuda e Suporte", "ADMIN_SUPPORT")]
    ])
  );
});

// Respostas temporárias (sem alterar sistema principal)
bot.action(/ADMIN_/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID)
    return ctx.answerCbQuery("Não autorizado.");

  await ctx.answerCbQuery();
  await ctx.reply("⚙️ Função em desenvolvimento.");
});

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
  expiration.setMinutes(expiration.getMinutes() + 30);

  const payment = await paymentClient.create({
    body: {
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
    }
  });

  const qr = payment.point_of_interaction.transaction_data.qr_code_base64;
  const pixCode = payment.point_of_interaction.transaction_data.qr_code;

  await Payment.create({
    telegramId: ctx.from.id,
    planType,
    amount,
    mpPaymentId: payment.id,
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
// ✅ JÁ PAGUEI
// =============================
bot.action("CHECK_PAYMENT", async (ctx) => {
  const payment = await Payment.findOne({
    telegramId: ctx.from.id,
    status: "pending"
  }).sort({ createdAt: -1 });

  if (!payment)
    return ctx.reply("❌ Nenhum pagamento pendente encontrado.");

  const mpPayment = await paymentClient.get({
    id: payment.mpPaymentId
  });

  if (mpPayment.status === "approved") {
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

  const mpPayment = await paymentClient.get({ id: paymentId });

  if (mpPayment.status !== "approved")
    return res.sendStatus(200);

  const { telegramId, planType } = mpPayment.metadata;
  const payment = await Payment.findOne({ mpPaymentId: paymentId });

  if (!payment || payment.status === "approved")
    return res.sendStatus(200);

  const settings = await Settings.findOne();
  const user = await User.findOne({ telegramId });

  if (mpPayment.transaction_amount !== payment.amount)
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
cron.schedule("*/10 * * * *", async () => {
  const now = new Date();
  const settings = await Settings.findOne();
  if (!settings) return;

  await Payment.deleteMany({
    status: "pending",
    expiresAt: { $lte: now }
  });

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
app.use(bot.webhookCallback("/webhook"));

app.get("/", (req, res) => {
  res.send("🚀 VIP PRO rodando...");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  await bot.telegram.setWebhook(`${process.env.RENDER_URL}/webhook`);
  console.log("🚀 Servidor iniciado");
});
