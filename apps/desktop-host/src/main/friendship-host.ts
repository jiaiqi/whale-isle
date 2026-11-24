/**
 * 友谊 / 小本子 / 闲时互聊 / 久坐喝水提醒（T-M6-48）。
 *
 * - 数据：`userData/friendship.sqlite`（FriendshipStore，日上限 15）；
 * - 互聊：从**在线桌宠**里挑两只，按角色预置模板各说一句（不是 LLM 生成，也不冒充实时对话），
 *   经 voiceHost 串行播报并写入 memory-graph；
 * - 提醒：60min 久坐 / 45min 喝水，23:00–07:00 与睡眠态免打扰；
 * - 隐私：`friendship:wipe` 只清友谊/留言/互聊三表。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ipcMain } from 'electron';
import { FriendshipStore, type FriendshipAction, type FriendshipStats, type NotebookBanter, type NotebookNote } from '@workbench/local-store/friendship';
import { createBreakReminderState, dueReminder, greetingForHour, isQuietHours, reminderLine, type BreakReminderKind, type BreakReminderState } from './break-reminders';

export interface NotebookView {
  characterId: string;
  stats: FriendshipStats | null;
  notes: NotebookNote[];
  banter: NotebookBanter[];
}

export interface FriendshipHost {
  record(action: FriendshipAction, characterId: string): FriendshipStats | null;
  notebook(characterId: string): NotebookView;
  addNote(characterId: string, text: string): NotebookNote;
  wipe(): void;
  /** 闲时互聊：需要至少 2 只在线桌宠；返回这一轮的两句台词。 */
  pairChat(activeCharacterIds: string[]): { ok: true; aName: string; aText: string; bName: string; bText: string } | { ok: false; error: string };
  /** 定时器调用：返回本次提醒（免打扰/睡眠返回 null）。 */
  tickReminders(now: number, asleep: boolean): { kind: BreakReminderKind; text: string } | null;
  greeting(characterId: string, hour: number): string;
  /** 每天首次见面才返回问候（落 userData/friendship/greeting.json）；当天已问候返回空串。 */
  meetGreeting(characterId: string, hour: number): string;
  close(): void;
}

/** 互聊模板（CrossPet pair-chat 的原创改写；不含任何模拟指标）。 */
const BANTER_TEMPLATES: Array<{ a: string; b: string }> = [
  { a: '今天主人交给你的活忙完了吗？我这边刚收尾。', b: '还差一点，不过进度我都记在小本子上了。' },
  { a: '你那边桌面乱不乱？我总想顺手整理一下。', b: '别动我的窗口摆放，那是我记住的位置。' },
  { a: '刚才主人夸我了，我要记下来。', b: '我也记了——不过是记在本子上，不是记仇。' },
  { a: '要是今天干不完，我们就明天接着来。', b: '好，那今晚早点休息，别熬到太晚。' },
];

export function createFriendshipHost(options: {
  userDataDir: string;
  characters: () => Array<{ id: string; displayName: string }>;
  speak?: (characterId: string, text: string) => void;
  remember?: (text: string) => void;
  now?: () => number;
  store?: FriendshipStore;
}): FriendshipHost {
  const now = options.now ?? Date.now;
  const store = options.store ?? new FriendshipStore(join(options.userDataDir, 'friendship.sqlite'));
  const reminders = new Map<string, BreakReminderState>();
  const greetingPath = join(options.userDataDir, 'friendship', 'greeting.json');
  let greeted: Record<string, string> = {};
  try {
    if (existsSync(greetingPath)) greeted = JSON.parse(readFileSync(greetingPath, 'utf8')) as Record<string, string>;
  } catch { greeted = {}; }
  let banterCursor = 0;
  const nameOf = (id: string): string => options.characters().find((character) => character.id === id)?.displayName ?? '桌宠';

  const record = (action: FriendshipAction, characterId: string): FriendshipStats | null => {
    try {
      return store.addPoints(characterId, action, now());
    } catch {
      return null;
    }
  };

  const host: FriendshipHost = {
    record,
    notebook: (characterId) => ({
      characterId,
      stats: store.get(characterId, now()),
      notes: store.listNotes(characterId),
      banter: store.listBanter(),
    }),
    addNote: (characterId, text) => store.addNote(characterId, text, now()),
    wipe: () => {
      store.wipe();
      greeted = {};
      try { writeFileSync(greetingPath, '{}\n', 'utf8'); } catch { /* 仅影响当天问候去重 */ }
    },
    pairChat(activeCharacterIds) {
      const unique = [...new Set(activeCharacterIds)].filter((id) => id !== '');
      if (unique.length < 2) return { ok: false, error: '至少需要 2 只桌宠在线才能互聊' };
      const template = BANTER_TEMPLATES[banterCursor % BANTER_TEMPLATES.length]!;
      banterCursor += 1;
      const [aId, bId] = unique as [string, string];
      const aName = nameOf(aId);
      const bName = nameOf(bId);
      const entry = store.addBanter({ aId, aName, aText: template.a, bId, bName, bText: template.b }, now());
      record('chat', aId);
      record('chat', bId);
      // 串行播报：后一句等前一句播完（voiceHost 内部 active≤1，这里再加 1.2s 间隔更自然）
      options.speak?.(aId, template.a);
      setTimeout(() => options.speak?.(bId, template.b), 1_200);
      options.remember?.(`闲时互聊：${aName}「${template.a}」→ ${bName}「${template.b}」`);
      return { ok: true, aName, aText: template.a, bName, bText: entry.bText };
    },
    tickReminders(at, asleep) {
      const date = new Date(at);
      const key = 'global';
      let state = reminders.get(key);
      if (state === undefined) {
        state = createBreakReminderState(at);
        reminders.set(key, state);
      }
      const kind = dueReminder(state, at, { asleep, quiet: isQuietHours(date) });
      if (kind === null) return null;
      return { kind, text: reminderLine(kind, nameOf(options.characters()[0]?.id ?? '')) };
    },
    greeting: (characterId, hour) => greetingForHour(hour, nameOf(characterId)),
    meetGreeting(characterId, hour) {
      if (characterId.trim() === '') return '';
      const day = new Date(now()).toISOString().slice(0, 10);
      if (greeted[characterId] === day) return '';
      greeted = { ...greeted, [characterId]: day };
      try {
        mkdirSync(dirname(greetingPath), { recursive: true });
        writeFileSync(greetingPath, `${JSON.stringify(greeted, null, 2)}\n`, 'utf8');
      } catch { /* 只影响当天去重 */ }
      return greetingForHour(hour, nameOf(characterId));
    },
    close: () => store.close(),
  };
  void host;
  return host;
}

export function registerFriendshipIpc(host: FriendshipHost, options: { activeCharacterIds: () => string[] }): void {
  ipcMain.handle('friendship:record', (_event, characterId: string, action: string) => host.record(String(action) as FriendshipAction, String(characterId)));
  ipcMain.handle('friendship:notebook', (_event, characterId: string) => host.notebook(String(characterId)));
  ipcMain.handle('friendship:note-add', (_event, characterId: string, text: string) => {
    try {
      return { ok: true, note: host.addNote(String(characterId), String(text)) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('friendship:wipe', () => { host.wipe(); return { ok: true }; });
  ipcMain.handle('friendship:pair-chat', () => host.pairChat(options.activeCharacterIds()));
  ipcMain.handle('friendship:greeting', (_event, characterId: string) => host.greeting(String(characterId), new Date().getHours()));
  ipcMain.handle('friendship:meet', (_event, characterId: string) => host.meetGreeting(String(characterId), new Date().getHours()));
}
