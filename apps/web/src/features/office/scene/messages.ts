// Message keys the scene itself needs (props without a view-model label: easter
// eggs, the zoom control). The scene never imports i18n (M4_PLAN §3.2): the
// office connect passes the catalog's `t`, which must define every key here.
// The values are the zh-TW defaults for the shared catalog (M4-T4).

export const sceneMessagesZhTW = {
  'office.scene.aria': '像素辦公室',
  'office.scene.zoomOut': '{room}：還原全樓層',
  'office.scene.plant': '盆栽',
  'office.scene.coffee': '咖啡機',
  'office.scene.clock': '時鐘',
  'office.scene.clockTime': '現在 {time}',
} as const;

export type SceneMessageKey = keyof typeof sceneMessagesZhTW;
export type SceneTranslate = (
  key: SceneMessageKey,
  params?: Readonly<Record<string, string | number>>,
) => string;
