// Vercel Serverless Function: /api/find?url=<tiktok-link>
// Sumber link preset: caption video + komentar (RapidAPI) + API eksternal opsional.
// Env di Vercel:
//   RAPIDAPI_KEY   (wajib untuk cek komentar)
//   RAPIDAPI_HOST  (default: tiktok-scraper7.p.rapidapi.com -> samakan dengan Code snippet kamu)
//   RAPIDAPI_PATH  (default: /comment/list)
//   PRESET_API_URL (opsional)

const TIKTOK_HOST = /(^|\.)tiktok\.com$/i;
const LINK_RE = /https?:\/\/[^\s"'<>)]+/gi;
const PRESET_HINT = /(alight|alightmotion|alight\.link|preset|\.xml|\.zip|mediafire|drive\.google|t\.me|bit\.ly|linktr\.ee|sfile|dropbox|mega\.nz)/i;
const PAGES = 2, PER_PAGE = 50;

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', code === 200 ? 's-maxage=300, stale-while-revalidate=600' : 'no-store');
  res.end(JSON.stringify(body));
}

async function timedFetch(url, ms = 9000, opts = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: c.signal, headers: { 'User-Agent': 'Mozilla/5.0', ...(opts.headers || {}) } });
  } finally { clearTimeout(t); }
}

function urlsIn(text) {
  return [...new Set((String(text || '').match(LINK_RE) || []).map(u => u.replace(/[.,;!?]+$/, '')))];
}

async function getComments(target) {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) return { list: [], note: 'RAPIDAPI_KEY belum diatur di Vercel' };
  const host = process.env.RAPIDAPI_HOST || 'tiktok-scraper7.p.rapidapi.com';
  const path = process.env.RAPIDAPI_PATH || '/comment/list';
  let cursor = 0, list = [], note = null;
  for (let i = 0; i < PAGES; i++) {
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        const q = `url=${encodeURIComponent(target)}&count=${PER_PAGE}&cursor=${cursor}`;
        const r = await timedFetch(`https://${host}${path}?${q}`, 12000,
          { headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host, accept: 'application/json' } });
        const txt = await r.text();
        if (r.status === 429) { note = 'Kuota/limit API komentar habis (429)'; i = PAGES; break; }
        if (r.status === 401 || r.status === 403) { note = 'API key ditolak (' + r.status + '): cek RAPIDAPI_KEY dan subscribe'; i = PAGES; break; }
        if (!r.ok) { note = 'API komentar error ' + r.status + ': ' + txt.slice(0, 80); continue; }
        let j; try { j = JSON.parse(txt); } catch { note = 'Respons API komentar bukan JSON: ' + txt.slice(0, 60); continue; }
        if (j.code !== undefined && j.code !== 0) { note = 'API komentar: ' + (j.msg || 'gagal'); continue; }
        const d = j.data || {};
        list = list.concat(Array.isArray(d.comments) ? d.comments : []);
        ok = true; note = null;
        if (!d.hasMore || d.cursor == null) i = PAGES;
        else cursor = d.cursor;
      } catch (e) {
        note = 'API komentar gagal (' + (e.cause && e.cause.code || e.name) + ': ' + String(e.message).slice(0, 60) + ')';
      }
    }
    if (!ok) break;
  }
  return { list, note: list.length ? null : note };
}

module.exports = async (req, res) => {
  try {
    const raw = (req.query && req.query.url) || new URL(req.url, 'http://x').searchParams.get('url');
    if (!raw) return json(res, 400, { ok: false, error: 'Parameter url wajib diisi.' });

    let u;
    try { u = new URL(raw.trim()); } catch { return json(res, 400, { ok: false, error: 'Format link tidak valid.' }); }
    if (!/^https?:$/.test(u.protocol) || !TIKTOK_HOST.test(u.hostname))
      return json(res, 400, { ok: false, error: 'Link harus dari tiktok.com (termasuk vm.tiktok.com / vt.tiktok.com).' });

    const oe = await timedFetch('https://www.tiktok.com/oembed?url=' + encodeURIComponent(u.href));
    if (!oe.ok) return json(res, 404, { ok: false, error: 'Video tidak ditemukan atau akun diprivat.' });
    const v = await oe.json();
    // Pakai ID video dari oEmbed (lebih stabil daripada link pendek)
    const m = String(v.html || '').match(/data-video-id="(\d+)"/);
    const cm = await getComments(m ? m[1] : u.href);
    const author = String(v.author_unique_id || '').toLowerCase();

    const sources = {};
    const add = (arr, label) => arr.forEach(l => { if (!sources[l]) sources[l] = label; });

    // 1. caption
    const capAll = urlsIn(v.title);
    add(capAll.filter(l => PRESET_HINT.test(l)), 'caption');

    // 2. komentar: pembuat video dulu, lalu komentar lain
    const mine = [], others = [];
    for (const c of cm.list) {
      const ls = urlsIn(c.text).filter(l => PRESET_HINT.test(l) && !/tiktok\.com/i.test(l));
      if (!ls.length) continue;
      const cu = c.user && String(c.user.unique_id || '').toLowerCase();
      (author && cu === author ? mine : others).push(...ls);
    }
    add(mine, 'komentar pembuat');
    add(others, 'komentar');

    // 3. API eksternal opsional
    if (process.env.PRESET_API_URL) {
      try {
        const r = await timedFetch(process.env.PRESET_API_URL + encodeURIComponent(u.href), 12000);
        add(urlsIn(await r.text()).filter(l => !/tiktok\.com|tiktokcdn/i.test(l)), 'API');
      } catch (e) {}
    }

    const order = { 'API': 0, 'caption': 1, 'komentar pembuat': 2, 'komentar': 3 };
    const presets = Object.keys(sources).sort((a, b) => order[sources[a]] - order[sources[b]]).map(url => ({ url, source: sources[url] }));

    return json(res, 200, {
      ok: true,
      video: { title: v.title || '', author: v.author_name, authorUrl: v.author_url, thumbnail: v.thumbnail_url },
      presets,
      commentsChecked: cm.list.length,
      note: cm.note,
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.name === 'AbortError' ? 'Server timeout, coba lagi.' : 'Terjadi kesalahan server.' });
  }
};
