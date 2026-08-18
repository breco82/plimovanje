/* index.js */
/* Frontend Controller for the Slovenian Sea Level Tracker */

// App State
let chartMode = 'level'; // 'level' or 'temp'
let periodHours = 24;   // 24, 72, or 168
let actualData = [];    // Loaded ARSO measurements
let currentChart = null; // Highcharts instance
let meteoForecastMap = new Map(); // Open-Meteo hourly pressure and wind map
let openMeteoHourlyForecast = []; // Global variable to store hourly forecast items
let activeHourlyDayOffset = null; // Track which day's hourly forecast is currently open
let arsoForecastData = null; // Global variable to store raw ARSO Koper JSON forecast
let openMeteoDailyData = null; // Global variable to store daily Open-Meteo forecast fallback
const PROXY_URL = 'https://script.google.com/macros/s/AKfycbxoILNm85D58iHTxfbE8J_BawhREfiv2q1bUHSED_GqPT2LhUSyFxXjSXEx4cyk9eT8/exec';

// Datum offset constant (Srednja gladina morja / Mean sea level - SVS2010 reference datum is 217.0 cm above gauge zero)
const MEAN_SEA_LEVEL_OFFSET = 217.0;

let deferredPrompt = null;

document.addEventListener('DOMContentLoaded', () => {
    // Configure Highcharts to use local timezone globally
    if (typeof Highcharts !== 'undefined') {
        Highcharts.setOptions({
            time: {
                useUTC: false
            },
            lang: {
                weekdays: ['Nedelja', 'Ponedeljek', 'Torek', 'Sreda', 'Četrtek', 'Petek', 'Sobota'],
                shortWeekdays: ['Ned', 'Pon', 'Tor', 'Sre', 'Čet', 'Pet', 'Sob'],
                months: ['Januar', 'Februar', 'Marec', 'April', 'Maj', 'Junij', 'Julij', 'Avgust', 'September', 'Oktober', 'November', 'December'],
                shortMonths: ['Jan', 'Feb', 'Mar', 'Apr', 'Maj', 'Jun', 'Jul', 'Avg', 'Sep', 'Okt', 'Nov', 'Dec']
            }
        });
    }

    // Initialize Theme (Default is light unless saved as dark)
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        document.body.classList.remove('light-theme');
    } else {
        document.body.classList.add('light-theme');
    }
    updateThemeIcon();

    // Start clock display
    updateClock();
    setInterval(updateClock, 1000);
    
    // Update moon phase
    updateMoonPhase();
    setInterval(updateMoonPhase, 3600000); // refresh moon phase every hour

    // Instant load from localStorage
    try {
        const cachedData = localStorage.getItem('arso_actual_data');
        if (cachedData) {
            actualData = JSON.parse(cachedData).map(item => ({
                time: new Date(item.time),
                temp: item.temp,
                level: item.level
            }));
            if (actualData.length > 0) {
                const latest = actualData[actualData.length - 1];
                const relativeVal = latest.level - MEAN_SEA_LEVEL_OFFSET;
                const relativeSign = relativeVal >= 0 ? '+' : '';
                document.getElementById('current-level-val').textContent = `${relativeSign}${Math.round(relativeVal)}`;
                document.getElementById('relative-level-val').textContent = `Absolutna gladina: ${Math.round(latest.level)} cm`;
                
                const timeStr = latest.time.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
                const timeEl = document.getElementById('level-time-val');
                if (timeEl) timeEl.textContent = `Meritev ARSO ob: ${timeStr}`;
                
                document.getElementById('current-temp-val').textContent = latest.temp.toFixed(1);
                
                calculateTideExtrema(latest.time);
                renderChart();
            }
        }
    } catch (e) {
        console.warn("Failed to load cached data:", e);
    }
    
    // Load meteorological data from Bazdara Firebase (CORS-free)
    loadWeather();
    setInterval(loadWeather, 60000); // refresh weather every minute
    
    // Load tide data
    refreshData();
    setInterval(refreshData, 300000); // refresh water data every 5 minutes

    // Load weather forecast asynchronously (does not block tide data)
    loadArsoForecast();
    setInterval(loadArsoForecast, 600000); // refresh weather forecast every 10 minutes

    // Register Service Worker for PWA
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('sw.js')
                .then(reg => console.log('Service Worker registered successfully!', reg))
                .catch(err => console.log('Service Worker registration failed:', err));
        });
    }
    
    // Handle PWA Install Prompt
    const installBanner = document.getElementById('pwa-install-banner');
    const installBtn = document.getElementById('pwa-install-btn');
    
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        if (installBanner) {
            installBanner.style.display = 'flex';
        }
    });
    
    if (installBtn) {
        installBtn.addEventListener('click', async () => {
            if (deferredPrompt) {
                deferredPrompt.prompt();
                const { outcome } = await deferredPrompt.userChoice;
                console.log(`User response to install prompt: ${outcome}`);
                deferredPrompt = null;
                if (installBanner) {
                    installBanner.style.display = 'none';
                }
            }
        });
    }
    
    window.addEventListener('appinstalled', (evt) => {
        console.log('App was installed successfully!');
        if (installBanner) {
            installBanner.style.display = 'none';
        }
    });

    // Auto-refresh when app comes to foreground (PWA resumes)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            console.log("App brought to foreground. Refreshing data...");
            refreshData();
            loadWeather();
        }
    });
});

function updateClock() {
    const timeDisplay = document.getElementById('current-time-display');
    const now = new Date();
    timeDisplay.textContent = now.toLocaleString('sl-SI', { 
        weekday: 'short', 
        day: '2-digit', 
        month: '2-digit', 
        year: 'numeric',
        hour: '2-digit', 
        minute: '2-digit',
        second: '2-digit'
    });
}

function setChartMode(mode) {
    if (chartMode === mode) return;
    chartMode = mode;
    
    // Update active button
    document.getElementById('mode-level').classList.toggle('active', mode === 'level');
    document.getElementById('mode-temp').classList.toggle('active', mode === 'temp');
    
    // Re-draw chart
    renderChart();
}

function setPeriod(hours) {
    periodHours = hours;
    
    // Update active button
    document.getElementById('period-24h').classList.toggle('active', hours === 24);
    document.getElementById('period-3d').classList.toggle('active', hours === 72);
    document.getElementById('period-7d').classList.toggle('active', hours === 168);
    const btn30 = document.getElementById('period-30d');
    if (btn30) btn30.classList.toggle('active', hours === 720);
    
    if (currentChart && actualData.length > 0) {
        const latestTimeVal = actualData[actualData.length - 1].time.getTime();
        const minTime = latestTimeVal - (periodHours * 60 * 60 * 1000);
        const maxTime = chartMode === 'level' ? latestTimeVal + (periodHours * 60 * 60 * 1000) : latestTimeVal;
        currentChart.xAxis[0].setExtremes(minTime, maxTime);
    }
}

// Custom Date parser for ARSO table string "DD.MM.YYYY HH:MM"
function parseArsoDate(dateStr) {
    const parts = dateStr.split(' ');
    if (parts.length < 2) return new Date();
    
    const dParts = parts[0].split('.');
    const tParts = parts[1].split(':');
    
    if (dParts.length < 3 || tParts.length < 2) return new Date();
    
    // Date arguments: Year, Month (0-11), Day, Hour, Minute
    return new Date(dParts[2], dParts[1] - 1, dParts[0], tParts[0], tParts[1], 0);
}

// Client-side HTML table parser for fallback requests
function parseArsoHtml(htmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');
    const rows = doc.querySelectorAll('table.podatki tbody tr');
    const parsedData = [];
    
    rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 3) {
            const time = cells[0].textContent.trim();
            const temp = parseFloat(cells[1].textContent.trim());
            const level = parseFloat(cells[2].textContent.trim());
            if (!isNaN(temp) && !isNaN(level)) {
                parsedData.push({ time, temp, level });
            }
        }
    });
    return parsedData;
}

// Load data with triple redundancy
async function loadWaterData(arsoPeriod) {
    const cb = new Date().getTime();
    const localUrl = `/api/data?period=${arsoPeriod}&cb=${cb}`;
    const publicUrl = `https://www.arso.gov.si/vode/podatki/amp/H9350_t_${arsoPeriod}.html?cb=${cb}`;
    
    // Attempt 1: Local server proxy
    try {
        const res = await fetch(localUrl);
        if (res.ok) {
            return await res.json();
        }
    } catch (e) {
        console.log(`Local API endpoint failed for period ${arsoPeriod}, trying direct public CORS proxy...`, e);
    }
    
    // Attempt 2: Public CORS proxy (corsproxy.io)
    try {
        const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(publicUrl)}`;
        const res = await fetch(proxyUrl);
        if (res.ok) {
            const html = await res.text();
            return parseArsoHtml(html);
        }
    } catch (e) {
        console.log(`Primary CORS proxy failed for period ${arsoPeriod}, trying secondary backup proxy...`, e);
    }
    
    // Attempt 3: Backup CORS proxy (allorigins.win)
    try {
        const backupUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(publicUrl)}`;
        const res = await fetch(backupUrl);
        if (res.ok) {
            const json = await res.json();
            return parseArsoHtml(json.contents);
        }
    } catch (e) {
        console.error(`All proxies failed to fetch ARSO data for period ${arsoPeriod}`, e);
        throw e;
    }
}

// Load and merge both 24h and 30d tables to avoid lag in the 30d history table
async function loadMergedWaterData() {
    const [dayDataRaw, historyDataRaw] = await Promise.all([
        loadWaterData("1"),
        loadWaterData("30")
    ]);
    
    const dayData = dayDataRaw.map(item => ({
        time: parseArsoDate(item.time),
        temp: item.temp,
        level: item.level
    }));
    
    const historyData = historyDataRaw.map(item => ({
        time: parseArsoDate(item.time),
        temp: item.temp,
        level: item.level
    }));
    
    // Sort historyData chronologically
    historyData.sort((a, b) => a.time - b.time);
    
    // Interpolate hourly history data into 10-minute steps so it matches 10-minute predictions exactly
    const interpolatedHistory = [];
    for (let i = 0; i < historyData.length; i++) {
        const current = historyData[i];
        interpolatedHistory.push(current);
        
        if (i < historyData.length - 1) {
            const next = historyData[i+1];
            const timeDiffMs = next.time.getTime() - current.time.getTime();
            
            // If gap is approximately 1 hour (between 45 and 75 minutes), fill in 10-minute intervals
            if (timeDiffMs > 15 * 60 * 1000 && timeDiffMs < 90 * 60 * 1000) {
                const steps = Math.round(timeDiffMs / (10 * 60 * 1000));
                for (let step = 1; step < steps; step++) {
                    const t = current.time.getTime() + step * 10 * 60 * 1000;
                    const w = step / steps;
                    
                    const interpolatedTemp = current.temp + w * (next.temp - current.temp);
                    const interpolatedLevel = current.level + w * (next.level - current.level);
                    
                    interpolatedHistory.push({
                        time: new Date(t),
                        temp: parseFloat(interpolatedTemp.toFixed(1)),
                        level: parseFloat(interpolatedLevel.toFixed(1))
                    });
                }
            }
        }
    }
    
    // Merge data: Day data (24h) overwrites history data (30d) for same timestamp
    const mergedMap = new Map();
    
    interpolatedHistory.forEach(item => {
        mergedMap.set(item.time.getTime(), item);
    });
    
    dayData.forEach(item => {
        mergedMap.set(item.time.getTime(), item);
    });
    
    return Array.from(mergedMap.values()).sort((a, b) => a.time - b.time);
}

// Convert degrees to Slovenian wind direction abbreviation
function getWindDirectionSlo(deg) {
    if (deg === null || deg === undefined || isNaN(deg)) return "--";
    const directions = ["S", "SV", "V", "JV", "J", "JZ", "Z", "SZ"];
    // Round to closest 45 degree sector (0-360)
    const idx = Math.round(deg / 45) % 8;
    return directions[idx];
}

// Generate HTML for rotated wind arrow indicating direction the wind is blowing to
function getWindArrowHtml(deg) {
    if (deg === null || deg === undefined || isNaN(deg)) return "";
    // Rotate to point in the direction the wind is blowing to (deg + 180)
    const rotation = (parseFloat(deg) + 180) % 360;
    return `<i class="fa-solid fa-arrow-up wind-arrow" style="transform: rotate(${rotation}deg); font-size: 0.65rem; margin-right: 4px;" title="Smer vetra: ${Math.round(deg)}°"></i>`;
}

// Store ARSO forecast raw data
async function fetchArsoForecastViaProxy() {
    try {
        const targetUrl = 'https://vreme.arso.gov.si/api/1.0/location/?location=Piran&format=json';
        const url = PROXY_URL + '?url=' + encodeURIComponent(targetUrl);
        const response = await fetch(url);
        if (!response.ok) throw new Error("Proxy response not ok");
        const json = await response.json();
        return json;
    } catch (e) {
        console.error("Could not fetch ARSO forecast via proxy:", e);
        return null;
    }
}

async function fetchWaveHeight() {
    try {
        const url = 'https://marine-api.open-meteo.com/v1/marine?latitude=45.51&longitude=13.59&hourly=wave_height&timezone=auto';
        const response = await fetch(url);
        if (!response.ok) throw new Error("Marine API response not ok");
        const json = await response.json();
        return json;
    } catch (e) {
        console.error("Could not fetch wave height:", e);
        return null;
    }
}

function mapArsoIconToFa(nnIcon) {
    if (!nnIcon) return { icon: "fa-sun", color: "#f59e0b" };
    const name = nnIcon.toLowerCase();
    
    // Storm, snow, rain, fog
    if (name.includes("ts") || name.includes("bolt") || name.includes("thunder") || name.includes("neviht")) {
        return { icon: "fa-cloud-bolt", color: "#eab308" };
    }
    if (name.includes("sn") || name.includes("snow") || name.includes("flake") || name.includes("sneg")) {
        return { icon: "fa-snowflake", color: "#38bdf8" };
    }
    if (name.includes("shra") || name.includes("shower") || name.includes("ploh")) {
        return { icon: "fa-cloud-showers-heavy", color: "#0ea5e9" };
    }
    if (name.includes("ra") || name.includes("rain") || name.includes("dz") || name.includes("dež") || name.includes("ros")) {
        return { icon: "fa-cloud-rain", color: "#0ea5e9" };
    }
    if (name.includes("fg") || name.includes("fog") || name.includes("smog") || name.includes("megl")) {
        return { icon: "fa-smog", color: "#64748b" };
    }
    
    // Night icons (handled with CSS overrides in index.css for high contrast in light mode)
    if (name.includes("night") || name.includes("noč")) {
        if (name.includes("overcast") || name.includes("prevcloudy") || name.includes("oblač")) {
            return { icon: "fa-cloud", color: "#64748b" };
        }
        if (name.includes("partcloudy") || name.includes("modcloudy") || name.includes("delno") || name.includes("zmerno") || name.includes("slightcloudy")) {
            return { icon: "fa-cloud-moon", color: "#cbd5e1" };
        }
        return { icon: "fa-moon", color: "#fef08a" };
    }
    
    // Day icons / defaults
    if (name.includes("overcast") || name.includes("prevcloudy") || name.includes("oblač")) {
        return { icon: "fa-cloud", color: "#64748b" };
    }
    if (name.includes("partcloudy") || name.includes("modcloudy") || name.includes("delno") || name.includes("zmerno") || name.includes("slightcloudy")) {
        return { icon: "fa-cloud-sun", color: "#f59e0b" };
    }
    
    return { icon: "fa-sun", color: "#f59e0b" };
}

function updateOpenMeteoFallbackCards() {
    if (!openMeteoDailyData) return;
    try {
        const daily = openMeteoDailyData;
        const dTimes = daily.time;
        
        const getIndexForDate = (dateOffset) => {
            const targetDate = new Date();
            targetDate.setDate(targetDate.getDate() + dateOffset);
            const targetStr = targetDate.getFullYear() + '-' + 
                              String(targetDate.getMonth() + 1).padStart(2, '0') + '-' + 
                              String(targetDate.getDate()).padStart(2, '0');
            return dTimes.indexOf(targetStr);
        };
        
        const idxTomorrow = getIndexForDate(1);
        const idxDayAfter = getIndexForDate(2);
        
        const updateForecastCard = (cardPrefix, idx) => {
            if (idx !== -1) {
                const wCode = daily.weather_code[idx];
                const tempMin = daily.temperature_2m_min[idx];
                const tempMax = daily.temperature_2m_max[idx];
                const windSpeed = daily.wind_speed_10m_max[idx];
                const windDir = daily.wind_direction_10m_dominant[idx];
                
                const { icon, color } = mapArsoIconToFa(wCode === 0 || wCode === 1 ? "clear" : (wCode === 2 ? "partCloudy" : "overcast"));
                const windArrow = getWindArrowHtml(windDir);
                
                const iconEl = document.getElementById(`${cardPrefix}-icon`);
                if (iconEl) {
                    iconEl.className = `fa-solid ${icon} forecast-icon`;
                    iconEl.style.color = color;
                }
                
                const tempEl = document.getElementById(`${cardPrefix}-temp`);
                if (tempEl) {
                    tempEl.textContent = `${Math.round(tempMin)} / ${Math.round(tempMax)} °C`;
                }
                
                const windEl = document.getElementById(`${cardPrefix}-wind`);
                if (windEl) {
                    const windDirStr = getWindDirectionSlo(windDir);
                    windEl.innerHTML = `${windArrow}${Math.round(windSpeed)} km/h (${windDirStr})`;
                }
            }
        };
        
        updateForecastCard('forecast-day-1', idxTomorrow);
        updateForecastCard('forecast-day-2', idxDayAfter);
    } catch (fallbackErr) {
        console.error("Error populating Open-Meteo fallback cards:", fallbackErr);
    }
}

async function loadArsoForecast() {
    try {
        const badge = document.getElementById('weather-source-badge');
        if (badge) badge.textContent = 'Nalaganje...';
        
        // Fetch ARSO JSON forecast and Marine wave height forecast in parallel
        const [forecastJson, marineJson] = await Promise.all([
            fetchArsoForecastViaProxy(),
            fetchWaveHeight()
        ]);
        
        arsoForecastData = forecastJson;
        
        // Update wave height widget
        if (marineJson && marineJson.hourly) {
            try {
                const now = new Date();
                const timeMs = now.getTime();
                let closestIdx = 0;
                let minDiff = Infinity;
                
                for (let i = 0; i < marineJson.hourly.time.length; i++) {
                    const itemTime = new Date(marineJson.hourly.time[i]);
                    const diff = Math.abs(itemTime.getTime() - timeMs);
                    if (diff < minDiff) {
                        minDiff = diff;
                        closestIdx = i;
                    }
                }
                
                const wh = marineJson.hourly.wave_height[closestIdx];
                const waveValEl = document.getElementById('wave-height-val');
                if (waveValEl) {
                    if (wh !== undefined && wh !== null) {
                        waveValEl.textContent = `${wh.toFixed(2)} m`;
                    } else {
                        waveValEl.textContent = `-- m`;
                    }
                }
            } catch (whErr) {
                console.error("Error displaying wave height:", whErr);
                const waveValEl = document.getElementById('wave-height-val');
                if (waveValEl) waveValEl.textContent = `-- m`;
            }
        } else {
            const waveValEl = document.getElementById('wave-height-val');
            if (waveValEl) waveValEl.textContent = `-- m`;
        }
        
        // Set dynamic Slovenian names of days for Tomorrow and Day After
        const daysSloNominative = ["Nedelja", "Ponedeljek", "Torek", "Sreda", "Četrtek", "Petek", "Sobota"];
        const dateTomorrow = new Date();
        dateTomorrow.setDate(dateTomorrow.getDate() + 1);
        const dateDayAfter = new Date();
        dateDayAfter.setDate(dateDayAfter.getDate() + 2);
        
        const tomorrowDayName = daysSloNominative[dateTomorrow.getDay()];
        const dayAfterDayName = daysSloNominative[dateDayAfter.getDay()];
        
        const tomorrowNameEl = document.getElementById('forecast-day-1-name');
        if (tomorrowNameEl) tomorrowNameEl.textContent = tomorrowDayName;
        
        const dayAfterNameEl = document.getElementById('forecast-day-2-name');
        if (dayAfterNameEl) dayAfterNameEl.textContent = dayAfterDayName;
        
        let success = false;
        if (arsoForecastData && arsoForecastData.forecast24h?.features?.[0]?.properties?.days) {
            try {
                const days = arsoForecastData.forecast24h.features[0].properties.days;
                
                const updateCardFromArsoJson = (cardPrefix, dayData) => {
                    if (!dayData || !dayData.timeline || dayData.timeline.length === 0) return false;
                    const timeline = dayData.timeline[0];
                    
                    const tempMin = parseFloat(timeline.tnsyn);
                    const tempMax = parseFloat(timeline.txsyn);
                    const windSpeed = parseFloat(timeline.ff_val || "0"); // in m/s
                    const windSpeedKmh = windSpeed * 3.6;
                    const windDir = timeline.dd_shortText || "";
                    const windDirDeg = getWindDegFromSlo(windDir);
                    const windArrow = getWindArrowHtml(windDirDeg);
                    const iconName = timeline.clouds_icon_wwsyn_icon || "";
                    
                    const { icon, color } = mapArsoIconToFa(iconName);
                    
                    const iconEl = document.getElementById(`${cardPrefix}-icon`);
                    if (iconEl) {
                        iconEl.className = `fa-solid ${icon} forecast-icon`;
                        iconEl.style.color = color;
                    }
                    
                    const tempEl = document.getElementById(`${cardPrefix}-temp`);
                    if (tempEl) {
                        tempEl.textContent = `${Math.round(tempMin)} / ${Math.round(tempMax)} °C`;
                    }
                    
                    const windEl = document.getElementById(`${cardPrefix}-wind`);
                    if (windEl) {
                        windEl.innerHTML = `${windArrow}${Math.round(windSpeedKmh)} km/h (${windDir})`;
                    }
                    return true;
                };
                
                const tomorrowSuccess = updateCardFromArsoJson('forecast-day-1', days[1]);
                const dayAfterSuccess = updateCardFromArsoJson('forecast-day-2', days[2]);
                success = tomorrowSuccess && dayAfterSuccess;
            } catch (jsonErr) {
                console.error("Error parsing ARSO daily forecast:", jsonErr);
            }
        }
        
        if (success) {
            if (badge) badge.textContent = 'Vir: ARSO (Portorož)';
        } else {
            console.log("Using Open-Meteo daily forecast fallback");
            if (badge) badge.textContent = 'Vir: Open-Meteo';
            updateOpenMeteoFallbackCards();
        }
    } catch (e) {
        console.error("Error loading ARSO forecast:", e);
        const badge = document.getElementById('weather-source-badge');
        if (badge) badge.textContent = 'Vir: Open-Meteo';
        updateOpenMeteoFallbackCards();
    }
}

function renderArso1hForecast() {
    const container = document.getElementById('hourly-scroll-container');
    if (!container || !arsoForecastData) return false;
    
    const days = arsoForecastData.forecast1h?.features?.[0]?.properties?.days;
    if (!days || !days[0]) return false;
    
    const targetDay = days[0];
    const timeline = targetDay.timeline || [];
    
    container.innerHTML = '';
    
    const now = new Date();
    // Filter out past hours: start with the NEXT full hour
    const nextHour = new Date(now.getTime());
    nextHour.setMinutes(0, 0, 0);
    nextHour.setHours(nextHour.getHours() + 1);
    
    const filtered = timeline.filter(item => {
        const itemDate = new Date(item.valid);
        return itemDate >= nextHour;
    });
    
    if (filtered.length === 0) {
        container.innerHTML = '<div style="font-size:0.8rem;color:var(--text-secondary);width:100%;text-align:center;padding:10px;">Podatki niso na voljo.</div>';
        return true;
    }
    
    filtered.forEach(item => {
        const itemDate = new Date(item.valid);
        const timeStr = itemDate.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
        
        const tempVal = parseFloat(item.t);
        const windSpeed = parseFloat(item.ff_val || "0"); // in m/s
        const windSpeedKmh = windSpeed * 3.6;
        const windDir = item.dd_shortText || "";
        const windDirDeg = getWindDegFromSlo(windDir);
        const windArrow = getWindArrowHtml(windDirDeg);
        const iconName = item.clouds_icon_wwsyn_icon || "";
        const rain = parseFloat(item.tp_acc || "0");
        
        const { icon, color } = mapArsoIconToFa(iconName);
        
        const itemEl = document.createElement('div');
        itemEl.className = 'hourly-item';
        itemEl.innerHTML = `
            <span class="hourly-time">${timeStr}</span>
            <i class="fa-solid ${icon} hourly-icon" style="color: ${color};"></i>
            <span class="hourly-temp">${Math.round(tempVal)}°C</span>
            <span class="hourly-wind">${windArrow}${Math.round(windSpeedKmh)} km/h</span>
            <span class="hourly-rain">${rain > 0 ? rain.toFixed(1) + ' mm' : '0 mm'}</span>
        `;
        container.appendChild(itemEl);
    });
    
    return true;
}

function renderArso3hForecast(dayOffset) {
    const container = document.getElementById('hourly-scroll-container');
    if (!container || !arsoForecastData) return false;
    
    const days = arsoForecastData.forecast3h?.features?.[0]?.properties?.days;
    if (!days || !days[dayOffset]) return false;
    
    const targetDay = days[dayOffset];
    const timeline = targetDay.timeline || [];
    
    container.innerHTML = '';
    
    if (timeline.length === 0) {
        container.innerHTML = '<div style="font-size:0.8rem;color:var(--text-secondary);width:100%;text-align:center;padding:10px;">Podatki niso na voljo.</div>';
        return true;
    }
    
    timeline.forEach(item => {
        const itemDate = new Date(item.valid);
        
        // Format time range: e.g. "11h - 14h"
        const hour = itemDate.getHours();
        const startHour = (hour - 3 + 24) % 24;
        const timeRangeStr = `${startHour}h - ${hour}h`;
        
        const tempVal = parseFloat(item.t);
        const windSpeed = parseFloat(item.ff_val || "0"); // in m/s
        const windSpeedKmh = windSpeed * 3.6;
        const windDir = item.dd_shortText || "";
        const windDirDeg = getWindDegFromSlo(windDir);
        const windArrow = getWindArrowHtml(windDirDeg);
        const iconName = item.clouds_icon_wwsyn_icon || "";
        const rain = parseFloat(item.tp_acc || "0");
        
        const { icon, color } = mapArsoIconToFa(iconName);
        
        const itemEl = document.createElement('div');
        itemEl.className = 'hourly-item';
        itemEl.innerHTML = `
            <span class="hourly-time" style="font-size: 0.62rem; font-weight: 700;">${timeRangeStr}</span>
            <i class="fa-solid ${icon} hourly-icon" style="color: ${color};"></i>
            <span class="hourly-temp">${Math.round(tempVal)}°C</span>
            <span class="hourly-wind">${windArrow}${Math.round(windSpeedKmh)} km/h</span>
            <span class="hourly-rain">${rain > 0 ? rain.toFixed(1) + ' mm' : '0 mm'}</span>
        `;
        container.appendChild(itemEl);
    });
    
    return true;
}

function toggleHourlyForecast(dayOffset) {
    const panel = document.getElementById('hourly-forecast-panel');
    const container = document.getElementById('hourly-scroll-container');
    const titleEl = document.getElementById('hourly-forecast-title');
    
    if (!panel || !container || !titleEl) return;
    
    if (activeHourlyDayOffset === dayOffset) {
        panel.style.display = 'none';
        const activeCard = document.getElementById(`forecast-card-${activeHourlyDayOffset}`);
        if (activeCard) activeCard.classList.remove('active');
        activeHourlyDayOffset = null;
        return;
    }
    
    if (activeHourlyDayOffset !== null) {
        const prevCard = document.getElementById(`forecast-card-${activeHourlyDayOffset}`);
        if (prevCard) prevCard.classList.remove('active');
    }
    
    activeHourlyDayOffset = dayOffset;
    const activeCard = document.getElementById(`forecast-card-${dayOffset}`);
    if (activeCard) activeCard.classList.add('active');
    
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + dayOffset);
    
    const daysSloNominative = ["Nedelja", "Ponedeljek", "Torek", "Sreda", "Četrtek", "Petek", "Sobota"];
    const daysSloAccusative = ["nedeljo", "ponedeljek", "torek", "sredo", "četrtek", "petek", "soboto"];
    
    let dayTitleText = `Podrobna napoved za danes`;
    if (dayOffset > 0) {
        dayTitleText = `Podrobna napoved za ${daysSloAccusative[targetDate.getDay()]}`;
    }
    titleEl.textContent = dayTitleText;
    
    // Attempt rendering using official ARSO JSON (1h or 3h based on dayOffset)
    let arsoSuccess = false;
    if (dayOffset === 0) {
        arsoSuccess = renderArso1hForecast();
    } else {
        arsoSuccess = renderArso3hForecast(dayOffset);
    }
    
    if (!arsoSuccess) {
        console.log("Using Open-Meteo fallback for detail widget");
        let filtered = [];
        const now = new Date();
        
        if (dayOffset === 0) {
            const nextHour = new Date(now.getTime());
            nextHour.setMinutes(0, 0, 0);
            nextHour.setHours(nextHour.getHours() + 1);
            
            const endOfToday = new Date(now.getTime());
            endOfToday.setHours(23, 59, 59, 999);
            
            filtered = openMeteoHourlyForecast.filter(item => item.time >= nextHour && item.time <= endOfToday);
        } else {
            const startOfDay = new Date(targetDate.getTime());
            startOfDay.setHours(0, 0, 0, 0);
            
            const endOfDay = new Date(targetDate.getTime());
            endOfDay.setHours(23, 59, 59, 999);
            
            filtered = openMeteoHourlyForecast.filter(item => item.time >= startOfDay && item.time <= endOfDay);
        }
        
        container.innerHTML = '';
        
        if (filtered.length === 0) {
            container.innerHTML = '<div style="font-size:0.8rem;color:var(--text-secondary);width:100%;text-align:center;padding:10px;">Podatki niso na voljo.</div>';
        } else {
            filtered.forEach(item => {
                const timeStr = item.time.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
                const { icon, color } = mapArsoIconToFa(item.weatherCode === 0 || item.weatherCode === 1 ? "clear" : (item.weatherCode === 2 ? "partCloudy" : "overcast"));
                const rain = item.rain || 0;
                const windArrow = getWindArrowHtml(item.windDir);
                
                const itemEl = document.createElement('div');
                itemEl.className = 'hourly-item';
                itemEl.innerHTML = `
                    <span class="hourly-time">${timeStr}</span>
                    <i class="fa-solid ${icon} hourly-icon" style="color: ${color};"></i>
                    <span class="hourly-temp">${Math.round(item.temp)}°C</span>
                    <span class="hourly-wind">${windArrow}${Math.round(item.windSpeed)} km/h</span>
                    <span class="hourly-rain">${rain > 0 ? rain.toFixed(1) + ' mm' : '0 mm'}</span>
                `;
                container.appendChild(itemEl);
            });
        }
    }
    
    panel.style.display = 'block';
    container.scrollLeft = 0;
}

window.toggleHourlyForecast = toggleHourlyForecast;

async function loadOpenMeteoPressures() {
    try {
        // Fetch 31 days of history and 3 days of forecast from Open-Meteo (including sunrise/sunset)
        const url = 'https://api.open-meteo.com/v1/forecast?latitude=45.5469,42.6507&longitude=13.7294,18.0944&hourly=pressure_msl,weather_code,temperature_2m,wind_speed_10m,precipitation,wind_direction_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,wind_speed_10m_max,wind_direction_10m_dominant,sunrise,sunset&past_days=31&forecast_days=3&timezone=auto';
        const response = await fetch(url);
        if (!response.ok) throw new Error("Meteo API response not ok");
        const json = await response.json();
        
        if (json && json[0] && json[0].hourly && json[1] && json[1].hourly) {
            meteoForecastMap.clear();
            const times = json[0].hourly.time;
            const pressuresKoper = json[0].hourly.pressure_msl;
            const pressuresDubrovnik = json[1].hourly.pressure_msl;
            
            for (let i = 0; i < times.length; i++) {
                const date = new Date(times[i]);
                const timeMs = date.getTime();
                meteoForecastMap.set(timeMs, {
                    pressureKoper: pressuresKoper[i],
                    pressureDubrovnik: pressuresDubrovnik[i]
                });
            }
            console.log(`Loaded ${meteoForecastMap.size} Open-Meteo dual-pressure weather points.`);
            
            // Parse and save hourly details for the slider widget (as fallback)
            openMeteoHourlyForecast = [];
            const hourly = json[0].hourly;
            const startOfToday = new Date();
            startOfToday.setHours(0, 0, 0, 0);
            
            for (let i = 0; i < hourly.time.length; i++) {
                const date = new Date(hourly.time[i]);
                if (date >= startOfToday) {
                    openMeteoHourlyForecast.push({
                        time: date,
                        temp: hourly.temperature_2m[i],
                        weatherCode: hourly.weather_code[i],
                        windSpeed: hourly.wind_speed_10m[i],
                        windDir: hourly.wind_direction_10m ? hourly.wind_direction_10m[i] : 0,
                        rain: hourly.precipitation ? hourly.precipitation[i] : 0
                    });
                }
            }
            
            // Save daily data for fallback cards
            openMeteoDailyData = json[0].daily || null;
            
            // Update sunrise and sunset widgets
            if (openMeteoDailyData && openMeteoDailyData.sunrise && openMeteoDailyData.sunset) {
                const parseTime = (isoStr) => {
                    const d = new Date(isoStr);
                    return d.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
                };
                document.getElementById('sunrise-time').textContent = parseTime(openMeteoDailyData.sunrise[0]);
                document.getElementById('sunset-time').textContent = parseTime(openMeteoDailyData.sunset[0]);
            }
        }
    } catch (e) {
        console.error("Error loading Open-Meteo pressure data:", e);
    }
}

async function refreshData() {
    try {
        // Fetch Open-Meteo dual-pressure data (crucial for chart)
        const meteoPromise = loadOpenMeteoPressures();
        actualData = await loadMergedWaterData();
        if (!actualData || actualData.length === 0) throw new Error("Data empty");
        
        // Wait for pressure data to finish loading (very fast)
        await meteoPromise;
        
        // Cache data to LocalStorage
        try {
            localStorage.setItem('arso_actual_data', JSON.stringify(actualData));
        } catch (e) {
            console.warn("Could not save to localStorage:", e);
        }
        
        const latestTime = actualData[actualData.length - 1].time;
        
        // Update widgets based on latest actual measurement
        const latest = actualData[actualData.length - 1];
        const relativeVal = latest.level - MEAN_SEA_LEVEL_OFFSET;
        const relativeSign = relativeVal >= 0 ? '+' : '';
        document.getElementById('current-level-val').textContent = `${relativeSign}${Math.round(relativeVal)}`;
        document.getElementById('relative-level-val').textContent = `Absolutna gladina: ${Math.round(latest.level)} cm`;
        
        const timeStr = latest.time.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
        const timeEl = document.getElementById('level-time-val');
        if (timeEl) timeEl.textContent = `Meritev ARSO ob: ${timeStr}`;
        
        document.getElementById('current-temp-val').textContent = latest.temp.toFixed(1);
        
        // Check for flood warning (level >= 300 cm)
        const warningContainer = document.getElementById('warning-banner-container');
        const levelCard = document.getElementById('card-sea-level');
        
        if (latest.level >= 300.0) {
            if (levelCard) levelCard.classList.add('warning-active');
            if (warningContainer) {
                warningContainer.innerHTML = `
                    <div class="warning-banner">
                        <i class="fa-solid fa-triangle-exclamation"></i>
                        <span>OPOZORILO: Gladina morja presega kritično mejo (300 cm)! Možnost poplavljanja obale.</span>
                    </div>
                `;
            }
        } else {
            if (levelCard) levelCard.classList.remove('warning-active');
            if (warningContainer) warningContainer.innerHTML = '';
        }
        
        // Calculate sea level trend (raste / pada / stagnira) based on last 3 measurements
        const latestPoints = actualData.slice(-3);
        const trendBadge = document.getElementById('level-trend-badge');
        if (trendBadge && latestPoints.length >= 3) {
            const totalDiff = latestPoints[2].level - latestPoints[0].level;
            trendBadge.className = 'trend-badge'; // Reset state classes
            
            if (totalDiff > 0.4) {
                trendBadge.innerHTML = '<i class="fa-solid fa-arrow-trend-up"></i> raste';
                trendBadge.classList.add('trend-up');
            } else if (totalDiff < -0.4) {
                trendBadge.innerHTML = '<i class="fa-solid fa-arrow-trend-down"></i> pada';
                trendBadge.classList.add('trend-down');
            } else {
                trendBadge.innerHTML = '<i class="fa-solid fa-arrows-left-right"></i> stagnira';
                trendBadge.classList.add('trend-stable');
            }
        }
        
        // Calculate high/low tide predictions based on current device time
        calculateTideExtrema(new Date());
        
        // Draw the chart
        renderChart();
    } catch (err) {
        console.error("Error refreshing data:", err);
        // Show error indicator in cards
        document.getElementById('current-level-val').textContent = "Napaka";
        document.getElementById('current-temp-val').textContent = "Napaka";
    }
}

// Calculate the next high and low tides based on the physical model
function calculateTideExtrema(currentTime) {
    // Generate predictions for the next 36 hours at 5-minute intervals to find peak times precisely
    const start = new Date(currentTime.getTime());
    const end = new Date(currentTime.getTime() + (36 * 60 * 60 * 1000));
    const predictions = TideCalculator.getPredictionsForPeriod(start, end, 5);
    
    let nextHigh = null;
    let nextLow = null;
    
    // Search for peaks in the series
    for (let i = 1; i < predictions.length - 1; i++) {
        const prev = predictions[i-1].level;
        const curr = predictions[i].level;
        const next = predictions[i+1].level;
        
        // High tide peak (local maxima)
        if (curr > prev && curr > next) {
            if (!nextHigh && predictions[i].time > currentTime) {
                nextHigh = predictions[i];
            }
        }
        // Low tide peak (local minima)
        if (curr < prev && curr < next) {
            if (!nextLow && predictions[i].time > currentTime) {
                nextLow = predictions[i];
            }
        }
        
        if (nextHigh && nextLow) break;
    }
    
    console.log("calculateTideExtrema debug:", { 
        currentTime: currentTime.toString(), 
        predictionsLength: predictions.length, 
        nextHigh: nextHigh ? { time: nextHigh.time.toString(), level: nextHigh.level } : null,
        nextLow: nextLow ? { time: nextLow.time.toString(), level: nextLow.level } : null
    });
    
    const SLO_DAYS = ["NED", "PON", "TOR", "SRE", "ČET", "PET", "SOB"];
    
    // Update the widgets
    if (nextHigh) {
        const dayPrefix = SLO_DAYS[nextHigh.time.getDay()];
        const timeStr = nextHigh.time.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
        const highTimeStr = `${dayPrefix} ${timeStr}`;
        document.getElementById('next-high-time').textContent = highTimeStr;
        const relativeVal = nextHigh.level;
        const relativeSign = relativeVal >= 0 ? '+' : '';
        document.getElementById('next-high-height').textContent = `Višina: ${relativeSign}${relativeVal.toFixed(0)} cm`;
    }
    
    if (nextLow) {
        const dayPrefix = SLO_DAYS[nextLow.time.getDay()];
        const timeStr = nextLow.time.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
        const lowTimeStr = `${dayPrefix} ${timeStr}`;
        document.getElementById('next-low-time').textContent = lowTimeStr;
        const relativeVal = nextLow.level;
        const relativeSign = relativeVal >= 0 ? '+' : '';
        document.getElementById('next-low-height').textContent = `Višina: ${relativeSign}${relativeVal.toFixed(0)} cm`;
    }
}
// Fetch Portorož current weather conditions from ARSO via proxy
async function loadWeather() {
    try {
        const targetUrl = 'https://vreme.arso.gov.si/api/1.0/location/?location=Piran&format=json';
        const url = PROXY_URL + '?url=' + encodeURIComponent(targetUrl);
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            const obs = data.observation;
            if (!obs || !obs.features || obs.features.length === 0) return;
            
            const props = obs.features[0].properties;
            if (!props || !props.days || props.days.length === 0) return;
            
            const timeline = props.days[0].timeline;
            if (!timeline || timeline.length === 0) return;
            
            const current = timeline[0];
            
            // Air Temp
            const tempVal = parseFloat(current.t);
            document.getElementById('air-temp-val').textContent = `${tempVal.toFixed(1)}°C`;
            
            // Apparent Temperature (feels-like)
            const rh = parseFloat(current.rh);
            const ws = parseFloat(current.ff_val || "0"); // in m/s
            const feelsLikeEl = document.getElementById('air-temp-feels-val');
            if (feelsLikeEl && !isNaN(tempVal) && !isNaN(rh) && !isNaN(ws)) {
                const e = (rh / 100.0) * 6.105 * Math.exp((17.27 * tempVal) / (237.7 + tempVal));
                const apparentTemp = tempVal + 0.33 * e - 0.7 * ws - 4.0;
                feelsLikeEl.textContent = `Obč. ${Math.round(apparentTemp)}°C`;
            } else if (feelsLikeEl) {
                feelsLikeEl.textContent = `Obč. --`;
            }
            
            // Weather Condition Description
            const wDesc = current.clouds_shortText_wwsyn_shortText || current.clouds_shortText || "";
            document.getElementById('weather-desc-val').textContent = wDesc;
            
            // Weather icon mapping
            const iconBox = document.getElementById('weather-icon-box');
            const icon = document.getElementById('weather-icon');
            icon.className = 'fa-solid';
            
            const iconName = current.clouds_icon_wwsyn_icon || "";
            const { icon: iconClass, color } = mapArsoIconToFa(iconName);
            
            icon.classList.add(iconClass);
            iconBox.style.background = `rgba(${color === '#cbd5e1' || color === '#fef08a' ? '148, 163, 184' : '245, 158, 11'}, 0.1)`;
            iconBox.style.borderColor = `rgba(${color === '#cbd5e1' || color === '#fef08a' ? '148, 163, 184' : '245, 158, 11'}, 0.25)`;
            icon.style.color = color;
            
            // Pressure, Humidity, Wind
            document.getElementById('air-pressure-val').textContent = `${Math.round(parseFloat(current.msl))} hPa`;
            document.getElementById('humidity-val').textContent = `${Math.round(parseFloat(current.rh))}%`;
            
            const windSpeedKmh = parseFloat(current.ff_val || "0") * 3.6; // Convert m/s to km/h!
            const windDirStr = current.dd_shortText || "";
            const windDirDeg = getWindDegFromSlo(windDirStr);
            const windArrow = getWindArrowHtml(windDirDeg);
            document.getElementById('wind-speed-val').innerHTML = `${windArrow}${Math.round(windSpeedKmh)} km/h`;
            document.getElementById('wind-dir-val').textContent = windDirStr;
        }
    } catch (e) {
        console.error("Error loading weather data:", e);
    }
}

function renderChart() {
    if (actualData.length === 0) return;
    
    const startTime = actualData[0].time;
    const endTime = actualData[actualData.length - 1].time;
    
    // Predictions window: extend predictions 365 days into the future to see forecasted tides
    const forecastEnd = new Date(endTime.getTime() + (365 * 24 * 60 * 60 * 1000));
    
    // Generate astronomical predictions for the chart period (using 10-minute interval to align with ARSO measurements)
    const predictions = TideCalculator.getPredictionsForPeriod(startTime, forecastEnd, 10);
    
    let series = [];
    let yAxisTitle = '';
    let chartTitle = '';
    
    if (chartMode === 'level') {
        // Map actual levels into relative values
        const actualSeriesData = actualData.map(d => [d.time.getTime(), d.level - MEAN_SEA_LEVEL_OFFSET]);
        
        // Map predicted levels (already relative)
        const predictedSeriesData = predictions.map(d => [d.time.getTime(), d.level]);
        
        // Create a fast lookup map for astronomical predictions to optimize lookup speeds
        const predictionMap = new Map();
        predictions.forEach(p => {
            const roundedTimeMs = Math.round(p.time.getTime() / (10 * 60 * 1000)) * (10 * 60 * 1000);
            predictionMap.set(roundedTimeMs, p.level);
        });
        
        // Calculate rolling seasonal bias offset (Actual - Prediction - Weather) over the last 24 hours
        let totalDiffSum = 0;
        let diffCount = 0;
        
        const latestActualTime = actualData[actualData.length - 1].time;
        const oneDayAgoMs = latestActualTime.getTime() - (24 * 60 * 60 * 1000);
        
        actualData.forEach(d => {
            const timeMs = d.time.getTime();
            if (timeMs >= oneDayAgoMs) {
                const roundedTimeMs = Math.round(timeMs / (10 * 60 * 1000)) * (10 * 60 * 1000);
                const predRel = predictionMap.get(roundedTimeMs);
                
                if (predRel !== undefined) {
                    const hourMs = Math.round(timeMs / (3600 * 1000)) * (3600 * 1000);
                    const meteo = meteoForecastMap.get(hourMs);
                    
                    let meteoEffect = 0;
                    if (meteo) {
                        const pCorr = 1013.25 - meteo.pressureKoper;
                        const grad = meteo.pressureDubrovnik - meteo.pressureKoper;
                        const gradCorr = 2.0 * grad; // 2 cm of surge per hPa pressure difference
                        meteoEffect = pCorr + gradCorr;
                    }
                    
                    const actualRel = d.level - MEAN_SEA_LEVEL_OFFSET;
                    
                    // Difference after subtracting both astro prediction and meteo correction
                    const diff = actualRel - (predRel + meteoEffect);
                    totalDiffSum += diff;
                    diffCount++;
                }
            }
        });
        
        const biasOffset = diffCount > 0 ? (totalDiffSum / diffCount) : 0;
        console.log(`Calculated weather-corrected rolling bias: ${biasOffset.toFixed(2)} cm over ${diffCount} points.`);
        
        // Calculate hybrid predictions (astronomical tide + rolling bias + pressure-gradient weather correction)
        const hybridSeriesData = [];
        predictions.forEach(d => {
            const timeMs = d.time.getTime();
            
            // Find closest hourly weather data point (round to nearest hour)
            const hourMs = Math.round(timeMs / (3600 * 1000)) * (3600 * 1000);
            const meteo = meteoForecastMap.get(hourMs);
            
            if (meteo) {
                const pCorr = 1013.25 - meteo.pressureKoper;
                const grad = meteo.pressureDubrovnik - meteo.pressureKoper;
                const gradCorr = 2.0 * grad;
                const meteoEffect = pCorr + gradCorr;
                
                // Hybrid level = astronomical + seasonal bias + meteorological correction
                const hybridVal = d.level + biasOffset + meteoEffect;
                hybridSeriesData.push([timeMs, hybridVal]);
            }
        });
        
        series = [
            {
                name: 'Izmerjena gladina (ARSO)',
                data: actualSeriesData,
                type: 'spline',
                color: '#f97316', // High-contrast orange
                shadow: {
                    color: 'rgba(249, 115, 22, 0.35)',
                    width: 4,
                    offsetX: 0,
                    offsetY: 2
                },
                marker: { enabled: false, states: { hover: { enabled: true, radius: 5 } } }
            },
            {
                name: 'Napovedano plimovanje (NIB MBP)',
                data: predictedSeriesData,
                type: 'spline',
                color: '#10b981', // Distinct green
                dashStyle: 'ShortDash',
                opacity: 0.85,
                marker: { enabled: false }
            },
            {
                name: 'Hibridna napoved (beta)',
                data: hybridSeriesData,
                type: 'spline',
                color: '#eab308', // Vivid yellow
                dashStyle: 'ShortDot',
                opacity: 0.95,
                visible: true,
                marker: { enabled: false }
            }
        ];
        
        yAxisTitle = 'Relativna gladina morja (cm)';
        chartTitle = 'Primerjava izmerjene in napovedane gladine morja';
    } else {
        // Temperature Mode
        const tempSeriesData = actualData.map(d => [d.time.getTime(), d.temp]);
        series = [
            {
                name: 'Temperatura morja (ARSO)',
                data: tempSeriesData,
                type: 'spline',
                color: '#f43f5e',
                shadow: {
                    color: 'rgba(244, 63, 94, 0.4)',
                    width: 4,
                    offsetX: 0,
                    offsetY: 2
                },
                marker: { enabled: false, states: { hover: { enabled: true, radius: 5 } } }
            }
        ];
        
        yAxisTitle = 'Temperatura (°C)';
        chartTitle = 'Temperatura morja v zadnjem obdobju';
    }
    
    // Dynamic theme colors for Highcharts
    const isLight = document.body.classList.contains('light-theme');
    const titleColor = isLight ? '#0f172a' : '#f8fafc';
    const labelColor = isLight ? '#475569' : '#94a3b8';
    const gridColor = isLight ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.05)';
    const zeroLineCol = isLight ? 'rgba(0, 0, 0, 0.2)' : 'rgba(255, 255, 255, 0.2)';
    
    // Calculate visible extremes based on periodHours
    const latestTimeVal = endTime.getTime();
    const minTime = latestTimeVal - (periodHours * 60 * 60 * 1000);
    const maxTime = chartMode === 'level' ? latestTimeVal + (periodHours * 60 * 60 * 1000) : latestTimeVal;
    
    // Render Highcharts Stock
    currentChart = Highcharts.stockChart('sea-level-chart', {
        exporting: {
            enabled: false // Disable the exporting burger menu to prevent overlap with fullscreen button
        },
        chart: {
            style: { fontFamily: 'Inter' },
            spacingBottom: 5,
            panning: {
                enabled: true,
                type: 'x'
            },
            pinchType: 'x',
            zoomType: null
        },
        time: {
            useUTC: false
        },
        title: {
            text: null // Disable title entirely for cleaner UI and maximum vertical chart space
        },
        credits: { enabled: false },
        rangeSelector: {
            enabled: false // Custom HTML buttons control this
        },
        scrollbar: {
            enabled: false
        },
        navigator: {
            enabled: false
        },
        xAxis: {
            type: 'datetime',
            gridLineWidth: 1,
            labels: {
                style: { color: labelColor },
                formatter: function () {
                    const date = new Date(this.value);
                    const hours = date.getHours();
                    const minutes = date.getMinutes();
                    
                    // If it is midnight, display day name and date (e.g. Pon 10. 8.)
                    if (hours === 0 && minutes === 0) {
                        const days = ['Ned', 'Pon', 'Tor', 'Sre', 'Čet', 'Pet', 'Sob'];
                        const dayName = days[date.getDay()];
                        const day = date.getDate();
                        const month = date.getMonth() + 1;
                        return `<b>${dayName} ${day}. ${month}.</b>`;
                    }
                    
                    // Otherwise, display time
                    return Highcharts.dateFormat('%H:%M', this.value);
                }
            },
            min: minTime,
            max: maxTime,
            plotLines: [{
                value: endTime.getTime(),
                color: '#ef4444',
                width: 2,
                dashStyle: 'ShortDot',
                label: {
                    text: 'Sedaj',
                    align: 'right',
                    x: -8, // Shift to the left of the line so it doesn't clip on the right edge
                    y: 30, // Move lower to make it fully visible
                    style: { color: '#ef4444', fontWeight: 'bold' }
                },
                zIndex: 5
            }],
            ordinal: false
        },
        yAxis: {
            title: {
                text: yAxisTitle,
                style: { color: labelColor }
            },
            gridLineColor: gridColor,
            labels: { style: { color: labelColor } },
            plotLines: chartMode === 'level' ? [{
                value: 0,
                color: zeroLineCol,
                width: 1.5,
                dashStyle: 'Dash',
                label: {
                    text: 'Srednje morje (0 cm)',
                    align: 'left',
                    style: { color: isLight ? '#475569' : '#64748b', fontSize: '10px' },
                    x: 10
                },
                zIndex: 1
            }] : []
        },
        tooltip: {
            shared: true,
            crosshairs: true,
            followTouchMove: false, // Allows native vertical scrolling on mobile
            formatter: function () {
                const days = ['Ned', 'Pon', 'Tor', 'Sre', 'Čet', 'Pet', 'Sob'];
                const dateObj = new Date(this.x);
                const dayName = days[dateObj.getDay()];
                const timeStr = Highcharts.dateFormat('%H:%M', this.x);
                let s = `<b>${dayName}, ${timeStr}</b><br/>`;
                
                this.points.forEach(point => {
                    if (chartMode === 'level') {
                        const relVal = Math.round(point.y);
                        const sign = relVal >= 0 ? '+' : '';
                        let prefix = 'NAP';
                        if (point.series.name.includes('Izmerjena')) {
                            prefix = 'DEJ';
                        } else if (point.series.name.includes('Hibridna')) {
                            prefix = 'HIB';
                        }
                        s += `<span style="color:${point.color}">●</span> ${prefix}: <b>${sign}${relVal} cm</b><br/>`;
                    } else {
                        const val = point.y.toFixed(1);
                        s += `<span style="color:${point.color}">●</span> <b>${val} °C</b><br/>`;
                    }
                });
                return s;
            }
        },
        legend: {
            enabled: true,
            align: 'center',
            verticalAlign: 'bottom',
            layout: 'horizontal',
            margin: 5,
            padding: 2,
            itemDistance: 10,
            itemStyle: { color: labelColor, fontSize: '10px' },
            itemHoverStyle: { color: titleColor }
        },
        plotOptions: {
            spline: {
                lineWidth: 2.5
            },
            series: {
                dataGrouping: {
                    enabled: false
                }
            }
        },
        series: series
    });
}

// Toggle custom CSS-based pseudo-fullscreen mode for mobile/desktop
function toggleFullscreen() {
    const chartCard = document.querySelector('.chart-container-card');
    const fsBtn = document.getElementById('fullscreen-btn');
    
    if (!chartCard) return;
    
    const isFullscreen = chartCard.classList.toggle('fullscreen-active');
    document.body.classList.toggle('fullscreen-open', isFullscreen); // Add/remove body layout override class
    
    if (isFullscreen) {
        fsBtn.innerHTML = '<i class="fa-solid fa-compress"></i>';
        fsBtn.title = "Izhod iz celozaslonskega načina";
    } else {
        fsBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
        fsBtn.title = "Celozaslonski način";
    }
    
    if (currentChart) {
        setTimeout(() => {
            currentChart.reflow();
        }, 150); // Small timeout to allow CSS hide animations/transitions to finish before reflowing the chart size
    }
}

// Calculate moon phase client-side based on astronomical cycle
function updateMoonPhase() {
    const now = new Date();
    
    // Reference New Moon: Jan 6, 2000 18:14 UTC (947182440000 ms)
    const refNewMoon = 947182440000;
    const synodicMonth = 2551442977; // ms (29.530588853 days)
    
    const diffMs = now.getTime() - refNewMoon;
    const ageDays = ((diffMs % synodicMonth) + synodicMonth) % synodicMonth / 86400000;
    
    let phaseName = "";
    let iconClass = "fa-solid fa-moon";
    let iconTransform = "";
    
    if (ageDays < 1.0 || ageDays >= 28.53) {
        phaseName = "Mlaj";
        iconClass = "fa-regular fa-circle";
    } else if (ageDays < 6.38) {
        phaseName = "Rastoča luna";
        iconClass = "fa-solid fa-moon";
        iconTransform = "scaleX(-1)"; // Mirror to point like '('
    } else if (ageDays < 8.38) {
        phaseName = "Prvi krajec";
        iconClass = "fa-solid fa-circle-half-stroke";
        iconTransform = "rotate(180deg)"; // Make it right-side filled
    } else if (ageDays < 13.76) {
        phaseName = "Rastoča luna";
        iconClass = "fa-solid fa-circle-half-stroke";
        iconTransform = "rotate(180deg)"; // Make it right-side filled
    } else if (ageDays < 15.76) {
        phaseName = "Ščip";
        iconClass = "fa-solid fa-circle";
    } else if (ageDays < 21.15) {
        phaseName = "Padajoča luna";
        iconClass = "fa-solid fa-circle-half-stroke"; // Left-side filled by default
    } else if (ageDays < 23.15) {
        phaseName = "Zadnji krajec";
        iconClass = "fa-solid fa-circle-half-stroke"; // Left-side filled by default
    } else {
        phaseName = "Padajoča luna";
        iconClass = "fa-solid fa-moon"; // Points like ')' by default
    }
    
    // Calculate Tide Coefficient (0 = Neap, 100 = Spring)
    // Spring tide occurs at New Moon (0) and Full Moon (14.765)
    const cyclePos = ageDays % 14.7654;
    const dist = Math.min(cyclePos, 14.7654 - cyclePos);
    const coeff = Math.round(100 - (dist / 7.3827) * 100);
    
    let coeffDesc = "";
    if (coeff >= 75) {
        coeffDesc = `<span class="coeff-spring">Močno plimovanje</span> (sizigijsko, ${coeff}%)`;
    } else if (coeff <= 25) {
        coeffDesc = `<span class="coeff-neap">Šibko plimovanje</span> (kvadraturno, ${coeff}%)`;
    } else {
        coeffDesc = `Srednje plimovanje (${coeff}%)`;
    }
    
    // Update UI elements
    const phaseNameEl = document.getElementById('moon-phase-name');
    const coeffValEl = document.getElementById('moon-coeff-val');
    
    if (phaseNameEl) phaseNameEl.textContent = phaseName;
    if (coeffValEl) coeffValEl.innerHTML = `Tip: ${coeffDesc}`;
    
    const moonIcon = document.getElementById('moon-icon');
    if (moonIcon) {
        moonIcon.className = iconClass;
        moonIcon.style.display = "inline-block"; // Force display inline-block to allow transforms
        moonIcon.style.transform = iconTransform;
        if (phaseName === "Ščip") {
            moonIcon.style.textShadow = "0 0 10px #fff";
            moonIcon.style.color = "#fff";
        } else {
            moonIcon.style.textShadow = "none";
            moonIcon.style.color = "";
        }
    }
}

// Toggle between light and dark themes
function toggleTheme() {
    document.body.classList.toggle('light-theme');
    const isLight = document.body.classList.contains('light-theme');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    updateThemeIcon();
    
    // Re-render chart to apply new theme colors
    renderChart();
}

function updateThemeIcon() {
    const icon = document.getElementById('theme-icon-indicator');
    if (!icon) return;
    
    if (document.body.classList.contains('light-theme')) {
        // In light theme, show a Moon icon (click to switch to dark theme)
        icon.className = 'fa-solid fa-moon';
        icon.style.color = '#475569';
    } else {
        // In dark theme, show a Sun icon (click to switch to light theme)
        icon.className = 'fa-solid fa-sun';
        icon.style.color = '#e2e8f0';
    }
}
