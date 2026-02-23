require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const { Telegraf, Markup } = require("telegraf");
const { MercadoPagoConfig, Payment: MpPayment } = require("mercadopago");

const app = express();
app.use(express.json());

const ADMIN_ID = Number(process.env.ADMIN_ID);

// =============================
// ✅ MERCADO PAGO
// =============================
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
  vipGroupId: String,
  productName: String,
  productDescription: String,
  productType: String, // monthly ou lifetime
  monthlyPrice: Number,
  lifetimePrice: Number,
  monthlyDays: Number,
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
// 👑 PAINEL ADMIN
// =============================
bot.command("admin", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID)
    return ctx.reply("❌ Você não é administrador.");

  ctx.reply(
`⚙️ Painel Administrador

Olá, ${ctx.from.first_name}!`,
    Markup.inlineKeyboard([
      [Markup.button.callback("📦 Gerenciar Produto", "ADMIN_PRODUCTS")]
    ])
  );
});

// =============================
// 📦 GERENCIAR PRODUTO
// =============================
let productCreation = null;

bot.action("ADMIN_PRODUCTS", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  const settings = await Settings.findOne();

  await ctx.editMessageText(
`📦 Produto Atual

Nome: ${settings?.productName || "Não definido"}
Tipo: ${settings?.productType || "Não definido"}
Preço: ${
  settings?.productType === "monthly"
    ? settings?.monthlyPrice || "Não definido"
    : settings?.lifetimePrice || "Não definido"
}

Descrição:
${settings?.productDescription || "Não definida"}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("➕ Criar / Atualizar Produto", "CREATE_PRODUCT")],
      [Markup.button.callback("👑 Definir Grupo VIP", "SET_GROUP")]
    ])
  );
});

// Iniciar criação
bot.action("CREATE_PRODUCT", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  productCreation = {};
  ctx.reply("📌 Envie o NOME do produto:");
});

// Fluxo sequencial
bot.on("text", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  if (!productCreation) return;

  if (!productCreation.name) {
    productCreation.name = ctx.message.text;
    return ctx.reply("📝 Envie a DESCRIÇÃO:");
  }

  if (!productCreation.description) {
    productCreation.description = ctx.message.text;
    return ctx.reply("💰 Envie o PREÇO (somente número):");
  }

  if (!productCreation.price) {
    const price = Number(ctx.message.text);
    if (isNaN(price)) return ctx.reply("❌ Digite apenas número.");

    productCreation.price = price;

    return ctx.reply(
      "📦 Tipo de acesso:",
      Markup.inlineKeyboard([
        [Markup.button.callback("📅 Mensal", "TYPE_MONTHLY")],
        [Markup.button.callback("♾ Vitalício", "TYPE_LIFETIME")]
      ])
    );
  }
});

// Tipo mensal
bot.action("TYPE_MONTHLY", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  await Settings.updateOne(
    {},
    {
      productName: productCreation.name,
      productDescription: productCreation.description,
      monthlyPrice: productCreation.price,
      productType: "monthly"
    },
    { upsert: true }
  );

  productCreation = null;
  ctx.reply("✅ Produto mensal criado com sucesso!");
});

// Tipo vitalício
bot.action("TYPE_LIFETIME", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  await Settings.updateOne(
    {},
    {
      productName: productCreation.name,
      productDescription: productCreation.description,
      lifetimePrice: productCreation.price,
      productType: "lifetime"
    },
    { upsert: true }
  );

  productCreation = null;
  ctx.reply("✅ Produto vitalício criado com sucesso!");
});

// Definir grupo
bot.action("SET_GROUP", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  ctx.reply("Vá até o grupo VIP e envie uma mensagem para eu detectar automaticamente.");
});

bot.on("message", async (ctx) => {
  if (!ctx.chat || ctx.chat.type === "private") return;
  if (ctx.from.id !== ADMIN_ID) return;

  await Settings.updateOne({}, { vipGroupId: ctx.chat.id }, { upsert: true });
  ctx.reply("✅ Grupo VIP definido!");
});

// =============================
// 🚀 START USUÁRIO
// =============================
bot.start(async (ctx) => {
  const settings = await Settings.findOne();
  if (!settings) return ctx.reply("⚙ Produto não configurado.");

  let user = await User.findOne({ telegramId: ctx.from.id });
  if (!user) {
    user = await User.create({
      telegramId: ctx.from.id,
      username: ctx.from.username
    });
  }

  let button;

  if (settings.productType === "monthly") {
    button = Markup.button.callback("📅 Comprar Acesso", "BUY_MONTHLY");
  } else {
    button = Markup.button.callback("♾ Comprar Acesso", "BUY_LIFETIME");
  }

  ctx.reply(
`🔒 ${settings.productName}

${settings.productDescription}`,
    Markup.inlineKeyboard([[button]])
  );
});

// =============================
// 💳 PAGAMENTO
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
      payer: { email: `user${ctx.from.id}@vip.com` },
      metadata: { telegramId: ctx.from.id, planType }
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

  await ctx.replyWithPhoto(Buffer.from(qr, "base64"), {
    caption: `💳 ${description}
Valor: R$${amount}
⏳ Expira em 30 minutos

PIX Copia e Cola:
${pixCode}`
  });
}

bot.action("BUY_MONTHLY", async (ctx) => {
  const settings = await Settings.findOne();
  await createPixPayment(ctx, "monthly", settings.monthlyPrice, settings.productName);
});

bot.action("BUY_LIFETIME", async (ctx) => {
  const settings = await Settings.findOne();
  await createPixPayment(ctx, "lifetime", settings.lifetimePrice, settings.productName);
});

// =============================
// 💰 WEBHOOK
// =============================
app.post("/payment-webhook", async (req, res) => {
  if (req.body.type !== "payment") return res.sendStatus(200);

  const paymentId = req.body.data.id;
  const mpPayment = await paymentClient.get({ id: paymentId });
  if (mpPayment.status !== "approved") return res.sendStatus(200);

  const { telegramId, planType } = mpPayment.metadata;
  const payment = await Payment.findOne({ mpPaymentId: paymentId });
  if (!payment || payment.status === "approved") return res.sendStatus(200);

  const settings = await Settings.findOne();
  const user = await User.findOne({ telegramId });

  payment.status = "approved";
  await payment.save();

  settings.totalRevenue += payment.amount;
  await settings.save();

  if (planType === "monthly") {
    const expiration = new Date();
    expiration.setDate(expiration.getDate() + (settings.monthlyDays || 30));
    user.status = "active";
    user.expiresAt = expiration;
  }

  if (planType === "lifetime") {
    user.status = "active";
    user.lifetime = true;
  }

  await user.save();

  await bot.telegram.unbanChatMember(settings.vipGroupId, telegramId);
  await bot.telegram.sendMessage(
    telegramId,
    settings.approvedMessage || "✅ Pagamento aprovado!"
  );

  res.sendStatus(200);
});

// =============================
app.use(bot.webhookCallback("/webhook"));

app.listen(process.env.PORT || 3000, async () => {
  await bot.telegram.setWebhook(`${process.env.RENDER_URL}/webhook`);
  console.log("🚀 Servidor iniciado");
});
