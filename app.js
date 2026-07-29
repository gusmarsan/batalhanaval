import { initializeApp } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  collection,
  getDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCtZKE8YL2xC0hj0eWWrtGsuYCLEleLjoQ",
  authDomain: "batalha-naval-gus.firebaseapp.com",
  projectId: "batalha-naval-gus",
  storageBucket: "batalha-naval-gus.firebasestorage.app",
  messagingSenderId: "530937327103",
  appId: "1:530937327103:web:ab1bd4538f1af6c2b70bca"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const BOARD_SIZE = 10;
const ROOM_PREFIX = "MAR";
const STORAGE = {
  nickname: "batalha-naval-nickname",
  room: "batalha-naval-room",
  sound: "batalha-naval-sound"
};

const FLEET = [
  { id: "carrier", name: "Porta-aviões", size: 5 },
  { id: "battleship", name: "Encouraçado", size: 4 },
  { id: "cruiser", name: "Cruzador", size: 3 },
  { id: "destroyer-1", name: "Contratorpedeiro 1", size: 2 },
  { id: "destroyer-2", name: "Contratorpedeiro 2", size: 2 },
  { id: "submarine-1", name: "Submarino 1", size: 1 },
  { id: "submarine-2", name: "Submarino 2", size: 1 }
];

const state = {
  user: null,
  roomCode: null,
  room: null,
  ownBoard: null,
  shots: [],
  placement: [],
  selectedShipId: FLEET[0].id,
  orientation: "horizontal",
  hoverCoordinate: null,
  roomUnsubscribe: null,
  boardUnsubscribe: null,
  shotsUnsubscribe: null,
  resolvingShots: new Set(),
  startingRematch: false,
  busy: false,
  sound: localStorage.getItem(STORAGE.sound) !== "off"
};

const el = {
  app: document.querySelector("#app"),
  toast: document.querySelector("#toast"),
  soundButton: document.querySelector("#soundButton"),
  dialog: document.querySelector("#confirmDialog"),
  dialogTitle: document.querySelector("#dialogTitle"),
  dialogText: document.querySelector("#dialogText")
};

let toastTimer;
let audioContext;
let cachedNoiseBuffer;

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message, type = "") {
  clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.className = `toast show ${type}`.trim();
  toastTimer = setTimeout(() => {
    el.toast.className = "toast";
  }, 3200);
}

function getErrorMessage(error) {
  const code = error?.code || "";
  const messages = {
    "auth/operation-not-allowed": "Ative o acesso Anônimo em Authentication > Sign-in method no Firebase.",
    "auth/unauthorized-domain": "Autorize este domínio em Authentication > Settings > Authorized domains.",
    "auth/api-key-not-valid.-please-pass-a-valid-api-key.": "A chave pública do Firebase não foi aceita.",
    "permission-denied": "O Firebase bloqueou esta ação. Confira e publique as regras do Firestore.",
    "firestore/permission-denied": "O Firebase bloqueou esta ação. Confira e publique as regras do Firestore.",
    "unavailable": "O Firebase está temporariamente indisponível. Confira a conexão e tente novamente.",
    "firestore/unavailable": "O Firebase está temporariamente indisponível. Confira a conexão e tente novamente."
  };
  return messages[code] || error?.message || "Não foi possível concluir a ação.";
}

function ensureAudioContext() {
  audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
  return audioContext;
}

function getNoiseBuffer() {
  const context = ensureAudioContext();
  if (cachedNoiseBuffer && cachedNoiseBuffer.sampleRate === context.sampleRate) {
    return cachedNoiseBuffer;
  }
  const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < channel.length; index += 1) {
    channel[index] = Math.random() * 2 - 1;
  }
  cachedNoiseBuffer = buffer;
  return cachedNoiseBuffer;
}

function playOscillator({ frequency = 330, type = "sine", duration = .08, gain = .03, attack = .002, release = duration } = {}) {
  const context = ensureAudioContext();
  const oscillator = context.createOscillator();
  const gainNode = context.createGain();
  const now = context.currentTime;
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, now);
  gainNode.gain.setValueAtTime(.0001, now);
  gainNode.gain.linearRampToValueAtTime(gain, now + attack);
  gainNode.gain.exponentialRampToValueAtTime(.0001, now + release);
  oscillator.connect(gainNode).connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + duration);
}

function playNoise({ duration = .2, gain = .03, filterType = "lowpass", frequency = 900, q = .0001, attack = .005, release = duration } = {}) {
  const context = ensureAudioContext();
  const source = context.createBufferSource();
  source.buffer = getNoiseBuffer();
  const filter = context.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.setValueAtTime(frequency, context.currentTime);
  filter.Q.setValueAtTime(q, context.currentTime);
  const gainNode = context.createGain();
  const now = context.currentTime;
  gainNode.gain.setValueAtTime(.0001, now);
  gainNode.gain.linearRampToValueAtTime(gain, now + attack);
  gainNode.gain.exponentialRampToValueAtTime(.0001, now + release);
  source.connect(filter).connect(gainNode).connect(context.destination);
  source.start(now);
  source.stop(now + duration);
}

function playTone(kind = "tap") {
  if (!state.sound) return;
  try {
    if (kind === "tap") {
      playOscillator({ frequency: 320, type: "sine", duration: .05, gain: .018, release: .05 });
      return;
    }

    if (kind === "miss") {
      playNoise({ duration: .34, gain: .018, filterType: "lowpass", frequency: 620, q: .3, attack: .01, release: .34 });
      playOscillator({ frequency: 210, type: "sine", duration: .18, gain: .008, release: .18 });
      return;
    }

    if (kind === "hit") {
      playNoise({ duration: .16, gain: .028, filterType: "bandpass", frequency: 920, q: 1.4, attack: .002, release: .16 });
      playOscillator({ frequency: 92, type: "triangle", duration: .12, gain: .014, release: .12 });
      return;
    }

    if (kind === "sunk") {
      playNoise({ duration: .28, gain: .032, filterType: "bandpass", frequency: 780, q: 1.1, attack: .002, release: .28 });
      playOscillator({ frequency: 84, type: "triangle", duration: .2, gain: .016, release: .2 });
      playOscillator({ frequency: 150, type: "sine", duration: .16, gain: .01, release: .16 });
      return;
    }

    if (kind === "win") {
      playOscillator({ frequency: 554, type: "triangle", duration: .12, gain: .02, release: .12 });
      setTimeout(() => playOscillator({ frequency: 740, type: "triangle", duration: .18, gain: .024, release: .18 }), 110);
      setTimeout(() => playOscillator({ frequency: 880, type: "triangle", duration: .26, gain: .026, release: .26 }), 240);
      return;
    }
  } catch {
    // Sons são opcionais.
  }
}

function setBusy(value) {
  state.busy = value;
  document.body.setAttribute("aria-busy", String(value));
  document.querySelectorAll("button").forEach((button) => {
    if (button.dataset.keepEnabled === "true") return;
    if (value) {
      button.dataset.disabledBeforeBusy = button.disabled ? "true" : "false";
      button.disabled = true;
    } else if ("disabledBeforeBusy" in button.dataset) {
      button.disabled = button.dataset.disabledBeforeBusy === "true";
      delete button.dataset.disabledBeforeBusy;
    }
  });
}

function normalizeCode(value) {
  const digits = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (digits.startsWith(ROOM_PREFIX)) {
    return `${ROOM_PREFIX}-${digits.slice(ROOM_PREFIX.length, ROOM_PREFIX.length + 3)}`;
  }
  return `${ROOM_PREFIX}-${digits.replace(/\D/g, "").slice(0, 3)}`;
}

function coordinate(row, col) {
  return `${String.fromCharCode(65 + col)}${row + 1}`;
}

function parseCoordinate(value) {
  const col = value.charCodeAt(0) - 65;
  const row = Number(value.slice(1)) - 1;
  return { row, col };
}

function currentPlayerKey(room = state.room) {
  if (!room || !state.user) return null;
  if (room.player1?.uid === state.user.uid) return "player1";
  if (room.player2?.uid === state.user.uid) return "player2";
  return null;
}

function opponentPlayerKey(room = state.room) {
  const key = currentPlayerKey(room);
  return key === "player1" ? "player2" : key === "player2" ? "player1" : null;
}

function currentPlayer(room = state.room) {
  return room?.[currentPlayerKey(room)] || null;
}

function opponentPlayer(room = state.room) {
  return room?.[opponentPlayerKey(room)] || null;
}

function roomRef(code = state.roomCode) {
  return doc(db, "battleshipRooms", code);
}

function ownBoardRef(code = state.roomCode) {
  return doc(db, "battleshipRooms", code, "players", state.user.uid);
}

function shotsRef(code = state.roomCode) {
  return collection(db, "battleshipRooms", code, "shots");
}

function makePlayer(name, uid) {
  return {
    uid,
    name: name.trim().slice(0, 24),
    ready: false,
    shipsRemaining: FLEET.length,
    rematch: false
  };
}

function cleanNickname(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 24);
}

function blankPlacement() {
  return FLEET.map((ship) => ({ ...ship, cells: [], hits: [] }));
}

function inferOrientationFromCells(cells = []) {
  if (cells.length <= 1) return "horizontal";
  const first = parseCoordinate(cells[0]);
  const second = parseCoordinate(cells[1]);
  return first.row === second.row ? "horizontal" : "vertical";
}

function segmentType(index, size) {
  if (size <= 1) return "solo";
  if (index === 0) return "bow";
  if (index === size - 1) return "stern";
  return "mid";
}

function buildCellShapeMap(cells = [], orientation = "horizontal") {
  return new Map(cells.map((cell, index) => [
    cell,
    {
      orientation,
      segment: segmentType(index, cells.length),
      size: cells.length
    }
  ]));
}

function buildShipCellMap(ships = []) {
  const map = new Map();
  for (const ship of ships) {
    const cells = ship.cells || [];
    const orientation = ship.orientation || inferOrientationFromCells(cells);
    cells.forEach((cell, index) => {
      map.set(cell, {
        shipId: ship.id,
        shipName: ship.name,
        orientation,
        segment: segmentType(index, cells.length),
        size: cells.length
      });
    });
  }
  return map;
}

function getPlacedShip(shipId) {
  return state.placement.find((ship) => ship.id === shipId);
}

function occupiedCells(exceptShipId = null) {
  return new Set(
    state.placement
      .filter((ship) => ship.id !== exceptShipId)
      .flatMap((ship) => ship.cells)
  );
}

function cellsForPlacement(startCoordinate, ship, orientation = state.orientation) {
  const { row, col } = parseCoordinate(startCoordinate);
  return Array.from({ length: ship.size }, (_, index) => {
    const nextRow = orientation === "vertical" ? row + index : row;
    const nextCol = orientation === "horizontal" ? col + index : col;
    if (nextRow >= BOARD_SIZE || nextCol >= BOARD_SIZE) return null;
    return coordinate(nextRow, nextCol);
  });
}

function placementIsValid(cells, shipId) {
  if (cells.some((cell) => !cell)) return false;
  const occupied = occupiedCells(shipId);
  return cells.every((cell) => !occupied.has(cell));
}

function allShipsPlaced() {
  return state.placement.every((ship) => ship.cells.length === ship.size);
}

function chooseNextShip() {
  const next = state.placement.find((ship) => ship.cells.length === 0);
  state.selectedShipId = next?.id || state.selectedShipId;
}

function autoPlaceFleet() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const placement = blankPlacement();
    let failed = false;
    for (const ship of placement) {
      let placed = false;
      for (let tryCount = 0; tryCount < 200; tryCount += 1) {
        const orientation = Math.random() > .5 ? "horizontal" : "vertical";
        const maxRow = orientation === "vertical" ? BOARD_SIZE - ship.size : BOARD_SIZE - 1;
        const maxCol = orientation === "horizontal" ? BOARD_SIZE - ship.size : BOARD_SIZE - 1;
        const row = Math.floor(Math.random() * (maxRow + 1));
        const col = Math.floor(Math.random() * (maxCol + 1));
        const cells = Array.from({ length: ship.size }, (_, index) =>
          coordinate(
            orientation === "vertical" ? row + index : row,
            orientation === "horizontal" ? col + index : col
          )
        );
        const occupied = new Set(placement.flatMap((item) => item.cells));
        if (cells.every((cell) => !occupied.has(cell))) {
          ship.cells = cells;
          ship.orientation = orientation;
          placed = true;
          break;
        }
      }
      if (!placed) {
        failed = true;
        break;
      }
    }
    if (!failed) {
      state.placement = placement;
      state.selectedShipId = placement[0].id;
      render();
      playTone("tap");
      return;
    }
  }
  showToast("Não foi possível posicionar a frota automaticamente.", "error");
}

function createBoardHtml({ mode, ships = [], shots = [], disabled = false }) {
  const shipCellMap = buildShipCellMap(ships);
  const shotMap = new Map(shots.map((shot) => [shot.coordinate, shot]));
  const selectedShip = getPlacedShip(state.selectedShipId) || FLEET[0];
  const previewCells = mode === "placement" && state.hoverCoordinate
    ? cellsForPlacement(state.hoverCoordinate, selectedShip)
    : [];
  const previewValid = placementIsValid(previewCells, selectedShip.id);
  const previewShapeMap = buildCellShapeMap(previewCells.filter(Boolean), state.orientation);

  const cells = [];
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const coord = coordinate(row, col);
      const shot = shotMap.get(coord);
      const shipMeta = shipCellMap.get(coord);
      const previewMeta = !shipMeta ? previewShapeMap.get(coord) : null;
      const shapeMeta = shipMeta || previewMeta;
      const classes = ["cell"];
      if ((mode === "own" || mode === "placement") && shipMeta) classes.push("ship");
      if (previewMeta) classes.push(previewValid ? "preview-valid" : "preview-invalid");
      if (shot?.result === "miss") classes.push("miss");
      if (shot?.result === "hit") classes.push("hit");
      if (shot?.result === "sunk") classes.push("sunk");
      if (!shot?.result && shot?.status === "pending") classes.push("pending");
      if (shapeMeta?.segment) classes.push(`segment-${shapeMeta.segment}`);
      if (shapeMeta?.orientation) classes.push(`orientation-${shapeMeta.orientation}`);
      const unavailable = mode === "attack" && shot;
      cells.push(`
        <button
          type="button"
          class="${classes.join(" ")}"
          data-coordinate="${coord}"
          ${shapeMeta?.segment ? `data-segment="${shapeMeta.segment}"` : ""}
          ${shapeMeta?.orientation ? `data-orientation="${shapeMeta.orientation}"` : ""}
          ${shapeMeta?.size ? `data-size="${shapeMeta.size}"` : ""}
          aria-label="Casa ${coord}${shot?.result ? `: ${shot.result}` : ""}"
          ${disabled || unavailable ? "disabled" : ""}
        ></button>
      `);
    }
  }

  const boardClasses = ["board"];
  if (disabled) boardClasses.push("disabled");
  if (mode === "attack" && !disabled) boardClasses.push("attack-ready");

  return `
    <div class="board-shell">
      <div class="board-corner"></div>
      <div class="column-labels">${Array.from({ length: 10 }, (_, index) => `<span>${String.fromCharCode(65 + index)}</span>`).join("")}</div>
      <div class="row-labels">${Array.from({ length: 10 }, (_, index) => `<span>${index + 1}</span>`).join("")}</div>
      <div class="${boardClasses.join(" ")}" data-board-mode="${mode}">${cells.join("")}</div>
    </div>
  `;
}

function roomHeaderHtml(title, description) {
  return `
    <div class="room-header">
      <div>
        <p class="eyebrow">Rodada ${state.room?.round || 1}</p>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(description)}</p>
      </div>
      <div class="room-code-box">
        <div><span>Código da sala</span><strong>${escapeHtml(state.roomCode)}</strong></div>
        <button class="button secondary small" type="button" data-action="copy-code">Copiar</button>
      </div>
    </div>
  `;
}

function playerStatusHtml(player, key) {
  const isMe = key === currentPlayerKey();
  const isTurn = state.room?.turnUid === player?.uid;
  const status = !player
    ? "Aguardando jogador"
    : state.room.status === "finished"
      ? `${player.shipsRemaining ?? 0} navio(s) restante(s)`
      : player.ready
        ? "Frota pronta"
        : "Posicionando a frota";
  return `
    <div class="player-card ${isMe ? "me" : ""} ${isTurn ? "active" : ""}">
      <div class="name">
        <span>${player ? escapeHtml(player.name) : "Vaga disponível"}${isMe ? " (você)" : ""}</span>
        <i class="status-dot ${player?.ready ? "ready" : ""}"></i>
      </div>
      <small>${status}</small>
    </div>
  `;
}

function statusStripHtml() {
  return `
    <div class="status-strip">
      ${playerStatusHtml(state.room.player1, "player1")}
      <div class="vs">VS</div>
      ${playerStatusHtml(state.room.player2, "player2")}
    </div>
  `;
}

function renderHome() {
  const nickname = localStorage.getItem(STORAGE.nickname) || "";
  const lastRoom = localStorage.getItem(STORAGE.room);
  const invitedCode = normalizeCode(new URLSearchParams(window.location.search).get("sala") || "");
  const validInvitedCode = /^MAR-\d{3}$/.test(invitedCode) ? invitedCode : "";
  el.app.innerHTML = `
    <section class="card hero">
      <div class="hero-copy">
        <p class="eyebrow">Dois jogadores · tempo real</p>
        <h1>Prepare a frota.<br>Domine o oceano.</h1>
        <p>Crie uma sala privada, compartilhe o código e enfrente outra pessoa pelo celular ou computador.</p>
        <div class="feature-pills">
          <span class="pill">Tabuleiro 10 × 10</span>
          <span class="pill">7 embarcações</span>
          <span class="pill">Turnos online</span>
          <span class="pill">Revanche</span>
        </div>
      </div>

      <div class="home-actions">
        <h2>Começar partida</h2>
        <div class="field">
          <label for="nickname">Seu nome</label>
          <input id="nickname" class="input" maxlength="24" autocomplete="nickname" value="${escapeHtml(nickname)}" placeholder="Digite seu nome">
        </div>
        <div class="action-stack">
          <button class="button full" type="button" data-action="create-room">Criar sala</button>
        </div>
        <div class="divider">ou entre em uma sala</div>
        <div class="inline-action">
          <input id="roomCode" class="input code" maxlength="7" inputmode="numeric" value="${escapeHtml(validInvitedCode)}" placeholder="MAR-000" aria-label="Código da sala">
          <button class="button secondary" type="button" data-action="join-room">Entrar</button>
        </div>
        ${lastRoom ? `
          <div class="resume-box">
            <div><strong>Última sala: ${escapeHtml(lastRoom)}</strong><small>Continue caso a partida ainda esteja ativa.</small></div>
            <button class="button ghost small" type="button" data-action="resume-room" data-room="${escapeHtml(lastRoom)}">Retomar</button>
          </div>
        ` : ""}
      </div>
    </section>
  `;
}

function renderWaiting() {
  el.app.innerHTML = `
    ${roomHeaderHtml("Sala criada", "Compartilhe o código para iniciar o duelo")}
    ${statusStripHtml()}
    <section class="card game-card waiting-screen">
      <div>
        <div class="waiting-radar"><div class="radar-sweep"></div></div>
        <h2>Aguardando o adversário</h2>
        <p>Envie o código <strong>${escapeHtml(state.roomCode)}</strong>. Assim que a outra pessoa entrar, os dois poderão posicionar a frota.</p>
        <div class="waiting-actions">
          <button class="button" type="button" data-action="share-room">Compartilhar convite</button>
          <button class="button secondary" type="button" data-action="copy-code">Copiar código</button>
          <button class="button ghost" type="button" data-action="leave-room">Voltar</button>
        </div>
      </div>
    </section>
  `;
}

function renderPlacement() {
  const me = currentPlayer();
  const isReady = Boolean(me?.ready);
  const ships = isReady ? (state.ownBoard?.ships || []) : state.placement;
  el.app.innerHTML = `
    ${roomHeaderHtml("Organize sua frota", isReady ? "Frota confirmada. Aguarde o adversário." : "Posicione todas as embarcações antes de confirmar")}
    ${statusStripHtml()}
    <section class="card game-card">
      <div class="game-message">
        <div>
          <strong>${isReady ? "Frota pronta" : "Escolha uma embarcação"}</strong>
          <span>${isReady ? "A posição está protegida e não pode mais ser alterada nesta rodada." : "Clique em uma casa para definir o início do navio."}</span>
        </div>
        <span class="turn-badge ${isReady ? "waiting" : ""}">${isReady ? "Aguardando" : `${ships.filter((ship) => ship.cells?.length).length}/${FLEET.length} posicionados`}</span>
      </div>

      <div class="placement-layout">
        <div class="board-wrap">
          <div class="board-title">
            <div><h2>Minha frota</h2><p>Linhas 1–10 · colunas A–J</p></div>
          </div>
          ${createBoardHtml({ mode: isReady ? "own" : "placement", ships, disabled: isReady })}
        </div>

        <aside class="fleet-panel">
          <h2>Embarcações</h2>
          <p>${isReady ? "Todas as embarcações foram posicionadas." : "Selecione, gire e posicione cada item da frota."}</p>
          <div class="fleet-list">
            ${FLEET.map((ship) => {
              const placed = ships.find((item) => item.id === ship.id)?.cells?.length === ship.size;
              return `
                <button type="button" class="ship-option ${state.selectedShipId === ship.id ? "selected" : ""} ${placed ? "placed" : ""}" data-action="select-ship" data-ship="${ship.id}" ${isReady ? "disabled" : ""}>
                  <span><strong>${ship.name}</strong><small>${ship.size} ${ship.size === 1 ? "casa" : "casas"}</small></span>
                  <span class="ship-mini">${Array.from({ length: ship.size }, () => "<i></i>").join("")}</span>
                </button>
              `;
            }).join("")}
          </div>
          <div class="panel-actions">
            <button class="button secondary small" type="button" data-action="rotate" ${isReady ? "disabled" : ""}>${state.orientation === "horizontal" ? "↔ Horizontal" : "↕ Vertical"}</button>
            <button class="button secondary small" type="button" data-action="auto-place" ${isReady ? "disabled" : ""}>Posicionar automático</button>
            <button class="button ghost small" type="button" data-action="clear-placement" ${isReady ? "disabled" : ""}>Limpar</button>
            <button class="button success small" type="button" data-action="confirm-fleet" ${isReady || !allShipsPlaced() ? "disabled" : ""}>Confirmar frota</button>
            <button class="button ghost small full-row" type="button" data-action="leave-room">Sair da sala</button>
          </div>
        </aside>
      </div>
    </section>
  `;
}

function shotResultLabel(shot) {
  if (shot.status === "pending") return "aguardando";
  if (shot.result === "miss") return "água";
  if (shot.result === "hit") return "acertou";
  if (shot.result === "sunk") return "afundou";
  return "tiro";
}

function gameMessage() {
  const isMyTurn = state.room.turnUid === state.user.uid;
  if (state.room.pendingShotId) {
    const pending = state.shots.find((shot) => shot.id === state.room.pendingShotId);
    if (pending?.attackerUid === state.user.uid) {
      return { title: `Tiro em ${pending.coordinate}`, text: "Aguardando o adversário revelar o resultado.", badge: "Aguardando", className: "waiting" };
    }
    return { title: "Ataque recebido", text: "Conferindo o resultado do tiro adversário.", badge: "Processando", className: "waiting" };
  }
  if (isMyTurn) return { title: "Sua vez de atacar", text: "Escolha uma casa no tabuleiro adversário.", badge: "Seu turno", className: "" };
  return { title: `Vez de ${opponentPlayer()?.name || "adversário"}`, text: "Aguarde o próximo ataque.", badge: "Aguardando", className: "waiting" };
}

function renderBattle() {
  const me = currentPlayer();
  const opponent = opponentPlayer();
  const ownShots = state.shots.filter((shot) => shot.defenderUid === state.user.uid && shot.round === state.room.round);
  const attackShots = state.shots.filter((shot) => shot.attackerUid === state.user.uid && shot.round === state.room.round);
  const isMyTurn = state.room.turnUid === state.user.uid && !state.room.pendingShotId;
  const message = gameMessage();
  const recentShots = [...state.shots]
    .filter((shot) => shot.round === state.room.round)
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
    .slice(0, 8);

  el.app.innerHTML = `
    ${roomHeaderHtml("Batalha em andamento", "Destrua toda a frota adversária")}
    ${statusStripHtml()}
    <section class="card game-card">
      <div class="game-message">
        <div><strong>${escapeHtml(message.title)}</strong><span>${escapeHtml(message.text)}</span></div>
        <span class="turn-badge ${message.className}">${escapeHtml(message.badge)}</span>
      </div>

      <div class="battle-layout">
        <div class="battle-board-card">
          <div class="board-title">
            <div><h2>Área de ataque</h2><p>${escapeHtml(opponent?.name || "Adversário")} · ${opponent?.shipsRemaining ?? FLEET.length} navio(s) restante(s)</p></div>
          </div>
          ${createBoardHtml({ mode: "attack", shots: attackShots, disabled: !isMyTurn })}
          <div class="legend"><span><i class="water"></i> Água</span><span><i class="hit"></i> Acerto</span></div>
        </div>

        <div class="battle-board-card">
          <div class="board-title">
            <div><h2>Minha frota</h2><p>${escapeHtml(me?.name || "Você")} · ${me?.shipsRemaining ?? FLEET.length} navio(s) restante(s)</p></div>
          </div>
          ${createBoardHtml({ mode: "own", ships: state.ownBoard?.ships || [], shots: ownShots, disabled: true })}
          <div class="legend"><span><i class="ship"></i> Embarcação</span><span><i class="water"></i> Água</span><span><i class="hit"></i> Acerto</span></div>
        </div>
      </div>

      <div class="history">
        <h3>Últimos tiros</h3>
        ${recentShots.length ? `<div class="history-list">${recentShots.map((shot) => {
          const attacker = shot.attackerUid === state.room.player1.uid ? state.room.player1 : state.room.player2;
          return `<div class="history-item"><strong>${escapeHtml(attacker?.name || "Jogador")}</strong> em ${shot.coordinate}: ${shotResultLabel(shot)}</div>`;
        }).join("")}</div>` : `<div class="empty-note">Nenhum tiro disparado ainda.</div>`}
      </div>

      <div class="waiting-actions">
        <button class="button ghost small" type="button" data-action="copy-code">Copiar código</button>
        <button class="button danger small" type="button" data-action="forfeit">Desistir</button>
      </div>
    </section>
  `;
}

function renderResult() {
  const won = state.room.winnerUid === state.user.uid;
  const meKey = currentPlayerKey();
  const me = currentPlayer();
  const opponent = opponentPlayer();
  const myRematch = Boolean(me?.rematch);
  const opponentRematch = Boolean(opponent?.rematch);
  el.app.innerHTML = `
    ${roomHeaderHtml("Fim da batalha", won ? "Vitória confirmada" : "A frota foi destruída")}
    ${statusStripHtml()}
    <section class="card result-card ${won ? "" : "lost"}">
      <div class="result-icon">${won ? "🏆" : "🌊"}</div>
      <h2>${won ? "Você venceu!" : `${escapeHtml(opponent?.name || "O adversário")} venceu`}</h2>
      <p>${won ? "Toda a frota adversária foi afundada. O oceano é seu." : "Sua frota foi afundada, mas a sala continua aberta para uma revanche."}</p>
      <div class="result-actions">
        <button class="button ${myRematch ? "secondary" : "success"}" type="button" data-action="rematch" ${myRematch ? "disabled" : ""}>${myRematch ? "Revanche aceita" : "Pedir revanche"}</button>
        <button class="button ghost" type="button" data-action="leave-room">Sair da sala</button>
      </div>
      <div class="rematch-status">
        ${myRematch && opponentRematch ? "Preparando uma nova rodada…" : opponentRematch ? `${escapeHtml(opponent?.name || "O adversário")} pediu revanche.` : myRematch ? "Aguardando o adversário aceitar a revanche." : ""}
      </div>
    </section>
  `;
}

function renderError(error) {
  el.app.innerHTML = `
    <section class="card error-card">
      <p class="eyebrow">Configuração necessária</p>
      <h1>Não foi possível iniciar o jogo</h1>
      <p>${escapeHtml(getErrorMessage(error))}</p>
      <div class="error-code">${escapeHtml(error?.code || error?.message || "Erro desconhecido")}</div>
      <div class="waiting-actions" style="justify-content:flex-start">
        <button class="button" type="button" data-action="reload">Tentar novamente</button>
      </div>
    </section>
  `;
}

function render() {
  if (!state.user) return;
  if (!state.roomCode || !state.room) {
    renderHome();
    return;
  }
  if (!currentPlayerKey()) {
    showToast("Esta sala já está ocupada por outros jogadores.", "error");
    leaveRoom(false);
    return;
  }
  if (!state.room.player2 || state.room.status === "waiting") {
    renderWaiting();
    return;
  }
  if (state.room.status === "placing") {
    renderPlacement();
    return;
  }
  if (state.room.status === "playing") {
    renderBattle();
    return;
  }
  if (state.room.status === "finished") {
    renderResult();
    return;
  }
  renderWaiting();
}

function resetRoomSubscriptions() {
  state.roomUnsubscribe?.();
  state.boardUnsubscribe?.();
  state.shotsUnsubscribe?.();
  state.roomUnsubscribe = null;
  state.boardUnsubscribe = null;
  state.shotsUnsubscribe = null;
  state.room = null;
  state.ownBoard = null;
  state.shots = [];
  state.resolvingShots.clear();
}

async function createRoom(name) {
  const nickname = cleanNickname(name);
  if (!nickname) {
    showToast("Digite seu nome para criar a sala.", "error");
    return;
  }
  setBusy(true);
  try {
    localStorage.setItem(STORAGE.nickname, nickname);
    let createdCode = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = `${ROOM_PREFIX}-${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
      try {
        await runTransaction(db, async (transaction) => {
          const ref = roomRef(code);
          const snapshot = await transaction.get(ref);
          if (snapshot.exists()) throw new Error("ROOM_EXISTS");
          transaction.set(ref, {
            code,
            status: "waiting",
            round: 1,
            player1: makePlayer(nickname, state.user.uid),
            player2: null,
            turnUid: null,
            winnerUid: null,
            pendingShotId: null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
        });
        createdCode = code;
        break;
      } catch (error) {
        if (error.message !== "ROOM_EXISTS") throw error;
      }
    }
    if (!createdCode) throw new Error("Não foi possível gerar um código livre.");
    await enterRoom(createdCode);
    showToast("Sala criada. Compartilhe o código!", "success");
  } catch (error) {
    showToast(getErrorMessage(error), "error");
  } finally {
    setBusy(false);
  }
}

async function joinRoom(codeValue, name) {
  const nickname = cleanNickname(name);
  const code = normalizeCode(codeValue);
  if (!nickname) {
    showToast("Digite seu nome para entrar na sala.", "error");
    return;
  }
  if (!/^MAR-\d{3}$/.test(code)) {
    showToast("Digite um código no formato MAR-000.", "error");
    return;
  }
  setBusy(true);
  try {
    localStorage.setItem(STORAGE.nickname, nickname);
    const ref = roomRef(code);
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists()) throw new Error("ROOM_NOT_FOUND");
      const room = snapshot.data();
      const alreadyPlayer = room.player1?.uid === state.user.uid || room.player2?.uid === state.user.uid;
      if (alreadyPlayer) return;
      if (room.player2) throw new Error("ROOM_FULL");
      transaction.update(ref, {
        player2: makePlayer(nickname, state.user.uid),
        status: "placing",
        updatedAt: serverTimestamp()
      });
    });
    await enterRoom(code);
    showToast("Você entrou na sala.", "success");
  } catch (error) {
    const message = error.message === "ROOM_NOT_FOUND"
      ? "Sala não encontrada. Confira o código."
      : error.message === "ROOM_FULL"
        ? "Esta sala já tem dois jogadores."
        : getErrorMessage(error);
    showToast(message, "error");
  } finally {
    setBusy(false);
  }
}

async function resumeRoom(codeValue) {
  const code = normalizeCode(codeValue);
  setBusy(true);
  try {
    const snapshot = await getDoc(roomRef(code));
    if (!snapshot.exists()) throw new Error("ROOM_NOT_FOUND");
    const room = snapshot.data();
    const isParticipant = room.player1?.uid === state.user.uid || room.player2?.uid === state.user.uid;
    if (!isParticipant) throw new Error("NOT_PARTICIPANT");
    await enterRoom(code);
  } catch (error) {
    localStorage.removeItem(STORAGE.room);
    showToast(
      error.message === "ROOM_NOT_FOUND"
        ? "A última sala não existe mais."
        : error.message === "NOT_PARTICIPANT"
          ? "Este navegador não pertence à última sala."
          : getErrorMessage(error),
      "error"
    );
    renderHome();
  } finally {
    setBusy(false);
  }
}

async function enterRoom(code) {
  resetRoomSubscriptions();
  state.roomCode = code;
  state.placement = blankPlacement();
  state.selectedShipId = FLEET[0].id;
  state.orientation = "horizontal";
  localStorage.setItem(STORAGE.room, code);

  state.roomUnsubscribe = onSnapshot(roomRef(code), (snapshot) => {
    if (!snapshot.exists()) {
      showToast("A sala foi encerrada.", "error");
      leaveRoom(false);
      return;
    }
    const previousStatus = state.room?.status;
    const previousWinner = state.room?.winnerUid;
    state.room = { id: snapshot.id, ...snapshot.data() };

    if (state.room.status === "placing" && previousStatus !== "placing") {
      state.placement = blankPlacement();
      state.selectedShipId = FLEET[0].id;
    }
    if (state.room.status === "finished" && previousStatus !== "finished" && previousWinner !== state.room.winnerUid) {
      playTone(state.room.winnerUid === state.user.uid ? "win" : "sunk");
    }
    render();
    maybeStartRematch();
  }, (error) => {
    showToast(getErrorMessage(error), "error");
  });

  state.boardUnsubscribe = onSnapshot(ownBoardRef(code), (snapshot) => {
    state.ownBoard = snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
    if (state.ownBoard?.round === state.room?.round) {
      state.placement = state.ownBoard.ships || blankPlacement();
    }
    render();
    resolvePendingShots();
  }, (error) => {
    if (error.code !== "permission-denied") showToast(getErrorMessage(error), "error");
  });

  state.shotsUnsubscribe = onSnapshot(shotsRef(code), (snapshot) => {
    const previous = new Map(state.shots.map((shot) => [shot.id, shot]));
    state.shots = snapshot.docs.map((shotDoc) => ({ id: shotDoc.id, ...shotDoc.data() }));
    for (const shot of state.shots) {
      const before = previous.get(shot.id);
      if (before?.status === "pending" && shot.status === "resolved" && shot.attackerUid === state.user.uid) {
        playTone(shot.result === "miss" ? "miss" : shot.result === "sunk" ? "sunk" : "hit");
        showToast(
          shot.result === "miss" ? `Água em ${shot.coordinate}.` : shot.result === "sunk" ? `${shot.shipName || "Navio"} afundado!` : `Acerto em ${shot.coordinate}!`,
          shot.result === "miss" ? "" : "success"
        );
      }
    }
    render();
    resolvePendingShots();
  }, (error) => {
    showToast(getErrorMessage(error), "error");
  });
}

function leaveRoom(showMessage = true) {
  resetRoomSubscriptions();
  state.roomCode = null;
  localStorage.removeItem(STORAGE.room);
  renderHome();
  if (showMessage) showToast("Você saiu da sala.");
}

async function confirmFleet() {
  if (!allShipsPlaced() || state.room?.status !== "placing") return;
  setBusy(true);
  try {
    const playerKey = currentPlayerKey();
    const ships = state.placement.map((ship) => ({
      id: ship.id,
      name: ship.name,
      size: ship.size,
      orientation: ship.orientation || inferOrientationFromCells(ship.cells),
      cells: [...ship.cells],
      hits: []
    }));
    await setDoc(ownBoardRef(), {
      uid: state.user.uid,
      round: state.room.round,
      ships,
      updatedAt: serverTimestamp()
    });

    await runTransaction(db, async (transaction) => {
      const ref = roomRef();
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists()) throw new Error("ROOM_NOT_FOUND");
      const room = snapshot.data();
      const me = room[playerKey];
      if (!me || room.status !== "placing") return;
      const updatedMe = { ...me, ready: true, shipsRemaining: FLEET.length };
      const otherKey = playerKey === "player1" ? "player2" : "player1";
      const other = room[otherKey];
      const bothReady = Boolean(updatedMe.ready && other?.ready);
      transaction.update(ref, {
        [playerKey]: updatedMe,
        status: bothReady ? "playing" : "placing",
        turnUid: bothReady ? room.player1.uid : null,
        pendingShotId: null,
        updatedAt: serverTimestamp()
      });
    });
    playTone("tap");
    showToast("Frota confirmada.", "success");
  } catch (error) {
    showToast(getErrorMessage(error), "error");
  } finally {
    setBusy(false);
  }
}

async function fireAt(targetCoordinate) {
  if (state.room?.status !== "playing" || state.room.turnUid !== state.user.uid || state.room.pendingShotId) return;
  const opponent = opponentPlayer();
  if (!opponent) return;
  playTone("tap");
  try {
    const safeUid = state.user.uid.replace(/[^a-zA-Z0-9]/g, "");
    const shotId = `r${state.room.round}_${safeUid}_${targetCoordinate}`;
    const shotDocument = doc(db, "battleshipRooms", state.roomCode, "shots", shotId);
    await runTransaction(db, async (transaction) => {
      const currentRoomRef = roomRef();
      const [roomSnapshot, shotSnapshot] = await Promise.all([
        transaction.get(currentRoomRef),
        transaction.get(shotDocument)
      ]);
      if (!roomSnapshot.exists()) throw new Error("ROOM_NOT_FOUND");
      const room = roomSnapshot.data();
      if (room.status !== "playing") throw new Error("GAME_NOT_ACTIVE");
      if (room.turnUid !== state.user.uid || room.pendingShotId) throw new Error("NOT_YOUR_TURN");
      if (shotSnapshot.exists()) throw new Error("ALREADY_SHOT");

      transaction.set(shotDocument, {
        attackerUid: state.user.uid,
        defenderUid: opponent.uid,
        coordinate: targetCoordinate,
        round: room.round,
        status: "pending",
        result: null,
        shipId: null,
        shipName: null,
        createdAt: serverTimestamp(),
        resolvedAt: null
      });
      transaction.update(currentRoomRef, {
        turnUid: null,
        pendingShotId: shotId,
        updatedAt: serverTimestamp()
      });
    });
  } catch (error) {
    const message = error.message === "ALREADY_SHOT"
      ? "Você já atacou esta casa."
      : error.message === "NOT_YOUR_TURN"
        ? "Aguarde seu turno."
        : getErrorMessage(error);
    showToast(message, "error");
  }
}

async function resolvePendingShots() {
  if (!state.room || !state.ownBoard || state.ownBoard.round !== state.room.round) return;
  const pending = state.shots.filter((shot) =>
    shot.round === state.room.round
    && shot.defenderUid === state.user.uid
    && shot.status === "pending"
    && !state.resolvingShots.has(shot.id)
  );

  for (const shot of pending) {
    state.resolvingShots.add(shot.id);
    try {
      await resolveShot(shot.id);
    } catch (error) {
      showToast(getErrorMessage(error), "error");
    } finally {
      state.resolvingShots.delete(shot.id);
    }
  }
}

async function resolveShot(shotId) {
  const shotDocument = doc(db, "battleshipRooms", state.roomCode, "shots", shotId);
  const boardDocument = ownBoardRef();
  const currentRoomRef = roomRef();

  await runTransaction(db, async (transaction) => {
    const [shotSnapshot, boardSnapshot, roomSnapshot] = await Promise.all([
      transaction.get(shotDocument),
      transaction.get(boardDocument),
      transaction.get(currentRoomRef)
    ]);
    if (!shotSnapshot.exists() || !boardSnapshot.exists() || !roomSnapshot.exists()) return;

    const shot = shotSnapshot.data();
    const board = boardSnapshot.data();
    const room = roomSnapshot.data();
    if (shot.status !== "pending" || shot.defenderUid !== state.user.uid || shot.round !== room.round) return;

    const ships = (board.ships || []).map((ship) => ({
      ...ship,
      cells: [...ship.cells],
      hits: [...(ship.hits || [])]
    }));
    const targetShip = ships.find((ship) => ship.cells.includes(shot.coordinate));
    let result = "miss";
    let shipId = null;
    let shipName = null;
    let shipsRemaining = room[currentPlayerKey(room)]?.shipsRemaining ?? FLEET.length;

    if (targetShip) {
      if (!targetShip.hits.includes(shot.coordinate)) targetShip.hits.push(shot.coordinate);
      const sunk = targetShip.cells.every((cell) => targetShip.hits.includes(cell));
      result = sunk ? "sunk" : "hit";
      shipId = targetShip.id;
      shipName = targetShip.name;
      if (sunk) shipsRemaining = Math.max(0, shipsRemaining - 1);
    }

    const defenderKey = currentPlayerKey(room);
    const defender = room[defenderKey];
    const defenderUpdate = { ...defender, shipsRemaining };
    const gameFinished = shipsRemaining === 0;

    transaction.update(boardDocument, { ships, updatedAt: serverTimestamp() });
    transaction.update(shotDocument, {
      status: "resolved",
      result,
      shipId,
      shipName,
      resolvedAt: serverTimestamp()
    });
    transaction.update(currentRoomRef, {
      [defenderKey]: defenderUpdate,
      status: gameFinished ? "finished" : "playing",
      winnerUid: gameFinished ? shot.attackerUid : null,
      turnUid: gameFinished ? null : shot.defenderUid,
      pendingShotId: null,
      updatedAt: serverTimestamp()
    });
  });
}

async function forfeitGame() {
  const confirmed = await confirmAction("Desistir da partida?", "O adversário será declarado vencedor desta rodada.");
  if (!confirmed) return;
  try {
    const opponent = opponentPlayer();
    await updateDoc(roomRef(), {
      status: "finished",
      winnerUid: opponent?.uid || null,
      turnUid: null,
      pendingShotId: null,
      updatedAt: serverTimestamp()
    });
  } catch (error) {
    showToast(getErrorMessage(error), "error");
  }
}

async function requestRematch() {
  const key = currentPlayerKey();
  if (!key || state.room?.status !== "finished") return;
  try {
    await updateDoc(roomRef(), {
      [`${key}.rematch`]: true,
      updatedAt: serverTimestamp()
    });
  } catch (error) {
    // Firestore não aceita atualizar um objeto aninhado com chave calculada por updateDoc
    try {
      await runTransaction(db, async (transaction) => {
        const ref = roomRef();
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists()) return;
        const room = snapshot.data();
        transaction.update(ref, {
          [key]: { ...room[key], rematch: true },
          updatedAt: serverTimestamp()
        });
      });
    } catch (transactionError) {
      showToast(getErrorMessage(transactionError), "error");
    }
  }
}

async function maybeStartRematch() {
  if (
    state.startingRematch
    || state.room?.status !== "finished"
    || !state.room.player1?.rematch
    || !state.room.player2?.rematch
  ) return;
  state.startingRematch = true;
  try {
    await runTransaction(db, async (transaction) => {
      const ref = roomRef();
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists()) return;
      const room = snapshot.data();
      if (room.status !== "finished" || !room.player1.rematch || !room.player2.rematch) return;
      transaction.update(ref, {
        status: "placing",
        round: (room.round || 1) + 1,
        player1: { ...room.player1, ready: false, shipsRemaining: FLEET.length, rematch: false },
        player2: { ...room.player2, ready: false, shipsRemaining: FLEET.length, rematch: false },
        turnUid: null,
        winnerUid: null,
        pendingShotId: null,
        updatedAt: serverTimestamp()
      });
    });
  } catch (error) {
    showToast(getErrorMessage(error), "error");
  } finally {
    state.startingRematch = false;
  }
}

async function copyCode() {
  try {
    await navigator.clipboard.writeText(state.roomCode);
    showToast("Código copiado.", "success");
  } catch {
    showToast(`Código da sala: ${state.roomCode}`);
  }
}

async function shareRoom() {
  const text = `Entre na minha Batalha Naval. Código da sala: ${state.roomCode}`;
  try {
    if (navigator.share) {
      const inviteUrl = `${window.location.origin}${window.location.pathname}?sala=${encodeURIComponent(state.roomCode)}`;
      await navigator.share({ title: "Batalha Naval", text, url: inviteUrl });
    } else {
      const inviteUrl = `${window.location.origin}${window.location.pathname}?sala=${encodeURIComponent(state.roomCode)}`;
      await navigator.clipboard.writeText(`${text}\n${inviteUrl}`);
      showToast("Convite copiado.", "success");
    }
  } catch (error) {
    if (error.name !== "AbortError") showToast("Não foi possível compartilhar o convite.", "error");
  }
}

function confirmAction(title, text) {
  el.dialogTitle.textContent = title;
  el.dialogText.textContent = text;
  el.dialog.showModal();
  return new Promise((resolve) => {
    const onClose = () => {
      el.dialog.removeEventListener("close", onClose);
      resolve(el.dialog.returnValue === "confirm");
    };
    el.dialog.addEventListener("close", onClose);
  });
}

function handlePlacementClick(targetCoordinate) {
  const ship = getPlacedShip(state.selectedShipId);
  if (!ship) return;
  const cells = cellsForPlacement(targetCoordinate, ship);
  if (!placementIsValid(cells, ship.id)) {
    showToast("Esta embarcação não cabe nessa posição.", "error");
    return;
  }
  ship.cells = cells;
  ship.orientation = state.orientation;
  chooseNextShip();
  playTone("tap");
  render();
}

el.app.addEventListener("click", async (event) => {
  const actionTarget = event.target.closest("[data-action]");
  const cell = event.target.closest(".cell");

  if (cell && !cell.disabled) {
    const board = cell.closest("[data-board-mode]");
    const coord = cell.dataset.coordinate;
    if (board?.dataset.boardMode === "placement") handlePlacementClick(coord);
    if (board?.dataset.boardMode === "attack") await fireAt(coord);
    return;
  }

  if (!actionTarget) return;
  const action = actionTarget.dataset.action;
  const nicknameInput = document.querySelector("#nickname");
  const codeInput = document.querySelector("#roomCode");

  if (action === "create-room") await createRoom(nicknameInput?.value);
  if (action === "join-room") await joinRoom(codeInput?.value, nicknameInput?.value);
  if (action === "resume-room") await resumeRoom(actionTarget.dataset.room);
  if (action === "copy-code") await copyCode();
  if (action === "share-room") await shareRoom();
  if (action === "leave-room") leaveRoom();
  if (action === "reload") window.location.reload();
  if (action === "select-ship") {
    state.selectedShipId = actionTarget.dataset.ship;
    render();
  }
  if (action === "rotate") {
    state.orientation = state.orientation === "horizontal" ? "vertical" : "horizontal";
    render();
  }
  if (action === "auto-place") autoPlaceFleet();
  if (action === "clear-placement") {
    state.placement = blankPlacement();
    state.selectedShipId = FLEET[0].id;
    render();
  }
  if (action === "confirm-fleet") await confirmFleet();
  if (action === "forfeit") await forfeitGame();
  if (action === "rematch") await requestRematch();
});

el.app.addEventListener("mouseover", (event) => {
  const cell = event.target.closest('.cell[data-coordinate]');
  const board = cell?.closest('[data-board-mode="placement"]');
  if (!cell || !board || state.hoverCoordinate === cell.dataset.coordinate) return;
  state.hoverCoordinate = cell.dataset.coordinate;
  render();
});

el.app.addEventListener("mouseout", (event) => {
  const board = event.target.closest?.('[data-board-mode="placement"]');
  if (!board || board.contains(event.relatedTarget)) return;
  state.hoverCoordinate = null;
  render();
});

el.app.addEventListener("input", (event) => {
  if (event.target.id === "roomCode") {
    event.target.value = normalizeCode(event.target.value);
  }
});

el.app.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  if (event.target.id === "roomCode") {
    await joinRoom(event.target.value, document.querySelector("#nickname")?.value);
  }
});

el.soundButton.addEventListener("click", () => {
  state.sound = !state.sound;
  localStorage.setItem(STORAGE.sound, state.sound ? "on" : "off");
  el.soundButton.textContent = state.sound ? "🔊" : "🔇";
  el.soundButton.setAttribute("aria-label", state.sound ? "Desativar sons" : "Ativar sons");
  if (state.sound) playTone("tap");
});

async function start() {
  el.soundButton.textContent = state.sound ? "🔊" : "🔇";
  try {
    await setPersistence(auth, browserLocalPersistence);
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        try {
          await signInAnonymously(auth);
        } catch (error) {
          renderError(error);
        }
        return;
      }
      state.user = user;
      const lastRoom = localStorage.getItem(STORAGE.room);
      if (lastRoom) {
        await resumeRoom(lastRoom);
      } else {
        renderHome();
      }
    });
  } catch (error) {
    renderError(error);
  }
}

start();
