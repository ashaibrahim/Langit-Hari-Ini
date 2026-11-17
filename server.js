// Langit — working prototype server
// Node 18+ (uses the built-in fetch). No npm packages needed.
//
// Why a server at all?
//  - DOE's air-quality portal (APIMS) blocks browser requests from other websites (CORS),
//    so it has to be fetched server-side.
//  - Caching: MET only publishes the whole country at once (~3,000 rows); we fetch it once every 30 min, not per visitor.
//
// Data sources
//  - MET Malaysia via data.gov.my (CC BY 4.0): today's forecast for 440 locations
//  - DOE Malaysia APIMS (eqms.doe.gov.my): official hourly Air Pollutant Index, 68 stations
//  - Open-Meteo (CC BY 4.0): current conditions, rest-of-today hourly, 15-minute rain alerts

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const DATA_GOV = 'https://api.data.gov.my';
const APIMS = 'https://eqms.doe.gov.my/api3/publicportalapims';
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';

const MIN = 60 * 1000;

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

const STATES = {
  PLS: 'Perlis', KDH: 'Kedah', PNG: 'Pulau Pinang', PRK: 'Perak', KTN: 'Kelantan',
  TRG: 'Terengganu', PHG: 'Pahang', SGR: 'Selangor', KL: 'WP Kuala Lumpur',
  PJY: 'WP Putrajaya', NSN: 'Negeri Sembilan', MLK: 'Melaka', JHR: 'Johor',
  SWK: 'Sarawak', SBH: 'Sabah', LBN: 'WP Labuan',
};
const STATE_ORDER = Object.keys(STATES);

// APIMS uses its own numeric state ids
const APIMS_STATE = {
  1: 'JHR', 2: 'KDH', 3: 'KTN', 4: 'MLK', 5: 'NSN', 6: 'PHG', 7: 'PNG', 8: 'PRK',
  9: 'PLS', 10: 'SGR', 11: 'TRG', 12: 'SBH', 13: 'SWK', 14: 'KL', 15: 'LBN', 16: 'PJY',
};

const LOCATION_TYPES = {
  St: 'State', Ds: 'District', Dv: 'Division', Tn: 'Town', Rc: 'Recreation spot',
};
const TYPE_ORDER = ['St', 'Dv', 'Ds', 'Tn', 'Rc'];

// data/locations.txt → { Ds001: { lat, lon, state } }
const COORDS = {};
fs.readFileSync(path.join(__dirname, 'data', 'locations.txt'), 'utf8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join(';')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean)
  .forEach((entry) => {
    const [id, lat, lon, state] = entry.split(/\s+/);
    COORDS[id] = { lat: Number(lat), lon: Number(lon), state };
  });

// ---------------------------------------------------------------------------
// MET Malaysia forecast vocabulary (Bahasa Melayu → English + a simple code)
// ---------------------------------------------------------------------------

function translateForecast(bm) {
  if (!bm) return { code: 'unknown', en: 'No data', bm: '' };
  const s = bm.toLowerCase().trim();

  let code;
  let en;
  if (s.startsWith('ribut petir')) { code = 'storm'; en = 'Thunderstorms'; }
  else if (s.startsWith('tiada hujan')) { code = 'clear'; en = 'No rain'; }
  else if (s.startsWith('hujan')) { code = 'rain'; en = 'Rain'; }
  else if (s.startsWith('berjerebu')) { code = 'haze'; en = 'Hazy'; }
  else if (s.startsWith('mendung')) { code = 'cloudy'; en = 'Cloudy'; }
  else if (s.includes('petir')) { code = 'storm'; en = bm; }
  else if (s.includes('hujan')) { code = 'rain'; en = bm; }
  else { code = 'unknown'; en = bm; }

  // how widespread
  let extent = 'all';
  if (s.includes('menyeluruh')) { en += ', widespread'; extent = 'widespread'; }
  else if (s.includes('di kebanyakan tempat')) { en += ' in most places'; extent = 'most'; }
  else if (s.includes('di beberapa tempat')) { en += ' in a few places'; extent = 'few'; }
  else if (s.includes('di satu dua tempat')) { en += ', isolated'; extent = 'isolated'; }

  // where
  if (s.includes('kawasan pantai')) en += ' (coastal areas)';
  if (s.includes('kawasan pedalaman')) en += ' (inland areas)';

  return { code, en, bm, extent };
}

const WHEN_EN = {
  'pagi': 'Morning',
  'petang': 'Afternoon',
  'malam': 'Night',
  'pagi dan petang': 'Morning & afternoon',
  'pagi dan malam': 'Morning & night',
  'petang dan malam': 'Afternoon & night',
  'sepanjang hari': 'All day',
};

// ---------------------------------------------------------------------------
// Air Pollutant Index helpers (DOE bands)
// ---------------------------------------------------------------------------

const POLLUTANTS = {
  '**': 'PM2.5', '*': 'PM10', a: 'SO₂', b: 'NO₂', c: 'O₃', d: 'CO', '&': '2+ pollutants',
};

function apiBand(api) {
  if (api === null || api === undefined || Number.isNaN(api) || api < 0) {
    return { key: 'na', label: 'Not available' };
  }
  if (api <= 50) return { key: 'good', label: 'Good' };
  if (api <= 100) return { key: 'moderate', label: 'Moderate' };
  if (api <= 200) return { key: 'unhealthy', label: 'Unhealthy' };
  if (api <= 300) return { key: 'very-unhealthy', label: 'Very unhealthy' };
  return { key: 'hazardous', label: 'Hazardous' };
}

// ---------------------------------------------------------------------------
// Fetching + caching
// ---------------------------------------------------------------------------

async function fetchJSON(url, headers = {}) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Langit/0.1 (student project)', ...headers },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
  return res.json();
}

const cache = new Map(); // key → { time, value }
const inFlight = new Map(); // key → Promise (so 10 visitors don't trigger 10 fetches)

async function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < ttlMs) return hit.value;
  if (inFlight.has(key)) return inFlight.get(key);

  const p = (async () => {
    try {
      const value = await loader();
      cache.set(key, { time: Date.now(), value });
      return value;
    } catch (err) {
      if (hit) {
        console.warn(`[cache] ${key} refresh failed, serving stale copy: ${err.message}`);
        return hit.value;
      }
      throw err;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p);
  return p;
}

// ---- MET forecast (all locations at once) ---------------------------------

function getForecastData() {
  return cached('forecast', 30 * MIN, async () => {
    const rows = await fetchJSON(`${DATA_GOV}/weather/forecast?limit=10000`);
    const byLocation = new Map();
    for (const r of rows) {
      const id = r.location.location_id;
      if (!byLocation.has(id)) byLocation.set(id, { name: r.location.location_name, days: [] });
      byLocation.get(id).days.push({
        date: r.date,
        morning: translateForecast(r.morning_forecast),
        afternoon: translateForecast(r.afternoon_forecast),
        night: translateForecast(r.night_forecast),
        summary: translateForecast(r.summary_forecast),
        summaryWhen: { bm: r.summary_when, en: WHEN_EN[(r.summary_when || '').toLowerCase()] || r.summary_when },
        minTemp: r.min_temp,
        maxTemp: r.max_temp,
      });
    }
    for (const loc of byLocation.values()) loc.days.sort((a, b) => a.date.localeCompare(b.date));
    return byLocation;
  });
}

function describeLocation(id, name) {
  const c = COORDS[id] || {};
  const prefix = id.slice(0, 2);
  return {
    id,
    name,
    type: LOCATION_TYPES[prefix] || 'Location',
    typeCode: prefix,
    state: c.state || null,
    stateName: c.state ? STATES[c.state] : 'Other',
    lat: c.lat ?? null,
    lon: c.lon ?? null,
  };
}

// ---- Air quality (DOE APIMS) ----------------------------------------------

const APIMS_HEADERS = {
  Referer: 'https://eqms.doe.gov.my/APIMS/main',
  Origin: 'https://eqms.doe.gov.my',
};

function getAqiStations() {
  return cached('aqi', 10 * MIN, async () => {
    const json = await fetchJSON(`${APIMS}/mapcaqm`, APIMS_HEADERS);
    return (json.data || []).map((s) => {
      const api = typeof s.API === 'number' ? s.API : null;
      const state = APIMS_STATE[s.STATE_ID] || null;
      return {
        id: s.STATION_ID,
        name: s.STATION_LOCATION,
        state,
        stateName: state ? STATES[state] : s.STATE_NAME,
        apimsStateId: s.STATE_ID,
        lat: s.LATITUDE,
        lon: s.LONGITUDE,
        api,
        band: apiBand(api),
        pollutant: POLLUTANTS[s.PARAM_SYMBOL] || s.PARAM_SYMBOL || null,
        active: s.STATION_STATUS === 1,
        time: s.RECORD_DT,
      };
    });
  });
}

async function getAqiHistory(stationId) {
  const stations = await getAqiStations();
  const station = stations.find((s) => s.id === stationId);
  if (!station) return null;
  const latest = station.time || '';
  const rows = await cached(`aqi-hist-${station.apimsStateId}-${latest}`, 15 * MIN, async () => {
    const q = latest ? `&datetime=${encodeURIComponent(latest)}&` : '';
    const json = await fetchJSON(`${APIMS}/apitablehourly?stateid=${station.apimsStateId}${q}`, APIMS_HEADERS);
    return json.api_table_hourly || [];
  });
  const hours = rows
    .filter((r) => r.STATION_ID === stationId)
    .map((r) => {
      const api = typeof r.API === 'number' ? r.API : null;
      return { time: r.DATETIME, api, band: apiBand(api), pollutant: POLLUTANTS[r.PARAM_SYMBOL] || null };
    })
    .sort((a, b) => a.time.localeCompare(b.time));
  return { station, hours };
}

// ---- Open-Meteo: current, today's hours, 15-minute rain --------------------

function getHourly(lat, lon) {
  const la = Number(lat).toFixed(2);
  const lo = Number(lon).toFixed(2);
  return cached(`om-${la}-${lo}`, 15 * MIN, async () => {
    const params = new URLSearchParams({
      latitude: la,
      longitude: lo,
      timezone: 'Asia/Kuala_Lumpur',
      forecast_days: '1',
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,precipitation,wind_speed_10m,uv_index',
      hourly: 'temperature_2m,precipitation_probability,weather_code,is_day',
      minutely_15: 'precipitation',
    });
    return fetchJSON(`${OPEN_METEO}?${params}`);
  });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sendJSON(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function serveStatic(req, res, pathname) {
  const safe = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJSON(res, 403, { error: 'Forbidden' });
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

const routes = {
  // Every forecast location, grouped-ready (sorted by state, then type, then name)
  async '/api/locations'() {
    const data = await getForecastData();
    const list = [...data.entries()].map(([id, loc]) => describeLocation(id, loc.name));
    list.sort((a, b) => {
      const sa = a.state ? STATE_ORDER.indexOf(a.state) : 99;
      const sb = b.state ? STATE_ORDER.indexOf(b.state) : 99;
      if (sa !== sb) return sa - sb;
      const ta = TYPE_ORDER.indexOf(a.typeCode);
      const tb = TYPE_ORDER.indexOf(b.typeCode);
      if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name);
    });
    return { count: list.length, states: STATES, locations: list };
  },

  // Today's MET forecast for one location: /api/today?id=Tn196
  async '/api/today'(q) {
    const id = q.get('id');
    if (!id) return [400, { error: 'Missing ?id=' }];
    const data = await getForecastData();
    const loc = data.get(id);
    if (!loc) return [404, { error: `Unknown location ${id}` }];
    const todayMY = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const today = loc.days.find((d) => d.date === todayMY) || null;
    return { location: describeLocation(id, loc.name), date: todayMY, today };
  },

  // All 68 DOE stations + national summary
  async '/api/aqi'() {
    const stations = await getAqiStations();
    const summary = {};
    for (const s of stations) summary[s.band.key] = (summary[s.band.key] || 0) + 1;
    const latest = stations.map((s) => s.time).filter(Boolean).sort().pop() || null;
    return { updated: latest, summary, stations };
  },

  // Hourly readings for one station (the app shows today's): /api/aqi/history?station=CA17W
  async '/api/aqi/history'(q) {
    const station = q.get('station');
    if (!station) return [400, { error: 'Missing ?station=' }];
    const result = await getAqiHistory(station);
    if (!result) return [404, { error: `Unknown station ${station}` }];
    return result;
  },

  // Current conditions + rest of today hourly + 15-min rain: /api/now?lat=5.97&lon=116.07
  async '/api/now'(q) {
    const lat = Number(q.get('lat'));
    const lon = Number(q.get('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [400, { error: 'Missing ?lat=&lon=' }];
    return getHourly(lat, lon);
  },

  async '/api/health'() {
    return { ok: true, cached: [...cache.keys()], uptimeSec: Math.round(process.uptime()) };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const handler = routes[url.pathname];
  if (handler) {
    try {
      const out = await handler(url.searchParams);
      if (Array.isArray(out)) return sendJSON(res, out[0], out[1]);
      return sendJSON(res, 200, out);
    } catch (err) {
      console.error(`[error] ${url.pathname}:`, err.message);
      return sendJSON(res, 502, { error: 'Upstream data source failed', detail: err.message });
    }
  }
  if (url.pathname.startsWith('/api/')) return sendJSON(res, 404, { error: 'Unknown endpoint' });
  return serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`Langit running → http://localhost:${PORT}`);
  console.log(`Loaded coordinates for ${Object.keys(COORDS).length} forecast locations`);
  // Warm the caches so the first visitor doesn't wait
  Promise.allSettled([getForecastData(), getAqiStations()]).then((r) => {
    const failed = r.filter((x) => x.status === 'rejected');
    if (failed.length) failed.forEach((f) => console.warn('[warmup]', f.reason.message));
    else console.log('Data sources reachable ✓');
  });
});
