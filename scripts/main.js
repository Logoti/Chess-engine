/**
 * ============================================================================
 * HUMAN COGNITIVE CHESS ENGINE - GHOST LAYER ABSOLUTE (BLITZ)
 * Arquitetura Cognitiva Completa + WebSocket + Shadow DOM + Clean APIs
 * Para ligar/desligar: Pressione Alt + A
 * ============================================================================
 */

(function () {
  // ------------------------------------------------------------------------
  // TRAVA ANTI-DUPLICAÇÃO (Impede que o Alt+A acumule cliques)
  // ------------------------------------------------------------------------
  if (window.__GHOST_INJECTED) {
    console.warn(
      "🥷 [Fantasma] O script já está rodando nesta aba! Aperte Alt + A para alternar.",
    );
    return;
  }
  window.__GHOST_INJECTED = true;

  // ------------------------------------------------------------------------
  // 1. O COFRE DE VIDRO (Evasão de Monkey Patching)
  // ------------------------------------------------------------------------
  const vault = document.createElement("iframe");
  vault.style.display = "none";
  document.documentElement.appendChild(vault);

  const CleanObserver = vault.contentWindow.MutationObserver;
  const CleanWebSocket = vault.contentWindow.WebSocket;
  const CleanSetTimeout = vault.contentWindow.setTimeout;
  const CleanClearTimeout = vault.contentWindow.clearTimeout;

  // ------------------------------------------------------------------------
  // 2. A CAMADA DE INVISIBILIDADE (Closed Shadow DOM)
  // ------------------------------------------------------------------------
  const ghostHost = document.createElement("div");
  ghostHost.id = "ghost-layer-" + Math.random().toString(36).substr(2, 9);
  ghostHost.style.cssText =
    "position:fixed; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:9999999;";
  document.documentElement.appendChild(ghostHost);

  const shadow = ghostHost.attachShadow({ mode: "closed" });
  const overlayCanvas = document.createElement("canvas");
  shadow.appendChild(overlayCanvas);
  const overlayCtx = overlayCanvas.getContext("2d");

  // ------------------------------------------------------------------------
  // ESTADO GLOBAL DO FANTASMA
  // ------------------------------------------------------------------------
  let isRunning = false;
  let wsEngine = null;
  let currentEvals = [];
  let isCalculating = false;
  let lastStableFen = "";
  let boardObserver = null;
  let perceptionTimeout = null;
  
  // CORREÇÃO: Variáveis necessárias para evitar o desligamento da engine
  let heartbeatInterval = null;
  let calculationStartTime = 0;

  // ============================================================================
// ARQUITETURA COGNITIVA — v3
// ============================================================================
//
// O QUE ESTE MÓDULO É (e o que não é):
// Este arquivo NÃO é um motor de xadrez. Ele não gera lances legais nem avalia
// posições — isso é trabalho do seu motor (ex.: Stockfish). Este módulo é a
// CAMADA DE DECISÃO HUMANIZADA que fica entre o motor e o lance jogado: ele
// recebe candidatos já avaliados e decide COMO um humano de determinado
// perfil escolheria entre eles — quanto tempo pensar, quando jogar de
// imediato, quando seguir o livro de aberturas, quando errar (e por quê) e
// como manter um plano coerente ao longo da partida.
//
// CONTRATO DE DADOS ESPERADO (o que seu gerador de lances/motor deve fornecer)
// -----------------------------------------------------------------------------
// candidate = {
//   move,                 // string (SAN ou UCI) do lance — usada p/ casar com o livro
//   score,                 // avaliação em peões, do ponto de vista de quem vai jogar
//   isCheck, isCapture, isPawnMove,
//   pieceName,             // "knight" | "bishop" | "rook" | "queen" | "pawn" | "king"
//   planTags,              // string[] — quais planos estratégicos este lance serve
//   patternHash,           // string opcional — id de um padrão tático/posicional reconhecível
//   hangsPiece,            // bool — este lance pendura uma peça seguinte
//   hangsFreeMaterial,     // number opcional — valor em peões do material pendurado
//   opponentThreatAfter,   // bool — depois deste lance o oponente cria uma ameaça não óbvia
//   isMateInOne,           // bool
//   isSimplifying,         // bool opcional — troca peças / reduz complicações
//   isSafe,                // bool opcional — lance sólido, baixo risco
//   createsComplications,  // bool opcional — aumenta a bagunça (útil quando perdendo)
//   isDefensiveResource,   // bool opcional — recurso defensivo em posição pior
// }
//
// boardContext = {
//   isEndgame, kingExposed, isForcedRecapture, isOnlyLegalMove,
//   isInevitablePromotion, outOfTheory, moveHistory (string[]),
//   evalScore (peões, do ponto de vista de quem vai jogar),
//   knownEndgamePattern ("KPK" | "oposicao" | "torre_atras_do_passado" | ...),
// }
//
// Todos os campos opcionais têm fallback seguro: se seu gerador de lances
// ainda não fornece um campo, a feature correspondente vira um no-op — nada
// quebra, só fica "menos humano" naquele detalhe até você popular o dado.

const SKILL_TIERS = {
  BEGINNER: "beginner",
  INTERMEDIATE: "intermediate",
  ADVANCED: "advanced",
  MASTER: "master",
};

// Deve bater com o valor máximo de retorno de CognitiveState.timePressureFactor()
const MAX_TIME_PRESSURE = 2.5;

const TIER_PARAMS = {
  [SKILL_TIERS.BEGINNER]: {
    searchDepthPly: 1,
    candidatePoolSize: 3,
    tacticalVisionRadius: 1,
    blunderBaseRate: 0.18,
    hangingPieceDetection: 0.55,
    threatDetection: 0.5,
    endgameTechnique: 0.35,
    baseThinkSeconds: 1.2,
    minThinkSeconds: 0.6, // piso de "tempo de reação" mesmo em lance óbvio
    criticalThinkMultiplier: 2.5,
    timeControlSeconds: 300,
    movesPerControl: 40,
    openingBookDepth: 4,
    openingBookNoise: 0.5,
    winningSimplifyFactor: 0.15, // o quanto simplifica quando está ganhando muito
    losingDigFactor: 0.15, // o quanto aprofunda quando está perdendo muito
  },
  [SKILL_TIERS.INTERMEDIATE]: {
    searchDepthPly: 2,
    candidatePoolSize: 4,
    tacticalVisionRadius: 2,
    blunderBaseRate: 0.09,
    hangingPieceDetection: 0.75,
    threatDetection: 0.7,
    endgameTechnique: 0.55,
    baseThinkSeconds: 1.6,
    minThinkSeconds: 0.4,
    criticalThinkMultiplier: 3,
    timeControlSeconds: 300,
    movesPerControl: 40,
    openingBookDepth: 6,
    openingBookNoise: 0.3,
    winningSimplifyFactor: 0.3,
    losingDigFactor: 0.3,
  },
  [SKILL_TIERS.ADVANCED]: {
    searchDepthPly: 3,
    candidatePoolSize: 5,
    tacticalVisionRadius: 3,
    blunderBaseRate: 0.04,
    hangingPieceDetection: 0.93,
    threatDetection: 0.9,
    endgameTechnique: 0.75,
    baseThinkSeconds: 2,
    minThinkSeconds: 0.25,
    criticalThinkMultiplier: 4,
    timeControlSeconds: 300,
    movesPerControl: 40,
    openingBookDepth: 10,
    openingBookNoise: 0.15,
    winningSimplifyFactor: 0.45,
    losingDigFactor: 0.45,
  },
  [SKILL_TIERS.MASTER]: {
    searchDepthPly: 4,
    candidatePoolSize: 6,
    tacticalVisionRadius: 4,
    blunderBaseRate: 0.015,
    hangingPieceDetection: 0.985,
    threatDetection: 0.97,
    endgameTechnique: 0.92,
    baseThinkSeconds: 2.5,
    minThinkSeconds: 0.15,
    criticalThinkMultiplier: 5,
    timeControlSeconds: 300,
    movesPerControl: 40,
    openingBookDepth: 14,
    openingBookNoise: 0.05,
    winningSimplifyFactor: 0.6,
    losingDigFactor: 0.6,
  },
};

const BLUNDER_TYPES = {
  hangsPiece: { baseRate: 0.01, fatigueMult: 1.6, timePressureMult: 2.2 },
  missedTactic: { baseRate: 0.06, fatigueMult: 1.3, timePressureMult: 1.8 },
  quietMoveMiss: { baseRate: 0.08, fatigueMult: 1.2, timePressureMult: 1.5 },
  positionalDrift: {
    baseRate: 0.15,
    fatigueMult: 1.1,
    timePressureMult: 1.2,
  },
};

const STYLES = ["Agressivo", "Posicional", "Sólido", "Criativo", "Prático"];
const STYLE_PRIORS = {
  Agressivo: { risk: 0.72, calcBonus: -0.05, creativity: 0.55 },
  Posicional: { risk: 0.3, calcBonus: 0.05, creativity: 0.35 },
  Sólido: { risk: 0.2, calcBonus: 0.08, creativity: 0.2 },
  Criativo: { risk: 0.55, calcBonus: -0.02, creativity: 0.8 },
  Prático: { risk: 0.45, calcBonus: 0.03, creativity: 0.4 },
};

const PLAN_TAGS = [
  "ataqueRei",
  "minoriaDamas",
  "controleCentro",
  "trocaSimplificadora",
  "jogoDeFinais",
];

// ----------------------------------------------------------------------------
// LIVRO DE ABERTURAS — repertório padronizado
// ----------------------------------------------------------------------------
// Regra de convenção de chaves: o path (moveHistory.join("|")) representa os
// lances já jogados, ambas as cores. Uma chave só existe quando é A NOSSA VEZ
// de jogar — ou seja, path de comprimento PAR para o livro de brancas (0, 2,
// 4 lances já jogados) e ÍMPAR para o de pretas (1, 3, 5 lances já jogados).
// Cada entrada é uma lista de { move, weight, planTags } — pesos permitem
// pequenas variações dentro do mesmo repertório (ex.: às vezes Bc4, às vezes
// Bb5), sem abandonar a identidade fixa do reportório.
//
// Isto cobre os lances mais comuns do adversário com boa profundidade, mas
// não é uma enciclopédia — é deliberadamente enxuto, como você pediu. Se o
// oponente sair dessas linhas, getBookMove() retorna null e o motor cai no
// pipeline cognitivo normal (calculando "na marra", filtrado pela camada
// humana de fadiga/perfil/erros).

// --- BRANCAS: 1.e4 — Italiana / Giuoco Piano (com desvio para Evans) -------
const ITALIAN_LINES = {
  "": [{ move: "e4", weight: 1, planTags: ["controleCentro"] }],

  // 1...e5 — linha principal do repertório
  "e4|e5": [{ move: "Nf3", weight: 1, planTags: ["controleCentro"] }],
  "e4|e5|Nf3|Nc6": [
    { move: "Bc4", weight: 0.75, planTags: ["ataqueRei"] },
    { move: "Bb5", weight: 0.25, planTags: ["controleCentro"] }, // desvio ocasional p/ Espanhola
  ],
  "e4|e5|Nf3|Nc6|Bc4|Bc5": [
    { move: "c3", weight: 0.65, planTags: ["controleCentro"] }, // Giuoco Piano/Pianissimo
    { move: "b4", weight: 0.35, planTags: ["ataqueRei"] }, // Evans Gambit
  ],
  "e4|e5|Nf3|Nc6|Bc4|Nf6": [
    { move: "Ng5", weight: 0.5, planTags: ["ataqueRei"] }, // Two Knights, ideias de Fried Liver
    { move: "d3", weight: 0.5, planTags: ["controleCentro"] }, // linha tranquila
  ],

  // 1...c5 — Siciliana: evita teoria pesada da Aberta, joga Rossolimo-like
  "e4|c5": [{ move: "Nf3", weight: 1, planTags: ["controleCentro"] }],
  "e4|c5|Nf3|Nc6": [
    { move: "Bb5", weight: 0.7, planTags: ["controleCentro"] },
    { move: "d4", weight: 0.3, planTags: ["ataqueRei"] },
  ],
  "e4|c5|Nf3|d6": [{ move: "d4", weight: 1, planTags: ["controleCentro"] }],
  "e4|c5|Nf3|e6": [{ move: "d4", weight: 1, planTags: ["controleCentro"] }],

  // 1...e6 — Francesa (do lado de quem joga de brancas)
  "e4|e6": [{ move: "d4", weight: 1, planTags: ["controleCentro"] }],
  "e4|e6|d4|d5": [
    { move: "Nc3", weight: 0.55 },
    { move: "Nd2", weight: 0.45 },
  ],

  // 1...c6 — Caro-Kann (do lado de brancas)
  "e4|c6": [{ move: "d4", weight: 1, planTags: ["controleCentro"] }],
  "e4|c6|d4|d5": [
    { move: "Nc3", weight: 0.45 },
    { move: "Nd2", weight: 0.35 },
    { move: "e5", weight: 0.2 },
  ],

  // 1...d5 — Escandinava
  "e4|d5": [{ move: "exd5", weight: 1 }],
  "e4|d5|exd5|Qxd5": [{ move: "Nc3", weight: 1, planTags: ["ataqueRei"] }],

  // 1...Nf6 — Alekhine
  "e4|Nf6": [{ move: "e5", weight: 1, planTags: ["controleCentro"] }],
  "e4|Nf6|e5|Nd5": [{ move: "d4", weight: 1, planTags: ["controleCentro"] }],

  // 1...d6 / 1...g6 — Pirc/Moderna, resposta clássica de centro
  "e4|d6": [{ move: "d4", weight: 1, planTags: ["controleCentro"] }],
  "e4|g6": [{ move: "d4", weight: 1, planTags: ["controleCentro"] }],
};

// --- BRANCAS: 1.d4 — Sistema Londres (quase o mesmo plano sempre) ---------
const LONDON_LINES = {
  "": [{ move: "d4", weight: 1, planTags: ["controleCentro"] }],

  "d4|d5": [{ move: "Bf4", weight: 1, planTags: ["controleCentro"] }],
  "d4|d5|Bf4|Nf6": [{ move: "e3", weight: 1 }],
  "d4|d5|Bf4|Nf6|e3|e6": [{ move: "Nf3", weight: 1 }],
  "d4|d5|Bf4|Nf6|e3|c5": [{ move: "c3", weight: 1 }],
  "d4|d5|Bf4|Nf6|e3|c5|c3|Nc6": [
    { move: "Nf3", weight: 0.5 },
    { move: "Nd2", weight: 0.5 },
  ],

  "d4|Nf6": [{ move: "Bf4", weight: 1, planTags: ["controleCentro"] }],
  "d4|Nf6|Bf4|g6": [{ move: "e3", weight: 1 }], // vs esquema tipo K-Índia
  "d4|Nf6|Bf4|e6": [{ move: "e3", weight: 1 }],
  "d4|Nf6|Bf4|d5": [{ move: "e3", weight: 1 }],

  "d4|c5": [
    { move: "Nf3", weight: 0.6 },
    { move: "Bf4", weight: 0.4 },
  ],
  "d4|c5|Nf3|Nf6": [{ move: "Bf4", weight: 1 }],
  "d4|c5|Nf3|d6": [{ move: "Bf4", weight: 1 }],

  "d4|e6": [{ move: "Bf4", weight: 1 }],
  "d4|g6": [{ move: "Bf4", weight: 1 }],
  "d4|f5": [{ move: "Bf4", weight: 1 }], // vs Holandesa
};

// --- PRETAS contra 1.e4: Caro-Kann (opção sólida "muro") ------------------
const CARO_KANN_LINES = {
  "e4": [{ move: "c6", weight: 1, planTags: ["trocaSimplificadora"] }],
  "e4|c6|d4": [{ move: "d5", weight: 1, planTags: ["controleCentro"] }],
  "e4|c6|Nc3": [{ move: "d5", weight: 1 }],
  "e4|c6|Nf3": [{ move: "d5", weight: 1 }],

  "e4|c6|d4|d5|Nc3": [
    { move: "dxe4", weight: 0.6, planTags: ["trocaSimplificadora"] }, // Clássica
    { move: "Nf6", weight: 0.25 }, // vs Ataque de Peões
    { move: "Bg4", weight: 0.15 },
  ],
  "e4|c6|d4|d5|Nd2": [
    { move: "dxe4", weight: 0.6, planTags: ["trocaSimplificadora"] },
    { move: "Nf6", weight: 0.4 },
  ],
  "e4|c6|d4|d5|e5": [{ move: "Bf5", weight: 1, planTags: ["trocaSimplificadora"] }], // Avançada
  "e4|c6|d4|d5|exd5": [{ move: "cxd5", weight: 1 }], // Troca

  "e4|c6|d4|d5|Nc3|dxe4|Nxe4": [
    { move: "Bf5", weight: 0.7, planTags: ["trocaSimplificadora"] },
    { move: "Nd7", weight: 0.3 },
  ],
  "e4|c6|d4|d5|Nd2|dxe4|Nxe4": [
    { move: "Bf5", weight: 0.7, planTags: ["trocaSimplificadora"] },
    { move: "Nd7", weight: 0.3 },
  ],
  "e4|c6|d4|d5|e5|Bf5|Nf3": [{ move: "e6", weight: 1 }],
};

// --- PRETAS contra 1.e4: Francesa (opção sólida alternativa) --------------
const FRENCH_LINES = {
  "e4": [{ move: "e6", weight: 1, planTags: ["controleCentro"] }],
  "e4|e6|d4": [{ move: "d5", weight: 1 }],
  "e4|e6|d4|d5|Nc3": [
    { move: "Bb4", weight: 0.55, planTags: ["ataqueRei"] }, // Winawer
    { move: "Nf6", weight: 0.45 }, // Clássica
  ],
  "e4|e6|d4|d5|Nd2": [
    { move: "Nf6", weight: 0.55 },
    { move: "c5", weight: 0.45 }, // Tarrasch
  ],
  "e4|e6|d4|d5|e5": [{ move: "c5", weight: 1, planTags: ["controleCentro"] }], // Avançada
};

// --- PRETAS contra 1.d4: Eslava (mantém o bispo de casas brancas livre) ---
const SLAV_LINES = {
  "d4": [{ move: "d5", weight: 1, planTags: ["controleCentro"] }],
  "d4|d5|c4": [{ move: "c6", weight: 1, planTags: ["trocaSimplificadora"] }],
  "d4|d5|Nf3": [{ move: "Nf6", weight: 1 }],
  "d4|d5|Bf4": [
    { move: "Nf6", weight: 0.6 },
    { move: "c6", weight: 0.4 },
  ],

  "d4|d5|c4|c6|Nf3": [{ move: "Nf6", weight: 1 }],
  "d4|d5|c4|c6|Nc3": [{ move: "Nf6", weight: 1 }],
  "d4|d5|c4|c6|Nf3|Nf6|Nc3": [
    { move: "dxc4", weight: 0.6, planTags: ["controleCentro"] }, // Eslava pura
    { move: "e6", weight: 0.4 }, // Semi-Eslava
  ],
  "d4|d5|c4|c6|Nf3|Nf6|Nc3|dxc4|a4": [{ move: "Bf5", weight: 1 }],
};

// --- PRETAS contra 1.d4: Gambito da Dama Recusado (alternativa teórica) ---
const QGD_LINES = {
  "d4": [{ move: "d5", weight: 1 }],
  "d4|d5|c4": [{ move: "e6", weight: 1, planTags: ["controleCentro"] }],
  "d4|d5|c4|e6|Nc3": [{ move: "Nf6", weight: 1 }],
  "d4|d5|c4|e6|Nf3": [{ move: "Nf6", weight: 1 }],
  "d4|d5|c4|e6|Nc3|Nf6|Bg5": [{ move: "Be7", weight: 1 }],
  "d4|d5|c4|e6|Nc3|Nf6|Bf4": [
    { move: "Be7", weight: 0.5 },
    { move: "c5", weight: 0.5 },
  ],
};

// Respostas genéricas a primeiros lances "fora do script" (1.c4, 1.Nf3),
// tentando transpor de volta para a estrutura escolhida em vez de deixar
// essas aberturas totalmente fora do livro.
const GENERIC_BLACK_TRANSPOSITION_FALLBACKS = {
  c4: [{ move: "e5", weight: 0.3 }, { move: "c6", weight: 0.35 }, { move: "Nf6", weight: 0.35 }],
  Nf3: [{ move: "d5", weight: 0.6 }, { move: "Nf6", weight: 0.4 }],
};

/**
 * Monta o repertório fixo de brancas. `system`: "italian" | "london".
 * Escolha determinística — é exatamente o ponto de "padronizar": a mesma
 * instância de perfil sempre joga o mesmo primeiro lance e o mesmo plano.
 */
function buildWhiteRepertoire(system = "italian") {
  const systems = {
    italian: { name: "Italiana (Giuoco Piano / Evans)", lines: ITALIAN_LINES },
    london: { name: "Sistema Londres", lines: LONDON_LINES },
  };
  const chosen = systems[system] || systems.italian;
  return { color: "white", name: chosen.name, lines: chosen.lines };
}

/**
 * Monta o repertório fixo de pretas. Como pretas não escolhem o 1º lance,
 * o repertório precisa cobrir a resposta a 1.e4 E a 1.d4 (e um fallback
 * genérico pros demais). `vsE4`: "caroKann" | "francesa".
 * `vsD4`: "eslava" | "qgd".
 */
function buildBlackRepertoire({ vsE4 = "caroKann", vsD4 = "eslava" } = {}) {
  const e4Books = { caroKann: CARO_KANN_LINES, francesa: FRENCH_LINES };
  const d4Books = { eslava: SLAV_LINES, qgd: QGD_LINES };
  const lines = {
    ...(e4Books[vsE4] || CARO_KANN_LINES),
    ...(d4Books[vsD4] || SLAV_LINES),
    ...GENERIC_BLACK_TRANSPOSITION_FALLBACKS,
  };
  const name = `${vsE4 === "francesa" ? "Francesa" : "Caro-Kann"} + ${
    vsD4 === "qgd" ? "Gambito da Dama Recusado" : "Eslava"
  }`;
  return { color: "black", name, lines };
}

/**
 * Ponto único de montagem do repertório de um perfil, usado pelo construtor
 * de PlayerProfile. `options` é passado adiante para build*Repertoire.
 */
function pickRepertoire(color, options = {}) {
  if (color === "white") return buildWhiteRepertoire(options.system);
  if (color === "black") return buildBlackRepertoire(options);
  return null;
}

/**
 * Procura um lance de livro para a posição atual. Retorna null quando:
 * - a posição não está catalogada (o oponente saiu da teoria preparada), ou
 * - o lance de livro não está entre os candidatos fornecidos (pode acontecer
 *   se o motor não gerou aquele lance por algum motivo).
 * Nesses casos o chamador deve seguir para o pipeline cognitivo normal.
 */
function getBookMove(profile, moveHistory, candidates) {
  if (!profile.openingRepertoire) return null;
  const path = (moveHistory || []).join("|");
  const entries = profile.openingRepertoire.lines[path];
  if (!entries || entries.length === 0) return null;

  const withCandidate = entries
    .map((e) => ({ ...e, candidate: candidates.find((c) => c.move === e.move) }))
    .filter((e) => e.candidate);
  if (withCandidate.length === 0) return null;

  const totalWeight = withCandidate.reduce((s, e) => s + e.weight, 0);
  let r = Math.random() * totalWeight;
  for (const e of withCandidate) {
    r -= e.weight;
    if (r <= 0) return e.candidate;
  }
  return withCandidate[withCandidate.length - 1].candidate;
}

// ----------------------------------------------------------------------------
// UTILITÁRIOS
// ----------------------------------------------------------------------------
function clamp(x, min = 0, max = 1) {
  return Math.max(min, Math.min(max, x));
}
function sampleNormal(mean, stdDev) {
  const u1 = Math.random() || 1e-9;
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return clamp(mean + z * stdDev);
}

// ----------------------------------------------------------------------------
// PERFIL DO JOGADOR
// ----------------------------------------------------------------------------
class PlayerProfile {
  /**
   * repertoireOptions:
   *   brancas -> { system: "italian" | "london" }              (padrão: italian)
   *   pretas  -> { vsE4: "caroKann" | "francesa",
   *                vsD4: "eslava" | "qgd" }                     (padrão: caroKann/eslava)
   */
  constructor(
    skillTier = SKILL_TIERS.ADVANCED,
    style = null,
    color = "white",
    repertoireOptions = {},
  ) {
    this.skillTier = skillTier;
    this.color = color;
    this.style = style || STYLES[Math.floor(Math.random() * STYLES.length)];
    const prior = STYLE_PRIORS[this.style];
    this.aggression = sampleNormal(prior.risk, 0.15);
    this.riskTolerance = sampleNormal(prior.risk, 0.15);
    this.creativity = sampleNormal(prior.creativity, 0.15);
    this.calculationAccuracy = clamp(
      0.82 + prior.calcBonus + sampleNormal(0, 0.05),
    );
    this.quirks = {
      lovesKnights: sampleNormal(0.4, 0.2),
      avoidsEndgames: sampleNormal(0.35, 0.2),
      pawnPreference: sampleNormal(0.3, 0.2),
      opennessToSacrifice: sampleNormal(prior.risk * 0.8, 0.15),
    };
    this.longTermMemory = {
      pieceSuccessRate: {
        knight: 0.5,
        bishop: 0.5,
        rook: 0.5,
        queen: 0.5,
        pawn: 0.5,
      },
      patternLibrary: new Map(),
    };
    const t = TIER_PARAMS[skillTier];
    this.searchDepthPly = t.searchDepthPly;
    this.candidatePoolSize = t.candidatePoolSize;
    this.blunderBaseRate = t.blunderBaseRate;
    this.hangingPieceDetection = t.hangingPieceDetection;
    this.threatDetection = t.threatDetection;

    // Repertório fixo (item 1/9 do pedido): um "estilo de abertura" estável
    // e determinístico para esta instância, com pequenas variações internas
    // apenas via pesos dentro da mesma linha (nunca troca de sistema sozinha).
    this.openingRepertoire = pickRepertoire(color, repertoireOptions);
  }

  reinforcePattern(pieceType, outcomeScore) {
    if (this.longTermMemory.pieceSuccessRate[pieceType] != null) {
      this.longTermMemory.pieceSuccessRate[pieceType] = clamp(
        this.longTermMemory.pieceSuccessRate[pieceType] +
          0.03 *
            (outcomeScore - this.longTermMemory.pieceSuccessRate[pieceType]),
      );
    }
  }

  /**
   * Fecha o loop de aprendizado do patternLibrary (antes só era lido, nunca
   * escrito). O chamador deve invocar isto quando tiver algum sinal de
   * resultado associado a um padrão — por exemplo, ao ver que a avaliação
   * do motor manteve-se estável/melhorou nos lances seguintes depois de um
   * padrão reconhecido, ou ao final da partida distribuindo crédito.
   * outcomeScore: ~1 = deu certo, ~0 = deu errado, 0.5 = neutro.
   */
  recordPatternOutcome(patternHash, outcomeScore) {
    if (!patternHash) return;
    const current = this.longTermMemory.patternLibrary.get(patternHash) || 0;
    this.longTermMemory.patternLibrary.set(
      patternHash,
      clamp(current + 0.2 * (outcomeScore - 0.5), -1, 1),
    );
  }
}

// ----------------------------------------------------------------------------
// ESTADO COGNITIVO (fadiga, confiança, relógio, plano em curso)
// ----------------------------------------------------------------------------
class CognitiveState {
  constructor(timeControlSeconds = 300) {
    this.moveNumber = 1;
    this.fatigue = 0;
    this.confidence = 0.5;
    this.momentum = 0;
    this.previousErrors = 0;
    this.consecutiveGoodMoves = 0;
    this.timeRemaining = timeControlSeconds;
    this.movesSinceControl = 0;
    this.currentPlan = null;
    this.planStrength = 0;
    this.planAgeInMoves = 0;
  }

  spendTime(seconds) {
    this.timeRemaining = Math.max(2, this.timeRemaining - seconds);
    this.movesSinceControl += 1;
  }

  timePressureFactor(movesPerControl = 40) {
    const movesLeftToControl = Math.max(
      1,
      movesPerControl - this.movesSinceControl,
    );
    const secondsPerMoveLeft = this.timeRemaining / movesLeftToControl;
    if (secondsPerMoveLeft < 10) return MAX_TIME_PRESSURE;
    if (secondsPerMoveLeft < 30) return 1.6;
    if (secondsPerMoveLeft < 60) return 1.2;
    return 1.0;
  }

  updatePlan(chosenPlanTag) {
    if (chosenPlanTag && chosenPlanTag === this.currentPlan) {
      this.planStrength = clamp(this.planStrength + 0.15, 0, 1);
      this.planAgeInMoves += 1;
    } else if (chosenPlanTag) {
      this.currentPlan = chosenPlanTag;
      this.planStrength = 0.4;
      this.planAgeInMoves = 0;
    } else {
      this.planStrength = clamp(this.planStrength - 0.08, 0, 1);
      this.planAgeInMoves += 1;
      if (this.planStrength <= 0) this.currentPlan = null;
    }
  }

  update({ difficultyScore, wasBlunder }) {
    this.moveNumber += 1;
    this.fatigue = clamp(this.fatigue + (0.004 + difficultyScore * 0.0006));
    if (wasBlunder) {
      this.previousErrors += 1;
      this.consecutiveGoodMoves = 0;
      this.momentum = clamp(this.momentum - 0.4, -1, 1);
      this.confidence = clamp(this.confidence - 0.15);
    } else {
      this.consecutiveGoodMoves += 1;
      this.momentum = clamp(this.momentum + 0.08, -1, 1);
      this.confidence = clamp(this.confidence + 0.02);
    }
  }
}

// ----------------------------------------------------------------------------
// LANCES ÓBVIOS (item 2 do pedido)
// ----------------------------------------------------------------------------
/**
 * Detecta lances que um humano jogaria quase sem pensar. Retorna
 * { isObvious: false } quando nada se aplica — o pipeline cognitivo completo
 * roda normalmente nesse caso.
 */
function classifyObviousness(candidates, boardContext = {}) {
  if (candidates.length === 1 || boardContext.isOnlyLegalMove) {
    return { isObvious: true, reason: "unicoLanceLegal", forcedMove: candidates[0] };
  }
  const mate = candidates.find((c) => c.isMateInOne);
  if (mate) return { isObvious: true, reason: "mateEm1", forcedMove: mate };

  if (boardContext.isForcedRecapture) {
    const recapture = candidates.find((c) => c.isCapture) || candidates[0];
    return { isObvious: true, reason: "recaptura", forcedMove: recapture };
  }

  if (boardContext.isInevitablePromotion) {
    const promo = candidates.find((c) => c.isPawnMove) || candidates[0];
    return { isObvious: true, reason: "promocaoInevitavel", forcedMove: promo };
  }

  // Captura evidente de peça pendurada: um candidato ganha material de graça
  // e nenhum outro candidato chega perto em avaliação.
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const best = sorted[0];
  const second = sorted[1];
  const clearFreeCapture =
    best.isCapture &&
    (best.hangsFreeMaterial || 0) >= 3 &&
    !best.opponentThreatAfter &&
    (!second || best.score - second.score > 2);
  if (clearFreeCapture) {
    return { isObvious: true, reason: "capturaDeGraca", forcedMove: best };
  }

  return { isObvious: false };
}

// ----------------------------------------------------------------------------
// DIFICULDADE DA POSIÇÃO
// ----------------------------------------------------------------------------
function calculateDifficulty(candidates, boardContext = {}) {
  if (candidates.length < 2)
    return {
      total: 0,
      scoreGap: 0,
      forcingCount: 0,
      quietDangerCount: 0,
      isEndgame: !!boardContext.isEndgame,
    };

  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const scoreGap = (sorted[0].score - sorted[1].score) / 8;
  const forcingCount = candidates.filter(
    (c) => c.isCheck || c.isCapture,
  ).length;
  const quietDangerCount = candidates.filter(
    (c) => !c.isCheck && !c.isCapture && c.opponentThreatAfter,
  ).length;

  const total = Math.max(
    0,
    Math.min(candidates.length, 6) * 15 -
      scoreGap +
      forcingCount * 4 +
      quietDangerCount * 8,
  );

  return {
    total,
    scoreGap,
    forcingCount,
    quietDangerCount,
    isEndgame: !!boardContext.isEndgame,
  };
}

function isCriticalMoment(difficulty, boardContext = {}) {
  if (boardContext.isForcedRecapture) return false;
  return (
    difficulty.total > 55 ||
    difficulty.forcingCount >= 2 ||
    difficulty.quietDangerCount >= 1 ||
    !!boardContext.kingExposed
  );
}

// ----------------------------------------------------------------------------
// ALOCAÇÃO DE ESFORÇO (tempo, profundidade, nº de candidatos)
// ----------------------------------------------------------------------------
function allocateEffort(profile, state, difficulty, boardContext = {}) {
  const tier = TIER_PARAMS[profile.skillTier];
  const critical = isCriticalMoment(difficulty, boardContext);
  const timePressure = state.timePressureFactor(tier.movesPerControl);

  let depth = tier.searchDepthPly;
  let poolSize = tier.candidatePoolSize;
  let thinkSeconds = tier.baseThinkSeconds;
  let endgameHeuristic = false;

  if (critical) {
    depth += 1;
    poolSize += 2;
    thinkSeconds *= tier.criticalThinkMultiplier;
  }

  // Confiança pela avaliação (item 3 do pedido): ganhando muito -> simplifica
  // e joga rápido/seguro; perdendo muito -> aprofunda em busca de recursos.
  const evalAdv = boardContext.evalScore ?? 0;
  if (evalAdv > 3) {
    const factor = tier.winningSimplifyFactor;
    depth = Math.max(1, Math.round(depth - factor * 2));
    poolSize = Math.max(1, Math.round(poolSize - factor * 3));
    thinkSeconds *= 1 - factor * 0.5;
  } else if (evalAdv < -2) {
    const factor = tier.losingDigFactor;
    depth += Math.round(factor * 2);
    poolSize += Math.round(factor * 2);
    thinkSeconds *= 1 + factor;
  }

  // Final especializado: jogadores com boa técnica reconhecem o padrão rápido;
  // jogadores fracos continuam lentos/inseguros mesmo em finais "conhecidos".
  if (boardContext.isEndgame && boardContext.knownEndgamePattern) {
    endgameHeuristic = true;
    thinkSeconds *= 1.3 - tier.endgameTechnique * 0.6;
  }

  // Gestão de relógio: sob pressão de tempo real, cai profundidade também
  // (antes só afetava a chance de erro).
  if (timePressure > 1.6) {
    depth = Math.max(1, depth - 1);
    poolSize = Math.max(1, poolSize - 1);
  }
  thinkSeconds = Math.min(thinkSeconds, state.timeRemaining * 0.15);
  thinkSeconds = Math.max(tier.minThinkSeconds, thinkSeconds / timePressure);

  return { depth, poolSize, thinkSeconds, critical, endgameHeuristic, timePressure };
}

// ----------------------------------------------------------------------------
// PERCEPÇÃO HUMANA DOS CANDIDATOS
// ----------------------------------------------------------------------------
function simulateHumanPerception(candidates, profile, state, effort, boardContext = {}) {
  return candidates.map((c) => {
    let intuitive =
      c.score +
      (profile.longTermMemory.patternLibrary.get(c.patternHash) || 0) * 15;
    if (c.hangsPiece && Math.random() > profile.hangingPieceDetection)
      intuitive += 300;

    let adjustment = 0;
    const calcSuccessProb = clamp(
      profile.calculationAccuracy *
        (1 - state.fatigue * 0.35) *
        (0.85 + state.confidence * 0.3),
    );

    if (Math.random() > calcSuccessProb) {
      adjustment = (Math.random() - 0.35) * 60 * (1 - calcSuccessProb);
    }

    let planBonus = 0;
    if (
      state.currentPlan &&
      c.planTags &&
      c.planTags.includes(state.currentPlan)
    ) {
      planBonus = 20 * state.planStrength;
    }

    // Confiança pela avaliação, parte 2: bônus para lances que combinam com
    // a intenção (simplificar quando ganhando / criar complicação e buscar
    // recursos defensivos quando perdendo).
    let situationalBonus = 0;
    const evalAdv = boardContext.evalScore ?? 0;
    if (evalAdv > 3 && (c.isSimplifying || c.isSafe)) situationalBonus += 18;
    if (evalAdv < -2 && (c.createsComplications || c.isDefensiveResource))
      situationalBonus += 18;

    return {
      ...c,
      perceivedScore: intuitive + adjustment + planBonus + situationalBonus,
    };
  });
}

function applyPersonalityBias(candidate, profile) {
  let bonus =
    {
      Agressivo: candidate.isAttack ? 55 * profile.aggression : 0,
      Posicional: candidate.isForward ? 0 : 30,
      Prático: 30,
    }[profile.style] || 0;

  if (candidate.pieceName === "knight")
    bonus += profile.quirks.lovesKnights * 30;
  if (candidate.isPawnMove) bonus += profile.quirks.pawnPreference * 15;

  // Desempate entre lances equivalentes (item 10 do pedido): usa a memória
  // de sucesso por tipo de peça, que antes era só escrita e nunca lida.
  const pieceSuccess = candidate.pieceName
    ? profile.longTermMemory.pieceSuccessRate[candidate.pieceName]
    : null;
  if (pieceSuccess != null) bonus += (pieceSuccess - 0.5) * 20;

  return candidate.perceivedScore + bonus;
}

function softmax(values, temperature) {
  const t = Math.max(0.05, temperature);
  const max = Math.max(...values);
  const exps = values.map((v) => Math.exp((v - max) / t));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

// ----------------------------------------------------------------------------
// DETECÇÃO DE ERROS (blunders)
// ----------------------------------------------------------------------------
// Interpola linearmente entre 1x (sem pressão) e baseMult (pressão máxima),
// em vez da fórmula anterior, que era redundante (se cancelava sozinha de um
// jeito difícil de auditar).
function timePressureMultiplierFor(baseMult, timePressure) {
  const t = clamp((timePressure - 1) / (MAX_TIME_PRESSURE - 1), 0, 1);
  return 1 + t * (baseMult - 1);
}

function checkBlunderCategory(topCandidate, profile, state, difficulty, timePressure) {
  for (const [type, params] of Object.entries(BLUNDER_TYPES)) {
    const fatigueFactor = 1 + state.fatigue * (params.fatigueMult - 1);
    const pressureFactor = timePressureMultiplierFor(params.timePressureMult, timePressure);
    const rate = params.baseRate * fatigueFactor * pressureFactor;
    if (Math.random() < clamp(rate, 0, 0.9)) return type;
  }

  if (topCandidate.opponentThreatAfter) {
    const detectionChance = clamp(
      profile.threatDetection -
        state.fatigue * 0.12 -
        (difficulty.total / 100) * 0.15,
    );
    if (Math.random() > detectionChance) return "quietMoveMiss";
  }
  return null;
}

// ----------------------------------------------------------------------------
// VERIFICAÇÃO FINAL (item 7 do pedido)
// ----------------------------------------------------------------------------
// Isto é diferente de "gerar" um erro: é a checagem de segurança que qualquer
// jogador (principalmente os fortes) faz antes de soltar a peça, capaz de
// salvar de um desastre que não era o erro pretendido pela simulação — mas
// que nunca deve anular um blunder que a própria simulação decidiu cometer
// (senão a taxa de erro configurada deixaria de fazer sentido).
function finalSanityCheck(chosen, ranked, profile, wasIntentionalBlunder) {
  if (wasIntentionalBlunder) return chosen;
  const hangsBigMaterial = chosen.hangsPiece && (chosen.hangsFreeMaterial || 0) >= 3;
  if (hangsBigMaterial && Math.random() < profile.hangingPieceDetection) {
    const alternative = ranked.find((c) => c !== chosen && !c.hangsPiece);
    if (alternative) return alternative;
  }
  return chosen;
}

// ----------------------------------------------------------------------------
// "SISTEMA 1 → SISTEMA 2" (item 3 das melhorias principais)
// ----------------------------------------------------------------------------
// Para decidir quantos candidatos pedir ao motor e com que profundidade, é
// preciso primeiro ver os candidatos — por isso este processo é em 2 fases:
// 1) um scan raso e barato pra ter uma ideia da posição;
// 2) com base nisso, uma configuração de busca mais profunda, mas só quando
//    a posição realmente pede (momento crítico) — evitando gastar tempo de
//    engine analisando tudo com a mesma profundidade.
function getInitialScanRequest(profile) {
  const tier = TIER_PARAMS[profile.skillTier];
  return {
    multiPV: tier.candidatePoolSize + 2,
    depth: Math.max(6, tier.searchDepthPly * 2),
    moveTimeMs: 150,
  };
}

function getRefinedSearchRequest(profile, state, scanCandidates, boardContext = {}) {
  const difficulty = calculateDifficulty(scanCandidates, boardContext);
  const effort = allocateEffort(profile, state, difficulty, boardContext);
  return {
    multiPV: effort.poolSize,
    depth: effort.depth,
    moveTimeMs: Math.round(effort.thinkSeconds * 1000),
  };
}

// ----------------------------------------------------------------------------
// ORQUESTRADOR PRINCIPAL
// ----------------------------------------------------------------------------
function decideMove(candidates, profile, state, boardContext = {}) {
  const tier = TIER_PARAMS[profile.skillTier];

  // 0) Livro de aberturas — segue teoria até certo ponto, só depois calcula
  //    a fundo (itens 1, 2 e 9 do pedido).
  if (state.moveNumber <= tier.openingBookDepth && !boardContext.outOfTheory) {
    const bookMove = getBookMove(profile, boardContext.moveHistory, candidates);
    if (bookMove) {
      const thinkSeconds = Math.max(
        tier.minThinkSeconds,
        tier.baseThinkSeconds * tier.openingBookNoise,
      );
      state.spendTime(thinkSeconds);
      state.update({ difficultyScore: 0, wasBlunder: false });
      state.updatePlan(bookMove.planTags ? bookMove.planTags[0] : null);
      return {
        chosenMove: bookMove,
        blunderType: null,
        source: "openingBook",
        timePressure: state.timePressureFactor(tier.movesPerControl),
      };
    }
  }

  // 1) Lances óbvios — tempo mínimo de reação, não zero (item 2 do pedido).
  const obviousness = classifyObviousness(candidates, boardContext);
  if (obviousness.isObvious) {
    const jitter = sampleNormal(0, tier.minThinkSeconds * 0.25);
    const thinkSeconds = Math.max(0.05, tier.minThinkSeconds + jitter);
    state.spendTime(thinkSeconds);
    state.update({ difficultyScore: 0, wasBlunder: false });
    state.updatePlan(
      obviousness.forcedMove.planTags ? obviousness.forcedMove.planTags[0] : null,
    );
    return {
      chosenMove: obviousness.forcedMove,
      blunderType: null,
      source: "obvious",
      reason: obviousness.reason,
      timePressure: state.timePressureFactor(tier.movesPerControl),
    };
  }

  // 2) Pipeline cognitivo completo.
  const difficulty = calculateDifficulty(candidates, boardContext);
  const effort = allocateEffort(profile, state, difficulty, boardContext);

  const perceived = simulateHumanPerception(
    candidates,
    profile,
    state,
    effort,
    boardContext,
  ).map((c) => ({ ...c, finalScore: applyPersonalityBias(c, profile) }));
  const ranked = [...perceived].sort((a, b) => b.finalScore - a.finalScore);

  const endgamePenalty = boardContext.isEndgame
    ? (1 - tier.endgameTechnique) * 30
    : 0;

  const blunderType = checkBlunderCategory(
    ranked[0],
    profile,
    state,
    { ...difficulty, total: difficulty.total + endgamePenalty },
    effort.timePressure,
  );
  const isBlunder = !!blunderType;

  let pool = ranked;
  if (isBlunder && ranked.length > 1) {
    const dropCount =
      blunderType === "hangsPiece" ? 1 : Math.min(2, ranked.length - 1);
    pool = ranked.slice(dropCount);
  }

  const temperature =
    0.55 *
    (1 + state.fatigue * 0.6) *
    (1 - (state.confidence - 0.5) * 0.5) *
    (effort.critical ? 0.85 : 1.1);

  const probs = softmax(
    pool.map((c) => c.finalScore),
    temperature,
  );

  let acc = 0,
    random = Math.random(),
    chosen = pool[pool.length - 1];
  for (let i = 0; i < probs.length; i++) {
    acc += probs[i];
    if (random <= acc) {
      chosen = pool[i];
      break;
    }
  }

  // Verificação final (item 7) — só entra se o erro não foi o pretendido.
  chosen = finalSanityCheck(chosen, ranked, profile, isBlunder);

  state.spendTime(effort.thinkSeconds);
  state.update({ difficultyScore: difficulty.total, wasBlunder: isBlunder });
  state.updatePlan(chosen.planTags ? chosen.planTags[0] : null);

  if (chosen.pieceName) {
    profile.reinforcePattern(
      chosen.pieceName,
      chosen.score - ranked[0].score > -20 ? 1 : 0,
    );
  }

  return {
    chosenMove: chosen,
    blunderType,
    source: "cognitivePipeline",
    effort,
    timePressure: effort.timePressure,
  };
}

// Trava arquitetural: só executa a exportação se o ambiente for o Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SKILL_TIERS,
    TIER_PARAMS,
    BLUNDER_TYPES,
    STYLES,
    STYLE_PRIORS,
    PLAN_TAGS,
    ITALIAN_LINES,
    LONDON_LINES,
    CARO_KANN_LINES,
    FRENCH_LINES,
    SLAV_LINES,
    QGD_LINES,
    buildWhiteRepertoire,
    buildBlackRepertoire,
    PlayerProfile,
    CognitiveState,
    classifyObviousness,
    calculateDifficulty,
    isCriticalMoment,
    allocateEffort,
    simulateHumanPerception,
    applyPersonalityBias,
    checkBlunderCategory,
    finalSanityCheck,
    getInitialScanRequest,
    getRefinedSearchRequest,
    decideMove,
  };
}
  // ------------------------------------------------------------------------
  // 3. LÓGICA DE INTERFACE E RENDERIZAÇÃO
  // ------------------------------------------------------------------------
  function updateCanvasSize() {
    const board = document.querySelector("wc-chess-board");
    if (!board || !overlayCanvas) return;

    const rect = board.getBoundingClientRect();

    overlayCanvas.style.position = "absolute";
    overlayCanvas.style.left = rect.left + "px";
    overlayCanvas.style.top = rect.top + "px";

    overlayCanvas.style.width = rect.width + "px";
    overlayCanvas.style.height = rect.height + "px";
    overlayCanvas.width = rect.width;
    overlayCanvas.height = rect.height;
  }

  function clearGhostCanvas() {
    if (overlayCtx && overlayCanvas) {
      overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }
  }

  function drawGhostMove(moveStr, isFlipped) {
    if (!overlayCanvas || !overlayCtx) return;
    updateCanvasSize();
    clearGhostCanvas();

    const sqW = overlayCanvas.width / 8;
    const sqH = overlayCanvas.height / 8;

    function getCenter(sq) {
      let file = sq.charCodeAt(0) - 97;
      let rank = 8 - parseInt(sq[1]);

      if (isFlipped) {
        file = 7 - file;
        rank = 7 - rank;
      }

      return {
        x: file * sqW + sqW / 2,
        y: rank * sqH + sqH / 2,
      };
    }

    const start = getCenter(moveStr.substring(0, 2));
    const end = getCenter(moveStr.substring(2, 4));

    overlayCtx.fillStyle = "rgba(255, 165, 0, 0.55)";

    overlayCtx.beginPath();
    overlayCtx.arc(start.x, start.y, sqW / 3.5, 0, Math.PI * 2);
    overlayCtx.fill();

    overlayCtx.beginPath();
    overlayCtx.arc(end.x, end.y, sqW / 3.5, 0, Math.PI * 2);
    overlayCtx.fill();
  }

  function getPieceAtSquare(fen, square) {
    if (!fen || !square) return " ";
    const files = { a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, g: 6, h: 7 };
    let rows = fen.split(" ")[0].split("/");
    let expandedRow = "";
    for (let char of rows[8 - parseInt(square[1])] || "") {
      expandedRow += !isNaN(char) ? " ".repeat(parseInt(char)) : char;
    }
    return expandedRow[files[square[0]]] || " ";
  }

  function getActiveColor() {
    // CORREÇÃO: Utilizando o atributo data-ply que é imune à rolagem de tela e virtualização
    const plyNodes = document.querySelectorAll('[data-ply]');
    if (plyNodes.length > 0) {
      const lastPly = parseInt(plyNodes[plyNodes.length - 1].getAttribute('data-ply'), 10);
      return lastPly % 2 === 0 ? "w" : "b";
    }
    return "w"; // Fallback para o lance inicial
  }

  function getFenString() {
    const chessboard = document.querySelector("wc-chess-board");
    if (!chessboard) return "";

    // CORREÇÃO (ANTI-ALUCINAÇÃO): Se houver qualquer peça se movendo na tela, aborta a leitura
    // Assim o FEN gerado nunca terá peças faltando (o que enlouquecia o Stockfish)
    if (chessboard.querySelector(".dragging") || chessboard.querySelector(".animating")) {
      return null;
    }

    let boardArray = Array(8).fill(null).map(() => Array(8).fill(""));

    chessboard.querySelectorAll(".piece").forEach((piece) => {
      // CORREÇÃO: Removido o 'if' que ignorava peças sendo arrastadas/apagadas.
      // Agora o escudo acima garante que a leitura só ocorre quando o tabuleiro está parado.

      let sqClass = Array.from(piece.classList).find((c) => c.startsWith("square-"));
      let pcClass = Array.from(piece.classList).find(
        (c) => c.length === 2 && (c.startsWith("w") || c.startsWith("b"))
      );

      if (sqClass && pcClass) {
        let sq = sqClass.replace("square-", "");
        let file = parseInt(sq[0]) - 1;
        let rank = 8 - parseInt(sq[1]);

        boardArray[rank][file] = pcClass[0] === "w" 
            ? pcClass[1].toUpperCase() 
            : pcClass[1].toLowerCase();
      }
    });

    let fenRows = [];
    for (let i = 0; i < 8; i++) {
      let emptyCount = 0;
      let rowStr = "";

      for (let j = 0; j < 8; j++) {
        if (boardArray[i][j] === "") {
          emptyCount++;
        } else {
          if (emptyCount > 0) {
            rowStr += emptyCount;
            emptyCount = 0;
          }
          rowStr += boardArray[i][j];
        }
      }
      
      if (emptyCount > 0) {
        rowStr += emptyCount;
      }
      fenRows.push(rowStr);
    }

    let boardFen = fenRows.join("/");
    const activeColor = getActiveColor();

    const finalFen = `${boardFen} ${activeColor} KQkq - 0 1`;
    return finalFen;
  }

  // ------------------------------------------------------------------------
  // 4. REDE (O OPERADOR REMOTO VIA WEBSOCKET)
  // ------------------------------------------------------------------------

  // INSTÂNCIA COGNITIVA CRIADA AQUI PARA GARANTIR CONTEXTO AO WEBSOCKET
  const profile = new PlayerProfile(SKILL_TIERS.ADVANCED, "Prático");
  const state = new CognitiveState(TIER_PARAMS[SKILL_TIERS.ADVANCED].timeControlSeconds);

  function initWebSocketEngine() {
    wsEngine = new CleanWebSocket("ws://localhost:8081");

    wsEngine.onopen = () => {
      console.log("[Fantasma] Ligado ao Cérebro Local (Porta 8081).");
      wsEngine.send("uci");
      wsEngine.send("setoption name MultiPV value 8");
    };

    wsEngine.onmessage = (event) => {
      const line = event.data;
      if (line.includes("info depth") && line.includes("multipv")) {
        const cp = line.match(/score cp (-?\d+)/);
        const mate = line.match(/score mate (-?\d+)/);
        const pv = line.match(/ pv ([a-h1-8qrbn]+)/);
        const mpv = line.match(/multipv (\d+)/);

        if ((cp || mate) && pv && mpv) {
          const board = document.querySelector("wc-chess-board");
          if (!board) return;
          let score = mate
            ? parseInt(mate[1]) > 0
              ? 10000 - parseInt(mate[1])
              : -10000 - parseInt(mate[1])
            : parseInt(cp[1]);
            
          // CORREÇÃO: A linha que invertia o score para as pretas foi completamente extirpada.
          // O Stockfish UCI já retorna o score correto em relação ao jogador da vez.

          currentEvals[parseInt(mpv[1]) - 1] = {
            id: parseInt(mpv[1]) - 1,
            move: pv[1],
            score,
            isMate: mate !== null,
          };
        }
      }

      if (line.startsWith("bestmove")) {
        isCalculating = false;
        if (line.includes("(none)")) return;
        
        // CORREÇÃO (Filtro de Turno): Se não for a nossa vez, ignora os lances calculados
        const board = document.querySelector("wc-chess-board");
        if (!board) return;
        
        let isFlipped = board.classList.contains("flipped");
        let activeColor = getActiveColor(); 
        let myColor = isFlipped ? "b" : "w";
        
        if (myColor !== activeColor) {
          currentEvals = [];
          return;
        }

        let validEvals = currentEvals
          .filter((e) => e !== undefined)
          .sort((a, b) => b.score - a.score);

        if (validEvals.length > 0) {
          // CORREÇÃO: Utilizando a base lastStableFen diretamente, 
          // sem sobrescrever a cor ativa e gerar posições inválidas
          let base_fen = lastStableFen;

          const candidates = validEvals.map((cand) => {
            let originSq = cand.move.substring(0, 2);
            let targetSq = cand.move.substring(2, 4);

            let piece = getPieceAtSquare(base_fen, originSq);
            let targetPiece = getPieceAtSquare(base_fen, targetSq);

            let isCapture = targetPiece !== " ";
            let isForward =
              activeColor === "w"
                ? targetSq[1] > originSq[1]
                : targetSq[1] < originSq[1];

            let fileIndex = targetSq.charCodeAt(0) - 97;
            let planTags = [];
            if (fileIndex >= 2 && fileIndex <= 5)
              planTags.push("controleCentro");
            if (
              (activeColor === "w" && fileIndex > 4) ||
              (activeColor === "b" && fileIndex < 3)
            )
              planTags.push("ataqueRei");
            if (fileIndex < 3) planTags.push("minoriaDamas");

            return {
              ...cand,
              pieceName:
                {
                  p: "pawn",
                  n: "knight",
                  b: "bishop",
                  r: "rook",
                  q: "queen",
                  k: "king",
                }[piece.toLowerCase()] || "pawn",
              isPawnMove: piece.toLowerCase() === "p",
              isForward: isForward,
              isCapture: isCapture,
              isAttack: isForward && fileIndex > 4,
              hangsPiece: validEvals[0].score - cand.score > 250,
              opponentThreatAfter: validEvals[0].score - cand.score > 150,
              planTags: planTags,
            };
          });

          const decision = decideMove(candidates, profile, state);

          let delayMs = Math.max(
            50,
            decision.effort.thinkSeconds * 1000 * 0.05,
          );

          CleanSetTimeout(() => {
            drawGhostMove(decision.chosenMove.move, isFlipped);
            console.log(
              `🥷 [Fantasma] Lance escolhido: ${decision.chosenMove.move} | Pensamento: ${decision.effort.thinkSeconds.toFixed(1)}s | Blunder: ${decision.blunderType || "Nenhum"}`,
            );
          }, delayMs);
          
          currentEvals = [];
        }
      }
    };

    wsEngine.onerror = () => {
      console.error(
        "[Fantasma] Erro de conexão! O Servidor (Node.js) está rodando na porta 8081?",
      );
    };

    // CORREÇÃO: Reconexão automática em caso de pequenas falhas de rede (Anti-Desligamento)
    wsEngine.onclose = () => {
      if (isRunning) {
        console.log("🥷 [Fantasma] Conexão caiu. Reconectando...");
        CleanSetTimeout(() => initWebSocketEngine(), 2000);
      }
    };
  }

  function askEngine(fen) {
    if (isCalculating || !wsEngine || wsEngine.readyState !== 1) return;
    currentEvals = [];
    isCalculating = true;
    calculationStartTime = Date.now(); // Marca o tempo do início do cálculo

    // Fallback original mantido caso queira uso futuro
    CleanSetTimeout(() => {
      if (isCalculating) isCalculating = false;
    }, 2000);
    
    wsEngine.send(`position fen ${fen}`);
    wsEngine.send(`go depth 12`);
  }

  // ------------------------------------------------------------------------
  // 5. OBSERVAÇÃO NATIVA DA TELA & PULSO CARDÍACO
  // ------------------------------------------------------------------------
  function startGhostObserver() {
    const board = document.querySelector("wc-chess-board");
    if (!board) return;

    boardObserver = new CleanObserver(() => {
      CleanClearTimeout(perceptionTimeout);

      perceptionTimeout = CleanSetTimeout(
        () => {
          let raw_fen = getFenString();
          
          // Se o FEN retornou null (devido ao escudo anti-alucinação), aborta e tenta depois
          if (!raw_fen || !raw_fen.includes("K") || !raw_fen.includes("k")) return;

          if (raw_fen !== lastStableFen) {
            lastStableFen = raw_fen;
            clearGhostCanvas();
            
            // CORREÇÃO: Só envia para a engine se for estritamente a nossa vez
            let isFlipped = board.classList.contains("flipped");
            let myColor = isFlipped ? "b" : "w";
            
            if (getActiveColor() === myColor) {
               askEngine(raw_fen);
            }
          }
        },
        250 + Math.random() * 200,
      );
    });

    boardObserver.observe(board, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  // CORREÇÃO: Função Heartbeat (Anti-Travamento). Garante que a engine retome se o Observer falhar
  function startHeartbeat() {
    if (!isRunning) return;
    
    const board = document.querySelector("wc-chess-board");
    if (board) {
      let raw_fen = getFenString();
      if (raw_fen && raw_fen.includes("K") && raw_fen !== lastStableFen) {
        lastStableFen = raw_fen;
        clearGhostCanvas();
        
        let isFlipped = board.classList.contains("flipped");
        let myColor = isFlipped ? "b" : "w";
        if (getActiveColor() === myColor) {
          askEngine(raw_fen);
        }
      }
      
      if (!boardObserver) startGhostObserver();
    }
    
    // Destrava a flag se a engine não respondeu a tempo (Prevenção de congelamento eterno)
    if (isCalculating && (Date.now() - calculationStartTime > 3500)) {
      isCalculating = false;
    }
    
    heartbeatInterval = CleanSetTimeout(startHeartbeat, 1000);
  }

  // ------------------------------------------------------------------------
  // 6. GATILHO INVISÍVEL (Alt + A)
  // ------------------------------------------------------------------------
  window.addEventListener("keydown", (e) => {
    if (e.altKey && e.key.toLowerCase() === "a") {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")
        return;

      if (isRunning) {
        if (boardObserver) boardObserver.disconnect();
        if (perceptionTimeout) CleanClearTimeout(perceptionTimeout);
        if (heartbeatInterval) CleanClearTimeout(heartbeatInterval);
        if (wsEngine) wsEngine.close();
        clearGhostCanvas();
        isRunning = false;
        console.log("🥷 [Fantasma] Desativado.");
      } else {
        isRunning = true;
        initWebSocketEngine();
        window.addEventListener("resize", updateCanvasSize);
        window.addEventListener("scroll", updateCanvasSize);
        startGhostObserver();
        startHeartbeat(); // Inicia o seguro contra desligamentos
        
        const board = document.querySelector("wc-chess-board");
        
        if (board) {
          CleanSetTimeout(
            () => {
               let fen = getFenString();
               if (fen) askEngine(fen);
            },
            500,
          );
        }
        console.log("🥷 [Fantasma] Operando nas sombras (Blindado).");
      }
    }
  });

  console.log(
    "🥷 Injeção concluída. Pressione Alt + A para sincronizar com o Servidor Local.",
  );
})();