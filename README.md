# Blogg-taggning

Litet verktyg för att klassificera blogposterna på ambitiongrp.com som **story**, **news**
eller **event** inför migreringen till Framers CMS.

Noll npm-beroenden. Node 18+ (inbyggd `fetch`).

## Data

Två filer i `DATA_DIR` (`/data` i containern):

| Fil | Innehåll |
|---|---|
| `posts.json` | Cache av posterna från WordPress REST API, med fullt innehåll och bilder (~0,4 MB). Skrivs över vid varje hämtning. |
| `types.json` | **Sanningen.** `{"18929": "story", "18901": "news", ...}` — vilken typ varje post fått. |

Nya poster i WordPress dyker upp som otaggade automatiskt: en sidladdning hämtar om från
WP om cachen är äldre än `REFRESH_TTL_MS` (10 min som standard). Knappen **Hämta om**
tvingar fram en hämtning direkt. Redan satta typer rörs aldrig av en hämtning.

Bara publicerade poster hämtas (`status=publish`) — 113 st i skrivande stund.

## Ut till Framer

Knapparna **posts_story.json / posts_news.json / posts_event.json** i UI:t laddar ner en
fil per typ, i exakt det format som Framer-pluginet i `../WPFramerMigration/wpblogimport`
läser. Ingen mellanhand behövs — inget `wp_export.py`, ingen split.

Skapa tre managed collections i Framer (Stories, News, Events), öppna pluginet från var och
en och välj motsvarande fil. Pluginet laddar upp bilder till Framers CDN och synkar posterna.

Filformatet är verifierat fält för fält mot `export/wp_export.py` för alla 113 poster. Två
avvikelser, båda avsiktliga:

- `authorName` fylls i här (Python-exportern lämnade den alltid `null`).
- `raw` (hela WP-svaret) utelämnas — pluginet använder den inte.

## Kör lokalt

```sh
WP_BASE_URL=https://ambitiongrp.com node server.js
# http://localhost:8080
```

## Kör i Docker

```sh
docker compose up -d --build
```

Lyssnar bara på `127.0.0.1:5102` — Caddy är det som exponeras utåt.

## Deploy på Antec

Följer husets docker-mönster, men utan GitHub Actions-runner: verktyget är temporärt och
körs bara tills posterna är klassificerade.

```sh
git clone https://github.com/niklasforstberg/WordpressPostExportTypeClassifier.git \
  /home/deploy/wordpress-post-export-type-classifier
cd /home/deploy/wordpress-post-export-type-classifier
docker compose up -d --build
```

Port **5102** (5100 mynt, 5101 immoralsloth, 5146 precipio är tagna). `data/` skapas i
katalogen och innehåller cachen och `types.json` — det är den enda staten som betyder
något, ta en kopia innan du river containern.

Kedjan utåt är `posts.forstberg.net` → tunneln `forstberg` → Caddy → containern:

1. Lägg in `Caddyfile.snippet` i Caddyfilen, `caddy reload`. Blocket svarar på `http://`
   eftersom tunneln redan terminerat TLS — ett `https://`-block ger certifikatfel.
2. Lägg till hostnamnet i cloudflared-configen och DNS-posten `posts` → tunneln, precis
   som för `amalfi`.
3. Zero Trust → Access → Applications → Add: self-hosted, domän `posts.forstberg.net`.
   Policy: Allow, selector *Emails*, Nathalies adress och din egen. Engångskod på e-post
   kräver ingen identitetsleverantör.

Åtkomsten återkallas genom att ta bort hennes rad i policyn.

### Riva efteråt

```sh
docker compose down --rmi local
```

Ta sedan bort Caddy-blocket, hostnamnet i cloudflared, DNS-posten och Access-appen.

## API

| Metod | Väg | Beskrivning |
|---|---|---|
| GET | `/api/posts` | Poster ur cachen för listvyn, med `type` inmergad. Innehålls-HTML utelämnad. |
| GET | `/api/export/<story\|news\|event>` | Plugin-färdig `posts_<typ>.json` med alla poster av den typen. |
| GET | `/api/types` | Rå `types.json` som nedladdning (backup / manuell koll). |
| POST | `/api/type` | `{"id": 18929, "type": "story"}` — `type: null` rensar. Skrivningar serialiseras och filen byts atomärt. |
| POST | `/api/refresh` | Hämtar om från WordPress direkt. |

## Tangentbord

`1` story · `2` news · `3` event · `0`/backsteg rensa · `↑`/`↓` (eller `k`/`j`) flytta ·
`/` sök. När en typ sätts hoppar markeringen automatiskt vidare till nästa rad.

## Miljövariabler

| Variabel | Standard | |
|---|---|---|
| `WP_BASE_URL` | – | Krävs. Utan avslutande snedstreck. |
| `PORT` | `8080` | |
| `DATA_DIR` | `./data` | |
| `REFRESH_TTL_MS` | `600000` | |
| `WP_USER` / `WP_APP_PASSWORD` | – | Bara om REST-API:et låses. Det är publikt läsbart i dag. |
