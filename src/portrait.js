import OBR from "@owlbear-rodeo/sdk";

const SCENE_METADATA_ID = "com.rpg-dialog.extension/scene-metadata";

// Jeder Portrait-Popover weiß über den URL-Parameter welchen Charakter er zeigt.
// main.js öffnet jeden Popover als /portrait.html?cid=<characterId>
const myCharId = decodeURIComponent(new URLSearchParams(window.location.search).get("cid") || "");

let lastTimestamp = 0;

OBR.onReady(() => {
  // Initialer Ladestand beim Öffnen des Popovers
  OBR.scene.getMetadata().then((metadata) => {
    const data = metadata[SCENE_METADATA_ID];
    if (data && Object.keys(data).length > 0) {
      lastTimestamp = 0;
      renderPortrait(data);
    }
  }).catch(() => {});

  OBR.scene.onMetadataChange((metadata) => {
    const data = metadata[SCENE_METADATA_ID];
    if (!data || Object.keys(data).length === 0) {
      const img = document.getElementById("portrait-img");
      if (img) img.src = "";
      return;
    }
    // >= statt > damit active/inactive-Wechsel
    if (data.timestamp >= lastTimestamp) {
      lastTimestamp = data.timestamp;
      renderPortrait(data);
    }
  });
});

function renderPortrait(data) {
  const img = document.getElementById("portrait-img");
  if (!img || !data.portraits) return;
  const portrait = data.portraits.find(p => p.characterId === myCharId);

  if (!portrait?.url) {
    img.src = "";
    return;
  }

  if (img.src !== portrait.url) img.src = portrait.url;

  // Aktiv = aktueller Sprecher (hell, leichter Glow)
  // Inaktiv = vorheriger Sprecher
  img.className = portrait.active ? "active" : "inactive";

  img.style.transform = portrait.mirror ? "scaleX(-1)" : "scaleX(1)";
}