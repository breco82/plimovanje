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
let activeWeatherSource = 'portoroz'; // 'vida' or 'portoroz'
let weatherDataVida = null;       // Cached weather data from Vida buoy
let weatherDataPortoroz = null;   // Cached weather data from Portorož Airport
let currentMarineWaveHeight = null; // Cached current wave height from Open-Meteo forecast
let marineHourlyWaves = new Map();  // Map of timestamp (ms) -> wave height (m)
const PROXY_URL = 'https://script.google.com/macros/s/AKfycbxoILNm85D58iHTxfbE8J_BawhREfiv2q1bUHSED_GqPT2LhUSyFxXjSXEx4cyk9eT8/exec';

// Datum offset constant (Srednja gladina morja / Mean sea level - SVS2010 reference datum is 217.0 cm above gauge zero)
const MEAN_SEA_LEVEL_OFFSET = 217.0;

let deferredPrompt = null;

// Helper: Official Douglas Sea Scale
function getDouglasSeaState(heightM) {
    if (heightM === null || heightM === undefined || isNaN(heightM)) {
        return { code: null, text: "--", label: "--" };
    }
    const h = parseFloat(heightM);
    if (h < 0.05) return { code: 0, text: "Mirno morje", label: "Mirno (0)" };
    if (h <= 0.1) return { code: 1, text: "Mirno z zibanjem", label: "Mirno z zibanjem (1)" };
    if (h <= 0.5) return { code: 2, text: "Rahlo vzvalovano", label: "Rahlo vzvalovano (2)" };
    if (h <= 1.25) return { code: 3, text: "Zmerno vzvalovano", label: "Zmerno vzvalovano (3)" };
    if (h <= 2.5) return { code: 4, text: "Vzvalovano morje", label: "Vzvalovano (4)" };
    if (h <= 4.0) return { code: 5, text: "Močno vzvalovano", label: "Močno vzvalovano (5)" };
    if (h <= 6.0) return { code: 6, text: "Zelo močno vzvalovano", label: "Zelo močno vzvalovano (6)" };
    if (h <= 9.0) return { code: 7, text: "Visoko valovito", label: "Visoko valovito (7)" };
    if (h <= 14.0) return { code: 8, text: "Zelo visoko valovito", label: "Zelo visoko valovito (8)" };
    return { code: 9, text: "Izjemno valovito", label: "Izjemno valovito (9)" };
}

// Helper: Option A wave symbol and height
function getWaveIconHtml(heightM) {
    if (heightM === null || heightM === undefined || isNaN(heightM)) {
        return `<span style="color:var(--text-secondary);font-size:0.7rem;">--</span>`;
    }
    const h = parseFloat(heightM);
    if (h <= 0.5) {
        return `<span style="display:inline-flex;align-items:center;gap:3px;color:#22c55e;font-size:0.72rem;font-weight:600;" title="Rahlo vzvalovano (${h.toFixed(2)} m)">
            <svg style="width:13px;height:8px;fill:none;stroke:currentColor;stroke-width:2.5;stroke-linecap:round;" viewBox="0 0 24 12"><path d="M0 6 Q6 0, 12 6 T24 6"/></svg>
            ${h.toFixed(1)}m
        </span>`;
    } else if (h <= 1.25) {
        return `<span style="display:inline-flex;align-items:center;gap:3px;color:#38bdf8;font-size:0.72rem;font-weight:600;" title="Zmerno vzvalovano (${h.toFixed(2)} m)">
            <svg style="width:13px;height:10px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;" viewBox="0 0 24 16"><path d="M0 5 Q6 0, 12 5 T24 5 M0 11 Q6 6, 12 11 T24 11"/></svg>
            ${h.toFixed(1)}m
        </span>`;
    } else if (h <= 2.5) {
        return `<span style="display:inline-flex;align-items:center;gap:3px;color:#f59e0b;font-size:0.72rem;font-weight:600;" title="Vzvalovano (${h.toFixed(2)} m)">
            <svg style="width:13px;height:12px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;" viewBox="0 0 24 20"><path d="M0 4 Q6 -2, 12 4 T24 4 M0 10 Q6 4, 12 10 T24 10 M0 16 Q6 10, 12 16 T24 16"/></svg>
            ${h.toFixed(1)}m
        </span>`;
    } else {
        return `<span style="display:inline-flex;align-items:center;gap:3px;color:#ef4444;font-size:0.72rem;font-weight:700;" title="Močno valovito (${h.toFixed(2)} m)">
            <i class="fa-solid fa-triangle-exclamation" style="font-size:0.65rem;"></i>
            ${h.toFixed(1)}m
        </span>`;
    }
}

// Helper: Closest hourly wave height lookup
function getWaveHeightForTime(targetDate) {
    if (!targetDate || marineHourlyWaves.size === 0) return currentMarineWaveHeight;
    const targetMs = targetDate.getTime();
    let closestHeight = currentMarineWaveHeight;
    let minDiff = Infinity;
    for (const [timeMs, height] of marineHourlyWaves.entries()) {
        const diff = Math.abs(timeMs - targetMs);
        if (diff < minDiff) {
            minDiff = diff;
            closestHeight = height;
        }
    }
    return closestHeight;
}

// Helper: Maximum wave height for a calendar day (for daily forecast cards)
function getDayMaxWaveHeight(targetDate) {
    if (!targetDate || marineHourlyWaves.size === 0) return currentMarineWaveHeight;
    const targetY = targetDate.getFullYear();
    const targetM = targetDate.getMonth();
    const targetD = targetDate.getDate();
    
    let maxH = 0;
    let found = false;
    
    for (const [timeMs, height] of marineHourlyWaves.entries()) {
        const d = new Date(timeMs);
        if (d.getFullYear() === targetY && d.getMonth() === targetM && d.getDate() === targetD) {
            found = true;
            if (height > maxH) {
                maxH = height;
            }
        }
    }
    return found ? maxH : currentMarineWaveHeight;
}

// Helper: Beaufort scale & Slovene descriptions
function getBeaufortInfo(windSpeedKmh) {
    const kmh = parseFloat(windSpeedKmh) || 0;
    if (kmh < 1) return { bft: 0, text: "tišina" };
    if (kmh <= 5) return { bft: 1, text: "lahka sapa" };
    if (kmh <= 11) return { bft: 2, text: "lahek vetrič" };
    if (kmh <= 19) return { bft: 3, text: "zmeren veter" };
    if (kmh <= 28) return { bft: 4, text: "zmerno močan veter" };
    if (kmh <= 38) return { bft: 5, text: "svež veter" };
    if (kmh <= 49) return { bft: 6, text: "močan veter" };
    if (kmh <= 61) return { bft: 7, text: "zelo močan veter" };
    if (kmh <= 74) return { bft: 8, text: "vihar" };
    if (kmh <= 88) return { bft: 9, text: "močan vihar" };
    if (kmh <= 102) return { bft: 10, text: "polni vihar" };
    if (kmh <= 117) return { bft: 11, text: "orkanski vihar" };
    return { bft: 12, text: "orkan" };
}

// Toggle Sea Scale Legend
function toggleSeaLegend() {
    const content = document.getElementById('sea-legend-content');
    const arrow = document.getElementById('sea-legend-arrow');
    if (!content) return;
    const isHidden = content.style.display === 'none';
    content.style.display = isHidden ? 'block' : 'none';
    if (arrow) {
        arrow.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
    }
}
window.toggleSeaLegend = toggleSeaLegend;

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

    // Reset initial UI displays to loading placeholders
    document.getElementById('current-level-val').textContent = "--";
    document.getElementById('relative-level-val').textContent = "Absolutna gladina: Nalaganje...";
    document.getElementById('current-temp-val').textContent = "--";
    const timeEl = document.getElementById('level-time-val');
    if (timeEl) timeEl.textContent = "Nalaganje meritev...";
    
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
    
    const isLocalhost = (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
    
    // Attempt 1: Local server proxy (ONLY if running on localhost to avoid 3s network timeout on live web)
    if (isLocalhost) {
        try {
            const res = await fetch(localUrl);
            if (res.ok) {
                return await res.json();
            }
        } catch (e) {
            console.log(`Local API endpoint failed for period ${arsoPeriod}, trying direct public CORS proxy...`, e);
        }
    }
    
    // Attempt 2: Google Apps Script CORS proxy (completely free and reliable, hosted on Google Cloud)
    try {
        const proxyUrl = `${PROXY_URL}?url=${encodeURIComponent(publicUrl)}`;
        const res = await fetch(proxyUrl);
        if (res.ok) {
            const html = await res.text();
            return parseArsoHtml(html);
        }
    } catch (e) {
        console.log(`Google Apps Script proxy failed for period ${arsoPeriod}, trying backup proxy...`, e);
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

// Convert Slovenian wind direction abbreviation (S, SV, V, JV, J, JZ, Z, SZ) to degrees
function getWindDegFromSlo(dirStr) {
    if (!dirStr) return 0;
    const str = dirStr.trim().toUpperCase();
    switch (str) {
        case "S": return 0;
        case "SV": return 45;
        case "V": return 90;
        case "JV": return 135;
        case "J": return 180;
        case "JZ": return 225;
        case "Z": return 270;
        case "SZ": return 315;
        default: return 0;
    }
}

// Store ARSO forecast raw data with proxy fallbacks (to bypass ad-blockers and CORS issues)
async function fetchWeatherWithFallback(targetUrl, isXml = false) {
    const directUrl = PROXY_URL + '?url=' + encodeURIComponent(targetUrl);
    
    // Try 1: Direct fetch to Google Apps Script (fastest)
    try {
        const res = await fetch(directUrl);
        if (res.ok) {
            if (isXml) {
                return await res.text();
            } else {
                const json = await res.json();
                if (json && !json.error) return json;
            }
        }
    } catch (e) {
        console.warn("Direct Google Apps Script fetch failed, trying via CORS proxy fallback...", e);
    }
    
    // Try 2: Via corsproxy.io
    try {
        const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(directUrl)}`;
        const res = await fetch(proxyUrl);
        if (res.ok) {
            if (isXml) {
                return await res.text();
            } else {
                const json = await res.json();
                if (json && !json.error) return json;
            }
        }
    } catch (e) {
        console.warn("CORS proxy fallback failed, trying via AllOrigins fallback...", e);
    }
    
    // Try 3: Via allorigins
    try {
        const backupUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(directUrl)}`;
        const res = await fetch(backupUrl);
        if (res.ok) {
            const wrapper = await res.json();
            if (wrapper && wrapper.contents) {
                if (isXml) {
                    return wrapper.contents;
                } else {
                    const json = JSON.parse(wrapper.contents);
                    if (json && !json.error) return json;
                }
            }
        }
    } catch (e) {
        console.error("All weather proxy fallbacks failed", e);
    }
    return null;
}

async function fetchArsoForecastViaProxy() {
    const targetUrl = 'https://vreme.arso.gov.si/api/1.0/location/?location=Piran&format=json';
    return await fetchWeatherWithFallback(targetUrl);
}

async function fetchWaveHeight() {
    try {
        const url = 'https://marine-api.open-meteo.com/v1/marine?latitude=45.527662&longitude=13.598006&hourly=wave_height&timezone=auto';
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
        return { icon: "fa-cloud-bolt", color: "#38bdf8" }; // cloud/rain/storm icons are blue
    }
    if (name.includes("sn") || name.includes("snow") || name.includes("flake") || name.includes("sneg")) {
        return { icon: "fa-snowflake", color: "#38bdf8" }; // snow/flake is blue
    }
    if (name.includes("shra") || name.includes("shower") || name.includes("ploh")) {
        return { icon: "fa-cloud-showers-heavy", color: "#38bdf8" }; // showers is blue
    }
    if (name.includes("ra") || name.includes("rain") || name.includes("dz") || name.includes("dež") || name.includes("ros")) {
        return { icon: "fa-cloud-rain", color: "#38bdf8" }; // rain is blue
    }
    if (name.includes("fg") || name.includes("fog") || name.includes("smog") || name.includes("megl")) {
        return { icon: "fa-smog", color: "#38bdf8" }; // fog/smog is blue
    }
    
    // Night icons
    if (name.includes("night") || name.includes("noč")) {
        if (name.includes("overcast") || name.includes("prevcloudy") || name.includes("oblač")) {
            return { icon: "fa-cloud", color: "#38bdf8" }; // cloud is blue
        }
        if (name.includes("partcloudy") || name.includes("modcloudy") || name.includes("delno") || name.includes("zmerno") || name.includes("slightcloudy")) {
            return { icon: "fa-cloud-moon", color: "#38bdf8" }; // cloud-moon is blue
        }
        return { icon: "fa-moon", color: "#f59e0b" }; // moon is yellow
    }
    
    // Day icons / defaults
    if (name.includes("overcast") || name.includes("prevcloudy") || name.includes("oblač")) {
        return { icon: "fa-cloud", color: "#38bdf8" }; // cloud is blue
    }
    if (name.includes("partcloudy") || name.includes("modcloudy") || name.includes("delno") || name.includes("zmerno") || name.includes("slightcloudy")) {
        return { icon: "fa-cloud-sun", color: "#38bdf8" }; // cloud-sun is blue
    }
    
    return { icon: "fa-sun", color: "#f59e0b" }; // sun is yellow
}

function getWeatherIconHtml(nnIcon, sizeStyle = "") {
    if (!nnIcon) nnIcon = "clear";
    const name = nnIcon.toLowerCase();
    
    // Check type of weather
    let type = "sun";
    
    if (name.includes("ts") || name.includes("bolt") || name.includes("thunder") || name.includes("neviht")) {
        type = "cloud-bolt";
    } else if (name.includes("sn") || name.includes("snow") || name.includes("flake") || name.includes("sneg")) {
        type = "snowflake";
    } else if (name.includes("shra") || name.includes("shower") || name.includes("ploh")) {
        type = "cloud-rain";
    } else if (name.includes("ra") || name.includes("rain") || name.includes("dz") || name.includes("dež") || name.includes("ros")) {
        type = "cloud-rain";
    } else if (name.includes("fg") || name.includes("fog") || name.includes("smog") || name.includes("megl")) {
        type = "smog";
    } else if (name.includes("night") || name.includes("noč")) {
        if (name.includes("overcast") || name.includes("prevcloudy") || name.includes("oblač")) {
            type = "cloud";
        } else if (name.includes("partcloudy") || name.includes("modcloudy") || name.includes("delno") || name.includes("zmerno") || name.includes("slightcloudy")) {
            type = "cloud-moon";
        } else {
            type = "moon";
        }
    } else {
        if (name.includes("overcast") || name.includes("prevcloudy") || name.includes("oblač")) {
            type = "cloud";
        } else if (name.includes("partcloudy") || name.includes("modcloudy") || name.includes("delno") || name.includes("zmerno") || name.includes("slightcloudy") || name.includes("mostclear")) {
            type = "cloud-sun";
        } else {
            type = "sun";
        }
    }

    // Return HTML depending on type
    const size = sizeStyle ? `font-size: ${sizeStyle};` : "";
    
    switch (type) {
        case "sun":
            return `<i class="fa-solid fa-sun" style="color: #f59e0b; ${size}"></i>`;
        case "moon":
            return `<i class="fa-solid fa-moon" style="color: #f59e0b; ${size}"></i>`;
        case "cloud":
            return `<i class="fa-solid fa-cloud" style="color: #38bdf8; ${size}"></i>`;
        case "snowflake":
            return `<i class="fa-solid fa-snowflake" style="color: #38bdf8; ${size}"></i>`;
        case "smog":
            return `<i class="fa-solid fa-smog" style="color: #38bdf8; ${size}"></i>`;
        case "cloud-rain":
            return `<i class="fa-solid fa-cloud-rain" style="color: #38bdf8; ${size}"></i>`;
        case "cloud-sun":
            return `
            <span style="position: relative; display: inline-flex; align-items: center; justify-content: center; width: 1.2em; height: 1.2em; ${size}">
                <i class="fa-solid fa-sun" style="color: #f59e0b; position: absolute; top: 0.05em; right: 0.05em; font-size: 0.85em; z-index: 1; margin: 0; padding: 0;"></i>
                <i class="fa-solid fa-cloud" style="color: #38bdf8; position: absolute; bottom: 0.05em; left: 0.05em; font-size: 0.85em; z-index: 2; margin: 0; padding: 0;"></i>
            </span>`;
        case "cloud-moon":
            return `
            <span style="position: relative; display: inline-flex; align-items: center; justify-content: center; width: 1.2em; height: 1.2em; ${size}">
                <i class="fa-solid fa-moon" style="color: #f59e0b; position: absolute; top: 0.05em; right: 0.05em; font-size: 0.85em; z-index: 1; margin: 0; padding: 0;"></i>
                <i class="fa-solid fa-cloud" style="color: #38bdf8; position: absolute; bottom: 0.05em; left: 0.05em; font-size: 0.85em; z-index: 2; margin: 0; padding: 0;"></i>
            </span>`;
        case "cloud-bolt":
            return `
            <span style="position: relative; display: inline-flex; align-items: center; justify-content: center; width: 1.2em; height: 1.2em; ${size}">
                <i class="fa-solid fa-cloud" style="color: #38bdf8; position: absolute; top: 0.05em; left: 0.05em; font-size: 0.85em; z-index: 1; margin: 0; padding: 0;"></i>
                <i class="fa-solid fa-bolt" style="color: #f59e0b; position: absolute; bottom: 0.05em; right: 0.05em; font-size: 0.85em; z-index: 2; margin: 0; padding: 0;"></i>
            </span>`;
    }
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
                
                const weatherName = wCode === 0 || wCode === 1 ? "clear" : (wCode === 2 ? "partCloudy" : "overcast");
                const windArrow = getWindArrowHtml(windDir);
                
                const iconBox = document.getElementById(`${cardPrefix}-icon-box`);
                if (iconBox) {
                    iconBox.innerHTML = getWeatherIconHtml(weatherName, "1.5rem");
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
        
        const idxToday = getIndexForDate(0);
        if (idxToday !== -1) {
            const wCode = daily.weather_code[idxToday];
            const weatherName = wCode === 0 || wCode === 1 ? "clear" : (wCode === 2 ? "partCloudy" : "overcast");
            const todayIconBox = document.getElementById('weather-icon-box');
            if (todayIconBox) {
                todayIconBox.innerHTML = getWeatherIconHtml(weatherName, "1.8rem");
            }
        }
        
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
        
        // Update wave height data & populate hourly marine map
        if (marineJson && marineJson.hourly) {
            try {
                marineHourlyWaves.clear();
                const now = new Date();
                const timeMs = now.getTime();
                let closestIdx = 0;
                let minDiff = Infinity;
                
                for (let i = 0; i < marineJson.hourly.time.length; i++) {
                    const itemTime = new Date(marineJson.hourly.time[i]);
                    const whVal = marineJson.hourly.wave_height[i];
                    marineHourlyWaves.set(itemTime.getTime(), whVal);
                    
                    const diff = Math.abs(itemTime.getTime() - timeMs);
                    if (diff < minDiff) {
                        minDiff = diff;
                        closestIdx = i;
                    }
                }
                
                const wh = marineJson.hourly.wave_height[closestIdx];
                currentMarineWaveHeight = wh;
                renderWeather(); // Update weather UI with new wave height if necessary
            } catch (whErr) {
                console.error("Error setting wave height from forecast:", whErr);
            }
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
        
        // Update wave badges in daily cards (use maximum representative wave height for that day)
        const waveCard0 = document.getElementById('forecast-day-0-wave');
        if (waveCard0) waveCard0.innerHTML = getWaveIconHtml(getDayMaxWaveHeight(new Date()));
        
        const waveCard1 = document.getElementById('forecast-day-1-wave');
        if (waveCard1) waveCard1.innerHTML = getWaveIconHtml(getDayMaxWaveHeight(dateTomorrow));
        
        const waveCard2 = document.getElementById('forecast-day-2-wave');
        if (waveCard2) waveCard2.innerHTML = getWaveIconHtml(getDayMaxWaveHeight(dateDayAfter));
        
        let success = false;
        if (arsoForecastData && arsoForecastData.forecast24h?.features?.[0]?.properties?.days) {
            try {
                const days = arsoForecastData.forecast24h.features[0].properties.days;
                
                // Update Danes forecast icon from official ARSO forecast24h
                if (days[0] && days[0].timeline && days[0].timeline.length > 0) {
                    const todayForecastIcon = days[0].timeline[0].clouds_icon_wwsyn_icon || "";
                    const todayIconBox = document.getElementById('weather-icon-box');
                    if (todayIconBox && todayForecastIcon) {
                        todayIconBox.innerHTML = getWeatherIconHtml(todayForecastIcon, "1.8rem");
                    }
                }
                
                const updateCardFromArsoJson = (cardPrefix, dayData) => {
                    if (!dayData || !dayData.timeline || dayData.timeline.length === 0) return false;
                    const timeline = dayData.timeline[0];
                    
                    const tempMin = parseFloat(timeline.tnsyn);
                    const tempMax = parseFloat(timeline.txsyn);
                    const windSpeedKmh = parseFloat(timeline.ff_val || "0"); // already in km/h from ARSO API
                    const windDir = timeline.dd_shortText || "";
                    const windDirDeg = getWindDegFromSlo(windDir);
                    const windArrow = getWindArrowHtml(windDirDeg);
                    const iconName = timeline.clouds_icon_wwsyn_icon || "";
                    
                    const iconBox = document.getElementById(`${cardPrefix}-icon-box`);
                    if (iconBox) {
                        iconBox.innerHTML = getWeatherIconHtml(iconName, "1.5rem");
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

function renderArso1hForecast(dayOffset = 0) {
    const container = document.getElementById('hourly-scroll-container');
    if (!container || !arsoForecastData) return false;
    
    const days = arsoForecastData.forecast1h?.features?.[0]?.properties?.days;
    if (!days || days.length === 0) return false;
    
    container.innerHTML = '';
    
    // For "Danes" (dayOffset === 0), combine all available 1-hour timeline points across all available days (up to ~36h)
    let allTimeline = [];
    days.forEach(dayItem => {
        if (dayItem.timeline && Array.isArray(dayItem.timeline)) {
            allTimeline = allTimeline.concat(dayItem.timeline);
        }
    });
    
    const now = new Date();
    const nextHour = new Date(now.getTime());
    nextHour.setMinutes(0, 0, 0);
    nextHour.setHours(nextHour.getHours() + 1);
    
    // Filter out past hours of today, keep all upcoming hours
    const filtered = allTimeline.filter(item => {
        const itemDate = new Date(item.valid);
        return itemDate >= nextHour;
    });
    
    if (filtered.length === 0) {
        return false;
    }
    
    filtered.forEach(item => {
        const itemDate = new Date(item.valid);
        
        const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const itemDay = new Date(itemDate.getFullYear(), itemDate.getMonth(), itemDate.getDate());
        const dayDiff = Math.round((itemDay.getTime() - nowDay.getTime()) / 86400000);
        
        let dayPrefix = "";
        if (dayDiff === 1) {
            dayPrefix = `<span style="font-size:0.55rem;opacity:0.85;display:block;line-height:1;">Jutri</span>`;
        } else if (dayDiff === 2) {
            dayPrefix = `<span style="font-size:0.55rem;opacity:0.85;display:block;line-height:1;">Pojutr.</span>`;
        } else if (dayDiff > 2) {
            const daysSloShort = ["Ned", "Pon", "Tor", "Sre", "Čet", "Pet", "Sob"];
            dayPrefix = `<span style="font-size:0.55rem;opacity:0.85;display:block;line-height:1;">${daysSloShort[itemDate.getDay()]}</span>`;
        }
        
        const timeFormatted = itemDate.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
        const timeDisplay = dayPrefix ? `${dayPrefix}${timeFormatted}` : timeFormatted;
        
        const tempVal = parseFloat(item.t);
        const windSpeedKmh = parseFloat(item.ff_val || "0"); // already in km/h from ARSO API
        const windDir = item.dd_shortText || "";
        const windDirDeg = getWindDegFromSlo(windDir);
        const windArrow = getWindArrowHtml(windDirDeg);
        const iconName = item.clouds_icon_wwsyn_icon || "";
        const rain = parseFloat(item.tp_acc || "0");
        const waveH = getWaveHeightForTime(itemDate);
        
        const itemEl = document.createElement('div');
        itemEl.className = 'hourly-item';
        itemEl.innerHTML = `
            <span class="hourly-time">${timeDisplay}</span>
            ${getWeatherIconHtml(iconName, "1.2rem")}
            <span class="hourly-temp">${Math.round(tempVal)}°C</span>
            <span class="hourly-wind">${windArrow}${Math.round(windSpeedKmh)} km/h</span>
            <span class="hourly-rain">${rain > 0 ? rain.toFixed(1) + ' mm' : '0 mm'}</span>
            <div style="margin-top:2px;">${getWaveIconHtml(waveH)}</div>
        `;
        container.appendChild(itemEl);
    });
    
    return true;
}

function renderArso3hForecast(dayOffset) {
    const container = document.getElementById('hourly-scroll-container');
    if (!container || !arsoForecastData) return false;
    
    const days = arsoForecastData.forecast3h?.features?.[0]?.properties?.days;
    if (!days) return false;
    
    // Find target day matching local calendar date
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    const targetDateStr = d.getFullYear() + '-' + 
                          String(d.getMonth() + 1).padStart(2, '0') + '-' + 
                          String(d.getDate()).padStart(2, '0');
    
    const targetDay = days.find(item => item.date === targetDateStr);
    if (!targetDay) return false;
    
    const timeline = targetDay.timeline || [];
    container.innerHTML = '';
    
    if (timeline.length === 0) {
        return false;
    }
    
    timeline.forEach(item => {
        const itemDate = new Date(item.valid);
        const timeStr = itemDate.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
        
        const tempVal = parseFloat(item.t);
        const windSpeedKmh = parseFloat(item.ff_val || "0"); // already in km/h from ARSO API
        const windDir = item.dd_shortText || "";
        const windDirDeg = getWindDegFromSlo(windDir);
        const windArrow = getWindArrowHtml(windDirDeg);
        const iconName = item.clouds_icon_wwsyn_icon || "";
        const rain = parseFloat(item.tp_acc || "0");
        const waveH = getWaveHeightForTime(itemDate);
        
        const itemEl = document.createElement('div');
        itemEl.className = 'hourly-item';
        itemEl.innerHTML = `
            <span class="hourly-time" style="font-size: 0.68rem; font-weight: 700;">${timeStr}</span>
            ${getWeatherIconHtml(iconName, "1.2rem")}
            <span class="hourly-temp">${Math.round(tempVal)}°C</span>
            <span class="hourly-wind">${windArrow}${Math.round(windSpeedKmh)} km/h</span>
            <span class="hourly-rain">${rain > 0 ? rain.toFixed(1) + ' mm' : '0 mm'}</span>
            <div style="margin-top:2px;">${getWaveIconHtml(waveH)}</div>
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
    
    // Attempt rendering using official ARSO JSON (1h for today 36h continuous track, 3h for tomorrow and day after tomorrow)
    let arsoSuccess = false;
    if (dayOffset === 0) {
        arsoSuccess = renderArso1hForecast(0);
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
                const weatherName = item.weatherCode === 0 || item.weatherCode === 1 ? "clear" : (item.weatherCode === 2 ? "partCloudy" : "overcast");
                const rain = item.rain || 0;
                const windArrow = getWindArrowHtml(item.windDir);
                
                const itemEl = document.createElement('div');
                itemEl.className = 'hourly-item';
                itemEl.innerHTML = `
                    <span class="hourly-time">${timeStr}</span>
                    ${getWeatherIconHtml(weatherName, "1.2rem")}
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
    setTimeout(() => {
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
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
                    if (!isoStr) return "--:--";
                    const d = new Date(isoStr);
                    if (isNaN(d.getTime())) return "--:--";
                    return d.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
                };
                
                // Open-Meteo daily arrays contain past_days=31, so today is at index 31.
                // We find it dynamically by matching today's date string in local time.
                const localToday = new Date();
                const todayStr = localToday.getFullYear() + '-' + 
                                 String(localToday.getMonth() + 1).padStart(2, '0') + '-' + 
                                 String(localToday.getDate()).padStart(2, '0');
                
                let todayIdx = openMeteoDailyData.time ? openMeteoDailyData.time.indexOf(todayStr) : -1;
                if (todayIdx === -1 || todayIdx >= openMeteoDailyData.sunrise.length) {
                    todayIdx = Math.min(31, openMeteoDailyData.sunrise.length - 1);
                    if (todayIdx < 0) todayIdx = 0;
                }
                
                document.getElementById('sunrise-time').textContent = parseTime(openMeteoDailyData.sunrise[todayIdx]);
                document.getElementById('sunset-time').textContent = parseTime(openMeteoDailyData.sunset[todayIdx]);
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
        try {
            await meteoPromise;
        } catch (meteoErr) {
            console.error("Failed to load meteo pressures, continuing:", meteoErr);
        }
        
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
        updateWaterGauge(relativeVal);
        
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
function getArsoDescriptionFromIcon(iconName) {
    if (!iconName) return "jasno";
    const name = iconName.toLowerCase();
    
    if (name.includes("ts") || name.includes("bolt") || name.includes("thunder") || name.includes("neviht")) {
        return "nevihta";
    }
    if (name.includes("snow") || name.includes("sn") || name.includes("sneg")) {
        return "sneženje";
    }
    if (name.includes("shra") || name.includes("shower") || name.includes("ploh")) {
        return "ploha";
    }
    if (name.includes("rain") || name.includes("ra") || name.includes("dež") || name.includes("dz")) {
        return "dež";
    }
    if (name.includes("fog") || name.includes("fg") || name.includes("megl")) {
        return "megla";
    }
    if (name.includes("overcast") || name.includes("oblač")) {
        return "oblačno";
    }
    if (name.includes("prevcloudy")) {
        return "pretežno oblačno";
    }
    if (name.includes("modcloudy")) {
        return "zmerno oblačno";
    }
    if (name.includes("partcloudy") || name.includes("delno")) {
        return "delno oblačno";
    }
    if (name.includes("slightcloudy") || name.includes("rahlo")) {
        return "rahlo oblačno";
    }
    if (name.includes("mostclear")) {
        return "pretežno jasno";
    }
    if (name.includes("clear") || name.includes("jasno")) {
        return "jasno";
    }
    return "jasno";
}

// Helper to parse official ARSO AMS station XML feeds
async function parseArsoAmsXml(stationId, cb) {
    try {
        const targetUrl = `http://meteo.arso.gov.si/uploads/probase/www/observ/surface/text/sl/observationAms_${stationId}_latest.xml?cb=${cb}`;
        const xmlText = await fetchWeatherWithFallback(targetUrl, true);
        if (!xmlText || typeof xmlText !== 'string') return null;

        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, "text/xml");
        const metData = xmlDoc.getElementsByTagName("metData")[0];
        if (!metData) return null;

        const getValue = (tagName, fallback = "") => {
            const node = metData.getElementsByTagName(tagName)[0];
            return node ? node.textContent : fallback;
        };

        const tempVal = parseFloat(getValue("t") || "0");
        const rh = parseFloat(getValue("rh") || "0");

        // Wind calculations (both buoy and airport use m/s in ffavg_val and km/h in ffavg_val_kmh)
        let windSpeedKmh = parseFloat(getValue("ffavg_val_kmh") || getValue("ff_val_kmh") || "0");
        let windSpeedMs = parseFloat(getValue("ffavg_val") || getValue("ff_val") || "0");
        if (windSpeedKmh === 0 && windSpeedMs > 0) {
            windSpeedKmh = windSpeedMs * 3.6;
        } else if (windSpeedMs === 0 && windSpeedKmh > 0) {
            windSpeedMs = windSpeedKmh / 3.6;
        }

        const e = (rh / 100.0) * 6.105 * Math.exp((17.27 * tempVal) / (237.7 + tempVal));
        const feelsLike = tempVal + 0.33 * e - 0.7 * windSpeedMs - 4.0;

        const windDirDeg = parseFloat(getValue("dd_val") || "0");
        const windDirStr = getValue("dd_shortText") || "";

        const pressure = parseFloat(getValue("p") || getValue("msl") || "1013");
        const iconName = getValue("nn_icon-wwsyn_icon") || getValue("clouds_icon_wwsyn_icon") || "";
        let desc = getValue("nn_shortText-wwsyn_longText") || getValue("clouds_shortText") || "";
        if (!desc && iconName) {
            desc = getArsoDescriptionFromIcon(iconName);
        }
        if (!desc) {
            desc = "jasno";
        }
        const validTime = getValue("valid") || "";

        return {
            description: desc,
            temp: tempVal,
            feelsLike: feelsLike,
            pressure: pressure,
            humidity: rh,
            windSpeedMs: windSpeedMs,
            windSpeedKmh: windSpeedKmh,
            windDirDeg: windDirDeg,
            windDirStr: windDirStr,
            iconName: iconName,
            validTime: validTime
        };
    } catch (e) {
        console.error(`Error parsing ARSO AMS XML for ${stationId}:`, e);
        return null;
    }
}

// Fetch weather conditions from both Vida Buoy (ARSO PIRAN_OCEAN-BOJ) and Letališče Portorož (ARSO PORTOROZ_SECOVLJE)
async function loadWeather() {
    const cb = Date.now();
    
    // 1. Fetch Vida Buoy (PIRAN_OCEAN-BOJ) from ARSO XML directly + waves from Bazdara Firebase
    const fetchVida = async () => {
        try {
            const amsData = await parseArsoAmsXml("PIRAN_OCEAN-BOJ", cb);
            
            // Get wave height from Bazdara Firebase (still the only source for waves)
            let waveHeight = 0;
            try {
                const res = await fetch(`https://bazdara-99a47.firebaseio.com/trenutno.json?cb=${cb}`);
                if (res.ok) {
                    const db = await res.json();
                    if (db && db.val) {
                        waveHeight = parseFloat(db.val.zdaj || "0");
                    }
                }
            } catch (err) {
                console.warn("Could not fetch wave height from Firebase:", err);
            }
            
            // Fallback to Open-Meteo forecast for Strunjan if buoy waves are 0 (offline/missing)
            if (waveHeight <= 0) {
                let wh = currentMarineWaveHeight;
                if (wh === null || wh === undefined) {
                    try {
                        const marineJson = await fetchWaveHeight();
                        if (marineJson && marineJson.hourly) {
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
                            wh = marineJson.hourly.wave_height[closestIdx];
                            currentMarineWaveHeight = wh;
                        }
                    } catch (whErr) {
                        console.error("Could not fetch wave height fallback directly:", whErr);
                    }
                }
                if (wh !== null && wh !== undefined) {
                    waveHeight = wh;
                    console.log(`Buoy wave height is offline (0), falling back to Open-Meteo: ${waveHeight} m`);
                }
            }
            
            if (amsData) {
                weatherDataVida = {
                    ...amsData,
                    waveHeight: waveHeight
                };
            }
        } catch (e) {
            console.error("Error loading Vida buoy data:", e);
        }
    };

    // 2. Fetch Portorož Airport (PORTOROZ_SECOVLJE) from ARSO XML directly
    const fetchPortoroz = async () => {
        try {
            const amsData = await parseArsoAmsXml("PORTOROZ_SECOVLJE", cb);
            if (amsData) {
                const portorozWave = weatherDataVida ? weatherDataVida.waveHeight : currentMarineWaveHeight;
                weatherDataPortoroz = {
                    ...amsData,
                    waveHeight: portorozWave
                };
            }
        } catch (e) {
            console.error("Error loading Portorož Airport data:", e);
        }
    };

    // Run fetches in parallel
    await Promise.all([fetchVida(), fetchPortoroz()]);
    
    // Render the active tab
    renderWeather();
}

function parseArsoXmlDate(dateStr) {
    if (!dateStr) return null;
    const parts = dateStr.trim().split(/\s+/);
    if (parts.length >= 2) {
        const dateParts = parts[0].split('.');
        const timeParts = parts[1].split(':');
        if (dateParts.length === 3 && timeParts.length >= 2) {
            const day = parseInt(dateParts[0], 10);
            const month = parseInt(dateParts[1], 10) - 1;
            const year = parseInt(dateParts[2], 10);
            const hour = parseInt(timeParts[0], 10);
            const minute = parseInt(timeParts[1], 10);
            const second = timeParts.length > 2 ? parseInt(timeParts[2], 10) : 0;
            return new Date(year, month, day, hour, minute, second);
        }
    }
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
}

function renderWeather() {
    const badge = document.getElementById('weather-source-badge');
    
    // De-activate all tabs, activate current one
    const tabVida = document.getElementById('tab-vida');
    const tabPortoroz = document.getElementById('tab-portoroz');
    
    if (tabVida) tabVida.classList.remove('active');
    if (tabPortoroz) tabPortoroz.classList.remove('active');
    
    if (activeWeatherSource === 'vida') {
        if (tabVida) tabVida.classList.add('active');
        if (badge) badge.textContent = 'Vir: Boja Vida (ARSO)';
    } else {
        if (tabPortoroz) tabPortoroz.classList.add('active');
        if (badge) badge.textContent = 'Vir: ARSO (Letališče Portorož)';
    }

    const data = (activeWeatherSource === 'vida') ? weatherDataVida : weatherDataPortoroz;
    
    const timeBadge = document.getElementById('weather-time-badge');
    if (timeBadge) {
        if (data && data.validTime) {
            const mDate = parseArsoXmlDate(data.validTime);
            if (mDate) {
                const timeStr = mDate.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
                timeBadge.textContent = `Meritev ob: ${timeStr}`;
                timeBadge.style.display = 'inline';
            } else {
                timeBadge.style.display = 'none';
            }
        } else {
            timeBadge.style.display = 'none';
        }
    }
    
    if (!data) {
        document.getElementById('weather-desc-val').textContent = 'Nalaganje podatkov...';
        document.getElementById('air-temp-val').textContent = '--°C';
        document.getElementById('current-air-temp-val').textContent = '--°C';
        document.getElementById('air-temp-feels-val').textContent = 'Obč. --';
        document.getElementById('current-feels-like-val').textContent = 'Obč. --°C';
        document.getElementById('air-pressure-val').textContent = '-- hPa';
        document.getElementById('humidity-val').textContent = '-- %';
        document.getElementById('wind-speed-val').textContent = '-- km/h';
        document.getElementById('wind-dir-val').textContent = '--';
        document.getElementById('wave-height-val').textContent = '-- m';
        return;
    }

    // Determine common weather condition description and icon name (buoy uses airport description as fallback)
    const descData = weatherDataPortoroz || data;
    const weatherDesc = descData.description || 'jasno';
    const weatherIconName = descData.iconName || '';

    // Populate description
    document.getElementById('weather-desc-val').textContent = weatherDesc;

    // Center weather icon box at the top of the sidebar card
    const currentIconBox = document.getElementById('current-weather-icon-box');
    if (currentIconBox) {
        currentIconBox.innerHTML = getWeatherIconHtml(weatherIconName, "2.5rem");
    }

    // Temperature & Apparent Temp
    document.getElementById('air-temp-val').textContent = `${data.temp.toFixed(1)}°C`;
    document.getElementById('current-air-temp-val').textContent = `${data.temp.toFixed(1)}°C`;
    
    const feelsLikeStr = `Obč. ${Math.round(data.feelsLike)}°C`;
    document.getElementById('air-temp-feels-val').textContent = feelsLikeStr;
    document.getElementById('current-feels-like-val').textContent = feelsLikeStr;

    // Pressure & Humidity
    document.getElementById('air-pressure-val').textContent = `${Math.round(data.pressure)} hPa`;
    document.getElementById('humidity-val').textContent = `${Math.round(data.humidity)}%`;

    // Wind (dual units + Beaufort scale display in separate line)
    const windArrow = getWindArrowHtml(data.windDirDeg);
    const bft = getBeaufortInfo(data.windSpeedKmh);
    document.getElementById('wind-speed-val').innerHTML = `
        <div style="text-align: right; line-height: 1.25;">
            <div>${windArrow}${data.windSpeedMs.toFixed(1)} m/s (${Math.round(data.windSpeedKmh)} km/h)</div>
            <div style="font-size: 0.72rem; color: var(--text-secondary); font-weight: 500; margin-top: 2px;">${bft.bft} Bft - ${bft.text}</div>
        </div>
    `;
    document.getElementById('wind-dir-val').textContent = data.windDirStr ? data.windDirStr : `${Math.round(data.windDirDeg)}°`;

    // Waves (Vida measurement or Open-Meteo model fallback for Portorož)
    let waveH = data.waveHeight;
    if ((waveH === null || waveH === undefined) && activeWeatherSource === 'portoroz') {
        waveH = weatherDataVida ? weatherDataVida.waveHeight : currentMarineWaveHeight;
    }
    if (waveH !== null && waveH !== undefined && !isNaN(waveH)) {
        const seaState = getDouglasSeaState(waveH);
        document.getElementById('wave-height-val').textContent = `${waveH.toFixed(2)} m (${seaState.label})`;
    } else {
        document.getElementById('wave-height-val').textContent = '-- m';
    }
}

function updateWaterGauge(relativeLevel) {
    const fill = document.getElementById('water-gauge-fill');
    const pointer = document.getElementById('water-gauge-pointer');
    if (!fill || !pointer) return;
    
    // Scale range: -60 cm to +90 cm (150 cm total range)
    const minScale = -60;
    const maxScale = 90;
    const pct = Math.max(0, Math.min(100, ((relativeLevel - minScale) / (maxScale - minScale)) * 100));
    
    // Set heights
    fill.style.height = `${pct}%`;
    pointer.style.bottom = `${pct}%`;
    
    // Set color based on limits:
    // Green: -30 to +40
    // Yellow: -40 to -30 and +40 to +50
    // Red: below -40 or above +50
    let color = '#22c55e'; // green
    if ((relativeLevel >= -40 && relativeLevel < -30) || (relativeLevel > 40 && relativeLevel <= 50)) {
        color = '#eab308'; // yellow
    } else if (relativeLevel < -40 || relativeLevel > 50) {
        color = '#ef4444'; // red
    }
    
    fill.style.backgroundColor = color;
    pointer.style.borderLeftColor = color;
}

// User-facing function to switch sources
function setWeatherSource(source) {
    if (source === 'vida' || source === 'portoroz') {
        activeWeatherSource = source;
        renderWeather();
    }
}
window.setWeatherSource = setWeatherSource;

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
        phaseName = "Prazna Luna - Mlaj";
        iconClass = "fa-regular fa-circle";
    } else if (ageDays < 6.38) {
        phaseName = "Rastoča Luna";
        iconClass = "fa-solid fa-moon";
        iconTransform = "scaleX(-1)"; // Mirror to point like '('
    } else if (ageDays < 8.38) {
        phaseName = "Prvi krajec";
        iconClass = "fa-solid fa-circle-half-stroke";
        iconTransform = "rotate(180deg)"; // Make it right-side filled
    } else if (ageDays < 13.76) {
        phaseName = "Rastoča Luna";
        iconClass = "fa-solid fa-circle-half-stroke";
        iconTransform = "rotate(180deg)"; // Make it right-side filled
    } else if (ageDays < 15.76) {
        phaseName = "Polna Luna - Ščip";
        iconClass = "fa-solid fa-circle";
    } else if (ageDays < 21.15) {
        phaseName = "Padajoča Luna";
        iconClass = "fa-solid fa-circle-half-stroke"; // Left-side filled by default
    } else if (ageDays < 23.15) {
        phaseName = "Zadnji krajec";
        iconClass = "fa-solid fa-circle-half-stroke"; // Left-side filled by default
    } else {
        phaseName = "Padajoča Luna";
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
    
    // Calculate the next principal phase (Mlaj, Prvi krajec, Ščip, Zadnji krajec)
    const cycleProgress = ((diffMs % synodicMonth) + synodicMonth) % synodicMonth / synodicMonth;
    const principalPhases = [
        { ratio: 0.0, name: "Prazna Luna - Mlaj", prefix: "Naslednja prazna luna - mlaj" },
        { ratio: 0.25, name: "Prvi krajec", prefix: "Naslednji prvi krajec" },
        { ratio: 0.5, name: "Polna Luna - Ščip", prefix: "Naslednja polna luna - ščip" },
        { ratio: 0.75, name: "Zadnji krajec", prefix: "Naslednji zadnji krajec" }
    ];
    
    let nextP = null;
    let minDiff = 2.0;
    
    for (const p of principalPhases) {
        let diff = p.ratio - cycleProgress;
        if (diff <= 0.001) diff += 1.0; // Wrap around if we are past or at the phase
        if (diff < minDiff) {
            minDiff = diff;
            nextP = p;
        }
    }
    
    const timeToNextMs = minDiff * synodicMonth;
    const nextPhaseDate = new Date(now.getTime() + timeToNextMs);
    
    const dayStr = String(nextPhaseDate.getDate()).padStart(2, '0') + '.' + 
                   String(nextPhaseDate.getMonth() + 1).padStart(2, '0') + '.' + 
                   nextPhaseDate.getFullYear();
    const hourStr = nextPhaseDate.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
    const nextPhaseText = `${nextP.prefix} ${dayStr} ob ${hourStr}`;
    
    // For principal phases, calculate the exact moment of the current phase
    let currentPhaseExactMoment = "";
    if (phaseName === "Prazna Luna - Mlaj" || phaseName === "Prvi krajec" || phaseName === "Polna Luna - Ščip" || phaseName === "Zadnji krajec") {
        let currentTargetRatio = 0.0;
        if (phaseName === "Prvi krajec") currentTargetRatio = 0.25;
        else if (phaseName === "Polna Luna - Ščip") currentTargetRatio = 0.5;
        else if (phaseName === "Zadnji krajec") currentTargetRatio = 0.75;
        
        let diffToCurrent = currentTargetRatio - cycleProgress;
        if (diffToCurrent > 0.5) diffToCurrent -= 1.0;
        if (diffToCurrent < -0.5) diffToCurrent += 1.0;
        
        const currentPhaseDate = new Date(now.getTime() + (diffToCurrent * synodicMonth));
        const cDayStr = String(currentPhaseDate.getDate()).padStart(2, '0') + '.' + 
                        String(currentPhaseDate.getMonth() + 1).padStart(2, '0') + '.';
        const cHourStr = currentPhaseDate.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
        
        currentPhaseExactMoment = ` (${cDayStr} ob ${cHourStr})`;
    }
    
    // Update UI elements
    const phaseNameEl = document.getElementById('moon-phase-name');
    const coeffValEl = document.getElementById('moon-coeff-val');
    const nextPhaseEl = document.getElementById('moon-next-phase');
    
    if (phaseNameEl) phaseNameEl.textContent = `${phaseName}${currentPhaseExactMoment}`;
    if (coeffValEl) coeffValEl.innerHTML = `Tip: ${coeffDesc}`;
    if (nextPhaseEl) nextPhaseEl.textContent = nextPhaseText;
    
    const moonIcon = document.getElementById('moon-icon');
    if (moonIcon) {
        moonIcon.className = iconClass;
        moonIcon.style.display = "inline-block"; // Force display inline-block to allow transforms
        moonIcon.style.transform = iconTransform;
        if (phaseName === "Polna Luna - Ščip") {
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
