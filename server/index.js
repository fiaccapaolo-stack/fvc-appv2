// FVC Project Srl — backend v2
const express = require("express");
const webpush = require("web-push");
const fs = require("fs");
const path = require("path");
const { Redis } = require("@upstash/redis");
const QRCode = require("qrcode");

const ROOT = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const SEED_OFFERS_FILE = path.join(DATA_DIR, "offers.json");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

async function getVapidKeys() {
  const stored = await redis.get("vapid_keys");
  if (stored) return typeof stored === "string" ? JSON.parse(stored) : stored;
  const keys = webpush.generateVAPIDKeys();
  await redis.set("vapid_keys", JSON.stringify(keys));
  return keys;
}

async function getSubscriptions() {
  const all = await redis.hgetall("subscriptions");
  if (!all) return [];
  return Object.values(all).map(v => typeof v === "string" ? JSON.parse(v) : v);
}
async function addSubscription(sub) {
  await redis.hset("subscriptions", { [sub.endpoint]: JSON.stringify(sub) });
}
async function removeSubscription(endpoint) {
  await redis.hdel("subscriptions", endpoint);
}

async function getOffers() {
  const all = await redis.hgetall("offers");
  if (!all) return [];
  const offers = Object.values(all).map(v => typeof v === "string" ? JSON.parse(v) : v);
  offers.sort((a,b) => (a.createdAt || 0) - (b.createdAt || 0));
  return offers;
}
async function saveOffer(offer) {
  await redis.hset("offers", { [offer.id]: JSON.stringify(offer) });
}
async function deleteOffer(id) {
  await redis.hdel("offers", id);
}
async function seedOffersIfEmpty() {
  if ((await getOffers()).length) return;
  const seed = readJSON(SEED_OFFERS_FILE, []);
  for (const offer of seed) await saveOffer({ ...offer, createdAt: Date.now() });
}

const DEFAULT_CONFIG = {
  shopName: "Fvc Project Srl",
  address: "Viale Indipendenza 57/a, 63100 Ascoli Piceno",
  phone: "0736 46354",
  phoneE164: "+39073646354",
  whatsapp: "333 123 456",
  whatsappLink: "https://wa.me/39333123456",
  publicUrl: "",
  hours: [
    { label: "Lunedì", value: "15:30 – 19:30" },
    { label: "Martedì – Sabato", value: "9:00 – 13:00, 15:30 – 19:30" },
    { label: "Domenica", value: "Chiuso" }
  ],
  products: [],
  plans: [],
  news: []
};

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.startsWith("39") ? `+${digits}` : `+39${digits}`;
}

/*
 * Compatibilità con i dati già presenti su Upstash:
 * - vecchio products.smartphone -> nuovo products[]
 * - vecchio carriers.* -> nuovo plans[]
 * - installments non viene più usato come catalogo separato
 *
 * Non vengono reintrodotti prodotti di default: se il catalogo era stato
 * svuotato, rimane vuoto.
 */
function normalizeProducts(list) {
  return (Array.isArray(list) ? list : []).map(p => ({
    ...p,
    installments: Array.isArray(p.installments) ? p.installments : [],
    rate: p.rate || p.installments?.[0]?.amount || ""
  }));
}

function migrateConfig(parsed) {
  const oldProducts = parsed && parsed.products;
  const rawProducts = Array.isArray(oldProducts)
    ? oldProducts
    : Array.isArray(oldProducts?.smartphone) ? oldProducts.smartphone : [];
  const products = normalizeProducts(rawProducts);

  const oldCarriers = parsed?.carriers || {};
  const plans = Array.isArray(parsed?.plans)
    ? parsed.plans
    : Object.entries(oldCarriers).flatMap(([carrier, items]) =>
        Array.isArray(items) ? items.map(p => ({ ...p, carrier })) : []
      );

  return {
    ...DEFAULT_CONFIG,
    ...(parsed || {}),
    products,
    plans,
    news: Array.isArray(parsed?.news) ? parsed.news : []
  };
}

async function getConfig() {
  const stored = await redis.get("config");
  if (!stored) return { ...DEFAULT_CONFIG };
  const parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
  return migrateConfig(parsed);
}

async function saveConfig(config) {
  await redis.set("config", JSON.stringify({
    ...DEFAULT_CONFIG,
    ...config,
    products: normalizeProducts(config.products),
    plans: Array.isArray(config.plans) ? config.plans : [],
    news: Array.isArray(config.news) ? config.news : []
  }));
}

async function seedConfigIfEmpty() {
  const stored = await redis.get("config");
  if (stored) return;
  await saveConfig(DEFAULT_CONFIG);
}

async function sendToAll(payload) {
  const subs = await getSubscriptions();
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error("Errore invio notifica:", err.statusCode, err.body || err.message);
      }
    }
  }
}

function requireAdmin(req, res, next) {
  const provided = req.header("x-admin-password");
  if (!process.env.ADMIN_PASSWORD || provided !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Password non corretta" });
  }
  next();
}

function publicConfig(cfg, offers) {
  return {
    ...cfg,
    products: Array.isArray(cfg.products) ? cfg.products : [],
    plans: Array.isArray(cfg.plans) ? cfg.plans : [],
    offers: offers.map(o => ({
      id: o.id,
      pct: o.pct || "",
      title: o.title || "",
      description: o.description ?? o.desc ?? "",
      heat: Number(o.heat) || 1,
      createdAt: o.createdAt || 0
    })),
    news: Array.isArray(cfg.news) ? cfg.news : []
  };
}

async function main() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error("Mancano UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN");
  }
  if (!process.env.ADMIN_PASSWORD) console.warn("ADMIN_PASSWORD non impostata.");

  const vapidKeys = await getVapidKeys();
  webpush.setVapidDetails(
    "mailto:negozio@example.com",
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );

  await seedOffersIfEmpty();
  await seedConfigIfEmpty();

  const app = express();
  app.use(express.json({ limit: "8mb" }));
  app.use(express.static(ROOT));

  app.get("/api/qr", async (req, res) => {
    try {
      const cfg = await getConfig();
      const appUrl = cfg.publicUrl || `${req.protocol}://${req.get("host")}`;
      const png = await QRCode.toBuffer(appUrl, { width: 700, margin: 2 });
      res.type("png").send(png);
    } catch (err) {
      console.error("Errore QR:", err);
      res.status(500).json({ error: "Impossibile generare il QR code" });
    }
  });

  app.get("/api/vapid-public-key", (req,res) => res.json({ publicKey: vapidKeys.publicKey }));

  app.get("/api/offers", async (req,res) => res.json(await getOffers()));

  app.get("/api/config", async (req,res) => {
    res.json(publicConfig(await getConfig(), await getOffers()));
  });

  app.post("/api/subscribe", async (req,res) => {
    const sub = req.body;
    if (!sub || !sub.endpoint) return res.status(400).json({error:"Iscrizione non valida"});
    await addSubscription(sub);
    res.status(201).json({ok:true});
  });

  app.post("/api/unsubscribe", async (req,res) => {
    const {endpoint} = req.body || {};
    if (endpoint) await removeSubscription(endpoint);
    res.json({ok:true});
  });

  app.post("/api/admin/check", requireAdmin, (req,res) => res.json({ok:true}));

  app.get("/api/admin/config", requireAdmin, async (req,res) => {
    res.json(publicConfig(await getConfig(), await getOffers()));
  });

  app.put("/api/admin/config", requireAdmin, async (req,res) => {
    const current = await getConfig();
    const {notify, ...body} = req.body || {};
    const updated = {
      ...current,
      ...body,
      products: Array.isArray(body.products) ? body.products : current.products,
      plans: Array.isArray(body.plans) ? body.plans : current.plans,
      news: Array.isArray(body.news) ? body.news : current.news
    };
    if (body.phone !== undefined) {
      updated.phoneE164 = normalizePhone(body.phone);
    }
    if (body.whatsapp !== undefined) {
      const n = normalizePhone(body.whatsapp);
      updated.whatsappLink = n ? `https://wa.me/${n.replace("+","")}` : "";
    }
    await saveConfig(updated);
    if (notify?.body) {
      await sendToAll({title: notify.title || `${updated.shopName} · Novità`, body: notify.body});
    }
    res.json(publicConfig(updated, await getOffers()));
  });

  app.get("/api/admin/offers", requireAdmin, async (req,res) => res.json(await getOffers()));

  app.post("/api/admin/offers", requireAdmin, async (req,res) => {
    const {id,pct,title,desc,description,heat} = req.body || {};
    if (!id || !pct || !title) return res.status(400).json({error:"Compila almeno id, sconto e titolo"});
    const existing = await getOffers();
    if (existing.some(o => o.id === id)) return res.status(409).json({error:"Esiste già un'offerta con questo id"});
    const offer = {id,pct,title,desc:description ?? desc ?? "",heat:Number(heat)||1,createdAt:Date.now()};
    await saveOffer(offer);
    res.status(201).json(offer);
  });

  app.put("/api/admin/offers/:id", requireAdmin, async (req,res) => {
    const existing = await getOffers();
    const current = existing.find(o => o.id === req.params.id);
    if (!current) return res.status(404).json({error:"Offerta non trovata"});
    const {pct,title,desc,description,heat} = req.body || {};
    const updated = {
      ...current,
      pct: pct ?? current.pct,
      title: title ?? current.title,
      desc: description ?? desc ?? current.desc ?? "",
      heat: heat !== undefined ? Number(heat) : current.heat
    };
    await saveOffer(updated);
    res.json(updated);
  });

  app.delete("/api/admin/offers/:id", requireAdmin, async (req,res) => {
    await deleteOffer(req.params.id);
    res.json({ok:true});
  });

  app.post("/api/admin/notify", requireAdmin, async (req,res) => {
    const {title,body} = req.body || {};
    if (!body) return res.status(400).json({error:"Scrivi almeno il testo del messaggio"});
    const cfg = await getConfig();
    await sendToAll({title:title || `${cfg.shopName} · Novità`,body});
    res.json({ok:true});
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`FVC App v2 backend attivo sulla porta ${PORT}`));
}

main().catch(err => {
  console.error("Avvio server fallito:", err);
  process.exit(1);
});
