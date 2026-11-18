/** T10 owns this additive catalog; it composes the common keys without mutating them. */
import { t as commonT, type MessageKey, type MessageParams } from './index.js';
export const seatsMessagesZhTW = {
  'seats.title': '座位詳情',
  'seats.select': '選取座位，查看詳情。',
  'seats.missing': '此時沒有這個座位。',
  'seats.doing': '正在做',
  'seats.attempt': '第 {n} 次',
  'seats.attemptLabel': '第幾次',
  'seats.reworks': 'rework',
  'seats.usage': 'token 用量',
  'seats.activity': '最近的動作',
  'seats.activityCount': '{tool} {n} 次',
  'seats.ago': '{n} 分前',
  'seats.justNow': '剛剛',
  'seats.empty': '尚無紀錄。',
  'seats.reviews': '審查紀錄',
  'seats.reviewCount': '審查 {n} 次',
  'seats.review': 'PR #{pr} · rework {n}',
  'seats.meeting': '會議立場',
  'seats.round': '第 {n} 輪',
  'seats.arguments': '理由',
  'seats.concerns': '疑慮',
  'seats.errors': '錯誤',
  'seats.history': 'attempt 歷史',
  'seats.historyEntry': '第 {n} 次 · {state}',
  'seats.message': '傳話',
  'seats.messageTo': '傳話給 {role}',
  'seats.subjectAuto': '主旨為自動產生（取第一行）。',
  'seats.send': '送出',
  'seats.sending': '送出中…',
  'seats.sent': '指示已受理。',
  'seats.disabled.replay': '回放中無法傳話，請先回到即時。',
  'seats.disabled.away': '座位目前沒有活著的 attempt，無法傳話。',
  'seats.disabled.meeting': '會議中的 agent 不收傳話。',
  'seats.disabled.workflow': '流程已結束，無法傳話。',
  'seats.rateLimited': '等待額度恢復',
  'seats.oncall': '值班',
  'seats.merge': '整合台',
  'seats.noWork': '尚未指派工作',
  'seats.read': '讀檔',
  'seats.edit': '改檔',
  'seats.shell': '跑指令',
  'seats.git': 'Git',
  'seats.network': '網路',
  'seats.orca': 'Orca',
  'seats.other': '其他工具',
  'seats.historyLoading': '正在載入審查紀錄…',
  'seats.historyFailed': '審查紀錄未完整載入，請重試。',
  'seats.error.auth': '登入已失效，請從啟動連結重新登入。',
  'seats.error.conflict': '座位狀態已改變，請確認目前狀態後再試。',
  'seats.error.validation': '訊息不能空白，第一行也必須有主旨文字。',
  'seats.error.rateLimited': '服務額度受限，請稍後再試。',
  'seats.error.unknown':
    '無法確認指示是否已受理；請先確認座位狀態，避免重複傳送。',
  'seats.error.failed': '無法傳送指示，請檢查服務狀態。',
} as const;
export type SeatsMessageKey = keyof typeof seatsMessagesZhTW | MessageKey;
export type SeatsTranslator = (
  key: SeatsMessageKey,
  params?: MessageParams,
) => string;
export const seatsT: SeatsTranslator = (key, params = {}) => {
  if (!(key in seatsMessagesZhTW)) return commonT(key as MessageKey, params);
  return seatsMessagesZhTW[key as keyof typeof seatsMessagesZhTW].replace(
    /\{(\w+)\}/g,
    (placeholder, name: string) => String(params[name] ?? placeholder),
  );
};
