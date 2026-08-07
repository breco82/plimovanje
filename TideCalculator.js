class TideCalculator {
    static getPrediction(date) {
        const year = date.getFullYear();
        if (!this.arcotsCache) this.arcotsCache = {};
        if (!this.arcotsCache[year]) {
            this.arcotsCache[year] = new Arcots(year);
        }
        const arcots = this.arcotsCache[year];
        
        // Reference is Jan 1 00:00:00 CET of that year (which is UTC+1)
        const jan1CET = new Date(`${year}-01-01T00:00:00+01:00`);
        const diffHours = (date.getTime() - jan1CET.getTime()) / 3600000.0;
        
        // Harmonic tidal sum
        let X = 0.0;
        for (let k = 0; k < 7; k++) {
            X += arcots.FH[k] * Math.cos(Arcots.S[k] * diffHours + arcots.VUG[k]);
        }
        return X;
    }

    /**
     * Generates predicted tidal heights for Koper at a regular interval between two dates.
     * Heights are in cm relative to Koper mean sea level (SVS2010 datum).
     */
    static getPredictionsForPeriod(startDate, endDate, intervalMinutes = 10) {
        const predictions = [];
        let current = new Date(startDate.getTime());
        // Align to the interval
        const remainder = current.getMinutes() % intervalMinutes;
        if (remainder !== 0) {
            current.setMinutes(current.getMinutes() - remainder, 0, 0);
        } else {
            current.setSeconds(0, 0);
        }

        while (current <= endDate) {
            predictions.push({
                time: new Date(current.getTime()),
                level: this.getPrediction(current)
            });
            current.setMinutes(current.getMinutes() + intervalMinutes);
        }
        return predictions;
    }
}

window.TideCalculator = TideCalculator;
