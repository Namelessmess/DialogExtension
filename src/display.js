import OBR from "@owlbear-rodeo/sdk";

const SCENE_METADATA_ID = "com.rpg-dialog.extension/scene-metadata";
const DIALOG_POPOVER_ID = "com.rpg-dialog.extension/dialog-popover";
const OVERLAY_ITEM_TAG  = "com.rpg-dialog.extension/scene-overlay";

let lastTimestamp    = 0;
let lastCharacterId  = null;
let currentMessageId = null;

OBR.onReady(() => {
  OBR.scene.getMetadata().then((metadata) => {
    const data = metadata[SCENE_METADATA_ID];
    // Kein lastTimestamp-Reset
    if (data && Object.keys(data).length > 0 && data.timestamp > lastTimestamp) {
      lastTimestamp = data.timestamp;
      renderDisplay(data);
    }
  }).catch(() => {});

  OBR.scene.onMetadataChange((metadata) => {
    const data = metadata[SCENE_METADATA_ID];
    if (!data || Object.keys(data).length === 0) {
      try { OBR.popover.close(DIALOG_POPOVER_ID); } catch (_) {}
      lastCharacterId = null;
      return;
    }
    if (data.timestamp > lastTimestamp) {
      lastTimestamp = data.timestamp;
      renderDisplay(data);
    } else if (data.chunks) {
      // Gleicher Timestamp = Streaming-Update (z.B. Speech-to-Text Chunks).
      updateText(data.chunks, false);
    }
  });

  document.getElementById("close-btn").onclick = async () => {
    await removeOverlayItem();
    await OBR.scene.setMetadata({ [SCENE_METADATA_ID]: {} });
  };
});

async function removeOverlayItem() {
  try {
    const existing = await OBR.scene.items.getItems(
      (item) => item.metadata?.[OVERLAY_ITEM_TAG] === true
    );
    if (existing.length > 0)
      await OBR.scene.items.deleteItems(existing.map(i => i.id));
  } catch (_) {}
}

function renderDisplay(data) {
  const box     = document.getElementById("dialog-box");
  const nameTag = document.getElementById("speaker-name");

  box.style.display = "flex";
  nameTag.innerText = data.senderName;

  const textContent = document.getElementById("text-content");
  const logScroll   = document.getElementById("log-scroll");
  const sameSpeaker = !!data.characterId && data.characterId === lastCharacterId;
  const shouldClear = data.clearLog || !sameSpeaker;

  if (shouldClear) {
    logScroll.querySelectorAll(".log-entry-old").forEach(el => el.remove());
    textContent.innerHTML = "";
  } else if (textContent.innerText.trim().length > 0) {
    const oldEntry = document.createElement("div");
    oldEntry.className = "log-entry-old";
    oldEntry.textContent = textContent.innerText;
    logScroll.insertBefore(oldEntry, textContent);
    textContent.innerHTML = "";
  }

  lastCharacterId  = data.characterId || null;
  currentMessageId = data.timestamp;
  updateText(data.chunks, true);

  requestAnimationFrame(() => { logScroll.scrollTop = logScroll.scrollHeight; });
}

// useTypewriter: true = neue Nachricht (Typewriter-Effekt auf neuen Spans)
//                false = Streaming-Update
function updateText(chunks, useTypewriter) {
  const textContent = document.getElementById("text-content");
  if (!chunks) return;
  chunks.forEach((chunk, index) => {
    const spanId = `chunk-${currentMessageId}-${index}`;
    let span = document.getElementById(spanId);
    if (!span) {
      span = document.createElement("span");
      span.id        = spanId;
      span.className = "chunk";
      textContent.appendChild(span);
      if (useTypewriter) {
        span.classList.add("typing");
        typeWriter(span, chunk);
      } else {
        span.innerText = chunk;
      }
    } else {
      span.dataset.stop = "1";
      span.innerText    = chunk;
    }
  });
}

function typeWriter(element, text) {
  delete element.dataset.stop;
  let i = 0;
  element.innerText = "";
  function type() {
    if (element.dataset.stop === "1") {
      element.classList.remove("typing");
      return;
    }
    if (i < text.length) {
      element.innerText += text.charAt(i);
      i++;
      if (text.charAt(i - 1) === " ") { type(); return; }
      setTimeout(type, 15);
    } else {
      element.classList.remove("typing");
      element.dataset.final = "1";
    }
  }
  type();
}