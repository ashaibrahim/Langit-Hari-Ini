# Mascot images

Drop one image per mood in this folder. The app picks them up automatically:

| File | When it shows |
|---|---|
| `sunny.png` | Clear / mostly clear, daytime |
| `cloudy.png` | Cloudy, no rain |
| `rain.png` | Raining now, or rain within 30 minutes |
| `storm.png` | Thunderstorm |
| `haze.png` | Air Pollutant Index above 100, or MET says hazy |
| `hot.png` | 34°C+ (or feels like 38°C+) |
| `night.png` | After sunset |
| `loading.png` | While data is loading (optional) |

Until a file exists, a text placeholder with the mood name shows instead.
Want a different format (GIF, WebP, SVG)? Change `mascot/${mood}.png` in `public/app.js` (search for `setMood`).
