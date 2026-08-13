const express = require('express');
const { Redis } = require('@upstash/redis');
const QRCode = require('qrcode');
const webpush = require('web-push');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const redis = Redis.fromEnv();
const CONFIG_KEY = 'fvc:v2:config';
const SUBS_KEY = 'fvc:v2:subscriptions';

const DEFAULT_CONFIG = {
  shopName: 'FVC Project', address: '', phone: '', whatsapp: '', publicUrl: '',
  products: [], offers: [], plans: [], news: [], updatedAt: null
};

async function getConfig() {
  const stored = await redis.get(CONFIG_KEY);
  return { ...DEFAULT_CONFIG, ...(stored || {}), news: Array.isArray(stored?.news) ? stored.news : [] };
}
async function saveConfig(config) { await redis.set(CONFIG_KEY, config); return config; }
function admin(req, res, next) {
  if (!process.env.ADMIN_PASSWORD || req.get('x-admin-password') !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Accesso non autorizzato' });
  }
  next();
}
function vapidReady() {
  return process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT;
}
if (vapidReady()) webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
async function notifyAll(payload) {
  if (!vapidReady()) return;
  const subscriptions = (await redis.get(SUBS_KEY)) || [];
  const alive = [];
  for (const subscription of subscriptions) {
    try { await webpush.sendNotification(subscription, JSON.stringify(payload)); alive.push(subscription); }
    catch (error) { if (![404, 410].includes(error.statusCode)) { console.error('Push:', error.message); alive.push(subscription); } }
  }
  await redis.set(SUBS_KEY, alive);
}
function makeNews(section, title, description) {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, section, title, description, createdAt: Date.now() };
}

app.get('/api/config', async (_req, res) => {
  const config = await getConfig();
  const { news, ...publicConfig } = config;
  res.json({ ...publicConfig, news: news.slice(0, 3) });
});
app.get('/api/qr', async (req, res) => {
  const config = await getConfig();
  const url = config.publicUrl || `${req.protocol}://${req.get('host')}`;
  const png = await QRCode.toBuffer(url, { width: 700, margin: 2, color: { dark: '#101827', light: '#ffffff' } });
  res.type('png').send(png);
});
app.get('/api/vapid-public-key', (_req, res) => res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' }));
app.post('/api/subscribe', async (req, res) => {
  if (!req.body?.endpoint) return res.status(400).json({ error: 'Iscrizione non valida' });
  const current = (await redis.get(SUBS_KEY)) || [];
  if (!current.some(item => item.endpoint === req.body.endpoint)) await redis.set(SUBS_KEY, [...current, req.body]);
  res.status(201).json({ ok: true });
});

app.get('/api/admin/config', admin, async (_req, res) => res.json(await getConfig()));

/* Verifica password Admin: richiesta dal pannello admin.html. */
app.post('/api/admin/check', admin, (_req, res) => {
  res.json({ ok: true });
});

app.put('/api/admin/config', admin, async (req, res) => {
  const current = await getConfig();
  const body = req.body || {};
  const updated = { ...current, ...body, news: current.news, updatedAt: Date.now() };
  await saveConfig(updated);
  res.json(updated);
});
app.post('/api/admin/publish', admin, async (req, res) => {
  const { section, title, description } = req.body || {};
  if (!['catalogo', 'telefonia', 'offerte'].includes(section) || !title) return res.status(400).json({ error: 'Dati pubblicazione non validi' });
  const current = await getConfig();
  const news = makeNews(section, title, description || 'Aggiornamento disponibile.');
  const updated = { ...current, news: [news, ...current.news].slice(0, 3), updatedAt: Date.now() };
  await saveConfig(updated);
  await notifyAll({ title: `${updated.shopName} · ${title}`, body: news.description });
  res.json({ ok: true, news, config: updated });
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(process.env.PORT || 3000, () => console.log('FVC App v2 avviata'));
