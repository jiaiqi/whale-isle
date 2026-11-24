/** 无焦点 Alt/Option 临时穿透（T-M6-44）：主进程按全局鼠标位置 + 系统键态判定。 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { WindowBounds } from './pet-window-manager';

export interface AltPeekWindow { agentId: string; bounds: WindowBounds }
export function pointInBounds(point: { x: number; y: number }, bounds: WindowBounds): boolean {
  return point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height;
}
/** 只有鼠标在窗口 bounds 内且 Alt 按下时才临时穿透。 */
export function resolveAltPeekTargets(windows: readonly AltPeekWindow[], point: { x: number; y: number }, altDown: boolean): string[] {
  if (!altDown) return [];
  return windows.filter((window) => pointInBounds(point, window.bounds)).map((window) => window.agentId);
}

/** 全局键态读取进程：macOS CGEventSource / Windows GetAsyncKeyState。 */
export class GlobalAltMonitor {
  private child: ChildProcess | null = null;
  private down = false;
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}
  current(): boolean { return this.down; }
  start(): boolean {
    if (this.child !== null) return true;
    const macScript = 'ObjC.import("CoreGraphics");const s=$.kCGEventSourceStateCombinedSessionState;while(true){console.log(($.CGEventSourceKeyState(s,58)||$.CGEventSourceKeyState(s,61))?1:0);delay(0.05);}';
    const winScript = 'Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);\' -Name U -Namespace W; while($true){ if(([W.U]::GetAsyncKeyState(0x12) -band 0x8000) -ne 0){"1"}else{"0"}; Start-Sleep -Milliseconds 50 }';
    if (this.platform !== 'darwin' && this.platform !== 'win32') return false;
    const child = this.platform === 'darwin'
      ? spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', macScript], { stdio: ['ignore', 'pipe', 'ignore'] })
      : spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', winScript], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      const lines = chunk.trim().split(/\s+/).filter(Boolean);
      const last = lines.at(-1);
      if (last === '1' || last === '0') this.down = last === '1';
    });
    child.once('exit', () => { if (this.child === child) { this.child = null; this.down = false; } });
    this.child = child;
    return true;
  }
  stop(): void {
    this.child?.kill('SIGTERM');
    this.child = null;
    this.down = false;
  }
}
