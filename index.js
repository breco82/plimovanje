/* index.js */
/* Frontend Controller for the Slovenian Sea Level Tracker */

// App State
let chartMode = 'level'; // 'level' or 'temp'
let periodHours = 24;   // 24, 72, or 168
let actualData = [];    // Loaded ARSO measurements
let currentChart = null; // Highcharts instance
let meteoForecastMap = new Map(); // Open-Meteo hourly pressure and wind map

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

async function loadMeteoData() {
    try {
        // Fetch 31 days of history and 3 days of forecast from Open-Meteo for Koper (idx 0) and Dubrovnik (idx 1), including Koper's daily forecast
        const url = 'https://api.open-meteo.com/v1/forecast?latitude=45.5469,42.6507&longitude=13.7294,18.0944&hourly=pressure_msl&daily=weather_code,temperature_2m_max,temperature_2m_min,wind_speed_10m_max,wind_direction_10m_dominant&past_days=31&forecast_days=3&timezone=auto';
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
            
            // Parse and update 2-day forecast in Koper sidebar
            try {
                if (json[0].daily) {
                    const daily = json[0].daily;
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
                            
                            let iconClass = 'fa-sun';
                            if (wCode === 0) iconClass = 'fa-sun';
                            else if (wCode >= 1 && wCode <= 3) iconClass = 'fa-cloud-sun';
                            else if (wCode === 45 || wCode === 48) iconClass = 'fa-smog';
                            else if (wCode >= 51 && wCode <= 57) iconClass = 'fa-cloud-rain';
                            else if (wCode >= 61 && wCode <= 67) iconClass = 'fa-cloud-showers-heavy';
                            else if (wCode >= 71 && wCode <= 77) iconClass = 'fa-snowflake';
                            else if (wCode >= 80 && wCode <= 82) iconClass = 'fa-cloud-rain';
                            else if (wCode >= 85 && wCode <= 86) iconClass = 'fa-snowflake';
                            else if (wCode >= 95 && wCode <= 99) iconClass = 'fa-cloud-bolt';
                            
                            let iconColor = '#f59e0b';
                            if (iconClass === 'fa-cloud' || iconClass === 'fa-smog' || iconClass === 'fa-cloud-sun') {
                                iconColor = '#94a3b8';
                            } else if (iconClass.includes('rain') || iconClass.includes('showers')) {
                                iconColor = '#0ea5e9';
                            } else if (iconClass === 'fa-snowflake') {
                                iconColor = '#38bdf8';
                            } else if (iconClass === 'fa-cloud-bolt') {
                                iconColor = '#a855f7';
                            }
                            
                            const iconEl = document.getElementById(`${cardPrefix}-icon`);
                            if (iconEl) {
                                iconEl.className = `fa-solid ${iconClass} forecast-icon`;
                                iconEl.style.color = iconColor;
                            }
                            
                            const tempEl = document.getElementById(`${cardPrefix}-temp`);
                            if (tempEl) {
                                tempEl.textContent = `${Math.round(tempMin)} / ${Math.round(tempMax)} °C`;
                            }
                            
                            const windEl = document.getElementById(`${cardPrefix}-wind`);
                            if (windEl) {
                                const windDirStr = getWindDirectionSlo(windDir);
                                windEl.textContent = `${Math.round(windSpeed)} km/h (${windDirStr})`;
                            }
                        }
                    };
                    
                    updateForecastCard('forecast-day-1', idxTomorrow);
                    updateForecastCard('forecast-day-2', idxDayAfter);
                }
            } catch (err) {
                console.error("Error populating 2-day forecast:", err);
            }
        }
    } catch (e) {
        console.error("Error loading meteorological forecast:", e);
    }
}

async function refreshData() {
    try {
        // Fetch merged data (24h + 30d) and weather forecast in parallel
        const meteoPromise = loadMeteoData();
        actualData = await loadMergedWaterData();
        if (!actualData || actualData.length === 0) throw new Error("Data empty");
        
        // Wait for weather data to finish loading
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

// Fetch Koper meteorological conditions from Bazdara Firebase DB
async function loadWeather() {
    try {
        const res = await fetch('https://bazdara-99a47.firebaseio.com/trenutno.json');
        if (res.ok) {
            const data = await res.json();
            
            // Air Temp
            const tempVal = parseFloat(data.temp.zdaj);
            document.getElementById('air-temp-val').textContent = `${tempVal.toFixed(1)}°C`;
            
            // Calculate Apparent Temperature (feels-like)
            const rh = parseFloat(data.vlaga);
            const ws = parseFloat(data.veter.zdaj);
            const feelsLikeEl = document.getElementById('air-temp-feels-val');
            
            if (feelsLikeEl && !isNaN(tempVal) && !isNaN(rh) && !isNaN(ws)) {
                const e = (rh / 100.0) * 6.105 * Math.exp((17.27 * tempVal) / (237.7 + tempVal));
                const apparentTemp = tempVal + 0.33 * e - 0.7 * ws - 4.0;
                feelsLikeEl.textContent = `Občutek: ${apparentTemp.toFixed(1)}°C`;
            } else if (feelsLikeEl) {
                feelsLikeEl.textContent = `Občutek: --`;
            }
            
            // Weather Condition
            document.getElementById('weather-desc-val').textContent = data.vreme.zdaj;
            
            // Weather icon mapping
            const iconBox = document.getElementById('weather-icon-box');
            const icon = document.getElementById('weather-icon');
            icon.className = 'fa-solid';
            
            const wDesc = data.vreme.zdaj.toLowerCase();
            if (wDesc.includes('jasno') || wDesc.includes('sonč')) {
                icon.classList.add('fa-sun');
                iconBox.style.background = 'rgba(245, 158, 11, 0.1)';
                iconBox.style.borderColor = 'rgba(245, 158, 11, 0.25)';
                icon.style.color = '#f59e0b';
            } else if (wDesc.includes('oblač') || wDesc.includes('megl')) {
                icon.classList.add('fa-cloud');
                iconBox.style.background = 'rgba(148, 163, 184, 0.1)';
                iconBox.style.borderColor = 'rgba(148, 163, 184, 0.25)';
                icon.style.color = '#94a3b8';
            } else if (wDesc.includes('dež') || wDesc.includes('ploh')) {
                icon.classList.add('fa-cloud-showers-heavy');
                iconBox.style.background = 'rgba(14, 165, 233, 0.1)';
                iconBox.style.borderColor = 'rgba(14, 165, 233, 0.25)';
                icon.style.color = '#0ea5e9';
            } else {
                icon.classList.add('fa-sun-cloud');
                iconBox.style.background = 'rgba(245, 158, 11, 0.1)';
                iconBox.style.borderColor = 'rgba(245, 158, 11, 0.25)';
                icon.style.color = '#f59e0b';
            }
            
            // Pressure, Humidity, Wind
            document.getElementById('air-pressure-val').textContent = `${data.tlak} hPa`;
            document.getElementById('humidity-val').textContent = `${data.vlaga}%`;
            document.getElementById('wind-speed-val').textContent = `${parseFloat(data.veter.zdaj).toFixed(1)} m/s`;
            document.getElementById('wind-dir-val').textContent = getWindDirectionSlo(parseFloat(data.veter.smer));
            
            // Sunrise/Sunset
            document.getElementById('sunrise-time').textContent = data.soncni.vzhod;
            document.getElementById('sunset-time').textContent = data.soncni.zahod;
            

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
        
        // Calculate rolling seasonal bias offset (Actual - Prediction - Weather) over the last 3 days (72 hours)
        let totalDiffSum = 0;
        let diffCount = 0;
        
        const latestActualTime = actualData[actualData.length - 1].time;
        const threeDaysAgoMs = latestActualTime.getTime() - (72 * 60 * 60 * 1000);
        
        actualData.forEach(d => {
            const timeMs = d.time.getTime();
            if (timeMs >= threeDaysAgoMs) {
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
                visible: false, // Disabled by default, user can turn it on by clicking legend
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
            dateTimeLabelFormats: {
                hour: '%H:%M',
                day: '%a %e. %m.',
                week: '%a %e. %m.'
            },
            labels: { style: { color: labelColor } },
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
        phaseName = "Rastoči srp";
        iconClass = "fa-solid fa-moon";
    } else if (ageDays < 8.38) {
        phaseName = "Prvi krajec";
        iconClass = "fa-solid fa-circle-half-stroke";
    } else if (ageDays < 13.76) {
        phaseName = "Rastoča luna";
        iconClass = "fa-solid fa-circle-half-stroke";
    } else if (ageDays < 15.76) {
        phaseName = "Ščip";
        iconClass = "fa-solid fa-circle";
    } else if (ageDays < 21.15) {
        phaseName = "Padajoča luna";
        iconClass = "fa-solid fa-circle-half-stroke";
        iconTransform = "rotate(180deg)";
    } else if (ageDays < 23.15) {
        phaseName = "Zadnji krajec";
        iconClass = "fa-solid fa-circle-half-stroke";
        iconTransform = "rotate(180deg)";
    } else {
        phaseName = "Padajoči srp";
        iconClass = "fa-solid fa-moon";
        iconTransform = "scaleX(-1)";
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
