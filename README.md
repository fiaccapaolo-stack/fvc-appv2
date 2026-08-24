# FVC App v2

Nuova PWA per catalogo, offerte, telefonia/fibra, notifiche e QR code dinamico.

## Deploy su Render

1. Carica tutti i file di questa cartella in un repository GitHub vuoto.
2. Crea un Web Service Render dal repository oppure usa `render.yaml`.
3. Configura `ADMIN_PASSWORD`, `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`.
4. Per le notifiche configura anche le tre variabili VAPID. Senza queste l'app funziona, ma il pulsante notifiche resta inattivo.
5. Inserisci l'URL pubblico Render dal pannello Admin: il QR code verrà aggiornato automaticamente.
