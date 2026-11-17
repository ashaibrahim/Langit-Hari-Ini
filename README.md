# Langit

A Malaysian weather and air quality app with a mascot that reacts to the weather.
This is the working prototype: all the data works, the styling is plain and ready to decorate.

## Run it


```bash
cd langit
npm start
```

Open http://localhost:3000

`npm run dev` restarts the server automatically when you edit `server.js`.

## What it shows (today only)

| Section | Source | Coverage |
|---|---|---|
| **Right now**: temperature, feels like, humidity, wind, UV, rain in the next 2 hours | Open-Meteo | Anywhere (by coordinates) |
| **Today**: MET's official morning / afternoon / night forecast + min–max °C | MET Malaysia via data.gov.my | **All 440 MET locations**: 16 states, 168 districts, 18 Sarawak/Sabah divisions, 201 towns, 37 recreation spots (islands, highlands, national parks) |
| **Rest of today**, hour by hour | Open-Meteo | Anywhere |
| **Air quality**: official Air Pollutant Index from the nearest station + readings so far today | Department of Environment (APIMS) | **All 68 DOE stations** (full list in the app too) |

Forecast text from MET is in Bahasa Melayu; the server translates it to English and keeps the original too.

## How it works for the user

1. **Choose a location**: the first screen only has a search box. Matching places appear as you type
   (arrow keys + Enter work too); the last place you checked is suggested when the box is empty.
   Pick one and press **Check weather**, or tap **Use my location**. Pressing Check weather without
   picking a place shows a "Please pick a location first" pop-up.
2. **Pick what to see**: once a place is chosen, two tabs appear: **Weather** and **Air quality**.
   "Change location" goes back to step 1. The browser Back button works too, and each view has its own
   link (e.g. `/#Tn196/aqi` = Kota Kinabalu air quality), so you can bookmark or share it.

The page background is animated to match the weather: falling rain, storm rain with soft lightning,
sunny sparkles, drifting clouds, haze, rising heat and twinkling stars at night. Animations switch off
automatically if the device has "reduce motion" turned on.

## How it's built

```
langit/
├── server.js            Node server: proxies + caches the data sources, serves the site
├── data/locations.txt   Coordinates + state for every MET location (MET doesn't provide them)
└── public/
    ├── index.html       Page structure
    ├── style.css        Plain styles + decoration hooks (see the bottom of the file)
    ├── app.js           Front-end logic: picker, mascot mood, rain alert, rendering
    └── mascot/          Put your mascot art here (see mascot/README.md)
```

Why a server? DOE's air quality portal blocks requests from other websites' browsers (CORS), so it must be
fetched server-side. The server also caches everything (forecast 30 min, air quality 10 min, current weather 15 min),
so many visitors don't hammer the government APIs. If a source goes down, it keeps serving the last good copy.

### API endpoints (your own server)

| Endpoint | Returns |
|---|---|
| `GET /api/locations` | All forecast locations with type, state and coordinates |
| `GET /api/today?id=Tn196` | Today's MET forecast for one location (translated) |
| `GET /api/now?lat=5.97&lon=116.07` | Current conditions, today's hours and 15-minute rain |
| `GET /api/aqi` | All DOE stations with API value, band and main pollutant |
| `GET /api/aqi/history?station=CA17W` | Recent hourly readings for one station |
| `GET /api/health` | Server status |

### Mascot moods

`sunny`, `cloudy`, `rain`, `storm`, `haze`, `hot`, `night` — picked in `pickMood()` in `public/app.js`
(priority: haze → storm → rain → night → hot → sunny → cloudy).

## Notes / limitations

- DOE's APIMS has no documented public API. The server uses the same JSON the official APIMS website loads.
  If DOE changes it, update the `APIMS` functions in `server.js`.
- Coordinates in `data/locations.txt` are approximate town/district centres. They're used to pick the nearest
  air quality station and for current weather.
- MET's forecast is per period (morning/afternoon/night). Current, hourly and 15-minute rain come from Open-Meteo's
  weather models, so the two can disagree sometimes.

## Deploying

Any host that runs Node works: Render, Railway, Fly.io, or a small VPS. Set `PORT` if the host requires it.
(Static-only hosts like GitHub Pages or Netlify won't work as-is because the air quality data needs the server.)

## Credits

- Today's forecast: MET Malaysia via [data.gov.my](https://developer.data.gov.my/realtime-api/weather) (CC BY 4.0)
- Air Pollutant Index: Department of Environment Malaysia, [APIMS](https://eqms.doe.gov.my/APIMS/main)
- Current & hourly weather: [Open-Meteo.com](https://open-meteo.com) (CC BY 4.0)
