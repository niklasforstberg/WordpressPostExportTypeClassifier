'use strict';

const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const WP_BASE_URL = (process.env.WP_BASE_URL || '').replace(/\/+$/, '');
const WP_USER = process.env.WP_USER || '';
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || '';
const REFRESH_TTL_MS = Number(process.env.REFRESH_TTL_MS || 10 * 60 * 1000);

const POSTS_FILE = path.join(DATA_DIR, 'posts.json');
const TYPES_FILE = path.join(DATA_DIR, 'types.json');
const VALID_TYPES = new Set(['story', 'news', 'event']);

// --- filer -----------------------------------------------------------------

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
  await fsp.rename(tmp, file);
}

// Serialiserar alla skrivningar till types.json.
let writeQueue = Promise.resolve();
function serialized(fn) {
  const result = writeQueue.then(fn, fn);
  writeQueue = result.then(() => {}, () => {});
  return result;
}

// --- WordPress -------------------------------------------------------------

const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', shy: '', bull: '•',
};

function decodeEntities(s) {
  return String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const key = name.toLowerCase();
      return key in NAMED_ENTITIES ? NAMED_ENTITIES[key] : m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

async function wpFetchAll(resource, params) {
  if (!WP_BASE_URL) throw new Error('WP_BASE_URL saknas');
  const headers = { Accept: 'application/json' };
  if (WP_USER && WP_APP_PASSWORD) {
    headers.Authorization =
      'Basic ' + Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');
  }

  const out = [];
  let page = 1;
  let totalPages = 1;
  do {
    const url = new URL(`${WP_BASE_URL}/wp-json/wp/v2/${resource}`);
    for (const [k, v] of Object.entries({ per_page: 100, page, ...params })) {
      url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`WP ${resource} svarade ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    totalPages = Number(res.headers.get('x-wp-totalpages')) || 1;
    out.push(...(await res.json()));
    page += 1;
  } while (page <= totalPages);
  return out;
}

// Plockar ut <img>-taggar ur HTML, samma fältformat som Framer-pluginet väntar sig.
function parseImgTags(html, source) {
  const out = [];
  for (const tag of String(html || '').match(/<img\b[^>]*>/gi) || []) {
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
    if (!src) continue;
    const alt = tag.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1];
    out.push({
      originalUrl: src,
      localPath: null,
      alt: alt ? decodeEntities(alt) : '',
      source,
      wpMediaId: null,
    });
  }
  return out;
}

async function refreshPosts() {
  const [posts, categories, tags] = await Promise.all([
    wpFetchAll('posts', { status: 'publish', orderby: 'date', order: 'desc', _embed: 1 }),
    wpFetchAll('categories', { _fields: 'id,name' }),
    wpFetchAll('tags', { _fields: 'id,name' }),
  ]);

  const catName = new Map(categories.map((c) => [c.id, decodeEntities(c.name)]));
  const tagName = new Map(tags.map((t) => [t.id, decodeEntities(t.name)]));

  const simplified = posts.map((p) => {
    const contentHtml = p.content?.rendered || '';
    const excerptHtml = p.excerpt?.rendered || '';

    const media = p._embedded?.['wp:featuredmedia']?.[0];
    const featuredImage = media?.source_url
      ? {
          originalUrl: media.source_url,
          localPath: null,
          alt: media.alt_text || '',
          source: 'featured',
          wpMediaId: media.id ?? null,
        }
      : null;

    const images = [];
    const seen = new Set();
    for (const img of [
      ...(featuredImage ? [featuredImage] : []),
      ...parseImgTags(contentHtml, 'content'),
      ...parseImgTags(excerptHtml, 'excerpt'),
    ]) {
      if (seen.has(img.originalUrl)) continue;
      seen.add(img.originalUrl);
      images.push(img);
    }

    const publishedAt = p.date_gmt || p.date || null;

    return {
      // Fält som Framer-pluginet läser
      sourceWpId: p.id,
      title: decodeEntities(p.title?.rendered || ''),
      slug: p.slug,
      publishedAt: publishedAt && !publishedAt.endsWith('Z') ? `${publishedAt}Z` : publishedAt,
      excerptHtml,
      contentHtml,
      authorName: p._embedded?.author?.[0]?.name || null,
      images,
      featuredImage,
      galleryImages: images.filter((i) => i.source !== 'featured'),
      // Fält som bara taggnings-UI:t använder
      id: p.id,
      date: (p.date || '').slice(0, 10),
      link: p.link,
      excerpt: decodeEntities(excerptHtml).slice(0, 400),
      categories: (p.categories || []).map((id) => catName.get(id)).filter(Boolean),
      tags: (p.tags || []).map((id) => tagName.get(id)).filter(Boolean),
    };
  });

  await writeJsonAtomic(POSTS_FILE, { fetchedAt: new Date().toISOString(), posts: simplified });
  return simplified.length;
}

async function ensureFresh() {
  const cache = await readJson(POSTS_FILE, null);
  const age = cache ? Date.now() - Date.parse(cache.fetchedAt) : Infinity;
  if (age > REFRESH_TTL_MS) {
    try {
      await refreshPosts();
    } catch (err) {
      console.error('refresh misslyckades:', err.message);
      if (!cache) throw err;
    }
  }
}

// --- http ------------------------------------------------------------------

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e5) reject(new Error('body för stor'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

async function serveStatic(req, res) {
  const rel = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'nope' });
  try {
    const body = await fsp.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/posts') {
      await ensureFresh();
      const [cache, types] = await Promise.all([
        readJson(POSTS_FILE, { fetchedAt: null, posts: [] }),
        readJson(TYPES_FILE, {}),
      ]);
      // Innehålls-HTML:en behövs bara i exporten, inte i listvyn.
      return sendJson(res, 200, {
        fetchedAt: cache.fetchedAt,
        posts: cache.posts.map(({ contentHtml, excerptHtml, images, galleryImages, ...p }) => ({
          ...p,
          type: types[String(p.id)] || null,
        })),
      });
    }

    // Plugin-färdig fil för en typ: samma format som WPFramerMigration/export/wp_export.py.
    const exportMatch = url.pathname.match(/^\/api\/export\/(\w+)$/);
    if (req.method === 'GET' && exportMatch) {
      const type = exportMatch[1];
      if (!VALID_TYPES.has(type)) return sendJson(res, 404, { error: 'okänd typ' });
      await ensureFresh();
      const [cache, types] = await Promise.all([
        readJson(POSTS_FILE, { fetchedAt: null, posts: [] }),
        readJson(TYPES_FILE, {}),
      ]);
      const posts = cache.posts
        .filter((p) => types[String(p.id)] === type)
        .map(({ id, date, link, excerpt, categories, tags, ...post }) => post);

      const buf = Buffer.from(JSON.stringify({
        meta: {
          exportedAt: new Date().toISOString(),
          source: `${WP_BASE_URL}/wp-json/wp/v2/posts`,
          scope: { status: 'publish', framerType: type },
          notes: 'Publicerade poster av en typ, redo för Framer-pluginet.',
        },
        posts,
      }, null, 2));

      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="posts_${type}.json"`,
        'content-length': buf.length,
      });
      return res.end(buf);
    }

    if (req.method === 'GET' && url.pathname === '/api/types') {
      const types = await readJson(TYPES_FILE, {});
      const buf = Buffer.from(JSON.stringify(types, null, 2));
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="types.json"',
        'content-length': buf.length,
      });
      return res.end(buf);
    }

    if (req.method === 'POST' && url.pathname === '/api/type') {
      const { id, type } = JSON.parse(await readBody(req));
      if (!Number.isInteger(id)) return sendJson(res, 400, { error: 'id måste vara ett heltal' });
      if (type !== null && !VALID_TYPES.has(type)) return sendJson(res, 400, { error: 'ogiltig typ' });
      const types = await serialized(async () => {
        const current = await readJson(TYPES_FILE, {});
        if (type === null) delete current[String(id)];
        else current[String(id)] = type;
        await writeJsonAtomic(TYPES_FILE, current);
        return current;
      });
      return sendJson(res, 200, { ok: true, tagged: Object.keys(types).length });
    }

    if (req.method === 'POST' && url.pathname === '/api/refresh') {
      const count = await refreshPosts();
      return sendJson(res, 200, { ok: true, count });
    }

    if (req.method === 'GET') return serveStatic(req, res);
    sendJson(res, 405, { error: 'method not allowed' });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message });
  }
});

fsp.mkdir(DATA_DIR, { recursive: true }).then(() => {
  server.listen(PORT, () => {
    console.log(`taggning på http://localhost:${PORT}  (data: ${DATA_DIR}, wp: ${WP_BASE_URL || 'EJ SATT'})`);
  });
});
