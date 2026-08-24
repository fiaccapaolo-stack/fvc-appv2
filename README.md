# FVC App v2

Nuova PWA per catalogo, offerte, telefonia/fibra, notifiche e QR code dinamico.

## Deploy su Render

1. Carica tutti i file di questa cartella in un repository GitHub vuoto.
2. Crea un Web Service Render dal repository oppure usa `render.yaml`.
3. Configura `ADMIN_PASSWORD`, `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`.
4. Le chiavi delle notifiche sono create automaticamente e salvate in Upstash con un nome riservato alla v2: non servono chiavi VAPID su Render. Facoltativamente puoi impostare `VAPID_SUBJECT` con un indirizzo `mailto:` del negozio.
5. Inserisci l'URL pubblico Render dal pannello Admin: il QR code verrà aggiornato automaticamente.
