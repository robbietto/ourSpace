/**
 * Micro Racing - Circuit Ourspace.
 * Server autoritativo Node.js e client canvas interpolato.
 * Fasi: qualifiche, recap griglia, semaforo, gara, DNF/finale.
 */

import { GameClient, GameServer }   from './game';
import { getCharacterDrawFunction } from '../client/characters';
import type { Player }              from '../common';
import type { IncomingMsg, OutgoingMsg } from '../server';
import type { UserInput }           from '../client/user-input';


// ============================================================================
// TIPI E MESSAGGI
// Contratti condivisi tra server e client: stato delle auto, input e payload.
// ============================================================================

type Punto = { x: number; y: number };
type StatoRigaClassifica = {
    y: number;
    targetY: number;
    lastIndex: number;
    lastBestGiro: number;
    flash: number;
};
type RigaClassificaAnimata = {
    id: string;
    auto: StatoAuto;
    index: number;
    y: number;
    delta: number;
    flash: number;
    improved: boolean;
};
type LayoutClassifica = { lbX: number; lbW: number; rowH: number; pad: number };
type SlotPodio = { place: number; x: number; h: number; color: string };

type Fase = 'qualifiche' | 'voto' | 'recap' | 'gara';
type ModalitaGara = 'standard' | 'sopravvivenza';

interface StatoAuto {
    x: number; y: number;
    xPrecedente: number; yPrecedente: number;
    a: number; vx: number; vy: number;
    // Gara
    giri: number;
    cp: number;             // bitmask checkpoint raccolti nel giro corrente (gara)
    // Qualifiche
    cpQual: number;         // bitmask checkpoint raccolti nel giro corrente (quali)
    migliorGiro: number;    // ms, -1 = nessun giro valido
    tempoGiroAttuale: number; // ms dall'inizio del giro corrente
    sulTraguardo: boolean;  // true = auto attualmente nel raggio del traguardo
                            // usato per l'edge-detection: conta solo l'INGRESSO nel raggio
    giroInvalido: boolean;  // true = e' uscito dalla pista in questo giro (quali)
    // Power-up
    turboTimer: number; turboCooldown: number;
    shockwaveCooldown: number; shockwaveTimer: number; spinTimer: number;
    // Meccaniche speciali
    inScia: boolean;        // true = sta beneficiando della scia
    tempoScia: number;      // secondi continui in scia
    slingshotTimer: number; // secondi rimanenti di boost slingshot
    speedPadCooldown: number;
    // Metadati
    nome: string; character: string;
    finito: boolean; dnf: boolean; posizione: number;
}

interface SpeedPad { x: number; y: number; w: number; h: number; a: number; }
interface StatoTreno { x: number; y: number; w: number; h: number; }

interface ParametriFisici {
    accelMax: number;
    velMax: number;
    attritoTotale: number;
}

interface CandidatoArrivo {
    auto: StatoAuto;
    haCompletatoGara: boolean;
    progress: number;
}

interface MsgInput {
    kind: 'input';
    su: boolean; giu: boolean;
    turbo: boolean; shockwave: boolean;
    mouseAngolo: number;
}

interface MsgVoto {
    kind: 'voto';
    scelta: ModalitaGara;
}

interface MsgStato {
    kind: 'stato';
    fase: Fase;
    tempoQual: number;          // secondi rimasti alle qualifiche
    tempoVoto: number;          // secondi rimasti al voto
    tempoRecap: number;         // secondi rimasti al recap
    countdownPartenza: number;  // secondi rimasti al semaforo
    dnfTimer: number;           // secondi rimasti prima del DNF globale (-1 = non attivo)
    auto: Record<string, StatoAuto>;
    garaFinita: boolean;
    gridOrder: string[];
    migliorAssoluto: number;    // ms del giro piu' veloce tra tutti
    votiStandard: number;
    votiSopravvivenza: number;
    modalitaGara: ModalitaGara;
    warningTreno: number;
    treno: StatoTreno | null;
}


// ============================================================================
// TRACCIATO E COSTANTI DI GIOCO
// Descrive il mondo, la pista, le regole temporali e i parametri fisici.
// ============================================================================

const MONDO_W = 4800;
const MONDO_H = 3800;
const LARGHEZZA_PISTA = 160; // ampia per permettere sorpassi side-by-side
const MARGINE_QUALI = 10; // px di tolleranza per evitare falsi track-limits in qualifica

/**
 * Waypoint della linea centrale (senso antiorario).
 * Il punto 0 e' il primo waypoint DOPO il traguardo sul rettilineo principale,
 * cosi' la griglia di partenza (posizionata ~200px piu' a sud) non coincide mai
 * con il raggio del traguardo all'avvio -> nessun falso "primo giro".
 */
const WAYPOINTS: Punto[] = [
    // Rettilineo principale (lato est, verso nord)
    { x: 3800, y: 2400 },   // 0  - griglia qui (sotto il traguardo)
    { x: 3800, y: 2100 },   // 1  - traguardo a y~2250, tra qui e il punto precedente
    { x: 3800, y: 1800 },   // 2
    { x: 3800, y: 1550 },   // 3
    // Tornante 90 gradi verso ovest (curva 1 - lenta)
    { x: 3700, y: 1380 },   // 4
    { x: 3500, y: 1270 },   // 5
    { x: 3300, y: 1230 },   // 6
    // Rettilineo nord-ovest -> curva veloce sinistra (curva 2)
    { x: 3000, y: 1210 },   // 7
    { x: 2700, y: 1200 },   // 8
    { x: 2450, y: 1250 },   // 9
    { x: 2250, y: 1370 },   // 10
    // Esse veloci S1 destra (curva 3)
    { x: 2100, y: 1280 },   // 11
    { x: 1950, y: 1160 },   // 12
    { x: 1800, y: 1200 },   // 13
    { x: 1680, y: 1320 },   // 14
    // S2 sinistra (curva 4)
    { x: 1550, y: 1240 },   // 15
    { x: 1420, y: 1160 },   // 16
    { x: 1260, y: 1190 },   // 17
    // Rettilineo ovest -> chicane sx/dx (curve 5+6)
    { x: 1050, y: 1300 },   // 18
    { x:  870, y: 1450 },   // 19
    { x:  780, y: 1620 },   // 20
    { x:  870, y: 1800 },   // 21
    // Grande curva a U verso sud (curva 7 - lenta, tecnica)
    { x:  900, y: 2000 },   // 22
    { x:  820, y: 2200 },   // 23
    { x:  750, y: 2450 },   // 24
    { x:  820, y: 2650 },   // 25
    { x: 1000, y: 2780 },   // 26
    // Rettilineo sud -> doppia chicane dx/sx (curve 8+9)
    { x: 1350, y: 2820 },   // 27
    { x: 1700, y: 2820 },   // 28
    { x: 2000, y: 2750 },   // 29
    { x: 2150, y: 2620 },   // 30
    { x: 2300, y: 2750 },   // 31
    { x: 2500, y: 2820 },   // 32
    // Rettilineo finale verso traguardo (sud-est)
    { x: 2850, y: 2820 },   // 33
    { x: 3200, y: 2750 },   // 34
    { x: 3500, y: 2620 },   // 35
    { x: 3700, y: 2500 },   // 36
    // -> si ricongiunge a wp[0]
];

/**
 * 8 checkpoint distribuiti uniformemente sul giro.
 * Devono essere attraversati in ordine numerico - impediscono tagli aggressivi
 * e la guida al contrario per gonfiare i tempi.
 */
const CHECKPOINTS = [
    { x: 3500, y: 1270, r: 90 },  // CP1: uscita tornante nord-est
    { x: 2700, y: 1200, r: 90 },  // CP2: rettilineo nord
    { x: 1800, y: 1200, r: 90 },  // CP3: esse centrali
    { x:  870, y: 1450, r: 90 },  // CP4: ingresso chicane ovest
    { x:  750, y: 2450, r: 90 },  // CP5: fondo curva a U
    { x: 1350, y: 2820, r: 90 },  // CP6: rettilineo sud
    { x: 2150, y: 2640, r: 90 },  // CP7: doppia chicane sud-est
    { x: 3200, y: 2750, r: 90 },  // CP8: lancio verso traguardo
];
const TUTTI_CHECKPOINT = (1 << CHECKPOINTS.length) - 1;
const CHECKPOINTS_WAYPOINT_INDEX = CHECKPOINTS.map(cp => {
    let bestIndex = 0;
    let bestDist = Infinity;

    for (let i = 0; i < WAYPOINTS.length; i++) {
        const wp = WAYPOINTS[i];
        const dist = Math.hypot(cp.x - wp.x, cp.y - wp.y);
        if (dist < bestDist) {
            bestDist = dist;
            bestIndex = i;
        }
    }

    return bestIndex;
});

// Il traguardo e' una fascia stretta centrata sulla linea di arrivo.
const TRAGUARDO    = { x: 3800, y: 2250 };
const TRAGUARDO_LARGHEZZA = LARGHEZZA_PISTA + 18;
const TRAGUARDO_ALTEZZA = 16;
// Offset griglia: file alternate a sinistra/destra, avanzano verso sud (y crescente)
const GRIGLIA_BASE = { dx: 35, dy: 90 };

const LUNGHEZZE_SEGMENTI = WAYPOINTS.map((p, i) => {
    const next = WAYPOINTS[(i + 1) % WAYPOINTS.length];
    return Math.hypot(next.x - p.x, next.y - p.y);
});
const DISTANZE_WAYPOINT = distanzeCumulative(LUNGHEZZE_SEGMENTI);
const LUNGHEZZA_TRACCIATO = LUNGHEZZE_SEGMENTI.reduce((tot, len) => tot + len, 0);


// --- Fisica e regole di gara -------------------------------------------------

const ACCEL          = 290;    // px/s^2 accelerazione su asfalto
const FRENO          = 560;    // px/s^2 frenata
const ATTRITO        = 120;    // px/s^2 attrito passivo su asfalto
const STERZO_RAD     = 3.8;   // rad/s velocita' di sterzata
const VEL_MAX        = 315;    // px/s velocita' massima su asfalto

// L'auto non rimbalza ma viene fortemente penalizzata sull'erba.
const ERBA_ACCEL_MULT  = 0.5;   // accelerazione ridotta al 50%
const ERBA_VELMAX_MULT = 0.4;   // velocita' massima ridotta al 40%
const ERBA_ATTRITO_ADD = 10;    // attrito aggiuntivo sull'erba (si somma a ATTRITO)
//   -> attrito totale su erba = 130 px/s^2 - resta lento ma puo' rientrare da fermo

const DRIFT          = 0.86;   // ritenzione velocita' laterale (effetto derapata)

const TURBO_BONUS    = 1.80;
const TURBO_DURATA   = 0.8;    // secondi
const TURBO_RICARICA = 4.0;    // secondi cooldown

const OLIO_SPIN      = 1.4;    // secondi di spin-out

const SHOCKWAVE_RAGGIO   = 200;  // px
const SHOCKWAVE_DURATA   = 0.55; // secondi
const SHOCKWAVE_RICARICA = 5.0;  // secondi
const SHOCKWAVE_FORZA    = 260;  // px/s di impulso massimo

const SPEED_PAD_BOOST    = 140;  // px/s impulso istantaneo
const SPEED_PAD_COOLDOWN = 0.45; // secondi
const SPEED_PADS: SpeedPad[] = [
    // Rettilineo principale (verso nord)
    { x: 3800, y: 2100, w: 120, h: 28, a: -Math.PI / 2 },
    { x: 3800, y: 1750, w: 120, h: 28, a: -Math.PI / 2 },
    // Rettilineo sud (verso est)
    { x: 1650, y: 2820, w: 120, h: 28, a: 0 },
    { x: 2850, y: 2820, w: 120, h: 28, a: 0 },
];

const GIRI_GARA         = 3;
const DURATA_QUALIFICHE = 120;  // due minuti: abbastanza per un giro lanciato senza rendere la lobby lenta
const DURATA_VOTO       = 10;
const DURATA_RECAP      = 8;    // secondi schermata griglia
const DURATA_PARTENZA   = 4;    // secondi semaforo (4 luci, 1 per secondo)
const DNF_TIMEOUT       = 60;   // secondi per tagliare il traguardo dopo il primo arrivo
const DURATA_AVVISO_PODIO = 3;
const DURATA_PODIO = 10;

const SCIA_BONUS      = 1.15;  // +15% vel max quando si e' in scia
const SCIA_DIST_MAX   = 180;   // px: distanza massima per la scia
const SCIA_CONE_BASE  = 18;    // px: apertura base del cono posteriore
const SCIA_CONE_GAIN  = 0.35;  // px laterali per px di distanza (cono allargato)
const SLINGSHOT_TEMPO  = 2.0;   // secondi continuativi in scia per attivare lo slingshot
const SLINGSHOT_BONUS  = 1.25;  // +25% vel max
const SLINGSHOT_DURATA = 1.5;   // secondi

const SOPRAVVIVENZA_INTERVALLO = 15; // secondi tra eliminazioni

const TRENO_INTERVALLO = 25; // secondi tra passaggi
const TRENO_AVVISO     = 3;  // secondi di preavviso
const TRENO_DURATA     = 4;  // secondi di attraversamento
const TRENO_LUNGHEZZA  = 420;
const TRENO_ALTEZZA    = 26;
const TRENO_Y          = 1580;
const TRENO_X_START    = -TRENO_LUNGHEZZA;
const TRENO_X_END      = MONDO_W + TRENO_LUNGHEZZA;
const TRENO_VEL        = (TRENO_X_END - TRENO_X_START) / TRENO_DURATA;

const COLORI_AUTO = ['#e74c3c','#3498db','#b7d29b','#f39c12','#9b59b6','#1abc9c','#e67e22','#e91e63'];


// ============================================================================
// INPUT DI RETE
// Normalizza payload esterni prima che entrino nella simulazione autoritativa.
// ============================================================================

function inputNeutro(): MsgInput {
    return {
        kind: 'input',
        su: false, giu: false,
        turbo: false, shockwave: false,
        mouseAngolo: Number.NaN,
    };
}

function normalizzaInput(payload: unknown): MsgInput | null {
    const p = payload as Partial<MsgInput> | null;
    if (!p || p.kind !== 'input') return null;
    const mouseAngolo = typeof p.mouseAngolo === 'number' && Number.isFinite(p.mouseAngolo)
        ? p.mouseAngolo
        : Number.NaN;

    return {
        kind: 'input',
        su: p.su === true,
        giu: p.giu === true,
        turbo: p.turbo === true,
        shockwave: p.shockwave === true,
        mouseAngolo,
    };
}

function normalizzaVoto(payload: unknown): MsgVoto | null {
    const p = payload as Partial<MsgVoto> | null;
    if (!p || p.kind !== 'voto') return null;
    if (p.scelta !== 'standard' && p.scelta !== 'sopravvivenza') return null;
    return { kind: 'voto', scelta: p.scelta };
}


// ============================================================================
// HELPER GEOMETRICI
// Funzioni pure per pista, traguardo, intersezioni e checkpoint.
// ============================================================================

/** Distanza minima dal punto P al segmento A->B */
function distSegmento(px: number, py: number,
                      ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Restituisce un array con le distanze cumulative dei segmenti, serve per il calcolo della posizione lungo il percorso */
function distanzeCumulative(lunghezze: number[]): number[] {
    let totale = 0;
    return lunghezze.map(len => {
        const inizioSegmento = totale;
        totale += len;
        return inizioSegmento;
    });
}

function dentroTraguardo(x: number, y: number): boolean {
    return Math.abs(x - TRAGUARDO.x) <= TRAGUARDO_LARGHEZZA / 2
        && Math.abs(y - TRAGUARDO.y) <= TRAGUARDO_ALTEZZA / 2;
}

/** true se il punto (cx, cy) e' sull'asfalto */
function sullaStrada(cx: number, cy: number): boolean {
    return vicinoAlTracciato(cx, cy, LARGHEZZA_PISTA / 2);
}

function sullaStradaConMargine(cx: number, cy: number, extra: number): boolean {
    return vicinoAlTracciato(cx, cy, LARGHEZZA_PISTA / 2 + extra);
}

function vicinoAlTracciato(cx: number, cy: number, limite: number): boolean {
    for (let i = 0; i < WAYPOINTS.length; i++) {
        const a = WAYPOINTS[i];
        const b = WAYPOINTS[(i + 1) % WAYPOINTS.length];
        if (distSegmento(cx, cy, a.x, a.y, b.x, b.y) < limite) return true;
    }
    return false;
}

function orientazione(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function puntoSuSegmento(ax: number, ay: number, bx: number, by: number, px: number, py: number): boolean {
    return px >= Math.min(ax, bx) && px <= Math.max(ax, bx)
        && py >= Math.min(ay, by) && py <= Math.max(ay, by)
        && orientazione(ax, ay, bx, by, px, py) === 0;
}

function segmentiSiIntersecano(
    ax: number, ay: number, bx: number, by: number,
    cx: number, cy: number, dx: number, dy: number,
): boolean {
    const o1 = orientazione(ax, ay, bx, by, cx, cy);
    const o2 = orientazione(ax, ay, bx, by, dx, dy);
    const o3 = orientazione(cx, cy, dx, dy, ax, ay);
    const o4 = orientazione(cx, cy, dx, dy, bx, by);

    if (o1 === 0 && puntoSuSegmento(ax, ay, bx, by, cx, cy)) return true;
    if (o2 === 0 && puntoSuSegmento(ax, ay, bx, by, dx, dy)) return true;
    if (o3 === 0 && puntoSuSegmento(cx, cy, dx, dy, ax, ay)) return true;
    if (o4 === 0 && puntoSuSegmento(cx, cy, dx, dy, bx, by)) return true;

    return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}

function attraversaTraguardo(
    xPrecedente: number,
    yPrecedente: number,
    xAttuale: number,
    yAttuale: number,
): boolean {
    const left = TRAGUARDO.x - TRAGUARDO_LARGHEZZA / 2;
    const right = TRAGUARDO.x + TRAGUARDO_LARGHEZZA / 2;
    const top = TRAGUARDO.y - TRAGUARDO_ALTEZZA / 2;
    const bottom = TRAGUARDO.y + TRAGUARDO_ALTEZZA / 2;

    if (Math.max(xPrecedente, xAttuale) < left || Math.min(xPrecedente, xAttuale) > right) return false;
    if (Math.max(yPrecedente, yAttuale) < top || Math.min(yPrecedente, yAttuale) > bottom) return false;

    if (dentroTraguardo(xPrecedente, yPrecedente) || dentroTraguardo(xAttuale, yAttuale)) return true;

    return segmentiSiIntersecano(
        xPrecedente, yPrecedente, xAttuale, yAttuale,
        left, top, right, top,
    ) || segmentiSiIntersecano(
        xPrecedente, yPrecedente, xAttuale, yAttuale,
        right, top, right, bottom,
    ) || segmentiSiIntersecano(
        xPrecedente, yPrecedente, xAttuale, yAttuale,
        right, bottom, left, bottom,
    ) || segmentiSiIntersecano(
        xPrecedente, yPrecedente, xAttuale, yAttuale,
        left, bottom, left, top,
    );
}

function puntoInRettangoloRuotato(px: number, py: number, rect: SpeedPad): boolean {
    const dx = px - rect.x;
    const dy = py - rect.y;
    const cos = Math.cos(-rect.a);
    const sin = Math.sin(-rect.a);
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    return Math.abs(rx) <= rect.w / 2 && Math.abs(ry) <= rect.h / 2;
}

function proiettaSuTracciato(px: number, py: number): number {
    let bestDist = Infinity;
    let bestProgress = 0;

    for (let i = 0; i < WAYPOINTS.length; i++) {
        const a = WAYPOINTS[i];
        const b = WAYPOINTS[(i + 1) % WAYPOINTS.length];
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0
            ? 0
            : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
        const sx = a.x + t * dx;
        const sy = a.y + t * dy;
        const dist = Math.hypot(px - sx, py - sy);

        if (dist < bestDist) {
            bestDist = dist;
            bestProgress = DISTANZE_WAYPOINT[i] + LUNGHEZZE_SEGMENTI[i] * t;
            if (bestProgress >= LUNGHEZZA_TRACCIATO) bestProgress -= LUNGHEZZA_TRACCIATO;
        }
    }

    return bestProgress;
}

function aggiornaCheckpoint(mask: number, x: number, y: number): number {
    let prossimoMask = mask;
    for (let i = 0; i < CHECKPOINTS.length; i++) {
        const bit = 1 << i;
        if (prossimoMask & bit) continue;
        if (i > 0 && !(prossimoMask & (1 << (i - 1)))) continue;
        if (Math.hypot(x - CHECKPOINTS[i].x, y - CHECKPOINTS[i].y) < CHECKPOINTS[i].r)
            prossimoMask |= bit;
    }
    return prossimoMask;
}


// ============================================================================
// HELPER DI CLASSIFICA E PROGRESSO
// Calcolano tempi, griglia e ordinamenti senza dipendere dalle classi.
// ============================================================================

function tempoQualifica(auto: StatoAuto): number {
    return auto.migliorGiro < 0 ? Infinity : auto.migliorGiro;
}

function confrontaQualifica(a: StatoAuto, b: StatoAuto): number {
    return tempoQualifica(a) - tempoQualifica(b);
}

function calcolaGriglia(auto: Record<string, StatoAuto>): string[] {
    return Object.keys(auto).sort((a, b) => confrontaQualifica(auto[a], auto[b]));
}

/** Miglior tempo assoluto tra tutti i giocatori (-1 se nessuno ha girato) */
function calcolaMigliorAssoluto(auto: Record<string, StatoAuto>): number {
    let best = Infinity;
    for (const id in auto) {
        const t = auto[id].migliorGiro;
        if (t >= 0 && t < best) best = t;
    }
    return best === Infinity ? -1 : best;
}

function progressoLungoGiro(auto: StatoAuto): number {
    return proiettaSuTracciato(auto.x, auto.y);
}

function progressoGara(auto: StatoAuto): number {
    return auto.giri * LUNGHEZZA_TRACCIATO + progressoLungoGiro(auto);
}

function confrontaAutoInGara(a: StatoAuto, b: StatoAuto): number {
    return progressoGara(b) - progressoGara(a);
}

/** ms -> "m:ss,ddd" (es. 68423 -> "1:08,423") */
function formatTempo(ms: number): string {
    if (ms < 0) return '--:--.---';
    const min  = Math.floor(ms / 60000);
    const sec  = Math.floor((ms % 60000) / 1000);
    const mill = Math.floor(ms % 1000);
    return `${min}:${String(sec).padStart(2, '0')},${String(mill).padStart(3, '0')}`;
}

function normalizzaAngolo(rad: number): number {
    while (rad > Math.PI) rad -= Math.PI * 2;
    while (rad < -Math.PI) rad += Math.PI * 2;
    return rad;
}


// ============================================================================
// HELPER DI FISICA
// Integrano timer, sterzo, attrito, turbo, erba e spin-out in passi piccoli.
// ============================================================================

/**
 * Aggiorna la fisica dell'auto per dt secondi.
 * Usata sia dal server (tutti) sia internamente per eventuali predizioni lato client.
 *
 * @param bonusScia   moltiplicatore vel max da scia (1 = nessuna scia)
 * @param fuoriPista  true = penalita' erba attive
 */
function aggiornaFisica(
    auto: StatoAuto,
    input: { su: boolean; giu: boolean; mouseAngolo: number },
    dt: number,
    bonusScia: number,
    fuoriPista: boolean,
): void {
    aggiornaTimerAuto(auto, dt);
    if (gestisciSpinOut(auto, dt)) return;
    orientaAutoVersoMouse(auto, input.mouseAngolo, dt);

    const fw = { x: Math.cos(auto.a), y: Math.sin(auto.a) };

    const fisica = calcolaParametriFisici(auto, bonusScia, fuoriPista);

    if (input.su) {
        auto.vx += fw.x * fisica.accelMax * dt;
        auto.vy += fw.y * fisica.accelMax * dt;
    }
    if (input.giu) {
        const v = Math.hypot(auto.vx, auto.vy);
        if (v > 5) {
            auto.vx -= (auto.vx / v) * FRENO * dt;
            auto.vy -= (auto.vy / v) * FRENO * dt;
        }
    }

    // Drift: decompone in avanti + laterale e riduce la laterale
    const fwdVel = auto.vx * fw.x + auto.vy * fw.y;
    const latX   = auto.vx - fw.x * fwdVel;
    const latY   = auto.vy - fw.y * fwdVel;
    auto.vx = fw.x * fwdVel + latX * DRIFT;
    auto.vy = fw.y * fwdVel + latY * DRIFT;

    // Attrito passivo (piu' forte su erba)
    const v = Math.hypot(auto.vx, auto.vy);
    if (v > 0) {
        const f = Math.min(v, fisica.attritoTotale * dt);
        auto.vx -= (auto.vx / v) * f;
        auto.vy -= (auto.vy / v) * f;
    }

    // Limita velocita' massima (modulata da turbo e scia)
    const vAtt = Math.hypot(auto.vx, auto.vy);
    if (vAtt > fisica.velMax) {
        auto.vx = (auto.vx / vAtt) * fisica.velMax;
        auto.vy = (auto.vy / vAtt) * fisica.velMax;
    }

    auto.x += auto.vx * dt;
    auto.y += auto.vy * dt;

    if (auto.speedPadCooldown <= 0) {
        for (const pad of SPEED_PADS) {
            if (!puntoInRettangoloRuotato(auto.x, auto.y, pad)) continue;
            const dirX = Math.cos(pad.a);
            const dirY = Math.sin(pad.a);
            auto.vx += dirX * SPEED_PAD_BOOST;
            auto.vy += dirY * SPEED_PAD_BOOST;
            auto.speedPadCooldown = SPEED_PAD_COOLDOWN;
            break;
        }
    }
}

function aggiornaTimerAuto(auto: StatoAuto, dt: number): void {
    if (auto.spinTimer > 0) auto.spinTimer = Math.max(0, auto.spinTimer - dt);
    if (auto.slingshotTimer > 0) auto.slingshotTimer = Math.max(0, auto.slingshotTimer - dt);
    if (auto.shockwaveTimer > 0) auto.shockwaveTimer = Math.max(0, auto.shockwaveTimer - dt);

    if (auto.turboTimer > 0) {
        auto.turboTimer -= dt;
        if (auto.turboTimer <= 0) auto.turboCooldown = TURBO_RICARICA;
    }

    if (auto.turboCooldown > 0) auto.turboCooldown = Math.max(0, auto.turboCooldown - dt);
    if (auto.shockwaveCooldown > 0) auto.shockwaveCooldown = Math.max(0, auto.shockwaveCooldown - dt);
    if (auto.speedPadCooldown > 0) auto.speedPadCooldown = Math.max(0, auto.speedPadCooldown - dt);
}

function gestisciSpinOut(auto: StatoAuto, dt: number): boolean {
    if (auto.spinTimer <= 0) return false;

    auto.a += 5.5 * dt;
    const v = Math.hypot(auto.vx, auto.vy);
    if (v > 0) {
        // Lo spin consuma velocita' in modo progressivo: l'auto resta leggibile,
        // ma il giocatore perde abbastanza tempo da percepire l'impatto come rischio reale.
        const f = Math.min(v, ATTRITO * 3 * dt);
        auto.vx -= (auto.vx / v) * f;
        auto.vy -= (auto.vy / v) * f;
    }

    auto.x += auto.vx * dt;
    auto.y += auto.vy * dt;
    return true;
}

function orientaAutoVersoMouse(auto: StatoAuto, mouseAngolo: number, dt: number): void {
    if (!Number.isFinite(mouseAngolo)) return;

    const diff = normalizzaAngolo(mouseAngolo - auto.a);
    const maxTurn = STERZO_RAD * dt * 1.7;
    auto.a += Math.sign(diff) * Math.min(Math.abs(diff), maxTurn);
}

function calcolaParametriFisici(auto: StatoAuto, bonusScia: number, fuoriPista: boolean): ParametriFisici {
    // L'erba taglia soprattutto la velocita' massima, non l'accelerazione assoluta:
    // cosi' l'errore costa caro sul giro ma il rientro non diventa frustrante.
    const accelMax = fuoriPista ? ACCEL * ERBA_ACCEL_MULT : ACCEL;
    const velMax = VEL_MAX
        * (fuoriPista ? ERBA_VELMAX_MULT : 1)
        * (auto.turboTimer > 0 ? TURBO_BONUS : 1)
        * bonusScia;
    const attritoTotale = fuoriPista ? ATTRITO + ERBA_ATTRITO_ADD : ATTRITO;

    return { accelMax, velMax, attritoTotale };
}

/** Posizione di griglia: file alternate sinistra/destra, avanzano verso sud */
function posGriglia(i: number): { x: number; y: number; a: number } {
    const lato = i % 2 === 0 ? -1 : 1;
    const fila  = Math.floor(i / 2);
    return {
        x: TRAGUARDO.x + lato * GRIGLIA_BASE.dx,
        y: TRAGUARDO.y + 150 + fila * GRIGLIA_BASE.dy, // 150px sotto il traguardo
        a: -Math.PI / 2,   // punta verso nord ()
    };
}


// ============================================================================
// SERVER AUTORITATIVO
// Riceve input, simula fisica/regole e pubblica lo stato ufficiale della gara.
// ============================================================================

export class MicroRacingServer extends GameServer {

    // --- Stato della partita -------------------------------------------------

    private auto: Record<string, StatoAuto> = {};
    private fase: Fase          = 'qualifiche';
    private tempoQual           = DURATA_QUALIFICHE;
    private tempoVoto           = DURATA_VOTO;
    private tempoRecap          = DURATA_RECAP;
    private countdownPartenza   = 0;    // >0 = semaforo attivo, input bloccati
    private dnfTimer            = -1;   // -1 = non attivo
    private gridOrder: string[] = [];
    private garaFinita          = false;
    private modalitaGara: ModalitaGara = 'standard';
    private voti: Record<string, ModalitaGara | null> = {};
    private totGiocatori        = 0;
    private ultimiInput: Record<string, MsgInput> = {};
    private sopravvivenzaTimer  = SOPRAVVIVENZA_INTERVALLO;
    private trenoCooldown       = TRENO_INTERVALLO;
    private trenoAttivo         = 0;
    private trenoX              = TRENO_X_START;
    private warningTreno        = 0;


    // --- API richiesta da GameServer ----------------------------------------

    init(giocatori: Record<string, Player>): void {
        let i = 0;
        for (const id in giocatori) {
            const g = posGriglia(i);
            this.auto[id] = {
                x: g.x, y: g.y, xPrecedente: g.x, yPrecedente: g.y,
                a: g.a, vx: 0, vy: 0,
                giri: 0, cp: 0, cpQual: 0,
                migliorGiro: -1, tempoGiroAttuale: 0,
                sulTraguardo: false,   // edge-detection: falso all'avvio
                giroInvalido: false,
                turboTimer: 0, turboCooldown: 0, shockwaveCooldown: 0, shockwaveTimer: 0, spinTimer: 0,
                inScia: false, tempoScia: 0, slingshotTimer: 0, speedPadCooldown: 0,
                nome: giocatori[id].name, character: giocatori[id].character,
                finito: false, dnf: false, posizione: 0,
            };
            this.ultimiInput[id] = inputNeutro();
            this.voti[id] = null;
            i++;
        }
        this.totGiocatori = i;
    }

    tick(messaggi: IncomingMsg[], dt: number): OutgoingMsg[] {
        this.registraInput(messaggi);
        this.aggiornaSimulazione(dt);
        this.aggiornaFase(dt);
        return [{ payload: this.creaPayloadStato() }];
    }

    isFinished(): boolean { return this.garaFinita; }


    // --- Pipeline del tick ---------------------------------------------------

    private garaInMovimento(): boolean {
        return this.fase === 'gara' && this.countdownPartenza <= 0;
    }

    private simulazioneFisicaAttiva(): boolean {
        return this.fase === 'qualifiche' || this.garaInMovimento();
    }

    private aggiornaSimulazione(dt: number): void {
        const garaAttiva = this.garaInMovimento();
        const simulazioneOn = this.simulazioneFisicaAttiva();

        if (simulazioneOn) this.simulaAuto(dt, garaAttiva);
        else this.tieniFermeLeAuto();

        if (garaAttiva) this.risolviCollisioniAuto();
    }

    private aggiornaFase(dt: number): void {
        if (this.fase === 'qualifiche') {
            this.tickQualifiche(dt);
            return;
        }

        if (this.fase === 'recap') {
            this.tickRecap(dt);
            return;
        }

        if (this.fase === 'voto') {
            this.tickVoto(dt);
            return;
        }

        this.tickGara(dt);
    }

    private creaPayloadStato(): MsgStato {
        const { standard, sopravvivenza } = this.conteggioVoti();
        return {
            kind: 'stato',
            fase: this.fase,
            tempoQual: this.tempoQual,
            tempoVoto: this.tempoVoto,
            tempoRecap: this.tempoRecap,
            countdownPartenza: this.countdownPartenza,
            dnfTimer: this.dnfTimer,
            auto: this.auto,
            garaFinita: this.garaFinita,
            gridOrder: this.gridOrder,
            migliorAssoluto: calcolaMigliorAssoluto(this.auto),
            votiStandard: standard,
            votiSopravvivenza: sopravvivenza,
            modalitaGara: this.modalitaGara,
            warningTreno: this.warningTreno,
            treno: this.trenoAttivo > 0
                ? { x: this.trenoX, y: TRENO_Y, w: TRENO_LUNGHEZZA, h: TRENO_ALTEZZA }
                : null,
        };
    }


    // --- Input, power-up e fisica auto --------------------------------------

    private registraInput(messaggi: IncomingMsg[]): void {
        for (const msg of messaggi) {
            const voto = normalizzaVoto(msg.payload);
            if (voto) {
                this.registraVoto(msg.clientId, voto);
                continue;
            }
            const input = normalizzaInput(msg.payload);
            if (!input || !this.auto[msg.clientId]) continue;
            this.ultimiInput[msg.clientId] = input;
        }
    }

    private registraVoto(id: string, voto: MsgVoto): void {
        if (this.fase !== 'voto' || !this.auto[id]) return;
        this.voti[id] = voto.scelta;
    }

    private conteggioVoti(): { standard: number; sopravvivenza: number } {
        let standard = 0;
        let sopravvivenza = 0;
        for (const id in this.voti) {
            if (this.voti[id] === 'standard') standard++;
            else if (this.voti[id] === 'sopravvivenza') sopravvivenza++;
        }
        return { standard, sopravvivenza };
    }

    private simulaAuto(dt: number, garaAttiva: boolean): void {
        for (const id in this.auto) {
            const auto = this.auto[id];
            const input = this.ultimiInput[id] ?? inputNeutro();
            if (garaAttiva && auto.finito) continue;

            this.preparaAutoPerTick(auto);
            this.usaPowerUp(auto, input);
            this.aggiornaFisicaAuto(id, auto, input, dt, garaAttiva);
        }
    }

    private preparaAutoPerTick(auto: StatoAuto): void {
        auto.xPrecedente = auto.x;
        auto.yPrecedente = auto.y;
    }

    private aggiornaFisicaAuto(
        id: string,
        auto: StatoAuto,
        input: MsgInput,
        dt: number,
        garaAttiva: boolean,
    ): void {
        const fuoriPistaPrima = !sullaStradaConMargine(auto.x, auto.y, MARGINE_QUALI);
        this.segnalaGiroInvalidoSeFuori(auto, fuoriPistaPrima);

        const bonusScia = garaAttiva ? this.calcolaBonusScia(id, dt) : 1;
        aggiornaFisica(auto, input, dt, bonusScia, fuoriPistaPrima);

        const fuoriPistaDopo = !sullaStradaConMargine(auto.x, auto.y, MARGINE_QUALI);
        this.segnalaGiroInvalidoSeFuori(auto, fuoriPistaDopo);
    }

    private segnalaGiroInvalidoSeFuori(auto: StatoAuto, fuoriPista: boolean): void {
        if (this.fase === 'qualifiche' && fuoriPista) auto.giroInvalido = true;
    }

    private usaPowerUp(auto: StatoAuto, input: MsgInput): void {
        this.provaAttivareTurbo(auto, input);
        this.provaAttivareShockwave(auto, input);
        input.turbo = false;
        input.shockwave = false;
    }

    private provaAttivareTurbo(auto: StatoAuto, input: MsgInput): void {
        if (input.turbo && auto.turboTimer <= 0 && auto.turboCooldown <= 0)
            auto.turboTimer = TURBO_DURATA;
    }

    private provaAttivareShockwave(auto: StatoAuto, input: MsgInput): void {
        if (this.fase !== 'gara' || !input.shockwave || auto.shockwaveCooldown > 0) return;

        auto.shockwaveCooldown = SHOCKWAVE_RICARICA;
        auto.shockwaveTimer = SHOCKWAVE_DURATA;
        this.applicaShockwave(auto);
    }

    private applicaShockwave(origine: StatoAuto): void {
        for (const id in this.auto) {
            const bersaglio = this.auto[id];
            if (bersaglio === origine || bersaglio.finito) continue;

            const dx = bersaglio.x - origine.x;
            const dy = bersaglio.y - origine.y;
            const dist = Math.hypot(dx, dy);
            if (dist <= 1 || dist > SHOCKWAVE_RAGGIO) continue;

            const intensita = 1 - dist / SHOCKWAVE_RAGGIO;
            const spinta = SHOCKWAVE_FORZA * intensita;
            bersaglio.vx += (dx / dist) * spinta;
            bersaglio.vy += (dy / dist) * spinta;
        }
    }


    // --- Collisioni ----------------------------------------------------------

    private tieniFermeLeAuto(): void {
        for (const id in this.auto) {
            this.auto[id].vx = 0;
            this.auto[id].vy = 0;
            this.auto[id].inScia = false;
            this.auto[id].tempoScia = 0;
            this.auto[id].slingshotTimer = 0;
            this.auto[id].shockwaveTimer = 0;
        }
    }

    private risolviCollisioniAuto(): void {
        const ids = Object.keys(this.auto);
        for (let i = 0; i < ids.length - 1; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                this.risolviCollisioneCoppia(this.auto[ids[i]], this.auto[ids[j]]);
            }
        }
    }

    private risolviCollisioneCoppia(a: StatoAuto, b: StatoAuto): void {
        if (a.finito || b.finito) return;

        const distanza = Math.hypot(a.x - b.x, a.y - b.y);
        if (distanza >= 12 || distanza <= 0) return;

        const nx = (b.x - a.x) / distanza;
        const ny = (b.y - a.y) / distanza;
        const overlap = (12 - distanza) / 2;
        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;

        // Impulso morbido: evita auto incollate senza produrre rimbalzi arcade eccessivi.
        const va = a.vx * nx + a.vy * ny;
        const vb = b.vx * nx + b.vy * ny;
        a.vx += (vb - va) * nx * 0.7;
        a.vy += (vb - va) * ny * 0.7;
        b.vx += (va - vb) * nx * 0.7;
        b.vy += (va - vb) * ny * 0.7;
    }

    // --- Qualifiche ----------------------------------------------------------

    private tickQualifiche(dt: number): void {
        this.tempoQual -= dt;

        for (const id in this.auto) {
            this.aggiornaAutoQualifica(this.auto[id], dt);
        }

        if (this.tempoQual <= 0) this.concludiQualifiche();
    }

    private rilevaPassaggioTraguardo(auto: StatoAuto): { nelTraguardo: boolean; appenaEntrato: boolean } {
        const haAttraversato = attraversaTraguardo(auto.xPrecedente, auto.yPrecedente, auto.x, auto.y);
        const nelTraguardo = dentroTraguardo(auto.x, auto.y);
        return {
            nelTraguardo,
            appenaEntrato: (nelTraguardo || haAttraversato) && !auto.sulTraguardo,
        };
    }

    private aggiornaAutoQualifica(auto: StatoAuto, dt: number): void {
        auto.tempoGiroAttuale += dt * 1000;
        auto.cpQual = aggiornaCheckpoint(auto.cpQual, auto.x, auto.y);
        this.gestisciPassaggioQualifica(auto);
    }

    private gestisciPassaggioQualifica(auto: StatoAuto): void {
        const passaggio = this.rilevaPassaggioTraguardo(auto);
        if (passaggio.appenaEntrato) {
            this.salvaMigliorGiroSeValido(auto);
            this.resetGiroQualifica(auto);
        }

        auto.sulTraguardo = passaggio.nelTraguardo;
    }

    private salvaMigliorGiroSeValido(auto: StatoAuto): void {
        const checkpointCompleti = (auto.cpQual & TUTTI_CHECKPOINT) === TUTTI_CHECKPOINT;
        if (!checkpointCompleti || auto.giroInvalido) return;

        const tempo = auto.tempoGiroAttuale;
        if (auto.migliorGiro < 0 || tempo < auto.migliorGiro) auto.migliorGiro = tempo;
    }

    private resetGiroQualifica(auto: StatoAuto): void {
        // Il reset avviene anche al primo passaggio non valido: cosi' il giro
        // successivo parte sempre da una base pulita e non eredita track-limits.
        auto.tempoGiroAttuale = 0;
        auto.cpQual = 0;
        auto.giroInvalido = false;
    }

    private concludiQualifiche(): void {
        this.tempoQual = 0;
        this.gridOrder = calcolaGriglia(this.auto);
        this.tieniFermeLeAuto();
        this.fase = 'voto';
        this.tempoVoto = DURATA_VOTO;
        this.modalitaGara = 'standard';
        for (const id in this.voti) this.voti[id] = null;
    }


    // --- Recap e griglia di partenza ----------------------------------------

    private tickRecap(dt: number): void {
        this.tempoRecap -= dt;
        if (this.tempoRecap <= 0) {
            this.tempoRecap = 0;
            this.avviaGara();
        }
    }

    private tickVoto(dt: number): void {
        this.tempoVoto -= dt;
        if (this.tempoVoto > 0) return;

        this.tempoVoto = 0;
        const { standard, sopravvivenza } = this.conteggioVoti();
        this.modalitaGara = sopravvivenza > standard ? 'sopravvivenza' : 'standard';
        this.fase = 'recap';
        this.tempoRecap = DURATA_RECAP;
    }

    /** Riposiziona le auto in griglia secondo i risultati delle qualifiche e accende il semaforo */
    private avviaGara(): void {
        this.fase               = 'gara';
        this.countdownPartenza  = DURATA_PARTENZA;
        this.dnfTimer           = -1;
        this.sopravvivenzaTimer = SOPRAVVIVENZA_INTERVALLO;
        this.trenoCooldown      = TRENO_INTERVALLO;
        this.trenoAttivo        = 0;
        this.trenoX             = TRENO_X_START;
        this.warningTreno       = 0;

        const ordine = this.gridOrder.length > 0 ? this.gridOrder : Object.keys(this.auto);
        ordine.forEach((id, i) => {
            const g = posGriglia(i);
            const a = this.auto[id];
            if (a) this.resetAutoPerGara(a, g);
        });
    }

    private resetAutoPerGara(auto: StatoAuto, griglia: { x: number; y: number; a: number }): void {
        auto.x = griglia.x;
        auto.y = griglia.y;
        auto.a = griglia.a;
        auto.xPrecedente = griglia.x;
        auto.yPrecedente = griglia.y;
        auto.vx = 0;
        auto.vy = 0;
        auto.giri = 0;
        auto.cp = 0;
        // La griglia parte sotto la fascia: forzare false evita un falso passaggio al primo tick utile.
        auto.sulTraguardo = false;
        auto.finito = false;
        auto.dnf = false;
        auto.posizione = 0;
        auto.giroInvalido = false;
        auto.inScia = false;
        auto.tempoScia = 0;
        auto.slingshotTimer = 0;
        auto.shockwaveCooldown = 0;
        auto.shockwaveTimer = 0;
        auto.speedPadCooldown = 0;
    }


    // --- Gara, arrivi e DNF --------------------------------------------------

    private tickGara(dt: number): void {
        if (this.aggiornaCountdownPartenza(dt)) return;

        this.updateTreno(dt);

        const finitiPrima = this.contaAutoFinite();
        const candidati = this.raccogliPassaggiGara();
        const haVincitoreQuestoTick = candidati.some(c => c.haCompletatoGara);
        let finiti = this.assegnaNuoviArrivi(candidati, finitiPrima, haVincitoreQuestoTick);

        if (this.tuttiHannoConcluso(finiti)) {
            this.garaFinita = true;
            return;
        }

        if (this.modalitaGara === 'sopravvivenza') {
            finiti = this.aggiornaSopravvivenza(dt, finiti);
            if (this.tuttiHannoConcluso(finiti)) {
                this.garaFinita = true;
                return;
            }
        }

        finiti = this.aggiornaDnfGlobale(dt, finiti);
        if (this.tuttiHannoConcluso(finiti)) this.garaFinita = true;
    }

    private aggiornaCountdownPartenza(dt: number): boolean {
        if (this.countdownPartenza <= 0) return false;

        this.countdownPartenza = Math.max(0, this.countdownPartenza - dt);
        return true;
    }

    private contaAutoFinite(): number {
        let finiti = 0;
        for (const id in this.auto) if (this.auto[id].finito) finiti++;
        return finiti;
    }

    private raccogliPassaggiGara(): CandidatoArrivo[] {
        const candidati: CandidatoArrivo[] = [];

        for (const id in this.auto) {
            const auto = this.auto[id];
            if (auto.finito) continue;

            auto.cp = aggiornaCheckpoint(auto.cp, auto.x, auto.y);
            this.registraPassaggioGara(auto, candidati);
        }

        return candidati;
    }

    private registraPassaggioGara(auto: StatoAuto, candidati: CandidatoArrivo[]): void {
        const passaggio = this.rilevaPassaggioTraguardo(auto);

        if (passaggio.appenaEntrato && (auto.cp & TUTTI_CHECKPOINT) === TUTTI_CHECKPOINT) {
            auto.giri++;
            auto.cp = 0;
            candidati.push({
                auto,
                haCompletatoGara: auto.giri >= GIRI_GARA,
                progress: progressoGara(auto),
            });
        }

        auto.sulTraguardo = passaggio.nelTraguardo;
    }

    private assegnaNuoviArrivi(
        candidati: CandidatoArrivo[],
        finitiPrima: number,
        haVincitoreQuestoTick: boolean,
    ): number {
        let finiti = finitiPrima;
        const dnfGiaAttivo = this.dnfTimer > 0;
        const dnfParteOra = finitiPrima === 0 && haVincitoreQuestoTick;
        const classificaAperta = dnfGiaAttivo || dnfParteOra;
        const nuoviFiniti = candidati.filter(c => c.haCompletatoGara || classificaAperta);

        nuoviFiniti.sort((a, b) => b.progress - a.progress);
        for (const candidato of nuoviFiniti) {
            candidato.auto.finito = true;
            candidato.auto.posizione = ++finiti;
        }

        if (this.dnfTimer < 0 && dnfParteOra) this.dnfTimer = DNF_TIMEOUT;
        return finiti;
    }

    private aggiornaDnfGlobale(dt: number, finiti: number): number {
        if (this.dnfTimer < 0) return finiti;

        this.dnfTimer = Math.max(0, this.dnfTimer - dt);
        if (this.dnfTimer > 0) return finiti;

        const nonFiniti = Object.keys(this.auto)
            .filter(id => !this.auto[id].finito)
            .sort((a, b) => confrontaAutoInGara(this.auto[a], this.auto[b]));

        for (const id of nonFiniti) {
            const auto = this.auto[id];
            auto.finito = true;
            auto.dnf = true;
            auto.posizione = ++finiti;
        }

        this.dnfTimer = -1;
        return finiti;
    }

    private aggiornaSopravvivenza(dt: number, finiti: number): number {
        this.sopravvivenzaTimer -= dt;
        if (this.sopravvivenzaTimer > 0) return finiti;

        this.sopravvivenzaTimer = SOPRAVVIVENZA_INTERVALLO;
        const eliminato = this.eliminaUltimoInGara();
        if (!eliminato) return finiti;
        return finiti + 1;
    }

    private eliminaUltimoInGara(): boolean {
        const attivi = Object.values(this.auto)
            .filter(a => !a.finito)
            .sort((a, b) => confrontaAutoInGara(a, b));

        if (attivi.length <= 1) return false;
        const ultimo = attivi[attivi.length - 1];
        ultimo.finito = true;
        ultimo.dnf = true;
        ultimo.vx = 0;
        ultimo.vy = 0;
        ultimo.posizione = this.contaAutoFinite();
        return true;
    }

    private updateTreno(dt: number): void {
        this.warningTreno = 0;

        if (this.trenoAttivo > 0) {
            this.trenoAttivo = Math.max(0, this.trenoAttivo - dt);
            this.trenoX += TRENO_VEL * dt;
            this.risolviCollisioniTreno();

            if (this.trenoAttivo === 0) {
                this.trenoCooldown = TRENO_INTERVALLO;
                this.trenoX = TRENO_X_START;
            }
            return;
        }

        this.trenoCooldown -= dt;
        if (this.trenoCooldown <= TRENO_AVVISO && this.trenoCooldown > 0) {
            this.warningTreno = this.trenoCooldown;
        }
        if (this.trenoCooldown <= 0) {
            this.trenoAttivo = TRENO_DURATA;
            this.trenoX = TRENO_X_START;
        }
    }

    private risolviCollisioniTreno(): void {
        const halfW = TRENO_LUNGHEZZA / 2;
        const halfH = TRENO_ALTEZZA / 2;

        for (const id in this.auto) {
            const auto = this.auto[id];
            if (auto.finito || auto.spinTimer > 0) continue;
            const dx = Math.abs(auto.x - this.trenoX);
            const dy = Math.abs(auto.y - TRENO_Y);
            if (dx <= halfW + 6 && dy <= halfH + 6) auto.spinTimer = OLIO_SPIN;
        }
    }

    private tuttiHannoConcluso(finiti: number): boolean {
        return finiti >= this.totGiocatori;
    }


    // --- Scia ---------------------------------------------------------------

    /**
     * Calcola il bonus scia per l'auto `idFollower`.
     * Un'auto e' in scia se si trova nel cono posteriore dell'auto davanti:
     *   - distanza < SCIA_DIST_MAX
     *   - proiezione lungo l'asse del leader > 0 (e' dietro)
     *   - distanza laterale < SCIA_CONE_BASE + distanza * SCIA_CONE_GAIN
        * Dopo SLINGSHOT_TEMPO in scia continua, si attiva lo slingshot temporaneo.
     */
    private calcolaBonusScia(idFollower: string, dt: number): number {
        const follower = this.auto[idFollower];
        if (!follower) return 1;
        let inScia = false;

        for (const id in this.auto) {
            if (id === idFollower) continue;
            const leader = this.auto[id];
            if (!leader || leader.finito) continue;

            const dx = follower.x - leader.x;
            const dy = follower.y - leader.y;
            const dist = Math.hypot(dx, dy);
            if (dist > SCIA_DIST_MAX || dist < 8) continue;

            // Asse del leader: forward e laterale
            const fwX = Math.cos(leader.a);
            const fwY = Math.sin(leader.a);

            // "lungoAsse" > 0 significa che il follower e' DIETRO il leader
            const lungoAsse = -(dx * fwX + dy * fwY);
            if (lungoAsse <= 0) continue;

            // Distanza laterale dall'asse del leader
            const laterale = Math.abs(dx * (-fwY) + dy * fwX);
            const aperturaCono = SCIA_CONE_BASE + lungoAsse * SCIA_CONE_GAIN;

            if (laterale <= aperturaCono) {
                inScia = true;
                break;
            }
        }

        if (inScia) {
            follower.tempoScia += dt;
            if (follower.tempoScia >= SLINGSHOT_TEMPO && follower.slingshotTimer <= 0) {
                follower.slingshotTimer = SLINGSHOT_DURATA;
                follower.tempoScia = 0;
            }
        } else {
            follower.tempoScia = 0;
        }

        follower.inScia = inScia;

        if (follower.slingshotTimer > 0) return SLINGSHOT_BONUS;
        if (inScia) return SCIA_BONUS;
        return 1;
    }
}


// ============================================================================
// CLIENT CANVAS
// Interpola lo stato ricevuto, invia input e disegna mondo, HUD e finali.
// ============================================================================

export class MicroRacingClient extends GameClient {

    // --- Stato ricevuto e interpolato ---------------------------------------

    // Stato ricevuto dal server (fonte di verita')
    private statoServer: Record<string, StatoAuto> | null = null;
    // Versioni interpolate per rendering fluido (anti-scatto da rete)
    private renderAuto: Record<string, StatoAuto> = {};

    private fase: Fase                 = 'qualifiche';
    private tempoQual                  = DURATA_QUALIFICHE;
    private tempoVoto                  = DURATA_VOTO;
    private tempoRecap                 = DURATA_RECAP;
    private countdownPartenza          = 0;
    private dnfTimer                   = -1;
    private gridOrder: string[]        = [];
    private migliorAssoluto            = -1;
    private votiStandard               = 0;
    private votiSopravvivenza          = 0;
    private modalitaGara: ModalitaGara = 'standard';
    private warningTreno               = 0;
    private trenoServer: StatoTreno | null = null;
    private colori: Record<string, string> = {};

    // Telecamera: segue l'auto del giocatore locale con smooth lerp
    private camX = TRAGUARDO.x;
    private camY = TRAGUARDO.y;
    private readonly ZOOM = 1.65;

    private trackCanvas: HTMLCanvasElement | null = null;
    private tasti = { su: false, giu: false, turbo: false, shockwave: false };
    private turboPremuto = false;
    private shockwavePremuto = false;
    private mouseSterzoAttivo = false;
    private animTime       = 0;
    private garaFinitaTimer = -1;
    private wrongWayTimer = 0;
    private classificaAnim: Record<string, StatoRigaClassifica> = {};
    private classificaAnimFase: 'qualifiche' | 'gara' | null = null;

    private votoSelezionato: ModalitaGara | null = null;
    private votoDaInviare: ModalitaGara | null = null;

    // goFlashTimer: dura ~0.9s dopo il GO! per mostrare il testo verde
    private goFlashTimer = 0;


    // --- Lifecycle e messaggi ------------------------------------------------

    constructor(userInput: UserInput, myId: string) {
        super(userInput, myId);
        this.registraTasti();
    }


    async init(giocatori: Record<string, Player>): Promise<void> {
        let i = 0;
        for (const id in giocatori) this.colori[id] = COLORI_AUTO[i++ % COLORI_AUTO.length];
        this.trackCanvas = this.costruisciCanvas();
    }

    handleMessage(msg: MsgStato): void {
        if (msg.kind !== 'stato') return;

        // Rileva il momento in cui il semaforo scatta a 0 -> mostra "GO!"
        const countdownPrecedente = this.countdownPartenza;
        this.fase               = msg.fase;
        this.tempoQual          = msg.tempoQual;
        this.tempoVoto          = msg.tempoVoto;
        this.tempoRecap         = msg.tempoRecap;
        this.countdownPartenza  = msg.countdownPartenza;
        this.dnfTimer           = msg.dnfTimer;
        this.gridOrder          = msg.gridOrder;
        this.migliorAssoluto    = msg.migliorAssoluto;
        this.votiStandard       = msg.votiStandard;
        this.votiSopravvivenza  = msg.votiSopravvivenza;
        this.modalitaGara       = msg.modalitaGara;
        this.warningTreno       = msg.warningTreno;
        this.trenoServer        = msg.treno;

        if (this.fase !== 'voto') this.votoDaInviare = null;

        if (countdownPrecedente > 0 && this.countdownPartenza <= 0 && this.fase === 'gara')
            this.goFlashTimer = 0.9;

        if (msg.garaFinita && this.garaFinitaTimer < 0)
            this.garaFinitaTimer = DURATA_AVVISO_PODIO + DURATA_PODIO;

        // Prima ricezione: inizializza renderAuto
        if (!this.statoServer) {
            this.statoServer = msg.auto;
            for (const id in msg.auto) this.renderAuto[id] = { ...msg.auto[id] };
            return;
        }

        // Aggiorna stato server; gestisce entrate/uscite di giocatori
        for (const id in msg.auto) {
            if (!this.statoServer[id]) this.renderAuto[id] = { ...msg.auto[id] };
            this.statoServer[id] = msg.auto[id];
        }
        for (const id in this.statoServer)
            if (!msg.auto[id]) { delete this.statoServer[id]; delete this.renderAuto[id]; }
    }

    flushMessages(): (MsgInput | MsgVoto)[] {
        const input: MsgInput = {
            kind: 'input',
            ...this.tasti,
            mouseAngolo: this.calcolaAngoloMouse(),
        };
        this.tasti.turbo = false;
        this.tasti.shockwave = false;

        const messaggi: (MsgInput | MsgVoto)[] = [input];
        if (this.fase === 'voto' && this.votoDaInviare) {
            messaggi.push({ kind: 'voto', scelta: this.votoDaInviare });
            this.votoDaInviare = null;
        }
        return messaggi;
    }

    isFinished(): boolean { return this.garaFinitaTimer === 0; }


    // --- Pipeline di rendering ----------------------------------------------

    draw(ctx: CanvasRenderingContext2D, dt: number): void {
        if (!this.statoServer) return;
        this.aggiornaTimerRender(dt);

        const { screenW: W, screenH: H } = this.userInput;
        const me = this.statoServer[this.myId];

        this.aggiornaStatoVisuale(me, dt);
        this.disegnaMondo(ctx, W, H);
        this.disegnaOverlay(ctx, me, W, H, dt);
    }

    private aggiornaTimerRender(dt: number): void {
        this.animTime += dt;
        if (this.garaFinitaTimer > 0) this.garaFinitaTimer = Math.max(0, this.garaFinitaTimer - dt);
        if (this.goFlashTimer    > 0) this.goFlashTimer    = Math.max(0, this.goFlashTimer    - dt);
    }

    private aggiornaStatoVisuale(me: StatoAuto | undefined, dt: number): void {
        if (me) this.aggiornaContromano(me, dt);
        else this.wrongWayTimer = 0;

        this.interpolaRenderAuto(dt);
        this.aggiornaCamera(me, dt);
    }

    private aggiornaCamera(me: StatoAuto | undefined, dt: number): void {
        if (this.fase === 'recap') {
            const cx = MONDO_W / 2, cy = MONDO_H / 2;
            this.camX += (cx - this.camX) * Math.min(1, dt * 3);
            this.camY += (cy - this.camY) * Math.min(1, dt * 3);
        } else if (me) {
            this.camX += (me.x - this.camX) * Math.min(1, dt * 9);
            this.camY += (me.y - this.camY) * Math.min(1, dt * 9);
        }
    }

    private disegnaMondo(ctx: CanvasRenderingContext2D, W: number, H: number): void {
        ctx.fillStyle = '#3a7d44';
        ctx.fillRect(0, 0, W, H);

        ctx.save();
        ctx.translate(W / 2, H / 2);
        ctx.scale(this.ZOOM, this.ZOOM);
        ctx.translate(-this.camX, -this.camY);

        if (this.trackCanvas) ctx.drawImage(this.trackCanvas, 0, 0);
        this.disegnaSpeedPads(ctx);
        for (const id in this.renderAuto)          this.disegnaAuto(ctx, id, this.renderAuto[id]);
        if (this.trenoServer) this.disegnaTreno(ctx, this.trenoServer);

        ctx.restore();
    }

    private disegnaSpeedPads(ctx: CanvasRenderingContext2D): void {
        const stride = 24;
        const offset = (this.animTime * 140) % stride;

        for (const pad of SPEED_PADS) {
            ctx.save();
            ctx.translate(pad.x, pad.y);
            ctx.rotate(pad.a);

            ctx.fillStyle = 'rgba(255,215,0,0.22)';
            ctx.fillRect(-pad.w / 2, -pad.h / 2, pad.w, pad.h);
            ctx.strokeStyle = 'rgba(255,235,120,0.9)';
            ctx.lineWidth = 2;

            for (let x = -pad.w / 2 - stride + offset; x < pad.w / 2 + stride; x += stride) {
                ctx.beginPath();
                ctx.moveTo(x, -pad.h / 2 + 4);
                ctx.lineTo(x + 8, 0);
                ctx.lineTo(x, pad.h / 2 - 4);
                ctx.stroke();
            }

            ctx.restore();
        }
    }

    private disegnaTreno(ctx: CanvasRenderingContext2D, treno: StatoTreno): void {
        ctx.save();
        ctx.translate(treno.x, treno.y);

        ctx.fillStyle = '#1b1b1b';
        ctx.fillRect(-treno.w / 2, -treno.h / 2, treno.w, treno.h);
        ctx.fillStyle = '#ff3b30';
        ctx.fillRect(-treno.w / 2, -treno.h / 2, treno.w, 4);
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        for (let x = -treno.w / 2 + 12; x < treno.w / 2 - 12; x += 26) {
            ctx.fillRect(x, -treno.h / 2 + 6, 14, treno.h - 12);
        }

        ctx.restore();
    }

    private disegnaOverlay(
        ctx: CanvasRenderingContext2D,
        me: StatoAuto | undefined,
        W: number,
        H: number,
        dt: number,
    ): void {
        if (this.fase === 'voto') {
            this.disegnaVoto(ctx, W, H);
        } else if (this.fase === 'recap') {
            this.disegnaRecap(ctx, W, H);
        } else {
            this.disegnaHUD(ctx, me, W, H);
            this.disegnaSemaforo(ctx, W);
            this.disegnaClassifica(ctx, W, dt);
            if (this.warningTreno > 0) this.disegnaAvvisoTreno(ctx, W);
            if (this.garaFinitaTimer < 0) this.disegnaAvvisoContromano(ctx, W, H);
            if (this.garaFinitaTimer >= 0) this.disegnaFinale(ctx, me, W, H);
        }
    }


    // --- Interpolazione e classifica animata --------------------------------

    /**
     * Avvicina renderAuto verso statoServer ogni frame.
     * Posizione e angolo vengono interpolati (lerp) per nascondere la latenza di rete.
     * Tutti gli altri campi sono autorevoli e vengono copiati direttamente.
     */
    private interpolaRenderAuto(dt: number): void {
        if (!this.statoServer) return;
        const alpha = Math.min(1, dt * 15);

        for (const id in this.statoServer) {
            const t = this.statoServer[id];
            const c = this.renderAuto[id] ?? { ...t };

            // Lerp posizione
            c.x += (t.x - c.x) * alpha;
            c.y += (t.y - c.y) * alpha;

            // Lerp angolo sul percorso piu' breve (evita giri da 360 gradi)
            let da = t.a - c.a;
            while (da >  Math.PI) da -= Math.PI * 2;
            while (da < -Math.PI) da += Math.PI * 2;
            c.a += da * alpha;

            // Campi gameplay: sempre autorevoli
            c.vx = t.vx; c.vy = t.vy;
            c.xPrecedente = t.xPrecedente; c.yPrecedente = t.yPrecedente;
            c.giri = t.giri; c.cp = t.cp; c.cpQual = t.cpQual;
            c.turboTimer = t.turboTimer; c.turboCooldown = t.turboCooldown;
            c.shockwaveCooldown = t.shockwaveCooldown; c.shockwaveTimer = t.shockwaveTimer;
            c.spinTimer = t.spinTimer;
            c.inScia = t.inScia; c.tempoScia = t.tempoScia; c.slingshotTimer = t.slingshotTimer;
            c.speedPadCooldown = t.speedPadCooldown; c.giroInvalido = t.giroInvalido;
            c.sulTraguardo = t.sulTraguardo;
            c.nome = t.nome; c.character = t.character;
            c.finito = t.finito; c.dnf = t.dnf; c.posizione = t.posizione;
            c.migliorGiro = t.migliorGiro; c.tempoGiroAttuale = t.tempoGiroAttuale;

            this.renderAuto[id] = c;
        }
    }

    /**
     * Anima la classifica facendo scorrere i riquadri verso la nuova posizione.
     * Quando cambia l'ordine, il box si muove invece di saltare di colpo.
     */
    private aggiornaClassificaAnimata(voci: [string, StatoAuto][], dt: number): RigaClassificaAnimata[] {
        const faseClassifica = this.fase === 'qualifiche' ? 'qualifiche' : 'gara';
        if (this.classificaAnimFase !== faseClassifica) {
            this.classificaAnimFase = faseClassifica;
            this.classificaAnim = {};
        }

        const rowH = 24;
        const pad = 8;
        const smoothing = Math.min(1, dt * 12);
        const present = new Set<string>();
        const animati: RigaClassificaAnimata[] = [];

        voci.forEach(([id, auto], index) => {
            const targetY = 10 + rowH * (index + 1) + pad;
            const bestGiroAttuale = auto.migliorGiro;
            let stato = this.classificaAnim[id];

            if (!stato) {
                stato = {
                    y: targetY,
                    targetY,
                    lastIndex: index,
                    lastBestGiro: bestGiroAttuale,
                    flash: 0,
                };
            }

            const delta = stato.lastIndex - index;
            const migliorato = faseClassifica === 'qualifiche'
                && bestGiroAttuale > 0
                && (stato.lastBestGiro < 0 || bestGiroAttuale < stato.lastBestGiro - 1);

            if (delta !== 0 || migliorato) stato.flash = 1;

            stato.targetY = targetY;
            stato.y += (stato.targetY - stato.y) * smoothing;
            stato.flash = Math.max(0, stato.flash - dt * 2.1);
            stato.lastIndex = index;
            stato.lastBestGiro = bestGiroAttuale;

            this.classificaAnim[id] = stato;
            present.add(id);
            animati.push({
                id,
                auto,
                index,
                y: stato.y,
                delta,
                flash: stato.flash,
                improved: migliorato,
            });
        });

        for (const id in this.classificaAnim) {
            if (!present.has(id)) delete this.classificaAnim[id];
        }

        return animati.sort((a, b) => a.y - b.y || a.index - b.index);
    }


    // --- Input locale, camera e avvisi guida --------------------------------

    private calcolaAngoloMouse(): number {
        const me = this.statoServer?.[this.myId];
        if (!me || !this.mouseSterzoAttivo || this.userInput.screenW <= 0 || this.userInput.screenH <= 0)
            return Number.NaN;

        const mouseWorldX = this.camX + (this.userInput.mouseX - this.userInput.screenW / 2) / this.ZOOM;
        const mouseWorldY = this.camY + (this.userInput.mouseY - this.userInput.screenH / 2) / this.ZOOM;
        const dx = mouseWorldX - me.x;
        const dy = mouseWorldY - me.y;

        if (Math.hypot(dx, dy) < 12) return me.a;
        return Math.atan2(dy, dx);
    }

    private deltaProgressoLungoGiro(x: number, y: number, px: number, py: number): number {
        const now = proiettaSuTracciato(x, y);
        const prev = proiettaSuTracciato(px, py);
        let delta = now - prev;
        const half = LUNGHEZZA_TRACCIATO / 2;
        if (delta > half) delta -= LUNGHEZZA_TRACCIATO;
        else if (delta < -half) delta += LUNGHEZZA_TRACCIATO;
        return delta;
    }

    private isContromano(me: StatoAuto): boolean {
        const dx = me.x - me.xPrecedente;
        const dy = me.y - me.yPrecedente;
        const dist = Math.hypot(dx, dy);
        if (dist < 3) return false;
        const delta = this.deltaProgressoLungoGiro(me.x, me.y, me.xPrecedente, me.yPrecedente);
        return delta < -4;
    }

    private aggiornaContromano(me: StatoAuto, dt: number): void {
        if (this.fase === 'recap') {
            this.wrongWayTimer = 0;
            return;
        }
        const contromano = this.isContromano(me);
        this.wrongWayTimer = contromano
            ? Math.min(1, this.wrongWayTimer + dt * 2)
            : Math.max(0, this.wrongWayTimer - dt * 1.4);
    }

    private disegnaAvvisoContromano(ctx: CanvasRenderingContext2D, W: number, H: number): void {
        if (this.wrongWayTimer <= 0) return;
        const alpha = Math.min(1, this.wrongWayTimer);
        const boxW = 300;
        const boxH = 34;
        const x = W / 2 - boxW / 2;
        const y = H - 110;
        ctx.fillStyle = `rgba(0,0,0,${0.55 * alpha})`;
        ctx.fillRect(x, y, boxW, boxH);
        ctx.textAlign = 'center';
        ctx.font = 'bold 18px Arial';
        ctx.fillStyle = `rgba(255,80,80,${alpha})`;
        ctx.fillText('CONTROMANO', W / 2, y + 23);
    }

    private disegnaAvvisoTreno(ctx: CanvasRenderingContext2D, W: number): void {
        const pulse = 0.55 + 0.45 * Math.sin(this.animTime * 10);
        const alpha = Math.min(1, pulse + this.warningTreno / TRENO_AVVISO);
        ctx.save();
        ctx.fillStyle = `rgba(0,0,0,${0.6 * alpha})`;
        ctx.fillRect(W / 2 - 190, 54, 380, 36);
        ctx.textAlign = 'center';
        ctx.font = 'bold 18px Arial';
        ctx.fillStyle = `rgba(255,90,70,${alpha})`;
        ctx.fillText('TRENO IN ARRIVO!', W / 2, 78);
        ctx.restore();
    }

    private disegnaVoto(ctx: CanvasRenderingContext2D, W: number, H: number): void {
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.72)';
        ctx.fillRect(0, 0, W, H);

        ctx.textAlign = 'center';
        ctx.font = 'bold 40px Arial';
        ctx.fillStyle = '#f1c40f';
        ctx.fillText('VOTA LA MODALITA', W / 2, 80);
        ctx.font = 'bold 18px Arial';
        ctx.fillStyle = '#fff';
        ctx.fillText(`Tempo rimasto: ${Math.max(0, Math.ceil(this.tempoVoto))}s`, W / 2, 115);

        const boxW = 320;
        const boxH = 90;
        const gap = 40;
        const startX = W / 2 - boxW - gap / 2;
        const y = H / 2 - boxH / 2;

        this.disegnaBoxVoto(ctx, startX, y, boxW, boxH, '1 - GARA STANDARD', this.votiStandard, this.votoSelezionato === 'standard');
        this.disegnaBoxVoto(ctx, startX + boxW + gap, y, boxW, boxH, '2 - SOPRAVVIVENZA', this.votiSopravvivenza, this.votoSelezionato === 'sopravvivenza');

        ctx.font = '12px Arial';
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillText('Premi 1 o 2 per votare', W / 2, y + boxH + 50);
        ctx.restore();
    }

    private disegnaBoxVoto(
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        w: number,
        h: number,
        label: string,
        count: number,
        selected: boolean,
    ): void {
        ctx.fillStyle = selected ? 'rgba(52,152,219,0.3)' : 'rgba(255,255,255,0.08)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = selected ? '#7ecfff' : 'rgba(255,255,255,0.2)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);

        ctx.textAlign = 'center';
        ctx.font = 'bold 16px Arial';
        ctx.fillStyle = '#fff';
        ctx.fillText(label, x + w / 2, y + 34);
        ctx.font = 'bold 26px Arial';
        ctx.fillStyle = selected ? '#7ecfff' : '#f1c40f';
        ctx.fillText(String(count), x + w / 2, y + 68);
    }


    // --- Rendering auto, scia e shockwave -----------------------------------

    private disegnaAuto(ctx: CanvasRenderingContext2D, id: string, auto: StatoAuto): void {
        const colore = this.colori[id] ?? '#fff';
        const sonoIo = id === this.myId;
        // hw = half-width, hh = half-height (nel sistema ruotato: hh negativo = muso)
        const hw = 5, hh = 10;

        if (auto.shockwaveTimer > 0) this.disegnaShockwave(ctx, auto);
        if (auto.slingshotTimer > 0) this.disegnaVentoSlingshot(ctx, auto, sonoIo);
        if (auto.inScia) this.disegnaSciaAuto(ctx, auto, sonoIo);

        ctx.save();

        // Ghosting in qualifica: le auto avversarie sono semi-trasparenti
        if (this.fase === 'qualifiche' && !sonoIo) ctx.globalAlpha = 0.45;

        ctx.translate(auto.x, auto.y);
        ctx.rotate(auto.a + Math.PI / 2);

        // --- OMBRA ---
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.beginPath();
        ctx.ellipse(1.5, 2, hw + 2, hh, 0, 0, Math.PI * 2);
        ctx.fill();

        // --- PNEUMATICI (4 rettangoli scuri che sbordano lateralmente) ---
        const tW = 3.5, tH = 4;
        ctx.fillStyle = '#111';
        ctx.beginPath(); ctx.roundRect(-hw - tW + 0.5, -hh + 2,      tW, tH, 1); ctx.fill(); // ant sx
        ctx.beginPath(); ctx.roundRect( hw - 0.5,       -hh + 2,      tW, tH, 1); ctx.fill(); // ant dx
        ctx.beginPath(); ctx.roundRect(-hw - tW + 0.5,  hh - 2 - tH, tW, tH, 1); ctx.fill(); // post sx
        ctx.beginPath(); ctx.roundRect( hw - 0.5,        hh - 2 - tH, tW, tH, 1); ctx.fill(); // post dx
        // cerchio ruota (cerchione)
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        for (const [tx, ty] of [
            [-hw - tW/2 + 0.5, -hh + 2 + tH/2],
            [ hw + tW/2 - 0.5, -hh + 2 + tH/2],
            [-hw - tW/2 + 0.5,  hh - 2 - tH/2],
            [ hw + tW/2 - 0.5,  hh - 2 - tH/2],
        ] as [number,number][]) {
            ctx.beginPath(); ctx.arc(tx, ty, 1.3, 0, Math.PI * 2); ctx.fill();
        }

        // --- ALA ANTERIORE (sottile barra larga, colorata al centro) ---
        ctx.fillStyle = auto.finito ? '#555' : '#111';
        ctx.beginPath(); ctx.roundRect(-hw - 5, -hh - 2, (hw + 5) * 2, 2.5, 1); ctx.fill();
        ctx.fillStyle = auto.finito ? '#777' : colore;
        ctx.fillRect(-3, -hh - 2, 6, 2.5);

        // --- CORPO PRINCIPALE a ogiva ---
        ctx.fillStyle = auto.finito ? '#888' : colore;
        ctx.beginPath();
        ctx.moveTo(0,       -hh);       // punta muso
        ctx.lineTo( hw*0.55, -hh + 3.5); // spalla ant dx
        ctx.lineTo( hw,      -hh + 6);   // fianco ant dx
        ctx.lineTo( hw,       hh - 5);   // fianco post dx
        ctx.lineTo( hw*0.75,  hh);       // coda dx
        ctx.lineTo(-hw*0.75,  hh);       // coda sx
        ctx.lineTo(-hw,       hh - 5);   // fianco post sx
        ctx.lineTo(-hw,      -hh + 6);   // fianco ant sx
        ctx.lineTo(-hw*0.55, -hh + 3.5); // spalla ant sx
        ctx.closePath();
        ctx.fill();

        // bordo corpo
        ctx.strokeStyle = sonoIo ? '#fff' : 'rgba(0,0,0,0.45)';
        ctx.lineWidth   = sonoIo ? 1.2 : 0.7;
        ctx.stroke();

        // --- STRISCIA CENTRALE (livrea) ---
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.beginPath();
        ctx.moveTo(0, -hh + 1);
        ctx.lineTo(1.5, -hh + 6);
        ctx.lineTo(1.5, hh - 2);
        ctx.lineTo(-1.5, hh - 2);
        ctx.lineTo(-1.5, -hh + 6);
        ctx.closePath();
        ctx.fill();

        // --- SIDEPODS (riflesso chiaro sui fianchi) ---
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.beginPath(); ctx.ellipse(-hw * 0.72, 1, 1.5, 4.5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse( hw * 0.72, 1, 1.5, 4.5, 0, 0, Math.PI * 2); ctx.fill();

        // --- COCKPIT / HALO (zona scura) ---
        ctx.fillStyle = 'rgba(0,0,0,0.60)';
        ctx.beginPath(); ctx.ellipse(0, -1.5, 2.8, 4.5, 0, 0, Math.PI * 2); ctx.fill();

        // --- CASCO PILOTA ---
        ctx.fillStyle = sonoIo ? '#f1c40f' : '#ddd';
        ctx.beginPath(); ctx.arc(0, -2, 1.9, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(120,200,255,0.55)';
        ctx.beginPath(); ctx.ellipse(0, -3.2, 1.3, 0.8, 0, 0, Math.PI * 2); ctx.fill(); // visiera

        // --- ALA POSTERIORE ---
        ctx.fillStyle = auto.finito ? '#555' : '#111';
        ctx.beginPath(); ctx.roundRect(-hw - 3.5, hh + 1, (hw + 3.5) * 2, 2.5, 1); ctx.fill();
        ctx.fillStyle = auto.finito ? '#777' : colore;
        ctx.fillRect(-2.5, hh + 1, 5, 2.5);

        // --- FIAMMA TURBO con flickering ---
        if (auto.turboTimer > 0) {
            const len = 5 + Math.sin(this.animTime * 25) * 2;
            ctx.fillStyle = '#ff7700'; ctx.shadowColor = '#ffaa00'; ctx.shadowBlur = 6;
            ctx.beginPath();
            ctx.moveTo(-2.5, hh + 4); ctx.lineTo(0, hh + 4 + len); ctx.lineTo(2.5, hh + 4);
            ctx.closePath(); ctx.fill(); ctx.shadowBlur = 0;
        }

        // --- CERCHIO SPIN-OUT ---
        if (auto.spinTimer > 0) {
            ctx.strokeStyle = '#ffff00'; ctx.lineWidth = 1.2; ctx.setLineDash([3, 3]);
            ctx.beginPath(); ctx.arc(0, 0, hh * 1.1, 0, Math.PI * 2); ctx.stroke();
            ctx.setLineDash([]);
        }

        ctx.restore();

        // Nome sopra l'auto (sempre orizzontale, fuori dalla rotazione)
        ctx.save();
        ctx.font = `bold ${sonoIo ? 8 : 7}px Arial`; ctx.textAlign = 'center';
        if (this.fase === 'qualifiche' && !sonoIo) ctx.globalAlpha = 0.45;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(auto.x - 18, auto.y - hh - 12, 36, 10);
        ctx.fillStyle = sonoIo ? '#ffff88' : '#fff';
        ctx.fillText(auto.nome.substring(0, 8), auto.x, auto.y - hh - 4);
        ctx.restore();
    }

    private disegnaSciaAuto(ctx: CanvasRenderingContext2D, auto: StatoAuto, intensa: boolean): void {
        ctx.save();
        ctx.translate(auto.x, auto.y);
        ctx.rotate(auto.a);

        const pulse = 0.5 + 0.5 * Math.sin(this.animTime * 18);
        const lunghezza = intensa ? 64 : 48;
        const alpha = intensa ? 0.22 + pulse * 0.08 : 0.14 + pulse * 0.05;
        const grad = ctx.createLinearGradient(-lunghezza, 0, -8, 0);
        grad.addColorStop(0, 'rgba(80,190,255,0)');
        grad.addColorStop(0.45, `rgba(80,190,255,${alpha})`);
        grad.addColorStop(1, 'rgba(220,255,255,0.06)');

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(-10, -7);
        ctx.lineTo(-lunghezza, -18 - pulse * 3);
        ctx.lineTo(-lunghezza * 0.82, 0);
        ctx.lineTo(-lunghezza, 18 + pulse * 3);
        ctx.lineTo(-10, 7);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = `rgba(180,235,255,${alpha * 0.8})`;
        ctx.lineWidth = 1;
        for (let i = 0; i < 3; i++) {
            const offset = (i - 1) * 6;
            ctx.beginPath();
            ctx.moveTo(-14, offset);
            ctx.lineTo(-lunghezza + i * 7, offset * 2.1);
            ctx.stroke();
        }

        ctx.restore();
    }

    private disegnaShockwave(ctx: CanvasRenderingContext2D, auto: StatoAuto): void {
        const progress = 1 - auto.shockwaveTimer / SHOCKWAVE_DURATA;
        const r = SHOCKWAVE_RAGGIO * Math.min(1, Math.max(0, progress));
        const alpha = 0.28 * (1 - Math.min(1, progress));

        ctx.save();
        ctx.strokeStyle = `rgba(120,200,255,${alpha})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(auto.x, auto.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    private disegnaVentoSlingshot(ctx: CanvasRenderingContext2D, auto: StatoAuto, intensa: boolean): void {
        ctx.save();
        ctx.translate(auto.x, auto.y);
        ctx.rotate(auto.a);

        const pulse = 0.5 + 0.5 * Math.sin(this.animTime * 22);
        const baseAlpha = intensa ? 0.55 : 0.38;
        const life = Math.min(1, auto.slingshotTimer / SLINGSHOT_DURATA);
        ctx.strokeStyle = `rgba(255,255,255,${baseAlpha * (0.6 + pulse * 0.4) * life})`;
        ctx.lineWidth = 1.4;

        for (let i = 0; i < 4; i++) {
            const offset = (i - 1.5) * 4;
            const len = 18 + i * 4 + pulse * 6;
            ctx.beginPath();
            ctx.moveTo(-10, offset);
            ctx.lineTo(-10 - len, offset + (i % 2 === 0 ? 2 : -2));
            ctx.stroke();
        }

        ctx.restore();
    }

    // --- HUD, minimappa e controlli visuali ---------------------------------

    private disegnaHUD(ctx: CanvasRenderingContext2D, me: StatoAuto | undefined, W: number, H: number): void {
        if (!me) return;
        const p = 14;

        const pannelloH = this.fase === 'qualifiche' ? 195 : 130;
        ctx.fillStyle = 'rgba(0,0,0,0.58)';
        ctx.fillRect(p - 3, p - 3, 242, pannelloH);

        if (this.fase === 'qualifiche') {
            // Timer qualifiche
            ctx.font = 'bold 14px Arial'; ctx.textAlign = 'left'; ctx.fillStyle = '#f1c40f';
            ctx.fillText('QUALIFICHE', p, p + 16);

            const min = Math.floor(this.tempoQual / 60);
            const sec = Math.ceil(this.tempoQual % 60);
            ctx.font = 'bold 36px Arial';
            ctx.fillStyle = this.tempoQual < 30 ? '#e74c3c' : '#fff';
            ctx.fillText(`${min}:${String(sec).padStart(2, '0')}`, p, p + 56);

            this.disegnaFeedbackGiroInvalido(ctx, me, p, p + 62);

            ctx.fillStyle = 'rgba(255,255,255,0.12)';
            ctx.fillRect(p, p + 78, 225, 1);

            // Tre righe tempi
            this.disegnaRigaTempo(ctx, p, p + 96,  'Giro corrente', formatTempo(me.tempoGiroAttuale), '#fff');
            this.disegnaRigaTempo(ctx, p, p + 116, 'Mio miglior giro', formatTempo(me.migliorGiro), '#7fff7f');
            this.disegnaRigaTempo(ctx, p, p + 136, 'Miglior assoluto', formatTempo(this.migliorAssoluto), '#f1c40f');

        } else {
            // Gara: contatore giri
            ctx.font = 'bold 26px Arial'; ctx.textAlign = 'left'; ctx.fillStyle = '#fff';
            ctx.fillText(`Giro ${Math.min(me.giri + 1, GIRI_GARA)} / ${GIRI_GARA}`, p, p + 30);

            // Timer DNF in cima allo schermo
            if (this.dnfTimer >= 0 && this.countdownPartenza <= 0) {
                const sec = Math.ceil(this.dnfTimer);
                ctx.fillStyle = 'rgba(0,0,0,0.65)';
                ctx.fillRect(W / 2 - 105, 10, 210, 34);
                ctx.textAlign = 'center'; ctx.font = 'bold 15px Arial';
                ctx.fillStyle = sec <= 10 ? '#ff6b6b' : '#f1c40f';
                ctx.fillText(`Gara termina tra ${sec}s`, W / 2, 32);
            }

            // Indicatore scia
            if (me.inScia) {
                ctx.fillStyle = 'rgba(0,150,255,0.18)';
                ctx.fillRect(p - 3, p + 42, 130, 22);
                ctx.font = 'bold 13px Arial'; ctx.textAlign = 'left'; ctx.fillStyle = '#7ecfff';
                ctx.fillText('SCIA ATTIVA', p + 4, p + 57);
            }
        }

        // Barre turbo e shockwave
        const turboY = this.fase === 'qualifiche' ? p + 152 : p + 52;
        const turboPct = me.turboTimer > 0
            ? me.turboTimer / TURBO_DURATA
            : Math.max(0, 1 - me.turboCooldown / TURBO_RICARICA);
        this.disegnaBarra(ctx, p, turboY, 185, 12, turboPct,
            me.turboTimer > 0 ? '#ff6a00' : turboPct >= 1 ? '#00aaff' : '#004488', 'TURBO [SPAZIO]');

        const shockPct = Math.max(0, 1 - me.shockwaveCooldown / SHOCKWAVE_RICARICA);
        this.disegnaBarra(ctx, p, turboY + 28, 185, 12, shockPct, '#222', 'SHOCKWAVE [SHIFT]', true);

        // Velocita' (in basso a destra)
        const vel = Math.round(Math.hypot(me.vx, me.vy));
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(W - 118, H - 44, 110, 36);
        ctx.font = 'bold 22px Arial'; ctx.textAlign = 'right'; ctx.fillStyle = '#fff';
        ctx.fillText(`${vel} m/s`, W - 10, H - 14);

        this.disegnaMiniMappa(ctx, me, W, H);
    }

    private disegnaFeedbackGiroInvalido(
        ctx: CanvasRenderingContext2D,
        me: StatoAuto,
        x: number,
        y: number,
    ): void {
        if (!me.giroInvalido) return;

        const pulse = 0.65 + 0.35 * Math.sin(this.animTime * 10);
        ctx.save();
        ctx.fillStyle = `rgba(231,76,60,${0.22 + pulse * 0.12})`;
        ctx.fillRect(x, y, 220, 20);
        ctx.strokeStyle = `rgba(255,145,130,${0.5 + pulse * 0.35})`;
        ctx.strokeRect(x + 0.5, y + 0.5, 219, 19);
        ctx.font = 'bold 11px Arial';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#ffd6d0';
        ctx.fillText('GIRO INVALIDO - fuori pista', x + 8, y + 14);
        ctx.restore();
    }

    private disegnaMiniMappa(ctx: CanvasRenderingContext2D, me: StatoAuto, W: number, H: number): void {
        const size = 150;
        const pad = 12;
        const x = W - size - pad;
        const y = H - size - pad - 52;

        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(x - 3, y - 3, size + 6, size + 6);
        ctx.fillStyle = 'rgba(20,20,20,0.85)';
        ctx.fillRect(x, y, size, size);

        // Tracciato
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        for (let i = 0; i <= WAYPOINTS.length; i++) {
            const p = WAYPOINTS[i % WAYPOINTS.length];
            const mx = x + (p.x / MONDO_W) * size;
            const my = y + (p.y / MONDO_H) * size;
            if (i === 0) ctx.moveTo(mx, my); else ctx.lineTo(mx, my);
        }
        ctx.stroke();

        // Auto giocatore
        const px = x + (me.x / MONDO_W) * size;
        const py = y + (me.y / MONDO_H) * size;
        ctx.translate(px, py);
        ctx.rotate(me.a);
        ctx.fillStyle = '#f1c40f';
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(7, 0);
        ctx.lineTo(-5, -4);
        ctx.lineTo(-3, 0);
        ctx.lineTo(-5, 4);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.restore();
    }

    /** Riga etichetta + valore allineati a sinistra/destra nel pannello HUD */
    private disegnaRigaTempo(ctx: CanvasRenderingContext2D,
        x: number, y: number, etichetta: string, valore: string, coloreValore: string): void {
        ctx.font = '11px Arial'; ctx.textAlign = 'left'; ctx.fillStyle = '#aaa';
        ctx.fillText(etichetta, x, y);
        ctx.font = 'bold 13px Arial'; ctx.textAlign = 'right'; ctx.fillStyle = coloreValore;
        ctx.fillText(valore, x + 232, y);
    }

    private disegnaBarra(ctx: CanvasRenderingContext2D,
        x: number, y: number, w: number, h: number,
        pct: number, colore: string, etichetta: string, iridescente = false): void {
        ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
        ctx.fillStyle = colore; ctx.fillRect(x, y, w * pct, h);
        if (iridescente && pct > 0) {
            const g = ctx.createLinearGradient(x, y, x + w * pct, y);
            g.addColorStop(0, 'rgba(140,0,255,0.6)'); g.addColorStop(1, 'rgba(0,255,200,0.6)');
            ctx.fillStyle = g; ctx.fillRect(x, y, w * pct, h);
        }
        ctx.font = 'bold 10px Arial'; ctx.textAlign = 'left'; ctx.fillStyle = '#bbb';
        ctx.fillText(etichetta, x, y + h + 11);
    }


    /**
     * Disegna 4 luci rosse che si accendono una per secondo,
     * poi tutte si spengono e compare "GO!" in verde.
     *
     * La logica di scaglionamento usa DURATA_PARTENZA=4 secondi:
     *   - elapsed 0->1s: 1 luce accesa
     *   - elapsed 1->2s: 2 luci accese
     *   - elapsed 2->3s: 3 luci accese
     *   - elapsed 3->4s: 4 luci accese
     *   - countdown = 0: tutte spente + "GO!" per goFlashTimer secondi
     */
    private disegnaSemaforo(ctx: CanvasRenderingContext2D, W: number): void {
        const inPreStart  = this.fase === 'gara' && this.countdownPartenza > 0;
        const inGoFlash   = this.fase === 'gara' && this.countdownPartenza <= 0 && this.goFlashTimer > 0;
        if (!inPreStart && !inGoFlash) return;

        ctx.fillStyle = 'rgba(0,0,0,0.60)';
        ctx.fillRect(W / 2 - 150, 10, 300, 88);

        // Calcola quante luci sono accese in base al tempo trascorso
        const elapsed  = DURATA_PARTENZA - this.countdownPartenza;
        const nAccese  = inPreStart ? Math.max(0, Math.min(4, Math.ceil(elapsed))) : 0;

        for (let i = 0; i < 4; i++) {
            const x = W / 2 - 90 + i * 60;
            const y = 52;
            const accesa = inPreStart && i < nAccese;

            // Bagliore rosso sulle luci accese
            if (accesa) {
                ctx.shadowColor = '#ff3b30'; ctx.shadowBlur = 18;
            }
            ctx.beginPath();
            ctx.arc(x, y, 20, 0, Math.PI * 2);
            ctx.fillStyle = accesa ? '#ff3b30' : '#3a1515';
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 2;
            ctx.stroke();
            ctx.shadowBlur = 0;
        }

        ctx.textAlign = 'center';
        if (inPreStart) {
            // Numero di secondi rimasti
            ctx.font = 'bold 16px Arial'; ctx.fillStyle = '#fff';
            ctx.fillText(String(Math.ceil(this.countdownPartenza)), W / 2, 86);
        } else {
            // GO! in verde, con fade-out
            ctx.font = 'bold 28px Arial';
            ctx.fillStyle = `rgba(100,255,100,${this.goFlashTimer / 0.9})`;
            ctx.fillText('GO!', W / 2, 74);
        }
    }


    // --- Classifica, recap e finale -----------------------------------------

    private disegnaClassifica(ctx: CanvasRenderingContext2D, W: number, dt: number): void {
        if (!this.statoServer) return;

        const voci = this.vociClassifica();
        const layout = { lbW: 228, rowH: 24, pad: 8, lbX: W - 228 - 10 };
        this.disegnaSfondoClassifica(ctx, layout, voci.length);

        const tempoLeader = calcolaMigliorAssoluto(this.statoServer);
        for (const riga of this.aggiornaClassificaAnimata(voci, dt)) {
            this.disegnaRigaClassifica(ctx, riga, layout, tempoLeader);
        }
    }

    private vociClassifica(): [string, StatoAuto][] {
        if (!this.statoServer) return [];
        const voci = Object.entries(this.statoServer);

        if (this.fase === 'qualifiche') {
            return voci.sort((a, b) => confrontaQualifica(a[1], b[1]));
        }

        // In gara: prima gli arrivati, poi chi e' ancora in pista ordinato per progresso.
        const finiti = voci
            .filter(([, auto]) => auto.finito)
            .sort((a, b) => {
                if (a[1].dnf !== b[1].dnf) return a[1].dnf ? 1 : -1;
                return a[1].posizione - b[1].posizione;
            });
        const inGara = voci
            .filter(([, auto]) => !auto.finito)
            .sort((a, b) => confrontaAutoInGara(a[1], b[1]));

        return [...finiti, ...inGara];
    }

    private disegnaSfondoClassifica(
        ctx: CanvasRenderingContext2D,
        layout: LayoutClassifica,
        numeroRighe: number,
    ): void {
        const { lbX, lbW, rowH, pad } = layout;
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fillRect(lbX, 10, lbW, rowH * (numeroRighe + 1) + pad);
        ctx.font = 'bold 12px Arial';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#f1c40f';
        ctx.fillText(this.fase === 'qualifiche' ? 'TEMPI QUALIFICHE' : 'CLASSIFICA GARA', lbX + pad, 26);
    }

    private disegnaRigaClassifica(
        ctx: CanvasRenderingContext2D,
        riga: RigaClassificaAnimata,
        layout: LayoutClassifica,
        tempoLeader: number,
    ): void {
        const { lbX, lbW, rowH, pad } = layout;
        const { id, auto, index, y, delta, flash, improved } = riga;
        const sonoIo = id === this.myId;
        const migliorato = this.fase === 'qualifiche' && improved;
        const accent = this.coloreAccentoClassifica(delta, migliorato);
        const rowY = y - 11;

        ctx.fillStyle = sonoIo
            ? 'rgba(52,152,219,0.28)'
            : index % 2 === 0 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.1)';
        ctx.fillRect(lbX, rowY, lbW, rowH - 2);

        this.disegnaFlashClassifica(ctx, lbX, rowY, lbW, rowH, delta, flash);

        ctx.fillStyle = this.colori[id] ?? '#fff';
        ctx.fillRect(lbX + pad, rowY, 9, 12);

        ctx.font = sonoIo ? 'bold 11px Arial' : '11px Arial';
        ctx.fillStyle = sonoIo ? '#ffff88' : '#fff';
        ctx.textAlign = 'left';
        ctx.fillText((index + 1) + '. ' + auto.nome.substring(0, 9), lbX + pad + 13, y);

        this.disegnaValoreClassifica(ctx, auto, lbX + lbW - pad, y, tempoLeader, accent, migliorato);
        this.disegnaDeltaClassifica(ctx, lbX + lbW - 44, y, delta, accent, migliorato);
    }

    private coloreAccentoClassifica(delta: number, migliorato: boolean): string {
        if (this.fase === 'qualifiche') return migliorato ? '#7fff7f' : '#f1c40f';
        return delta > 0 ? '#7fff7f' : delta < 0 ? '#ff9b9b' : '#f1c40f';
    }

    private disegnaFlashClassifica(
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        w: number,
        rowH: number,
        delta: number,
        flash: number,
    ): void {
        if (flash > 0) {
            ctx.fillStyle = this.fase === 'qualifiche'
                ? 'rgba(127,255,127,' + (0.25 * flash) + ')'
                : delta > 0
                    ? 'rgba(127,255,127,' + (0.22 * flash) + ')'
                    : 'rgba(255,107,107,' + (0.18 * flash) + ')';
            ctx.fillRect(x, y, w, rowH - 2);
        }

        if (this.fase === 'qualifiche' && delta !== 0) {
            ctx.fillStyle = delta > 0 ? 'rgba(127,255,127,0.12)' : 'rgba(255,107,107,0.12)';
            ctx.fillRect(x, y, w, rowH - 2);
        }
    }

    private disegnaValoreClassifica(
        ctx: CanvasRenderingContext2D,
        auto: StatoAuto,
        x: number,
        y: number,
        tempoLeader: number,
        accent: string,
        migliorato: boolean,
    ): void {
        ctx.textAlign = 'right';
        ctx.font = '10px Arial';

        if (this.fase === 'qualifiche') {
            if (migliorato && auto.migliorGiro > 0) {
                ctx.fillStyle = accent;
                ctx.fillText(formatTempo(auto.migliorGiro), x, y);
            } else if (auto.migliorGiro > 0 && tempoLeader > 0) {
                ctx.fillStyle = '#ccc';
                ctx.fillText('+' + (auto.migliorGiro - tempoLeader) + ' ms', x, y);
            } else {
                ctx.fillStyle = '#555';
                ctx.fillText('--', x, y);
            }
            return;
        }

        if (auto.dnf) {
            ctx.fillStyle = '#ff9b9b';
            ctx.fillText('DNF', x, y);
        } else if (auto.finito) {
            ctx.fillStyle = '#bbb';
            ctx.fillText('OK ARR.', x, y);
        } else {
            ctx.fillStyle = accent;
            ctx.fillText('G' + (auto.giri + 1), x, y);
        }
    }

    private disegnaDeltaClassifica(
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        delta: number,
        accent: string,
        migliorato: boolean,
    ): void {
        if (this.fase === 'gara' && delta !== 0) {
            ctx.textAlign = 'center';
            ctx.font = 'bold 10px Arial';
            ctx.fillStyle = accent;
            ctx.fillText((delta > 0 ? '+' : '-') + Math.abs(delta), x, y);
        }

        if (migliorato) {
            ctx.textAlign = 'center';
            ctx.font = 'bold 9px Arial';
            ctx.fillStyle = '#7fff7f';
            ctx.fillText('PB', x, y - 10);
        }
    }


    /**
     * Schermata tra qualifiche e gara.
     * Mostra la griglia di partenza DALL'ULTIMO AL PRIMO
     * l'ultimo qualificato e' in cima, la pole e' in fondo evidenziata in oro.
     */
    private disegnaRecap(ctx: CanvasRenderingContext2D, W: number, H: number): void {
        if (!this.statoServer) return;

        ctx.fillStyle = 'rgba(0,0,0,0.85)'; ctx.fillRect(0, 0, W, H);

        ctx.textAlign = 'center';
        ctx.font = 'bold 38px Arial'; ctx.fillStyle = '#f1c40f';
        ctx.fillText('GRIGLIA DI PARTENZA', W / 2, 52);
        ctx.font = '17px Arial'; ctx.fillStyle = '#aaa';
        ctx.fillText('La gara inizia tra...', W / 2, 80);

        const cd = Math.ceil(this.tempoRecap);
        ctx.font = 'bold 50px Arial'; ctx.fillStyle = '#fff';
        ctx.fillText(String(cd), W / 2, 140);

        const progresso = 1 - this.tempoRecap / DURATA_RECAP;
        const barW = 260, barX = W / 2 - barW / 2;
        ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(barX, 150, barW, 7);
        ctx.fillStyle = '#f1c40f'; ctx.fillRect(barX, 150, barW * progresso, 7);

        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(W / 2 - 190, 168, 380, 1);

        const gridRev     = [...this.gridOrder].reverse();
        const tempoLeader = this.gridOrder.length > 0
            ? (this.statoServer[this.gridOrder[0]]?.migliorGiro ?? -1)
            : -1;

        const rigaH = 44, startY = 178, listaW = 440;
        const listaX = W / 2 - listaW / 2;

        gridRev.forEach((id, idx) => {
            const auto = this.statoServer![id];
            if (!auto) return;

            const posGrig = this.gridOrder.length - idx; // 1 = pole (in fondo alla lista invertita)
            const isPole  = posGrig === 1;
            const sonoIo  = id === this.myId;
            const ry      = startY + idx * rigaH;

            // Sfondo riga
            ctx.fillStyle = isPole
                ? 'rgba(200,155,30,0.35)'
                : sonoIo
                    ? 'rgba(52,152,219,0.28)'
                    : idx % 2 === 0 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.1)';
            ctx.fillRect(listaX, ry, listaW, rigaH - 2);

            // Posizione griglia (grande, a sinistra)
            ctx.font = `bold ${isPole ? 26 : 22}px Arial`; ctx.textAlign = 'left';
            ctx.fillStyle = isPole ? '#f1c40f' : sonoIo ? '#7ecfff' : '#888';
            ctx.fillText(`P${posGrig}`, listaX + 10, ry + rigaH * 0.68);

            // Pastiglia colore auto
            ctx.fillStyle = this.colori[id] ?? '#fff';
            ctx.fillRect(listaX + 58, ry + 12, 10, rigaH - 26);

            // Nome pilota
            ctx.font = sonoIo ? 'bold 15px Arial' : '14px Arial';
            ctx.fillStyle = sonoIo ? '#ffff88' : '#fff';
            ctx.fillText(auto.nome.substring(0, 14), listaX + 76, ry + rigaH * 0.66);

            // Etichetta pole
            if (isPole) {
                ctx.font = '11px Arial'; ctx.fillStyle = '#f1c40f';
                ctx.fillText('POLE', listaX + 76, ry + rigaH * 0.66 - 16);
            }

            // Tempo qualifiche (a destra)
            ctx.textAlign = 'right'; ctx.font = isPole ? 'bold 13px Arial' : '12px Arial';
            if (isPole && auto.migliorGiro > 0) {
                ctx.fillStyle = '#7fff7f';
                ctx.fillText(formatTempo(auto.migliorGiro), listaX + listaW - 10, ry + rigaH * 0.66);
            } else if (auto.migliorGiro > 0 && tempoLeader > 0) {
                ctx.fillStyle = '#ccc';
                ctx.fillText(`+${auto.migliorGiro - tempoLeader} ms`, listaX + listaW - 10, ry + rigaH * 0.66);
            } else {
                ctx.fillStyle = '#555';
                ctx.fillText('senza tempo', listaX + listaW - 10, ry + rigaH * 0.66);
            }
        });

        ctx.textAlign = 'center'; ctx.font = '12px Arial'; ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillText('Le macchine vengono riposizionate automaticamente', W / 2, startY + rigaH * gridRev.length + 20);
    }


    private disegnaFinale(ctx: CanvasRenderingContext2D, me: StatoAuto | undefined, W: number, H: number): void {
        if (this.garaFinitaTimer > DURATA_PODIO) {
            this.disegnaAvvisoPodio(ctx, me, W, H);
        } else {
            this.disegnaPodio(ctx, W, H);
        }
    }

    private disegnaAvvisoPodio(ctx: CanvasRenderingContext2D, me: StatoAuto | undefined, W: number, H: number): void {
        const secondi = Math.max(1, Math.ceil(this.garaFinitaTimer - DURATA_PODIO));

        ctx.fillStyle = 'rgba(0,0,0,0.78)';
        ctx.fillRect(0, 0, W, H);
        ctx.textAlign = 'center';
        ctx.font = 'bold 54px Arial';
        ctx.fillStyle = '#f1c40f';
        ctx.fillText('GARA FINITA!', W / 2, H / 2 - 105);

        if (me?.finito) {
            ctx.font = 'bold 26px Arial';
            ctx.fillStyle = '#fff';
            ctx.fillText(me.dnf ? 'DNF - non hai completato la gara in tempo' : `Hai concluso P${me.posizione}!`, W / 2, H / 2 - 55);
        }

        ctx.font = 'bold 30px Arial';
        ctx.fillStyle = '#fff';
        ctx.fillText('Il podio sta per iniziare', W / 2, H / 2 + 25);
        ctx.font = 'bold 72px Arial';
        ctx.fillStyle = '#7ecfff';
        ctx.fillText(String(secondi), W / 2, H / 2 + 110);
    }

    private disegnaPodio(ctx: CanvasRenderingContext2D, W: number, H: number): void {
        const topTre = this.topTreFinale();
        const tempoRimasto = Math.max(0, Math.ceil(this.garaFinitaTimer));

        ctx.save();
        this.disegnaSfondoPodio(ctx, W, H);
        this.disegnaBannerScacchiPodio(ctx, W);
        this.disegnaTitoloPodio(ctx, W, tempoRimasto);
        this.disegnaGradiniPodio(ctx, W, H, topTre);
        ctx.restore();
    }

    private disegnaSfondoPodio(ctx: CanvasRenderingContext2D, W: number, H: number): void {
        const bg = ctx.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, '#17181d');
        bg.addColorStop(0.55, '#0d0f12');
        bg.addColorStop(1, '#050506');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);

        this.disegnaGlowPodio(ctx, W, H, W * 0.18, H * 0.16, Math.max(W, H) * 0.7, 'rgba(255, 71, 58, 0.22)', 'rgba(255, 71, 58, 0.08)');
        this.disegnaGlowPodio(ctx, W, H, W * 0.82, H * 0.18, Math.max(W, H) * 0.65, 'rgba(241, 196, 15, 0.18)', 'rgba(241, 196, 15, 0.05)');
        this.disegnaPavimentoPodio(ctx, W, H);
    }

    private disegnaGlowPodio(
        ctx: CanvasRenderingContext2D,
        W: number,
        H: number,
        x: number,
        y: number,
        r: number,
        centro: string,
        meta: string,
    ): void {
        const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
        glow.addColorStop(0, centro);
        glow.addColorStop(0.55, meta);
        glow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, W, H);
    }

    private disegnaPavimentoPodio(ctx: CanvasRenderingContext2D, W: number, H: number): void {
        const floorTop = H - 132;
        const floorGrad = ctx.createLinearGradient(0, floorTop, 0, H);
        floorGrad.addColorStop(0, 'rgba(255,255,255,0.04)');
        floorGrad.addColorStop(1, 'rgba(0,0,0,0.32)');
        ctx.fillStyle = floorGrad;
        ctx.fillRect(0, floorTop, W, 132);

        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 2;
        for (let x = -40; x < W + 60; x += 120) {
            ctx.beginPath();
            ctx.moveTo(x, floorTop + 22);
            ctx.lineTo(x + 44, H);
            ctx.stroke();
        }
    }

    private disegnaBannerScacchiPodio(ctx: CanvasRenderingContext2D, W: number): void {
        const bannerY = 18;
        const bannerH = 30;
        const bannerW = Math.min(W * 0.64, 440);
        const bannerX = W / 2 - bannerW / 2;
        const cellsX = 18;
        const cellW = bannerW / cellsX;
        const cellH = bannerH / 2;

        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(bannerX - 4, bannerY - 4, bannerW + 8, bannerH + 8);
        for (let row = 0; row < 2; row++) {
            for (let col = 0; col < cellsX; col++) {
                ctx.fillStyle = (row + col) % 2 === 0 ? '#f5f5f5' : '#101010';
                ctx.fillRect(bannerX + col * cellW, bannerY + row * cellH, cellW + 0.2, cellH + 0.2);
            }
        }
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(bannerX, bannerY, bannerW, 2);
        ctx.fillStyle = 'rgba(255,64,64,0.78)';
        ctx.fillRect(bannerX, bannerY + bannerH - 3, bannerW, 3);
    }

    private disegnaTitoloPodio(ctx: CanvasRenderingContext2D, W: number, tempoRimasto: number): void {
        ctx.textAlign = 'center';
        ctx.font = 'bold 46px Arial';
        ctx.fillStyle = '#f4f1e6';
        ctx.fillText('PODIO', W / 2, 80);
        ctx.font = 'bold 16px Arial';
        ctx.fillStyle = '#ffcf5a';
        ctx.fillText('Ritorno alla lobby in ' + tempoRimasto + 's', W / 2, 106);
    }

    private disegnaGradiniPodio(ctx: CanvasRenderingContext2D, W: number, H: number, topTre: StatoAuto[]): void {
        const baseY = H - 70;
        const stepW = Math.min(190, W * 0.25);
        const gap = Math.min(22, W * 0.03);
        const centerX = W / 2;
        const layout: SlotPodio[] = [
            { place: 2, x: centerX - stepW - gap, h: 150, color: '#c0c8d8' },
            { place: 1, x: centerX,               h: 220, color: '#f1c40f' },
            { place: 3, x: centerX + stepW + gap, h: 115, color: '#cd7f32' },
        ];

        for (const slot of layout) {
            const stepY = this.disegnaGradinoPodio(ctx, slot, stepW, baseY);
            const auto = topTre[slot.place - 1];
            if (auto) this.disegnaPilotaPodio(ctx, auto, slot, stepW, stepY);
        }
    }

    private disegnaGradinoPodio(ctx: CanvasRenderingContext2D, slot: SlotPodio, stepW: number, baseY: number): number {
        const stepX = slot.x - stepW / 2;
        const stepY = baseY - slot.h;
        const topH = 16;

        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(stepX + 10, stepY + 12, stepW, slot.h);

        const faceGrad = ctx.createLinearGradient(0, stepY, 0, stepY + slot.h);
        faceGrad.addColorStop(0, slot.place === 1 ? '#ffd95a' : slot.color);
        faceGrad.addColorStop(1, slot.place === 1 ? '#7a5f10' : '#4d5058');
        ctx.fillStyle = faceGrad;
        ctx.fillRect(stepX, stepY, stepW, slot.h);

        const topGrad = ctx.createLinearGradient(0, stepY, 0, stepY + topH);
        topGrad.addColorStop(0, '#2b2f37');
        topGrad.addColorStop(1, '#5e6572');
        ctx.fillStyle = topGrad;
        ctx.fillRect(stepX, stepY, stepW, topH);

        ctx.fillStyle = 'rgba(255,255,255,0.16)';
        ctx.fillRect(stepX, stepY, stepW, 4);
        ctx.fillStyle = 'rgba(0,0,0,0.2)';
        ctx.fillRect(stepX, stepY + slot.h - 5, stepW, 5);

        ctx.font = 'bold 54px Arial';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.fillText(String(slot.place), slot.x + 2, stepY + slot.h * 0.48 + 4);
        ctx.fillStyle = slot.place === 1 ? '#fff7b1' : '#eef1f7';
        ctx.fillText(String(slot.place), slot.x, stepY + slot.h * 0.48);

        return stepY;
    }

    private disegnaPilotaPodio(
        ctx: CanvasRenderingContext2D,
        auto: StatoAuto,
        slot: SlotPodio,
        stepW: number,
        stepY: number,
    ): void {
        const draw = getCharacterDrawFunction(auto.character);
        if (draw) draw(ctx, slot.x, stepY - 56, 48, 112);

        const nameW = Math.min(170, stepW + 12);
        const nameH = 24;
        const nameX = slot.x - nameW / 2;
        const nameY = stepY - 144;
        ctx.fillStyle = 'rgba(8,8,10,0.84)';
        ctx.fillRect(nameX, nameY, nameW, nameH);
        ctx.strokeStyle = slot.place === 1 ? '#f1c40f' : 'rgba(255,255,255,0.16)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(nameX, nameY, nameW, nameH);

        ctx.font = 'bold 15px Arial';
        ctx.fillStyle = '#fff';
        ctx.fillText(auto.nome.substring(0, 16), slot.x, nameY + 17);

        ctx.font = 'bold 13px Arial';
        ctx.fillStyle = auto.dnf ? '#ff9b9b' : '#dce8ff';
        ctx.fillText(auto.dnf ? 'DNF' : 'P' + auto.posizione, slot.x, stepY + slot.h - 14);
    }

    private topTreFinale(): StatoAuto[] {
        if (!this.statoServer) return [];
        return Object.values(this.statoServer)
            .filter(a => a.finito)
            .sort((a, b) => {
                if (a.dnf !== b.dnf) return a.dnf ? 1 : -1;
                return a.posizione - b.posizione;
            })
            .slice(0, 3);
    }


    // --- Canvas statico del circuito ----------------------------------------

    private costruisciCanvas(): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.width = MONDO_W;
        canvas.height = MONDO_H;
        const ctx = canvas.getContext('2d')!;

        this.disegnaSfondoPrato(ctx);
        this.disegnaAsfalto(ctx);
        this.disegnaCordoliEsterni(ctx);
        this.disegnaLineaCentrale(ctx);
        this.disegnaCheckpointPista(ctx);
        this.disegnaTraguardo(ctx);
        this.disegnaTextureAsfalto(ctx);

        return canvas;
    }

    private disegnaSfondoPrato(ctx: CanvasRenderingContext2D): void {
        ctx.fillStyle = '#2d6a35';
        ctx.fillRect(0, 0, MONDO_W, MONDO_H);
        ctx.fillStyle = '#2a6130';
        for (let y = 0; y < MONDO_H; y += 60) ctx.fillRect(0, y, MONDO_W, 30);
    }

    private disegnaAsfalto(ctx: CanvasRenderingContext2D): void {
        ctx.strokeStyle = '#4a4a4a';
        ctx.lineWidth = LARGHEZZA_PISTA;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        this.tracciaPolilineaCircuito(ctx);
        ctx.stroke();
    }

    private disegnaLineaCentrale(ctx: CanvasRenderingContext2D): void {
        ctx.strokeStyle = 'rgba(255,255,255,0.20)';
        ctx.lineWidth = 2;
        ctx.setLineDash([18, 14]);
        this.tracciaPolilineaCircuito(ctx);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    private tracciaPolilineaCircuito(ctx: CanvasRenderingContext2D): void {
        ctx.beginPath();
        ctx.moveTo(WAYPOINTS[0].x, WAYPOINTS[0].y);
        for (let i = 1; i <= WAYPOINTS.length; i++) {
            const punto = WAYPOINTS[i % WAYPOINTS.length];
            ctx.lineTo(punto.x, punto.y);
        }
    }

    private disegnaCheckpointPista(ctx: CanvasRenderingContext2D): void {
        for (let i = 0; i < CHECKPOINTS.length; i++) {
            this.disegnaCheckpoint(ctx, i);
        }
    }

    private disegnaCheckpoint(ctx: CanvasRenderingContext2D, index: number): void {
        const cp = CHECKPOINTS[index];
        const wpIndex = CHECKPOINTS_WAYPOINT_INDEX[index];
        const prev = WAYPOINTS[(wpIndex - 1 + WAYPOINTS.length) % WAYPOINTS.length];
        const next = WAYPOINTS[(wpIndex + 1) % WAYPOINTS.length];
        const tx = next.x - prev.x;
        const ty = next.y - prev.y;
        const lineAngle = Math.atan2(ty, tx) + Math.PI / 2;

        ctx.save();
        ctx.translate(cp.x, cp.y);
        ctx.rotate(lineAngle);
        this.disegnaLineaCheckpoint(ctx);
        ctx.rotate(-lineAngle);
        this.disegnaNumeroCheckpoint(ctx, index + 1);
        ctx.restore();
    }

    private disegnaLineaCheckpoint(ctx: CanvasRenderingContext2D): void {
        const lineLen = LARGHEZZA_PISTA * 0.92;
        const dashCount = 9;
        const dashLen = lineLen / (dashCount * 2 - 1);

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        for (let d = 0; d < dashCount; d++) {
            const start = -lineLen / 2 + d * dashLen * 2;
            ctx.beginPath();
            ctx.moveTo(start, 0);
            ctx.lineTo(start + dashLen, 0);
            ctx.stroke();
        }
    }

    private disegnaNumeroCheckpoint(ctx: CanvasRenderingContext2D, numero: number): void {
        ctx.fillStyle = 'rgba(255,255,255,0.65)';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(numero), 0, -14);
    }

    private disegnaTraguardo(ctx: CanvasRenderingContext2D): void {
        const t = TRAGUARDO;
        const bandW = TRAGUARDO_LARGHEZZA;
        const bandH = TRAGUARDO_ALTEZZA;
        const cellsX = 18;
        const cellW = bandW / cellsX;
        const cellH = bandH / 2;

        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(t.x - bandW / 2 - 4, t.y - bandH / 2 - 4, bandW + 8, bandH + 8);

        for (let row = 0; row < 2; row++) {
            for (let col = 0; col < cellsX; col++) {
                ctx.fillStyle = (row + col) % 2 === 0 ? '#f5f5f5' : '#101010';
                ctx.fillRect(t.x - bandW / 2 + col * cellW, t.y - bandH / 2 + row * cellH, cellW + 0.2, cellH + 0.2);
            }
        }

        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(t.x - bandW / 2, t.y - bandH / 2 - 3, bandW, 2);
        ctx.fillStyle = 'rgba(255,64,64,0.8)';
        ctx.fillRect(t.x - bandW / 2, t.y + bandH / 2 + 1, bandW, 3);
    }

    private disegnaTextureAsfalto(ctx: CanvasRenderingContext2D): void {
        ctx.fillStyle = 'rgba(0,0,0,0.07)';
        for (let i = 0; i < 10000; i++) {
            const rx = Math.random() * MONDO_W;
            const ry = Math.random() * MONDO_H;
            if (sullaStrada(rx, ry)) ctx.fillRect(rx, ry, 2, 2);
        }
    }
    private disegnaCordoliEsterni(c: CanvasRenderingContext2D): void {
        const raggio = LARGHEZZA_PISTA / 2 + 7;
        const profondita = 12;
        const lunghezzaStriscia = 18;
        const angoloMinimo = 0.22;

        c.save();
        c.lineWidth = profondita;
        c.lineCap = 'butt';

        for (let i = 0; i < WAYPOINTS.length; i++) {
            const prev = WAYPOINTS[(i - 1 + WAYPOINTS.length) % WAYPOINTS.length];
            const curr = WAYPOINTS[i];
            const next = WAYPOINTS[(i + 1) % WAYPOINTS.length];
            const inDir = this.normalizzaPunto({ x: curr.x - prev.x, y: curr.y - prev.y });
            const outDir = this.normalizzaPunto({ x: next.x - curr.x, y: next.y - curr.y });
            const cambioDirezione = Math.hypot(outDir.x - inDir.x, outDir.y - inDir.y);
            if (cambioDirezione < angoloMinimo) continue;

            const latoEsterno = inDir.x * outDir.y - inDir.y * outDir.x >= 0 ? -1 : 1;
            const normaleIn = this.normaleLaterale(inDir, latoEsterno);
            const normaleOut = this.normaleLaterale(outDir, latoEsterno);
            const start = Math.atan2(normaleIn.y, normaleIn.x);
            const delta = this.deltaAngoloMinimo(start, Math.atan2(normaleOut.y, normaleOut.x));
            const lunghezzaArco = Math.abs(delta) * raggio;
            const strisce = Math.max(3, Math.ceil(lunghezzaArco / lunghezzaStriscia));

            for (let s = 0; s < strisce; s++) {
                const t0 = s / strisce;
                const t1 = (s + 1) / strisce;
                c.strokeStyle = s % 2 === 0 ? '#cc0000' : '#ffffff';
                c.beginPath();
                c.arc(
                    curr.x,
                    curr.y,
                    raggio,
                    start + delta * t0,
                    start + delta * t1,
                    delta < 0,
                );
                c.stroke();
            }
        }

        c.restore();
    }

    private normalizzaPunto(p: Punto): Punto {
        const len = Math.hypot(p.x, p.y);
        return len === 0 ? { x: 0, y: 0 } : { x: p.x / len, y: p.y / len };
    }

    private normaleLaterale(dir: Punto, lato: -1 | 1): Punto {
        return lato === 1
            ? { x: -dir.y, y: dir.x }
            : { x: dir.y, y: -dir.x };
    }

    private deltaAngoloMinimo(from: number, to: number): number {
        let delta = to - from;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        return delta;
    }


    // --- Registrazione input da tastiera/mouse ------------------------------

    private registraTasti(): void {
        const set = (e: KeyboardEvent, v: boolean) => {
            const isGameKey =
                e.code === 'KeyW' || e.code === 'ArrowUp' ||
                e.code === 'KeyS' || e.code === 'ArrowDown' ||
                e.code === 'Space' ||
                e.code === 'ShiftLeft' || e.code === 'ShiftRight' ||
                e.code === 'Digit1' || e.code === 'Digit2' ||
                e.code === 'Numpad1' || e.code === 'Numpad2';
            if (isGameKey) e.preventDefault();

            if (e.code === 'KeyW' || e.code === 'ArrowUp')         this.tasti.su    = v;
            if (e.code === 'KeyS' || e.code === 'ArrowDown')       this.tasti.giu   = v;
            if (e.code === 'Space') {
                if (v) {
                    if (!this.turboPremuto) this.tasti.turbo = true;
                    this.turboPremuto = true;
                    e.preventDefault();
                } else {
                    this.turboPremuto = false;
                }
            }
            if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
                if (v) {
                    if (!this.shockwavePremuto) this.tasti.shockwave = true;
                    this.shockwavePremuto = true;
                } else {
                    this.shockwavePremuto = false;
                }
            }
            if (v && (e.code === 'Digit1' || e.code === 'Numpad1' || e.code === 'Digit2' || e.code === 'Numpad2')) {
                if (this.fase !== 'voto') return;
                const scelta = (e.code === 'Digit1' || e.code === 'Numpad1') ? 'standard' : 'sopravvivenza';
                this.votoSelezionato = scelta;
                this.votoDaInviare = scelta;
            }
        };
        document.addEventListener('keydown', e => set(e, true));
        document.addEventListener('keyup',   e => set(e, false));
        this.userInput.canvas.addEventListener('pointermove', () => { this.mouseSterzoAttivo = true; });
    }
}