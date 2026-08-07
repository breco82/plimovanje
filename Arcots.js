class Arcots {
    constructor(year) {
        this.F = [0, 0, 0, 0, 0, 0, 0];
        this.V0U = [0, 0, 0, 0, 0, 0, 0];
        this.A = [0, 0, 0, 0, 0, 0];
        this.B = [0, 0, 0, 0, 0, 0, 0];
        this.C = new Array(16).fill(0);
        this.DX = [0, 0, 0, 0, 0];
        this.DL = [0, 0, 0];
        this.DV = [0, 0, 0, 0, 0, 0, 0];
        
        this.FH = [0, 0, 0, 0, 0, 0, 0];
        this.FHS = [0, 0, 0, 0, 0, 0, 0];
        this.FHSS = [0, 0, 0, 0, 0, 0, 0];
        this.VUG = [0, 0, 0, 0, 0, 0, 0];
        
        this.Y = year;
        const YH = this.Y + 0.5;
        this.NODFAC(YH);
        this.VZEROU(this.Y, YH, 1);
        
        for (let L = 0; L < 7; L++) {
            this.FH[L] = this.F[L] * Arcots.H[L];
            this.FHS[L] = this.FH[L] * Arcots.S[L];
            this.FHSS[L] = this.FHS[L] * Arcots.S[L];
            this.VUG[L] = this.V0U[L] - Arcots.G[L];
        }
    }

    NODFAC(Y) {
        this.DX = this.INUXI(Y, 1);
        this.TIMCOF(Y);
        this.C[0] = Math.sin(this.DX[0]);
        this.C[1] = this.C[0] * this.C[0];
        this.C[2] = Math.sin(2.0 * this.DX[0]);
        this.C[3] = Math.cos(this.DX[0] / 2.0) * Math.cos(this.DX[0] / 2.0);
        
        this.F[0] = this.B[0] * Math.pow(this.C[3], 4);
        this.F[1] = 1.0;
        this.F[2] = this.F[0];
        this.F[3] = Math.sqrt(this.B[2] * this.C[1] * this.C[1] + this.B[5] * this.C[1] * Math.cos(2.0 * this.DX[1]) + this.B[6]);
        this.F[4] = Math.sqrt(this.B[1] * this.C[2] * this.C[2] + this.B[4] * this.C[2] * Math.cos(this.DX[1]) + this.B[6]);
        this.F[5] = this.B[3] * this.C[0] * this.C[3];
        this.F[6] = 1.0;
    }

    INUXI(Y, IRD) {
        this.TIMCOF(Y);
        const DN = this.NLONG(Y, 1);
        this.C[0] = DN / 2.0;
        this.C[1] = Math.sin(this.C[0]) / Math.cos(this.C[0]);
        this.C[2] = Math.atan(this.A[2] * this.C[1]);
        
        const AR = this.A[0] - this.A[1] * Math.cos(DN);
        this.DX[0] = Math.acos(AR);
        this.C[3] = Math.sin(2.0 * this.DX[0]);
        this.C[4] = Math.sin(this.DX[0]) * Math.sin(this.DX[0]);
        this.DX[1] = this.C[2] - Math.atan(this.A[3] * this.C[1]);
        this.C[5] = 2.0 * this.DX[1];
        this.DX[2] = Math.atan(this.C[3] * Math.sin(this.DX[1]) / (this.A[4] + this.C[3] * Math.cos(this.DX[1])));
        this.DX[3] = Math.atan(this.C[4] * Math.sin(this.C[5]) / (this.A[5] + this.C[4] * Math.cos(this.C[5])));
        this.DX[4] = DN + this.DX[1] - 2.0 * this.C[2];
        
        for (let i = 0; i < 5; i++) {
            if (this.DX[i] < 0.0) {
                this.DX[i] = this.DX[i] + 2.0 * Math.PI;
            }
        }
        
        if (IRD === 1) return this.DX;
        
        for (let i = 0; i < 5; i++) {
            this.DX[i] = this.DX[i] * 180.0 / Math.PI;
        }
        return this.DX;
    }

    TIMCOF(Y) {
        this.C[0] = 0.45987564;
        this.C[1] = 0.05490056;
        this.C[2] = 5.14537628;
        this.C[3] = Y - 1900.0;
        this.C[4] = 0.01675104 - 4.18e-7 * this.C[3] - 1.26e-11 * this.C[3] * this.C[3];
        this.C[5] = 23.452294 - 1.30111e-4 * this.C[3];
        
        const P = 180.0 / Math.PI;
        this.C[6] = P;
        this.C[7] = Math.sin(this.C[2] / P);
        this.C[8] = Math.sin(this.C[5] / P);
        this.C[9] = (this.C[5] - this.C[2]) / 2.0;
        this.C[10] = (this.C[5] + this.C[2]) / 2.0;
        this.C[11] = Math.sin(this.C[5] * 2.0 / P);
        this.C[12] = Math.cos(this.C[5] * 0.5 / P);
        this.C[13] = Math.cos(this.C[2] * 0.5 / P);
        this.C[14] = 1.0 - 1.5 * this.C[7] * this.C[7];
        
        this.A[0] = Math.cos(this.C[2] / P) * Math.cos(this.C[5] / P);
        this.A[1] = this.C[7] * this.C[8];
        this.A[2] = Math.cos(this.C[9] / P) / Math.cos(this.C[10] / P);
        this.A[3] = Math.sin(this.C[9] / P) / Math.sin(this.C[10] / P);
        
        this.C[15] = this.C[0] * (1.0 + 1.5 * this.C[4] * this.C[4]) / (1.0 + 1.5 * this.C[1] * this.C[1]);
        this.A[4] = this.C[15] * this.C[11];
        this.A[5] = this.C[15] * this.C[8] * this.C[8];
        
        this.B[0] = 1.0 / Math.pow(this.C[12] * this.C[13], 4);
        this.B[1] = 1.0 / Math.pow(this.A[4] + this.C[14] * this.C[11], 2);
        this.B[2] = 1.0 / Math.pow(this.A[5] + this.C[14] * this.C[8] * this.C[8], 2);
        this.B[3] = 1.0 / (this.C[12] * this.C[12] * Math.pow(this.C[13], 4) * this.C[8]);
        this.B[4] = 2.0 * this.A[4] * this.B[1];
        this.B[5] = 2.0 * this.A[5] * this.B[2];
        this.B[6] = this.B[1] * this.A[4] * this.A[4];
    }

    NLONG(Y, IRD) {
        const Y0 = Y - 1900.0;
        const TR = Math.floor((Y0 - 1.0) / 4.0) + 0.5;
        const T = (365.0 * Y0 + TR) / 36525.0;
        const T2 = T * T;
        const T3 = T * T * T;
        let DN = 259.182533 - 1934.142397 * T + 0.002106 * T2 + 2.22e-6 * T3;
        
        while (DN < 0.0) {
            DN = DN + 360.0;
        }
        if (IRD === 0) return DN;
        
        DN = DN * Math.PI / 180.0;
        return DN;
    }

    VZEROU(Y, YH, IRD) {
        let AF = 360.0;
        let A4 = 90.0;
        let A34 = 270.0;
        
        if (IRD === 1) {
            const DR = Math.PI / 180.0;
            AF = AF * DR;
            A4 = A4 * DR;
            A34 = A34 * DR;
        }
        
        this.HSPLON(Y, IRD);
        this.INUXI(YH, IRD);
        
        this.DV[0] = 2.0 * (this.DL[0] - this.DL[1] + this.DX[4] - this.DX[1]);
        this.DV[2] = 2.0 * (this.DL[0] + this.DX[4] - this.DX[1]) - 3.0 * this.DL[1] + this.DL[2];
        this.DV[3] = 2.0 * this.DL[0] - this.DX[3];
        this.DV[4] = this.DL[0] + A4 - this.DX[2];
        this.DV[5] = this.DL[0] - 2.0 * this.DL[1] + A34 + 2.0 * this.DX[4] - this.DX[1];
        this.DV[6] = A34 - this.DL[0];
        
        for (let i = 0; i < 7; i++) {
            if (i === 1) continue;
            this.DV[i] = this.DV[i] + AF;
            while (this.DV[i] < 0.0) {
                this.DV[i] = this.DV[i] + AF;
            }
            this.V0U[i] = this.DV[i] % AF;
        }
        this.V0U[1] = 0.0;
    }

    HSPLON(Y, IRD) {
        const Y0 = Y - 1900.0;
        const TR = Math.floor((Y0 - 1.0) / 4.0) + 0.5;
        const T = (365.0 * Y0 + TR) / 36525.0;
        const T2 = T * T;
        const T3 = T2 * T;
        
        this.DL[0] = 279.696678 + 36000.768925 * T + 3.025e-4 * T2;
        this.DL[1] = 270.437422 + 481267.892 * T + 0.002525 * T2 + 1.89e-6 * T3;
        this.DL[2] = 334.328019 + 4069.032206 * T - 0.010344 * T2 - 1.25e-5 * T3;
        
        for (let i = 0; i < 3; i++) {
            this.DL[i] = this.DL[i] % 360.0;
        }
        if (IRD === 0) return;
        
        for (let i = 0; i < 3; i++) {
            this.DL[i] = this.DL[i] * Math.PI / 180.0;
        }
    }
}

// Static harmonic constants for Koper tides (M2, S2, N2, K2, K1, O1, P1)
Arcots.MA = ["M2", "S2", "N2", "K2", "K1", "O1", "P1"];
Arcots.H = [25.1, 15.8, 4.6, 4.4, 18.2, 5.0, 5.9];
Arcots.G = [4.842, 4.955, 4.815, 4.752, 1.215, 1.079, 1.133];
Arcots.S = [0.50586805, 0.52359878, 0.49636692, 0.52503234, 0.26251617, 0.24335188, 0.26108261];

window.Arcots = Arcots;
