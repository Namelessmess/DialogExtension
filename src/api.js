import OBR from "@owlbear-rodeo/sdk";

export const METADATA_ID = "com.rpg-dialog.extension/metadata";
export const SCENE_METADATA_ID = "com.rpg-dialog.extension/scene-metadata";

export async function updateTokenMood(id, index) {
  if (!id) return;
  await OBR.scene.items.updateItems([id], (items) => {
    for (let item of items) {
      if (!item.metadata[METADATA_ID]) item.metadata[METADATA_ID] = {};
      item.metadata[METADATA_ID].currentPresetIndex = index;
    }
  });
}

export async function setSceneDialog(data) {
  await OBR.scene.setMetadata({ [SCENE_METADATA_ID]: data });
}

export async function closeOverlayAll() {
  await OBR.scene.setMetadata({ [SCENE_METADATA_ID]: {} });
}