// Server Fvc Project Srl
// - Serve i file della PWA (index.html, manifest, service worker, icone)
// - Serve il pannello di gestione offerte protetto da password (admin.html)
// - Riceve le iscrizioni alle notifiche dai telefoni dei clienti
// - Quando crei una nuova offerta dal pannello, la notifica parte in automatico
//
// Tutti i dati (offerte, iscrizioni, offerte gia' notificate, chiavi di
// sicurezza) sono salvati su Upstash Redis, un database gratuito che non
// si cancella mai a ogni riavvio o nuovo deploy di Render.

const express = require("express");
const webpush = require("web-push");
const fs = require("fs");
const path = require("path");
const { Redis } = require("@upstash/redis");
const QRCode = require("qrcode");

const ROOT = path.join(__dirname, "public"); // cartella della PWA (index.html, sw.js, ecc.)
const DATA_DIR = path.join(__dirname, "data");
const SEED_OFFERS_FILE = path.join(DATA_DIR, "offers.json"); // solo per il primo avvio

if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  console.error(
    "Mancano le variabili UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN.\n" +
    "Vai su upstash.com, crea un database Redis gratuito e imposta queste due\n" +
    "variabili d'ambiente su Render (vedi README.md)."
  );
}
if (!process.env.ADMIN_PASSWORD) {
  console.warn(
    "ATTENZIONE: variabile ADMIN_PASSWORD non impostata. Il pannello di " +
    "gestione offerte (admin.html) non sara' accessibile finche' non la imposti."
  );
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// ---- Chiavi VAPID: generate una sola volta e salvate su Redis ----
async function getVapidKeys() {
  const stored = await redis.get("vapid_keys");
  if (stored) return typeof stored === "string" ? JSON.parse(stored) : stored;
  const keys = webpush.generateVAPIDKeys();
  await redis.set("vapid_keys", JSON.stringify(keys));
  console.log("Nuove chiavi VAPID generate e salvate su Upstash (una sola volta).");
  return keys;
}

// ---- Iscrizioni alle notifiche: hash Redis, chiave = endpoint del browser ----
async function getSubscriptions() {
  const all = await redis.hgetall("subscriptions");
  if (!all) return [];
  return Object.values(all).map((v) => (typeof v === "string" ? JSON.parse(v) : v));
}
async function addSubscription(sub) {
  await redis.hset("subscriptions", { [sub.endpoint]: JSON.stringify(sub) });
}
async function removeSubscription(endpoint) {
  await redis.hdel("subscriptions", endpoint);
}

// ---- Offerte: hash Redis, chiave = id dell'offerta ----
async function getOffers() {
  const all = await redis.hgetall("offers");
  if (!all) return [];
  const offers = Object.values(all).map((v) => (typeof v === "string" ? JSON.parse(v) : v));
  offers.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return offers;
}
async function saveOffer(offer) {
  await redis.hset("offers", { [offer.id]: JSON.stringify(offer) });
}
async function deleteOffer(id) {
  await redis.hdel("offers", id);
}
// Al primissimo avvio in assoluto, se su Redis non c'e' ancora nessuna
// offerta, importiamo le 3 di esempio dal file locale (non generano notifica:
// sono solo il punto di partenza).
async function seedOffersIfEmpty() {
  const existing = await getOffers();
  if (existing.length > 0) return;
  const seed = readJSON(SEED_OFFERS_FILE, []);
  for (const offer of seed) {
    await saveOffer({ ...offer, createdAt: Date.now() });
  }
  if (seed.length) console.log(`Importate ${seed.length} offerte di esempio su Upstash.`);
}

// ---- Configurazione generale del negozio: nome, indirizzo, contatti,
// orari, catalogo prodotti. Un solo oggetto JSON salvato su Redis. ----
const DEFAULT_CONFIG = {
  shopName: "Fvc Project Srl",
  address: "Viale Indipendenza 57/a, 63100 Ascoli Piceno",
  phone: "0736 46354",
  phoneE164: "+39073646354",
  whatsapp: "333 123 456",
  whatsappLink: "https://wa.me/39333123456",
  hours: [
    { label: "Lunedì", value: "15:30 – 19:30" },
    { label: "Martedì – Sabato", value: "9:00 – 13:00, 15:30 – 19:30" },
    { label: "Domenica", value: "Chiuso" },
  ],
  products: {
    smartphone: [
      { name: "iPhone 15", spec: "128GB · Nero", price: "799€", stock: 4 },
      { name: "Galaxy S24", spec: "256GB · Grigio", price: "729€", stock: 3 },
      { name: "Redmi Note 13", spec: "128GB · Blu", price: "229€", stock: 4 },
      { name: "Pixel 8a", spec: "128GB · Verde", price: "459€", stock: 2 },
    ],
    accessori: [
      { name: "Cover silicone", spec: "Universale", price: "14,90€", stock: 4 },
      { name: "Vetro temperato", spec: "9H · Anti-impronta", price: "9,90€", stock: 4 },
      { name: "Caricatore 20W", spec: "USB-C · Ricarica rapida", price: "19,90€", stock: 3 },
      { name: "Auricolari BT", spec: "Bluetooth 5.3", price: "34,90€", stock: 2 },
    ],
    ricambi: [
      { name: "Batteria iPhone", spec: "Varie generazioni", price: "da 39€", stock: 3 },
      { name: "Display Samsung", spec: "Varie generazioni", price: "da 79€", stock: 2 },
      { name: "Vetro posteriore", spec: "Varie generazioni", price: "da 29€", stock: 3 },
      { name: "Connettore ricarica", spec: "Universale", price: "da 19€", stock: 4 },
    ],
  },
  // Piani telefonia mobile e fibra, divisi per gestore
  carriers: {
    tim: [
      { name: "Tim Power Iron", type: "mobile", price: "9,99€/mese", details: "150GB, minuti e SMS illimitati" },
    ],
    wind: [
      { name: "WindTre Go Unlimited", type: "mobile", price: "11,99€/mese", details: "Giga illimitati, minuti illimitati" },
    ],
    sky: [
      { name: "Sky Wifi", type: "fibra", price: "29,95€/mese", details: "Fibra fino a 1 Giga, modem incluso" },
    ],
    lyca: [
      { name: "Lycamobile Italia 100", type: "mobile", price: "7,99€/mese", details: "100GB, minuti illimitati" },
    ],
    very: [
      { name: "VeryMobile 150GB", type: "mobile", price: "5,99€/mese", details: "150GB, minuti illimitati" },
    ],
    kena: [
      { name: "Kena 150GB", type: "mobile", price: "7,99€/mese", details: "150GB, minuti illimitati" },
    ],
  },
  // Piani di rateizzazione telefono offerti dai gestori (es. TIM, WindTre)
  installments: {
    tim: [
      { name: "iPhone 15 a rate con TIM", price: "24 rate da 33,29€/mese", details: "TAN 0% TAEG 0%, nessuna spesa aggiuntiva" },
    ],
    wind: [
      { name: "Galaxy S24 a rate con WindTre", price: "30 rate da 25,90€/mese", details: "Anticipo 0€, TAN 0% TAEG 0%" },
    ],
    sky: [],
    lyca: [],
    very: [],
    kena: [],
  },
};

async function getConfig() {
  const stored = await redis.get("config");
  if (!stored) return null;
  const parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
  // Se la configurazione era gia' salvata prima dell'introduzione di un
  // campo nuovo (es. "carriers"), lo aggiungiamo qui coi valori di partenza,
  // senza toccare il resto di quello che il negozio ha gia' personalizzato.
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    products: parsed.products || DEFAULT_CONFIG.products,
    carriers: parsed.carriers || DEFAULT_CONFIG.carriers,
    installments: parsed.installments || DEFAULT_CONFIG.installments,
  };
}
async function saveConfig(config) {
  await redis.set("config", JSON.stringify(config));
}
async function seedConfigIfEmpty() {
  const existing = await getConfig();
  if (existing) return;
  await saveConfig(DEFAULT_CONFIG);
  console.log("Configurazione di partenza (nome, indirizzo, catalogo) salvata su Upstash.");
}

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.startsWith("39") ? `+${digits}` : `+39${digits}`;
}

async function sendToAll(payload) {
  const subs = await getSubscriptions();
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
    } catch (err) {
      const code = err.statusCode;
      if (code === 404 || code === 410) {
        await removeSubscription(sub.endpoint); // iscrizione scaduta
      } else {
        console.error("Errore invio notifica:", code, err.body);
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

async function main() {
  const vapidKeys = await getVapidKeys();
  webpush.setVapidDetails(
    "mailto:negozio@example.com", // sostituisci con una tua email di contatto
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );
  await seedOffersIfEmpty();
  await seedConfigIfEmpty();

  const app = express();
  app.use(express.json({ limit: "8mb" })); // aumentato per permettere le foto caricate dal pannello
  app.use(express.static(ROOT));


  // QR pubblico dell'app: la home lo richiede tramite <img src="/api/qr">.
  app.get("/api/qr", async (req, res) => {
    try {
      const config = (await getConfig()) || DEFAULT_CONFIG;
      const appUrl = config.publicUrl || `${req.protocol}://${req.get("host")}`;
      const png = await QRCode.toBuffer(appUrl, { width: 700, margin: 2 });
      res.type("png").send(png);
    } catch (err) {
      console.error("Errore generazione QR:", err);
      res.status(500).json({ error: "Impossibile generare il QR code" });
    }
  });

  // ---- endpoint pubblici, usati dalla app dei clienti ----
  app.get("/api/vapid-public-key", (req, res) => {
    res.json({ publicKey: vapidKeys.publicKey });
  });

  app.get("/api/offers", async (req, res) => {
    res.json(await getOffers());
  });

  app.get("/api/config", async (req, res) => {
    res.json((await getConfig()) || DEFAULT_CONFIG);
  });

  app.post("/api/subscribe", async (req, res) => {
    const sub = req.body;
    if (!sub || !sub.endpoint) {
      return res.status(400).json({ error: "Iscrizione non valida" });
    }
    await addSubscription(sub);
    res.status(201).json({ ok: true });
  });

  app.post("/api/unsubscribe", async (req, res) => {
    const { endpoint } = req.body || {};
    if (endpoint) await removeSubscription(endpoint);
    res.json({ ok: true });
  });

  // ---- endpoint del pannello di gestione, protetti da password ----
  app.post("/api/admin/check", requireAdmin, (req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/admin/offers", requireAdmin, async (req, res) => {
    res.json(await getOffers());
  });

  app.get("/api/admin/config", requireAdmin, async (req, res) => {
    res.json((await getConfig()) || DEFAULT_CONFIG);
  });

  // Aggiorna solo i campi inviati (nome/indirizzo/telefono/orari/catalogo),
  // lasciando invariato il resto della configurazione. Se il pannello manda
  // anche un campo "notify" ({title, body}), avvisa subito tutti gli iscritti.
  app.put("/api/admin/config", requireAdmin, async (req, res) => {
    console.log("DEBUG: ricevuto PUT /api/admin/config, campi:", Object.keys(req.body || {}));
    const current = (await getConfig()) || DEFAULT_CONFIG;
    const { notify, ...body } = req.body || {};
    const updated = { ...current, ...body };
    if (body.phone !== undefined) {
      updated.phone = body.phone;
      updated.phoneE164 = normalizePhone(body.phone);
    }
    if (body.whatsapp !== undefined) {
      updated.whatsapp = body.whatsapp;
      updated.whatsappLink = `https://wa.me/${normalizePhone(body.whatsapp).replace("+", "")}`;
    }
    await saveConfig(updated);
    if (notify && notify.body) {
      console.log("Modifica pubblicata dal pannello, invio notifica:", notify.body);
      await sendToAll({ title: notify.title || `${updated.shopName} · Novità`, body: notify.body });
    }
    res.json(updated);
  });

  app.post("/api/admin/offers", requireAdmin, async (req, res) => {
    const { id, pct, title, desc, heat } = req.body || {};
    if (!id || !pct || !title) {
      return res.status(400).json({ error: "Compila almeno id, sconto e titolo" });
    }
    const existing = await getOffers();
    if (existing.find((o) => o.id === id)) {
      return res.status(409).json({ error: "Esiste gia' un'offerta con questo id" });
    }
    const offer = { id, pct, title, desc: desc || "", heat: Number(heat) || 1, createdAt: Date.now() };
    await saveOffer(offer);
    const cfg = (await getConfig()) || DEFAULT_CONFIG;
    await sendToAll({
      title: `${cfg.shopName} · Nuova offerta`,
      body: `${offer.title}: ${offer.pct}${offer.desc ? ` · ${offer.desc}` : ""}`,
    });
    res.status(201).json(offer);
  });

  app.put("/api/admin/offers/:id", requireAdmin, async (req, res) => {
    const { id } = req.params;
    const existing = await getOffers();
    const current = existing.find((o) => o.id === id);
    if (!current) return res.status(404).json({ error: "Offerta non trovata" });
    const { pct, title, desc, heat } = req.body || {};
    const updated = {
      ...current,
      pct: pct ?? current.pct,
      title: title ?? current.title,
      desc: desc ?? current.desc,
      heat: heat !== undefined ? Number(heat) : current.heat,
    };
    await saveOffer(updated);
    const cfg = (await getConfig()) || DEFAULT_CONFIG;
    await sendToAll({
      title: `${cfg.shopName} · Offerta aggiornata`,
      body: `${updated.title}: ${updated.pct}${updated.desc ? ` · ${updated.desc}` : ""}`,
    });
    res.json(updated);
  });

  app.delete("/api/admin/offers/:id", requireAdmin, async (req, res) => {
    await deleteOffer(req.params.id);
    res.json({ ok: true });
  });

  // Invio manuale extra: da usare per annunci non legati a una singola
  // modifica (es. auguri, eventi, avvisi generali).
  app.post("/api/admin/notify", requireAdmin, async (req, res) => {
    const { title, body } = req.body || {};
    if (!body) return res.status(400).json({ error: "Scrivi almeno il testo del messaggio" });
    const cfg = (await getConfig()) || DEFAULT_CONFIG;
    console.log("Notifica manuale inviata dal pannello:", body);
    await sendToAll({ title: title || `${cfg.shopName} · Novità`, body });
    res.json({ ok: true });
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Fvc Project [build-check-v3] attivo su http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Errore all'avvio del server:", err);
  process.exit(1);
});
