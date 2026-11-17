'use strict';

// ===========================================================================
// Langit — front end
// Plain JavaScript, no build step. Talks only to our own server (/api/...).
// ===========================================================================

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// localStorage can throw (private mode, blocked storage) — never let that break the app
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

const REFRESH_MS = 15 * 60 * 1000;

let LOCATIONS = [];
let STATES = {};
let currentLoc = null;
let lastLoadedAt = 0;
let currentMood = 'loading';

async function api(path) {
  const res = await fetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

// ---------------------------------------------------------------------------
// Time helpers (everything is Malaysian time, UTC+8, whatever the device says)
// ---------------------------------------------------------------------------

function myNow() {
  // "YYYY-MM-DDTHH:MM" in Malaysian time — same format Open-Meteo returns
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16);
}
const myToday = () => myNow().slice(0, 10);
const myHour = () => Number(myNow().slice(11, 13));
const toMs = (localStr) => Date.parse(`${localStr.length === 16 ? localStr : localStr.slice(0, 16)}Z`);
const minutesUntil = (localStr) => Math.round((toMs(localStr) - toMs(myNow())) / 60000);

function hourLabel(localStr) {
  const h = Number(localStr.slice(11, 13));
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

function clockLabel(localStr) {
  if (!localStr) return '--';
  const h = Number(localStr.slice(11, 13));
  const m = localStr.slice(14, 16);
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m}${suffix}`;
}

function currentPeriod() {
  const h = myHour();
  if (h >= 6 && h < 12) return 'morning';
  if (h >= 12 && h < 19) return 'afternoon';
  return 'night';
}

function distanceKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// ---------------------------------------------------------------------------
// Open-Meteo weather codes → words + simple condition
// ---------------------------------------------------------------------------

const WMO = {
  0: ['Clear sky', 'sunny'], 1: ['Mostly clear', 'sunny'], 2: ['Partly cloudy', 'cloudy'],
  3: ['Cloudy', 'cloudy'], 45: ['Foggy', 'cloudy'], 48: ['Foggy', 'cloudy'],
  51: ['Light drizzle', 'rain'], 53: ['Drizzle', 'rain'], 55: ['Heavy drizzle', 'rain'],
  61: ['Light rain', 'rain'], 63: ['Rain', 'rain'], 65: ['Heavy rain', 'rain'],
  80: ['Light showers', 'rain'], 81: ['Showers', 'rain'], 82: ['Heavy showers', 'rain'],
  95: ['Thunderstorm', 'storm'], 96: ['Thunderstorm with hail', 'storm'], 99: ['Severe thunderstorm', 'storm'],
};
const wmo = (code) => WMO[code] || [`Weather code ${code}`, 'cloudy'];

// ---------------------------------------------------------------------------
// Mascot
// ---------------------------------------------------------------------------

const MOOD_LINES = {
  sunny: ['Cerah hari ni! Sunscreen on, okay?', 'Perfect day to keluar jalan-jalan.', 'Sun is out, so am I!'],
  cloudy: ['A bit mendung, but still cute.', 'Cloudy and cosy today.', 'No sun, no stress.'],
  rain: ['Hujan! Bring your umbrella.', 'Rainy day = stay in and snack.', 'Pitter patter... jangan lupa payung!'],
  storm: ['Ribut petir! Stay indoors, okay?', 'Thunder is scary. Stay safe inside!', 'Unplug, stay in, wait it out.'],
  haze: ['Jerebu... mask on, cutie.', 'The air is not nice today. Stay indoors if you can.', 'Hazy day. Drink lots of water!'],
  hot: ['Panas gila! Drink water, stay in the shade.', 'Melting... need ais kacang.', 'Too hot! Sunscreen + umbrella.'],
  night: ['Good night! Sleep tight.', 'Stars are out. Time to rest.', 'Malam dah. Jangan tidur lambat!'],
  loading: ['Checking the sky…'],
};

function pickMood({ hourly, today, aqiStation, rain }) {
  const period = currentPeriod();
  const metNow = today?.[period]?.code;
  const cur = hourly?.current;
  const curCond = cur ? wmo(cur.weather_code)[1] : null;

  if ((aqiStation && aqiStation.api > 100) || metNow === 'haze') return 'haze';
  if (curCond === 'storm' || (!cur && metNow === 'storm')) return 'storm';
  if (curCond === 'rain' || rain?.nowRaining || (rain?.inMinutes != null && rain.inMinutes <= 30)) return 'rain';
  if (cur ? cur.is_day === 0 : period === 'night') return 'night';
  if (cur && (cur.temperature_2m >= 34 || cur.apparent_temperature >= 38)) return 'hot';
  if (curCond === 'sunny' || (!cur && metNow === 'clear')) return 'sunny';
  return 'cloudy';
}

function setMood(mood) {
  const box = $('mascot');
  const img = $('mascot-img');
  const placeholder = $('mascot-placeholder');
  box.dataset.mood = mood;
  currentMood = mood;
  if (!$('view-place').hidden) document.body.dataset.mood = mood; // drives the animated background

  const lines = MOOD_LINES[mood] || MOOD_LINES.cloudy;
  $('mascot-line').textContent = lines[Math.floor(Math.random() * lines.length)];

  // Shows public/mascot/<mood>.png if it exists, otherwise a text placeholder
  img.onload = () => { img.hidden = false; placeholder.hidden = true; };
  img.onerror = () => { img.hidden = true; placeholder.hidden = false; placeholder.textContent = mood; };
  img.alt = `Mascot feeling ${mood}`;
  img.src = `mascot/${mood}.png`;
}

// ---------------------------------------------------------------------------
// Rain in the next 2 hours (from Open-Meteo 15-minute data)
// ---------------------------------------------------------------------------

function rainSoon(hourly) {
  const m = hourly?.minutely_15;
  if (!m) return null;
  const now = myNow();
  let idx = m.time.findIndex((t) => t > now) - 1;
  if (idx < 0) idx = 0;
  const nowRaining = (hourly.current?.precipitation ?? 0) > 0 || (m.precipitation[idx] ?? 0) >= 0.1;
  let inMinutes = null;
  for (let i = idx + 1; i < Math.min(idx + 9, m.time.length); i += 1) { // next 2 hours
    if ((m.precipitation[i] ?? 0) >= 0.1) { inMinutes = Math.max(0, minutesUntil(m.time[i])); break; }
  }
  return { nowRaining, inMinutes };
}

// ---------------------------------------------------------------------------
// Air quality
// ---------------------------------------------------------------------------

const AQI_ADVICE = {
  good: 'Air is clean. Enjoy being outside!',
  moderate: 'Air is okay. Very sensitive people may want to take it easy outdoors.',
  unhealthy: 'Cut down on long or heavy outdoor activity. Children, older people and those with asthma or heart problems should stay indoors. Consider a mask outside.',
  'very-unhealthy': 'Avoid outdoor activity. Stay indoors with windows closed, and wear a proper (N95) mask if you must go out.',
  hazardous: 'Stay indoors. Follow official advice from DOE and the Ministry of Health.',
  na: 'No reading from this station right now.',
};

function nearestStation(stations, lat, lon) {
  const usable = stations.filter((s) => s.lat != null && s.lon != null && s.api != null);
  let best = null;
  for (const s of usable) {
    const d = distanceKm(lat, lon, s.lat, s.lon);
    if (!best || d < best.distanceKm) best = { ...s, distanceKm: d };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderNow(hourly, rain) {
  const c = hourly?.current;
  if (!c) {
    ['now-temp', 'now-cond', 'now-feels', 'now-humidity', 'now-wind', 'now-uv']
      .forEach((id) => { $(id).textContent = '--'; });
    $('rain-soon').textContent = 'Live conditions unavailable for this place.';
    return;
  }
  $('now-temp').textContent = `${Math.round(c.temperature_2m)}°C`;
  $('now-cond').textContent = wmo(c.weather_code)[0];
  $('now-feels').textContent = `${Math.round(c.apparent_temperature)}°C`;
  $('now-humidity').textContent = `${c.relative_humidity_2m}%`;
  $('now-wind').textContent = `${Math.round(c.wind_speed_10m)} km/h`;
  $('now-uv').textContent = c.uv_index != null ? c.uv_index.toFixed(1) : '--';

  let msg = 'No rain expected in the next 2 hours.';
  if (rain?.nowRaining) msg = "It's raining now.";
  else if (rain?.inMinutes != null) msg = rain.inMinutes <= 15 ? 'Rain starting any minute now!' : `Rain expected in about ${rain.inMinutes} minutes.`;
  $('rain-soon').textContent = msg;
}

function renderToday(forecast) {
  const today = forecast?.today;
  if (!today) {
    $('today-summary').textContent = 'No MET forecast available.';
    return null;
  }
  $('today-summary').innerHTML = `${esc(today.summary.en)}${today.summaryWhen?.en ? ` <span class="small">(${esc(today.summaryWhen.en.toLowerCase())})</span>` : ''}
    · <strong>${today.minTemp}° – ${today.maxTemp}°C</strong>`;
  for (const p of ['morning', 'afternoon', 'night']) {
    const box = $(`p-${p}`);
    box.dataset.code = today[p].code; // clear | cloudy | rain | storm | haze
    box.classList.toggle('is-now', p === currentPeriod());
    box.querySelector('p').innerHTML = `${esc(today[p].en)}<br><span class="small bm">${esc(today[p].bm)}</span>`;
  }
  return today;
}

function renderHourly(hourly) {
  const h = hourly?.hourly;
  const list = $('hourly-list');
  if (!h) { list.innerHTML = '<li>Hourly forecast unavailable.</li>'; return; }
  // From the current hour until 11pm today
  const nowHour = `${myNow().slice(0, 13)}:00`;
  const idxs = h.time.map((t, i) => i).filter((i) => h.time[i] >= nowHour && h.time[i].startsWith(myToday()));
  list.innerHTML = idxs.map((i, k) => {
    const t = h.time[i];
    const [label, cond] = wmo(h.weather_code[i]);
    return `<li class="hour" data-cond="${cond}" data-day="${h.is_day?.[i] ?? 1}">
      <span class="hour-time">${k === 0 ? 'Now' : hourLabel(t)}</span>
      <span class="hour-cond">${esc(label)}</span>
      <span class="hour-temp">${Math.round(h.temperature_2m[i])}°</span>
      <span class="hour-rain">${h.precipitation_probability[i] ?? 0}% rain</span>
    </li>`;
  }).join('');
}

function renderAqi(aqi, station) {
  const main = $('aqi-main');
  if (!station) {
    main.dataset.band = 'na';
    $('aqi-value').textContent = '--';
    $('aqi-band').textContent = 'No station data';
    $('aqi-station').textContent = '';
    $('aqi-advice').textContent = '';
  } else {
    main.dataset.band = station.band.key;
    $('aqi-value').textContent = station.api;
    $('aqi-band').textContent = `${station.band.label}${station.pollutant ? ` · main pollutant ${station.pollutant}` : ''}`;
    $('aqi-station').textContent = `${station.name} station, ${Math.round(station.distanceKm)} km away · reading at ${clockLabel(station.time)}`;
    $('aqi-advice').textContent = AQI_ADVICE[station.band.key] || '';
  }

  // Every station in the country, grouped by state
  const s = aqi.summary || {};
  $('aqi-summary').textContent = `${aqi.stations.length} stations · Good ${s.good || 0} · Moderate ${s.moderate || 0} · Unhealthy ${s.unhealthy || 0} · Very unhealthy ${s['very-unhealthy'] || 0} · Hazardous ${s.hazardous || 0} · No data ${s.na || 0}`;
  const order = Object.values(STATES);
  const groups = {};
  for (const st of aqi.stations) (groups[st.stateName] ||= []).push(st);
  $('aqi-all').innerHTML = Object.keys(groups)
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map((state) => `
      <h4>${esc(state)}</h4>
      <table class="aqi-table">
        <thead><tr><th scope="col">Station</th><th scope="col">API</th><th scope="col">Status</th><th scope="col">Pollutant</th></tr></thead>
        <tbody>${groups[state].sort((a, b) => a.name.localeCompare(b.name)).map((st) => `
          <tr data-band="${st.band.key}">
            <td>${esc(st.name)}</td><td>${st.api ?? '--'}</td><td>${esc(st.band.label)}</td><td>${esc(st.pollutant || '')}</td>
          </tr>`).join('')}
        </tbody>
      </table>`).join('');
}

function renderAqiHistory(history) {
  const box = $('aqi-history');
  const hours = (history?.hours || []).filter((x) => x.time.startsWith(myToday()));
  if (!hours.length) { box.innerHTML = '<p class="small">No readings yet today.</p>'; return; }
  const max = Math.max(100, ...hours.map((x) => x.api ?? 0));
  box.innerHTML = `<div class="bars">${hours.map((x) => `
      <div class="bar" data-band="${x.band.key}" style="height:${x.api == null ? 2 : Math.max(4, (x.api / max) * 100)}%"
           title="${esc(clockLabel(x.time))}: ${x.api ?? 'no data'}"></div>`).join('')}
    </div>
    <div class="bars-axis small"><span>${esc(clockLabel(hours[0].time))}</span><span>${esc(clockLabel(hours[hours.length - 1].time))}</span></div>`;
}


// ---------------------------------------------------------------------------
// Screens: 1) choose a location  2) the place, with Weather / Air quality tabs
// The URL hash remembers where you are, so the browser Back button works:
//   (empty)      → choose a location
//   #Tn196       → Kota Kinabalu, Weather tab
//   #Tn196/aqi   → Kota Kinabalu, Air quality tab
// ---------------------------------------------------------------------------

function goTo(id, tab = 'weather') {
  const hash = id ? `#${id}${tab === 'aqi' ? '/aqi' : ''}` : '';
  if (hash) {
    if (location.hash === hash) route();
    else location.hash = hash; // fires hashchange → route()
    return;
  }
  // back to the picker: clear the hash but keep a history entry so Back returns to the place
  if (location.hash) history.pushState(null, '', location.pathname + location.search);
  route();
}

function route() {
  const [id, tab] = decodeURIComponent(location.hash.slice(1)).split('/');
  const loc = LOCATIONS.find((l) => l.id === id);
  if (!loc) { showPicker(); return; }
  showPlace(loc, tab === 'aqi' ? 'aqi' : 'weather');
}

function showPicker() {
  $('view-pick').hidden = false;
  $('view-place').hidden = true;
  $('updated-wrap').hidden = true;
  document.body.dataset.mood = 'none'; // calm background on the welcome screen
  document.title = 'Langit';

  // start fresh; the last place used is offered first in the suggestions
  pickedId = null;
  $('search').value = '';
  closeSuggestions();
}

function showPlace(loc, tab) {
  $('view-pick').hidden = true;
  $('view-place').hidden = false;
  $('updated-wrap').hidden = false;
  document.title = `${loc.name} · Langit`;
  setTab(tab);

  const stale = Date.now() - lastLoadedAt > REFRESH_MS;
  if (!currentLoc || currentLoc.id !== loc.id || stale) loadLocation(loc);
  else document.body.dataset.mood = currentMood;
}

function setTab(tab) {
  for (const name of ['weather', 'aqi']) {
    const active = name === tab;
    const btn = $(`tab-${name}`);
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
    $(`panel-${name}`).hidden = !active;
  }
}

// ---------------------------------------------------------------------------
// Location picker: type-ahead search
// ---------------------------------------------------------------------------

let pickedId = null;      // the place chosen from the suggestions
let suggestions = [];     // what's currently listed
let activeIndex = -1;     // keyboard-highlighted suggestion

function searchPlaces(query) {
  const q = query.trim().toLowerCase();
  if (!q) {
    // empty box: offer the last place used, if any
    const last = LOCATIONS.find((l) => l.id === store.get('langit-location'));
    return last ? [{ ...last, recent: true }] : [];
  }
  const scored = [];
  for (const l of LOCATIONS) {
    const name = l.name.toLowerCase();
    let score = -1;
    if (name === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (name.split(/[\s\-,()]+/).some((w) => w.startsWith(q))) score = 2;
    else if (name.includes(q)) score = 3;
    else if ((l.stateName || '').toLowerCase().includes(q)) score = 4;
    if (score >= 0) scored.push({ l, score });
  }
  // best matches first; towns before districts before states for equal scores
  const typeRank = { Tn: 0, Rc: 1, Ds: 2, Dv: 3, St: 4 };
  scored.sort((a, b) => a.score - b.score
    || (typeRank[a.l.typeCode] ?? 9) - (typeRank[b.l.typeCode] ?? 9)
    || a.l.name.localeCompare(b.l.name));
  return scored.slice(0, 8).map((x) => x.l);
}

function highlight(name, query) {
  const q = query.trim();
  const i = q ? name.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return esc(name);
  return `${esc(name.slice(0, i))}<mark>${esc(name.slice(i, i + q.length))}</mark>${esc(name.slice(i + q.length))}`;
}

function renderSuggestions() {
  const input = $('search');
  const list = $('suggestions');
  suggestions = searchPlaces(input.value);
  activeIndex = -1;

  if (!suggestions.length) {
    if (input.value.trim()) {
      list.innerHTML = '<li class="suggestion-empty" role="presentation">No places found. Try another spelling.</li>';
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    } else {
      closeSuggestions();
    }
    return;
  }
  list.innerHTML = suggestions.map((l, i) => `
    <li id="opt-${i}" class="suggestion" role="option" aria-selected="false" data-index="${i}">
      <span class="suggestion-name">${highlight(l.name, input.value)}</span>
      <span class="suggestion-meta">${l.recent ? 'Last checked · ' : ''}${esc(l.type)}${l.stateName ? ` · ${esc(l.stateName)}` : ''}</span>
    </li>`).join('');
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function setActive(i) {
  const items = [...$('suggestions').querySelectorAll('.suggestion')];
  if (!items.length) return;
  activeIndex = (i + items.length) % items.length;
  items.forEach((el, k) => el.setAttribute('aria-selected', String(k === activeIndex)));
  $('search').setAttribute('aria-activedescendant', items[activeIndex].id);
  items[activeIndex].scrollIntoView({ block: 'nearest' });
}

function closeSuggestions() {
  $('suggestions').hidden = true;
  $('search').setAttribute('aria-expanded', 'false');
  $('search').removeAttribute('aria-activedescendant');
  activeIndex = -1;
}

function pickSuggestion(i) {
  const l = suggestions[i];
  if (!l) return;
  pickedId = l.id;
  $('search').value = l.name;
  closeSuggestions();
}

function showPopup(message) {
  $('popup-text').textContent = message;
  const dlg = $('popup');
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else alert(message); // very old browsers
}

function checkWeather() {
  let id = pickedId;
  if (!id) {
    // accept a typed name that exactly matches one place
    const typed = $('search').value.trim().toLowerCase();
    const exact = LOCATIONS.filter((l) => l.name.toLowerCase() === typed);
    if (exact.length === 1) id = exact[0].id;
  }
  if (!id) {
    showPopup('Please pick a location first.');
    return;
  }
  closeSuggestions();
  goTo(id);
}

function useMyLocation() {
  if (!navigator.geolocation) { $('pick-status').textContent = 'Location is not supported on this device.'; return; }
  $('pick-status').textContent = 'Finding you…';
  navigator.geolocation.getCurrentPosition((pos) => {
    const { latitude, longitude } = pos.coords;
    // Prefer specific places (towns, districts, recreation spots) over whole states/divisions
    const candidates = LOCATIONS.filter((l) => l.lat != null && ['Tn', 'Ds', 'Rc'].includes(l.typeCode));
    let best = null;
    for (const l of candidates) {
      const d = distanceKm(latitude, longitude, l.lat, l.lon);
      if (!best || d < best.d) best = { l, d };
    }
    if (!best) { $('pick-status').textContent = 'Could not match your location.'; return; }
    $('pick-status').textContent = best.d > 300 ? 'You seem to be outside Malaysia. Showing the closest place we cover.' : '';
    goTo(best.l.id);
  }, (err) => {
    $('pick-status').textContent = `Couldn't get your location (${err.message}). Pick a place from the list instead.`;
  }, { timeout: 10000, maximumAge: 10 * 60 * 1000 });
}

// ---------------------------------------------------------------------------
// Load all data for a place
// ---------------------------------------------------------------------------

async function loadLocation(loc) {
  currentLoc = loc;
  store.set('langit-location', loc.id);

  $('place-name').textContent = loc.name;
  $('place-meta').textContent = `${loc.type}${loc.stateName ? `, ${loc.stateName}` : ''}`;
  $('status').textContent = 'Loading…';
  setMood('loading');

  const hasCoords = loc.lat != null && loc.lon != null;
  const [forecastR, hourlyR, aqiR] = await Promise.allSettled([
    api(`/api/today?id=${encodeURIComponent(loc.id)}`),
    hasCoords ? api(`/api/now?lat=${loc.lat}&lon=${loc.lon}`) : Promise.reject(new Error('no coordinates')),
    api('/api/aqi'),
  ]);
  if (currentLoc !== loc) return; // user switched place while we were loading

  const forecast = forecastR.status === 'fulfilled' ? forecastR.value : null;
  const hourly = hourlyR.status === 'fulfilled' ? hourlyR.value : null;
  const aqi = aqiR.status === 'fulfilled' ? aqiR.value : null;

  const rain = rainSoon(hourly);
  renderNow(hourly, rain);
  const today = renderToday(forecast);
  renderHourly(hourly);

  let station = null;
  if (aqi) {
    station = hasCoords ? nearestStation(aqi.stations, loc.lat, loc.lon) : null;
    renderAqi(aqi, station);
    if (station) {
      api(`/api/aqi/history?station=${encodeURIComponent(station.id)}`)
        .then((h) => { if (currentLoc === loc) renderAqiHistory(h); })
        .catch(() => renderAqiHistory(null));
    } else {
      renderAqiHistory(null);
    }
  } else {
    $('aqi-band').textContent = 'Air quality data unavailable right now.';
  }

  setMood(pickMood({ hourly, today, aqiStation: station, rain }));

  const failed = [
    [forecastR, "today's forecast"], [hourlyR, 'current weather'], [aqiR, 'air quality'],
  ].filter(([r]) => r.status === 'rejected').map(([, name]) => name);
  $('status').textContent = failed.length ? `Some data couldn't load: ${failed.join(', ')}.` : '';
  $('updated').textContent = new Date().toLocaleTimeString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', hour: 'numeric', minute: '2-digit' });
  lastLoadedAt = Date.now();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function init() {
  try {
    const data = await api('/api/locations');
    LOCATIONS = data.locations;
    STATES = data.states;
  } catch (err) {
    $('pick-status').textContent = `Could not load locations (${err.message}). Is the server running?`;
    return;
  }

  // picker
  const input = $('search');
  input.addEventListener('input', () => { pickedId = null; renderSuggestions(); });
  input.addEventListener('focus', renderSuggestions);
  input.addEventListener('keydown', (e) => {
    const open = !$('suggestions').hidden;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) renderSuggestions(); setActive(activeIndex + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (open) setActive(activeIndex - 1); }
    else if (e.key === 'Escape') { closeSuggestions(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && activeIndex >= 0) pickSuggestion(activeIndex);
      else checkWeather();
    }
  });
  input.addEventListener('blur', () => setTimeout(closeSuggestions, 150));
  // mousedown (not click) so the input doesn't lose focus first
  $('suggestions').addEventListener('mousedown', (e) => {
    const li = e.target.closest('.suggestion');
    if (!li) return;
    e.preventDefault();
    pickSuggestion(Number(li.dataset.index));
  });
  $('check').addEventListener('click', checkWeather);
  $('locate').addEventListener('click', useMyLocation);

  // place screen
  $('change').addEventListener('click', () => goTo(null));
  $('tab-weather').addEventListener('click', () => goTo(currentLoc.id, 'weather'));
  $('tab-aqi').addEventListener('click', () => goTo(currentLoc.id, 'aqi'));
  $('tab-weather').parentElement.addEventListener('keydown', (e) => { // arrow keys between tabs
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = $('tab-weather').getAttribute('aria-selected') === 'true' ? 'aqi' : 'weather';
    goTo(currentLoc.id, next);
    $(`tab-${next}`).focus();
  });

  window.addEventListener('hashchange', route);
  route();

  // keep it fresh while a place is open
  setInterval(() => { if (currentLoc && !$('view-place').hidden) loadLocation(currentLoc); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentLoc && !$('view-place').hidden && Date.now() - lastLoadedAt > REFRESH_MS) loadLocation(currentLoc);
  });
}

init();
