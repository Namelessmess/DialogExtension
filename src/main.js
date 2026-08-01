import OBR, { buildShape } from "@owlbear-rodeo/sdk";
import { METADATA_ID, SCENE_METADATA_ID, updateTokenMood, setSceneDialog, closeOverlayAll } from "./api.js";
import { addToHistory, clearHistory } from "./history.js";

const OVERLAY_ITEM_TAG    = "com.rpg-dialog.extension/scene-overlay";
const DIALOG_POPOVER_ID   = "com.rpg-dialog.extension/dialog-popover";
const PORTRAIT_POPOVER_ID = "com.rpg-dialog.extension/portrait-popover";

// -- Layout-Konstanten --
// Gleiche Werte wie display.html!
const DIALOG_H              = 200;   // Höhe des Dialog-Popovers (Iframe)
const DIALOG_W              = 780;   // Breite des Dialog-Popovers
const BOTTOM_GAP            = 12;    // Abstand Popover-Unterkante zu Viewport-Unterkante
const DIALOG_ROOT_PAD_BOT   = 10;    // padding-bottom von #dialog-root in display.html
const DIALOG_BOX_H          = 160;   // height von #dialog-box in display.html

const PORTRAIT_H_BASE       = 380;
const PORTRAIT_W_BASE       = 420;

let currentSelectedTokenId = null;
let isUpdatingUI    = false;
let suppressRefresh = false;
let suppressTimer   = null;
let targetedPlayerIds = new Set();

// Speech-to-Text
let recognition       = null;
let isRecording       = false;
let speechTimestamp   = null;   
let speechChunks      = [];     
let speechInterim     = "";     
let speechFirstSend   = true;   
let lastPopoverTimestamp = null;

// Bühne: alle aktuell sichtbaren Charaktere (aktiv + inaktiv).
// characterId -> {characterId, name, url, scale, posX, posY, mirror, active}
const stagePortraits = new Map();

// Aktuell offene Portrait-Popovers (IDs)
const openPortraitPopovers = new Set();

const portraitGeomCache = new Map(); // pid -> {popW, popH, popLeft, popTop}

function getPortraitPopoverId(characterId) {
  return `com.rpg-dialog.extension/portrait-${characterId}`;
}

OBR.onReady(async () => {
  const checkScene = async () => {
    const isReady = await OBR.scene.isReady();
    if (isReady) {
      initPlayerList();
      initTokenList();
      setupEventListeners();
      refreshUI();
    } else {
      setTimeout(checkScene, 500);
    }
  };
  checkScene();

  OBR.player.onChange(async (player) => {
    currentSelectedTokenId = (player.selection && player.selection.length > 0)
      ? player.selection[0] : null;
    if (document.getElementById("token-selector").value === "selected") refreshUI();
    initPlayerList();
  });

  OBR.scene.items.onChange(async () => {
    if (suppressRefresh) return;
    if (await OBR.scene.isReady()) { initTokenList(); refreshUI(); }
  });

  OBR.scene.onMetadataChange(async (metadata) => {
    if (await OBR.scene.isReady()) {
      showGlobalDialog(metadata[SCENE_METADATA_ID]);
    }
  });
});

// -- suppressRefresh-Helferfunktion --
function beginSuppress() {
  suppressRefresh = true;
  if (suppressTimer) clearTimeout(suppressTimer);
  suppressTimer = setTimeout(() => {
    suppressRefresh = false;
    suppressTimer   = null;
  }, 600);
}

function endSuppress() {}

// -- Player-Liste --

async function initPlayerList() {
  const players = await OBR.party.getPlayers();
  const container = document.getElementById("player-checkboxes");
  if (!container) return;
  const everyoneChecked = document.getElementById("target-everyone")?.checked ?? true;
  container.innerHTML = `<label class="check-label">
    <input type="checkbox" id="target-everyone" ${everyoneChecked ? 'checked' : ''}> <strong>Alle Spieler</strong>
  </label>`;
  players.forEach(p => {
    const isChecked = targetedPlayerIds.has(p.id);
    container.innerHTML += `<label class="check-label" style="opacity:${everyoneChecked ? '0.45' : '1'}">
      <input type="checkbox" class="player-target" value="${p.id}"
        ${isChecked ? 'checked' : ''} ${everyoneChecked ? 'disabled' : ''}> ${p.name}
    </label>`;
  });
  document.querySelectorAll(".player-target").forEach(el => {
    el.onchange = (e) => {
      if (e.target.checked) targetedPlayerIds.add(e.target.value);
      else targetedPlayerIds.delete(e.target.value);
    };
  });
  document.getElementById("target-everyone").onchange = (e) => {
    document.querySelectorAll(".player-target").forEach(el => {
      el.disabled = e.target.checked;
      el.parentElement.style.opacity = e.target.checked ? "0.45" : "1";
    });
  };
}

// -- Token-Liste --

async function initTokenList() {
  const items = await OBR.scene.items.getItems((item) => item.layer === "CHARACTER");
  const select = document.getElementById("token-selector");
  if (!select) return;
  const currentVal = select.value;
  select.innerHTML = '<option value="selected">Auswahl auf Map</option>';
  items.forEach(i => {
    const opt = document.createElement("option");
    opt.value = i.id; opt.text = i.name;
    select.appendChild(opt);
  });
  select.value = currentVal;
}

function getActiveTokenId() {
  const v = document.getElementById("token-selector").value;
  return v === "selected" ? currentSelectedTokenId : v;
}

// -- UI aktualisieren --

async function refreshUI() {
  if (!(await OBR.scene.isReady()) || isUpdatingUI) return;
  const targetId    = getActiveTokenId();
  const portraitImg = document.getElementById("active-portrait");
  const grid        = document.getElementById("preset-grid");
  const cleanId     = Array.isArray(targetId) ? targetId[0] : targetId;
  if (!cleanId || typeof cleanId !== "string") {
    if (portraitImg) portraitImg.src = "";
    if (grid) grid.innerHTML = "<span style='color:#888;font-size:0.8em'>Kein Token gewählt</span>";
    return;
  }
  try {
    const items = await OBR.scene.items.getItems([cleanId]);
    if (!items || items.length === 0) return;
    const token = items[0];
    document.getElementById("name-override").placeholder = token.name;
    const data = (token.metadata && token.metadata[METADATA_ID]) ? token.metadata[METADATA_ID] : {};
    isUpdatingUI = true;
    document.getElementById("scale-slider").value    = data.scale  ?? 100;
    document.getElementById("scale-input").value     = data.scale  ?? 100;
    document.getElementById("pos-x-slider").value    = data.posX   ?? 0;
    document.getElementById("pos-x-input").value     = data.posX   ?? 0;
    document.getElementById("pos-y-slider").value    = data.posY   ?? 0;
    document.getElementById("pos-y-input").value     = data.posY   ?? 0;
    document.getElementById("mirror-toggle").checked = data.mirror || false;
    isUpdatingUI = false;
    if (data.presets && data.presets.length > 0) {
      const idx = data.currentPresetIndex ?? 0;
      if (portraitImg) portraitImg.src = data.presets[idx] || "";
      if (grid) {
        grid.innerHTML = "";
        data.presets.forEach((_, i) => {
          const btn = document.createElement("button");
          btn.className = `preset-btn ${i === idx ? "active" : ""}`;
          btn.innerText = i;
          btn.onclick   = () => updateTokenMood(cleanId, i);
          grid.appendChild(btn);
        });
      }
    } else {
      if (portraitImg) portraitImg.src = "";
      if (grid) grid.innerHTML = "<span style='color:#888;font-size:0.8em'>Keine Presets</span>";
    }
    renderPosPresets(cleanId);
  } catch (err) { console.error("Fehler beim Laden:", err); isUpdatingUI = false; }
}

// -- Event Listener --

function setupEventListeners() {
  document.getElementById("token-selector").onchange = refreshUI;
  document.getElementById("btn-submit").onclick      = sendMessage;
  document.getElementById("clear-log").onclick       = clearHistory;
  document.getElementById("btn-close-all").onclick   = async () => {
    stagePortraits.clear();
    portraitGeomCache.clear();
    await removeSceneOverlay();
    closeOverlayAll();
    updateStageUI();
  };

  const msgInput = document.getElementById("message-input");
  if (msgInput) {
    msgInput.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    };
  }

  document.getElementById("save-urls").onclick = async () => {
    const cleanId = resolveCleanId();
    if (!cleanId) return alert("Bitte wähle zuerst ein Token auf der Map aus!");
    const urls = document.getElementById("url-input").value
      .split(",").map(u => u.trim()).filter(Boolean);
    if (!urls.length) return alert("Bitte trage mindestens eine gültige Bild-URL ein!");
    try {
      beginSuppress();
      await OBR.scene.items.updateItems([cleanId], (items) => {
        for (const item of items) {
          const ex = item.metadata[METADATA_ID] || {};
          item.metadata[METADATA_ID] = {
            presets: urls, currentPresetIndex: 0,
            scale: ex.scale ?? 100, posX: ex.posX ?? 0,
            posY: ex.posY ?? 0, mirror: ex.mirror || false,
          };
        }
      });
      document.getElementById("url-input").value = "";
      alert("Erfolgreich gespeichert!");
      setTimeout(refreshUI, 700);
    } catch (e) { console.error(e); alert("Fehler beim Speichern!"); }
  };

  const saveTransforms = async () => {
    if (isUpdatingUI) return;
    const cleanId = resolveCleanId();
    if (!cleanId) return;
    beginSuppress();
    await OBR.scene.items.updateItems([cleanId], (items) => {
      for (const item of items) {
        if (!item.metadata[METADATA_ID])
          item.metadata[METADATA_ID] = { presets: [], currentPresetIndex: 0 };
        item.metadata[METADATA_ID].scale  = parseInt(document.getElementById("scale-input").value)  || 100;
        item.metadata[METADATA_ID].posX   = parseInt(document.getElementById("pos-x-input").value)  || 0;
        item.metadata[METADATA_ID].posY   = parseInt(document.getElementById("pos-y-input").value)  || 0;
        item.metadata[METADATA_ID].mirror = document.getElementById("mirror-toggle").checked;
      }
    });
  };

  [["pos-x-slider","pos-x-input"],["pos-y-slider","pos-y-input"],["scale-slider","scale-input"]]
    .forEach(([s, n]) => {
      const sEl = document.getElementById(s), iEl = document.getElementById(n);
      if (!sEl || !iEl) return;
      sEl.oninput = async (e) => { iEl.value = e.target.value; await saveTransforms(); };
      iEl.oninput = async (e) => { sEl.value = e.target.value; await saveTransforms(); };
    });
  document.getElementById("mirror-toggle").onchange = saveTransforms;

  // Bühne leeren
  document.getElementById("btn-clear-stage")?.addEventListener("click", clearStage);

  // Spracheingabe initialisieren
  setupSpeechRecognition();

  window.addEventListener("keydown", (e) => {
    const inText = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA";
    let digit = null;
    if (/^Numpad[0-9]$/.test(e.code)) digit = parseInt(e.code.slice(6), 10);
    else if (/^Digit[0-9]$/.test(e.code) && !inText) digit = parseInt(e.code.slice(5), 10);
    if (digit === null) return;
    const cleanId = resolveCleanId();
    if (!cleanId) return;
    e.preventDefault();
    updateTokenMood(cleanId, digit);
  });
}

function resolveCleanId() {
  const v  = getActiveTokenId();
  const id = Array.isArray(v) ? v[0] : v;
  return (id && typeof id === "string") ? id : null;
}

async function createSceneOverlay(opacity) {
  beginSuppress();
  // Prüfen ob Overlay schon existiert
  const existing = await OBR.scene.items.getItems(
    (item) => item.metadata?.[OVERLAY_ITEM_TAG] === true
  );
  if (existing.length > 0) {
    const currentOpacity = existing[0].style?.fillOpacity ?? -1;
    if (Math.abs(currentOpacity - opacity) > 0.001) {
      await OBR.scene.items.updateItems(existing.map(i => i.id), (items) => {
        for (const item of items) item.style.fillOpacity = opacity;
      });
    }
    return null;
  }
  const SIZE  = 100000;
  const shape = buildShape()
    .width(SIZE).height(SIZE)
    .shapeType("RECTANGLE")
    .fillColor("#000000")
    .fillOpacity(opacity)
    .strokeOpacity(0).strokeWidth(0)
    .position({ x: -SIZE / 2, y: -SIZE / 2 })
    .layer("DRAWING")
    .locked(true)
    .name(OVERLAY_ITEM_TAG)
    .metadata({ [OVERLAY_ITEM_TAG]: true })
    .build();
  await OBR.scene.items.addItems([shape]);
  return null;
}

async function removeSceneOverlay() {
  try {
    beginSuppress(); 
    const existing = await OBR.scene.items.getItems(
      (item) => item.metadata?.[OVERLAY_ITEM_TAG] === true
    );
    if (existing.length > 0)
      await OBR.scene.items.deleteItems(existing.map(i => i.id));
  } catch (_) {}
}

// -- Nachricht senden --

async function sendMessage() {
  const cleanId = resolveCleanId();
  if (!cleanId) return alert("Bitte wähle zuerst ein Token auf der Map aus!");

  const items = await OBR.scene.items.getItems([cleanId]);
  if (!items || items.length === 0) return;
  const token = items[0];

  const messageText = document.getElementById("message-input").value;
  if (!messageText.trim()) return;

  const data     = token.metadata[METADATA_ID] || {};
  const name     = document.getElementById("name-override").value || token.name;
  const myId     = await OBR.player.getId();
  const clearLog = document.getElementById("clear-log-toggle").checked;

  const overlayOpacity = parseFloat(document.getElementById("overlay-opacity").value ?? "0");
  let overlayItemId = null;
  if (overlayOpacity > 0) {
    overlayItemId = await createSceneOverlay(overlayOpacity);
  } else {
    await removeSceneOverlay();
  }

  const posX  = parseInt(document.getElementById("pos-x-input").value)  || 0;
  const posY  = parseInt(document.getElementById("pos-y-input").value)  || 0;
  const scale = parseInt(document.getElementById("scale-input").value) || 100;

  // Bühne aktualisieren
  if (clearLog) {
    // Neuer Gesprächsabschnitt -> Bühne leeren, Portrait-Popovers schließen
    for (const pid of openPortraitPopovers) {
      try { await OBR.popover.close(pid); } catch (_) {}
    }
    openPortraitPopovers.clear();
    stagePortraits.clear();
  }

  // Aktuellen Sprecher in Bühne eintragen / aktualisieren
  stagePortraits.set(cleanId, {
    characterId: cleanId,
    name,
    url:    data?.presets?.[data.currentPresetIndex] || "",
    scale, posX, posY,
    mirror: document.getElementById("mirror-toggle").checked,
    active: true,
  });
  // Alle anderen auf inaktiv setzen
  for (const [cid, p] of stagePortraits) {
    if (cid !== cleanId) p.active = false;
  }
  const portraits = Array.from(stagePortraits.values());

  await setSceneDialog({
    senderName:  name,
    senderId:    myId,
    characterId: cleanId,
    chunks:      [messageText.trim()],
    isFinal:     true,
    overlayItemId,
    portraits,
    targetEveryone: document.getElementById("target-everyone").checked,
    targets:        Array.from(document.querySelectorAll(".player-target:checked")).map(el => el.value),
    showToSender:   document.getElementById("self-view-toggle").checked,
    clearLog,
    timestamp: Date.now(),
  });

  addToHistory(name, messageText.trim());
  document.getElementById("message-input").value = "";
  if (clearLog) document.getElementById("clear-log-toggle").checked = false;
  if (isRecording) stopRecording();
  updateStageUI();
}

// -- Portrait-Popover-Geometrie berechnen --------------------------------------─
//
// posX = 0   -> Portrait horizontal mittig auf dem Bildschirm
// posX ±100  -> Portrait ganz links / ganz rechts
// posY = 0   -> Portrait-Unterkante bündig auf Dialog-Box-Oberkante
// posY > 0   -> Portrait weiter nach oben
//
// Die Dialog-Box hat eine FESTE Höhe (DIALOG_H = 200px) und wird immer gleich positioniert.

function calcPortraitPopoverGeometry(portrait, totalW, totalH) {
  const scale = (portrait.scale || 100) / 100;
  const popH  = Math.round(PORTRAIT_H_BASE * scale);
  const popW  = Math.round(PORTRAIT_W_BASE * scale);

  // Dialog-Box-Oberkante im Viewport (screen-Koordinaten):
  //
  //   Dialog-Popover-Unterkante  = totalH - BOTTOM_GAP
  //   Dialog-Popover-Oberkante   = totalH - BOTTOM_GAP - DIALOG_H
  //   Innerhalb Iframe:
  //     #dialog-root padding-bottom = DIALOG_ROOT_PAD_BOT  -> Box-Unterkante
  //     #dialog-box height (fest)   = DIALOG_BOX_H         -> Box-Oberkante
  //
  //   dialogBoxTopScreen = (totalH - BOTTOM_GAP - DIALOG_H)   <- Iframe-Oberkante
  //                      + (DIALOG_H - DIALOG_ROOT_PAD_BOT - DIALOG_BOX_H) <- Offset im Iframe
  

  const dialogBoxTopScreen = totalH - BOTTOM_GAP - DIALOG_ROOT_PAD_BOT - DIALOG_BOX_H;
  const extraLift = parseInt(portrait.posY || 0);

  // X: posX=0 -> Mitte, ±100 -> ±40% der Bildschirmbreite
  const centerX = Math.round(totalW / 2 + (portrait.posX || 0) * (totalW * 0.004));

  const popLeft = Math.round(centerX - popW / 2);
  const popTop  = Math.round(dialogBoxTopScreen - popH - extraLift);

  return { popW, popH, popLeft, popTop };
}

// -- Zwei Popover öffnen --

async function showGlobalDialog(data) {
  // -- Alles schließen --
  async function closeAll() {
    lastPopoverTimestamp = null;
    const toClose = [...openPortraitPopovers, DIALOG_POPOVER_ID];
    for (const pid of toClose) {
      try { await OBR.popover.close(pid); } catch (_) {}
    }
    openPortraitPopovers.clear();
    portraitGeomCache.clear();
  }

  if (!data || Object.keys(data).length === 0) { await closeAll(); return; }

  const myId     = await OBR.player.getId();
  const isOwnMsg = data.senderId === myId;
  const shouldShow =
    (!isOwnMsg || data.showToSender) &&
    (isOwnMsg  || data.targetEveryone || data.targets?.includes(myId));

  if (!shouldShow) { await closeAll(); return; }
  const isNewMessage = data.timestamp !== lastPopoverTimestamp;
  const [totalW, totalH] = await Promise.all([
    OBR.viewport.getWidth(),
    OBR.viewport.getHeight(),
  ]);

  const portraits = data.portraits || [];

  // -- Portrait-Popovers verwalten --
  // Popovers für nicht mehr benötigte Charaktere schließen
  const neededIds = new Set(portraits.filter(p => p.url).map(p => getPortraitPopoverId(p.characterId)));
  for (const pid of [...openPortraitPopovers]) {
    if (!neededIds.has(pid)) {
      try { await OBR.popover.close(pid); } catch (_) {}
      openPortraitPopovers.delete(pid);
    }
  }

  for (const portrait of portraits) {
    if (!portrait.url || !portrait.characterId) continue;
    const pid  = getPortraitPopoverId(portrait.characterId);
    const geom = calcPortraitPopoverGeometry(portrait, totalW, totalH);

    if (openPortraitPopovers.has(pid)) {
      const cached = portraitGeomCache.get(pid);
      const same   = cached
        && cached.popW    === geom.popW
        && cached.popH    === geom.popH
        && cached.popLeft === geom.popLeft
        && cached.popTop  === geom.popTop;
      if (same) continue; // nichts zu tun
      try { await OBR.popover.close(pid); } catch (_) {}
      openPortraitPopovers.delete(pid);
      portraitGeomCache.delete(pid);
    }

    try {
      await OBR.popover.open({
        id:               pid,
        url:              `/portrait.html?cid=${encodeURIComponent(portrait.characterId)}`,
        width:            Math.max(geom.popW, 80),
        height:           Math.max(geom.popH, 80),
        anchorReference:  "POSITION",
        anchorPosition:   { left: geom.popLeft, top: geom.popTop },
        anchorOrigin:     { horizontal: "LEFT", vertical: "TOP" },
        transformOrigin:  { horizontal: "LEFT", vertical: "TOP" },
        disableClickAway: true,
        hidePaper:        true,
      });
      openPortraitPopovers.add(pid);
      portraitGeomCache.set(pid, geom);
    } catch (e) { console.error("Portrait-Popover-Fehler:", e); }
  }

  // -- Dialog-Popover --
  if (isNewMessage) {
    lastPopoverTimestamp = data.timestamp;
    try { await OBR.popover.close(DIALOG_POPOVER_ID); } catch (_) {}
    try {
      await OBR.popover.open({
        id:               DIALOG_POPOVER_ID,
        url:              "/display.html",
        width:            DIALOG_W,
        height:           DIALOG_H,
        anchorReference:  "POSITION",
        anchorPosition:   { left: Math.round(totalW / 2), top: Math.round(totalH - BOTTOM_GAP) },
        anchorOrigin:     { horizontal: "CENTER", vertical: "BOTTOM" },
        transformOrigin:  { horizontal: "CENTER", vertical: "BOTTOM" },
        disableClickAway: true,
        hidePaper:        true,
      });
    } catch (e) { console.error("Dialog-Popover-Fehler:", e); }
  }
}

// -- Positions-Presets --
// Gespeichert in token.metadata[METADATA_ID].posPresets = [{label,posX,posY,scale,mirror},…]

async function savePosPreset(slotIndex) {
  const cleanId = resolveCleanId();
  if (!cleanId) return;
  const label = prompt(`Name für Positions-Slot ${slotIndex + 1}:`,
    `Preset ${slotIndex + 1}`);
  if (label === null) return; // Abbruch
  beginSuppress();
  try {
    await OBR.scene.items.updateItems([cleanId], (items) => {
      for (const item of items) {
        if (!item.metadata[METADATA_ID]) item.metadata[METADATA_ID] = {};
        const presets = item.metadata[METADATA_ID].posPresets || Array(5).fill(null);
        presets[slotIndex] = {
          label,
          posX:   parseInt(document.getElementById("pos-x-input").value)  || 0,
          posY:   parseInt(document.getElementById("pos-y-input").value)  || 0,
          scale:  parseInt(document.getElementById("scale-input").value) || 100,
          mirror: document.getElementById("mirror-toggle").checked,
        };
        item.metadata[METADATA_ID].posPresets = presets;
      }
    });
    renderPosPresets(cleanId);
  } finally { endSuppress(); }
}

async function loadPosPreset(preset) {
  if (!preset) return;
  isUpdatingUI = true;
  document.getElementById("pos-x-slider").value = preset.posX;
  document.getElementById("pos-x-input").value  = preset.posX;
  document.getElementById("pos-y-slider").value = preset.posY;
  document.getElementById("pos-y-input").value  = preset.posY;
  document.getElementById("scale-slider").value = preset.scale;
  document.getElementById("scale-input").value  = preset.scale;
  document.getElementById("mirror-toggle").checked = preset.mirror;
  isUpdatingUI = false;
  const cleanId = resolveCleanId();
  if (!cleanId) return;
  beginSuppress();
  try {
    await OBR.scene.items.updateItems([cleanId], (items) => {
      for (const item of items) {
        if (!item.metadata[METADATA_ID]) item.metadata[METADATA_ID] = {};
        item.metadata[METADATA_ID].scale  = preset.scale;
        item.metadata[METADATA_ID].posX   = preset.posX;
        item.metadata[METADATA_ID].posY   = preset.posY;
        item.metadata[METADATA_ID].mirror = preset.mirror;
      }
    });
  } finally { endSuppress(); }
}

async function renderPosPresets(cleanId) {
  const grid = document.getElementById("pos-preset-grid");
  if (!grid || !cleanId) return;
  try {
    const items = await OBR.scene.items.getItems([cleanId]);
    if (!items?.length) return;
    const posPresets = items[0].metadata?.[METADATA_ID]?.posPresets || Array(5).fill(null);
    grid.innerHTML = "";
    posPresets.forEach((preset, i) => {
      const hasPreset = !!preset;
      const btn = document.createElement("div");
      btn.style.cssText = "display:flex;gap:3px;align-items:center";
      btn.innerHTML = `
        <button
          title="${hasPreset ? preset.label + ' laden' : 'Leer'}"
          onclick="window.posPresetLoad(${i})"
          style="flex:1;background:${hasPreset ? 'rgba(200,170,110,0.12)' : 'var(--bg-input)'};
            border:1px solid ${hasPreset ? '#c8aa6e' : 'rgba(200,170,110,0.2)'};
            color:${hasPreset ? '#c8aa6e' : 'var(--text-muted)'};
            border-radius:3px;padding:4px 6px;cursor:pointer;font-size:0.75em;
            text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
          >${hasPreset ? preset.label : `Slot ${i + 1}`}</button>
        <button
          title="Aktuelle Position in Slot ${i + 1} speichern"
          onclick="window.posPresetSave(${i})"
          style="background:var(--bg-input);border:1px solid rgba(200,170,110,0.2);
            color:var(--text-muted);border-radius:3px;padding:4px 6px;cursor:pointer;font-size:0.75em"
          onmouseover="this.style.color='#c8aa6e'" onmouseout="this.style.color='var(--text-muted)'"
          >💾</button>`;
      grid.appendChild(btn);
    });
  } catch (e) { console.error(e); }
}

window.posPresetSave = (i) => savePosPreset(i);
window.posPresetLoad = async (i) => {
  const cleanId = resolveCleanId();
  if (!cleanId) return;
  const items = await OBR.scene.items.getItems([cleanId]);
  const preset = items?.[0]?.metadata?.[METADATA_ID]?.posPresets?.[i];
  if (preset) await loadPosPreset(preset);
  else alert("Dieser Slot ist noch leer.");
};


// -- Bühnen-Verwaltung --
function updateStageUI() {
  const list     = document.getElementById("stage-list");
  const clearBtn = document.getElementById("btn-clear-stage");
  if (!list) return;

  if (stagePortraits.size === 0) {
    list.innerHTML = '<span style="color:var(--text-muted);font-size:0.8em;padding:2px 0;display:block">Keine Charaktere auf der Bühne</span>';
    if (clearBtn) clearBtn.style.display = "none";
    return;
  }

  if (clearBtn) clearBtn.style.display = "block";
  list.innerHTML = "";

  for (const [cid, p] of stagePortraits) {
    const row  = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid rgba(200,170,110,0.1)";

    const dot   = p.active ? "●" : "○";
    const color = p.active ? "#c8aa6e" : "#7a6e58";

    row.innerHTML = `
      <span style="color:${color};font-size:0.85em;flex-shrink:0">${dot}</span>
      <span style="flex:1;font-size:0.85em;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
            title="${p.name}">${p.name}</span>
      <button
        onclick="window.removeFromStage('${cid}')"
        style="background:none;border:none;color:var(--text-muted);cursor:pointer;padding:2px 5px;font-size:0.85em;border-radius:3px;flex-shrink:0"
        title="Aus Gespräch entfernen"
        onmouseover="this.style.color='#e57373'"
        onmouseout="this.style.color='var(--text-muted)'">✕</button>`;
    list.appendChild(row);
  }
}

// Einzelnen Charakter von der Bühne entfernen
window.removeFromStage = async (characterId) => {
  stagePortraits.delete(characterId);
  const pid = getPortraitPopoverId(characterId);
  try { await OBR.popover.close(pid); } catch (_) {}
  openPortraitPopovers.delete(pid);
  portraitGeomCache.delete(pid);
  updateStageUI();

  // Metadaten aktualisieren damit alle Clients das Portrait schließen
  if (stagePortraits.size > 0) {
    const currentMeta = await OBR.scene.getMetadata();
    const currentData = currentMeta[SCENE_METADATA_ID];
    if (currentData && Object.keys(currentData).length > 0) {
      const portraits = Array.from(stagePortraits.values());
      await setSceneDialog({ ...currentData, portraits });
    }
  } else {
    // Niemand mehr auf der Bühne -> Dialog schließen
    await closeOverlayAll();
  }
};
async function clearStage() {
  for (const pid of openPortraitPopovers) {
    try { await OBR.popover.close(pid); } catch (_) {}
  }
  openPortraitPopovers.clear();
  portraitGeomCache.clear();
  stagePortraits.clear();
  updateStageUI();
  await closeOverlayAll();
}

window.switchTab = (tabId) => {
  document.querySelectorAll(".tab-content").forEach(t => t.style.display = "none");
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.getElementById(`tab-${tabId}`).style.display = "block";
  document.getElementById(`btn-${tabId}`)?.classList.add("active");
};

// -- Speech-to-Text --
//
// Zwei Modi:
//   Push-to-Talk  — Button halten oder Leertaste halten (außerhalb von Textfeldern)
//   Toggle        — Button klicken um Aufnahme zu starten/stoppen
//
// Stream-Modus (Checkbox):
//   EIN  -> Interim-Ergebnisse werden sofort an Spieler gesendet (Text wächst live)
//   AUS  -> Nur finale Ergebnisse werden gesendet (weniger Updates, ruhiger)
//
// Chunk-Mechanismus:
//   Jedes finale Sprachsegment wird als eigener Chunk gespeichert.
//   Das aktuelle Interim-Segment ist immer der letzte (unfixierte) Chunk.
//   display.js aktualisiert unfixierte Chunks ohne Typewriter (direkt),
//   neue finale Chunks erhalten den Typewriter-Effekt.
//   -> Nur der gerade neu gesprochene Text "rattert", alter Text bleibt still.
//
//   Popovers werden nur beim ERSTEN Chunk (neuer Timestamp) geöffnet.
//   Alle weiteren Updates gehen direkt an display.js via onMetadataChange.

function setupSpeechRecognition() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const statusEl  = document.getElementById("speech-status");
  const pttBtn    = document.getElementById("btn-push-to-talk");
  const togBtn    = document.getElementById("btn-speech-toggle");

  if (!SpeechRec) {
    if (statusEl) statusEl.textContent = "!! Nicht unterstützt — Chrome oder Edge verwenden";
    if (pttBtn)   pttBtn.disabled = true;
    if (togBtn)   togBtn.disabled = true;
    return;
  }

  recognition = new SpeechRec();
  recognition.continuous     = true;
  recognition.interimResults = true;

  // -- Events --

  recognition.onstart = () => {
    isRecording = true;
    if (statusEl) statusEl.innerHTML = '<span style="color:#e57373">● Aufnahme läuft…</span>';
    if (pttBtn)   pttBtn.classList.add("recording");
    if (togBtn)   togBtn.classList.add("recording");
  };

  recognition.onend = async () => {
    isRecording = false;
    if (statusEl) statusEl.innerHTML = "Bereit";
    if (pttBtn)   pttBtn.classList.remove("recording");
    if (togBtn)   togBtn.classList.remove("recording");

    // Letzten Interim-Text als finalen Chunk committen (falls vorhanden)
    if (speechInterim.trim()) {
      speechChunks.push(speechInterim.trim());
      speechInterim = "";
    }

    if (speechChunks.length > 0) {
      // Finales Update mit isFinal:true senden
      await sendSpeechUpdate(true);

      // History-Eintrag
      const name = document.getElementById("name-override").value
        || document.getElementById("token-selector").selectedOptions[0]?.text
        || "NPC";
      addToHistory(name, speechChunks.join(" ").trim());

      // Textarea mit vollständigem Text befüllen
      const msgInput = document.getElementById("message-input");
      if (msgInput) msgInput.value = speechChunks.join(" ").trim();
    }

    // State zurücksetzen für nächste Sitzung
    speechChunks    = [];
    speechInterim   = "";
    speechTimestamp = null;
    speechFirstSend = true;
    updateStageUI();
  };

  recognition.onresult = async (event) => {
    let newFinal  = "";
    let newInterim = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) newFinal  += t;
      else                          newInterim += t;
    }

    if (newFinal) {
      speechChunks.push(newFinal.trim());
      speechInterim = "";
    } else {
      speechInterim = newInterim;
    }

    const streamMode = document.getElementById("speech-stream")?.checked;
    if (streamMode || newFinal) {
      await sendSpeechUpdate(false);
    }
    const msgInput = document.getElementById("message-input");
    if (msgInput) {
      const preview = [...speechChunks, speechInterim].join(" ").trim();
      msgInput.value = preview;
    }
  };

  recognition.onerror = (e) => {
    if (e.error === "no-speech") return;

    isRecording = false;
    if (pttBtn) pttBtn.classList.remove("recording");
    if (togBtn) togBtn.classList.remove("recording");

    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      recognition = null;
      if (pttBtn) { pttBtn.disabled = true; pttBtn.textContent = "Kein Zugriff"; }
      if (togBtn) { togBtn.disabled = true; }
      if (statusEl) statusEl.innerHTML =
        '<span style="color:#e57373">!! Mikrofon verweigert - siehe Hinweis unten</span>';
      const hint = document.getElementById("speech-permission-hint");
      if (hint) hint.style.display = "block";
      return;
    }

    console.error("Speech-Fehler:", e.error);
    if (statusEl) statusEl.textContent = `Fehler: ${e.error}`;
  };

  // -- Push-to-Talk Button --

  if (pttBtn) {
    pttBtn.addEventListener("mousedown",  (e) => { e.preventDefault(); startRecording(); });
    pttBtn.addEventListener("mouseup",    ()  => stopRecording());
    pttBtn.addEventListener("mouseleave", ()  => { if (isRecording) stopRecording(); });
    pttBtn.addEventListener("touchstart", (e) => { e.preventDefault(); startRecording(); }, { passive: false });
    pttBtn.addEventListener("touchend",   (e) => { e.preventDefault(); stopRecording(); },  { passive: false });
  }

  // -- Toggle Button --

  if (togBtn) {
    togBtn.onclick = () => {
      if (isRecording) stopRecording();
      else             startRecording();
    };
  }

  // -- Leertaste = Push-to-Talk (außerhalb von Textfeldern) --

  window.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || isRecording) return;
    const inText = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA";
    if (inText) return;
    e.preventDefault();
    startRecording();
  });
  window.addEventListener("keyup", (e) => {
    if (e.code !== "Space" || !isRecording) return;
    const inText = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA";
    if (inText) return;
    e.preventDefault();
    stopRecording();
  });
}

// -- Aufnahme starten / stoppen --

function startRecording() {
  if (isRecording || !recognition) return;
  // Verhindert Rapid-Fire bei gehaltenem Spacebar (key-repeat)
  if (startRecording._cooldown) return;
  startRecording._cooldown = true;
  setTimeout(() => { startRecording._cooldown = false; }, 300);
  const cleanId = resolveCleanId();
  if (!cleanId) {
    alert("Bitte wähle zuerst ein Token auf der Map aus!");
    return;
  }

  // Neuen Timestamp für diese Sprachsitzung festlegen
  speechTimestamp = Date.now();
  speechChunks    = [];
  speechInterim   = "";
  speechFirstSend = true;

  recognition.lang = document.getElementById("speech-lang")?.value || "de-DE";
  try { recognition.start(); } catch (_) {}
}

function stopRecording() {
  if (!isRecording || !recognition) return;
  try { recognition.stop(); } catch (_) {}
}

// -- Sprachdaten an Spieler senden --

async function sendSpeechUpdate(isFinal) {
  const cleanId = resolveCleanId();
  if (!cleanId || !speechTimestamp) return;

  // Alle finalen Chunks + ggf. aktueller Interim-Text als letzter Chunk
  const chunks = speechInterim
    ? [...speechChunks, speechInterim]
    : [...speechChunks];
  if (!chunks.length) return;

  const items = await OBR.scene.items.getItems([cleanId]);
  if (!items || items.length === 0) return;
  const token = items[0];
  const data  = token.metadata[METADATA_ID] || {};
  const name  = document.getElementById("name-override").value || token.name;
  const myId  = await OBR.player.getId();

  const clearLog = speechFirstSend && (document.getElementById("clear-log-toggle")?.checked ?? false);
  speechFirstSend = false;
  if (speechFirstSend === false && !stagePortraits.has(cleanId)) {
  }
  stagePortraits.set(cleanId, {
    characterId: cleanId,
    name,
    url:    data?.presets?.[data.currentPresetIndex] || "",
    scale:  parseInt(document.getElementById("scale-input").value)  || 100,
    posX:   parseInt(document.getElementById("pos-x-input").value)  || 0,
    posY:   parseInt(document.getElementById("pos-y-input").value)  || 0,
    mirror: document.getElementById("mirror-toggle").checked,
    active: true,
  });
  for (const [cid, p] of stagePortraits) {
    if (cid !== cleanId) p.active = false;
  }
  const portraits = Array.from(stagePortraits.values());

  await setSceneDialog({
    senderName:  name,
    senderId:    myId,
    characterId: cleanId,
    chunks,
    isFinal,
    overlayItemId: null,
    portraits,
    targetEveryone: document.getElementById("target-everyone").checked,
    targets:        Array.from(document.querySelectorAll(".player-target:checked")).map(el => el.value),
    showToSender:   document.getElementById("self-view-toggle").checked,
    clearLog,
    timestamp: speechTimestamp,
  });
}