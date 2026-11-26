// whale-input-helper — V2-P3-03c macOS 真实输入注入助手（CGEvent）
//
// 设计约束（AGENTS.md 运行时安全锁）：
// - 本程序为开发期编译的固定功能二进制，运行时由 Electron 主进程以固定子命令 + 参数数组
//   （spawnSync，不走 shell）调用；不读取任何配置文件，不接受任意脚本，不存在命令注入面。
// - 只实现 ComputerInputStep 契约允许的六类原子动作；屏幕坐标为 CGEvent 全局显示坐标（点）。
// - 权限探测走 AXIsProcessTrusted()，与 Electron systemPreferences.isTrustedAccessibilityClient
//   同源；未授权时 CGEventPost 会被系统静默丢弃，调用方必须先探测权限再注入。
//
// 用法：
//   whale-input-helper permission                 打印 granted|denied
//   whale-input-helper move <x> <y>               移动鼠标（合成移动事件）
//   whale-input-helper click <x> <y> [left|right] 移动并点击
//   whale-input-helper type <text>                Unicode 文本输入（CGEventKeyboardSetUnicodeString）
//   whale-input-helper key <name>                 单键（enter/tab/space/delete/esc/up/down/left/right/f1-f12）
//   whale-input-helper scroll <deltaY>            垂直滚轮（正值向上，与系统自然滚动方向一致由系统决定）
//
// 退出码：0 成功；2 参数错误；3 无辅助功能权限；4 事件创建失败。
import Cocoa

enum HelperError: Int32 {
    case ok = 0
    case badArgs = 2
    case noPermission = 3
    case eventFailed = 4
}

func hasPermission() -> Bool {
    return AXIsProcessTrusted()
}

func postEvent(_ event: CGEvent?) -> Bool {
    guard let event = event else { return false }
    event.post(tap: .cghidEventTap)
    return true
}

func moveMouse(to point: CGPoint) -> Bool {
    return postEvent(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
}

func clickMouse(at point: CGPoint, button: CGMouseButton) -> Bool {
    let downType: CGEventType = button == .left ? .leftMouseDown : .rightMouseDown
    let upType: CGEventType = button == .left ? .leftMouseUp : .rightMouseUp
    if !moveMouse(to: point) { return false }
    // 落位后给系统一个极短缓冲，避免移动与按下被合并
    usleep(15_000)
    guard postEvent(CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: button)) else { return false }
    usleep(35_000)
    return postEvent(CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: button))
}

func typeText(_ text: String) -> Bool {
    let utf16 = Array(text.utf16)
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { return false }
    down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
    up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
    if !postEvent(down) { return false }
    usleep(20_000)
    return postEvent(up)
}

let keyCodeTable: [String: CGKeyCode] = [
    "enter": 36, "return": 36,
    "tab": 48,
    "space": 49,
    "delete": 51, "backspace": 51,
    "esc": 53, "escape": 53,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

func pressKey(_ name: String) -> Bool {
    guard let code = keyCodeTable[name.lowercased()] else { return false }
    guard postEvent(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)) else { return false }
    usleep(20_000)
    return postEvent(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false))
}

func scrollWheel(deltaY: Int32) -> Bool {
    // wheelCount 1，像素级滚动用 .pixel 单位更可控
    return postEvent(CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: deltaY, wheel2: 0, wheel3: 0))
}

func parseDouble(_ args: [String], _ index: Int) -> Double? {
    guard args.count > index, let v = Double(args[index]) else { return nil }
    return v
}

let args = CommandLine.arguments
var exitCode = HelperError.ok

guard args.count >= 2 else {
    FileHandle.standardError.write("usage: whale-input-helper <permission|move|click|type|key|scroll> ...\n".data(using: .utf8)!)
    exit(HelperError.badArgs.rawValue)
}

let command = args[1]

if command == "permission" {
    print(hasPermission() ? "granted" : "denied")
    exit(HelperError.ok.rawValue)
}

guard hasPermission() else {
    FileHandle.standardError.write("accessibility permission not granted\n".data(using: .utf8)!)
    exit(HelperError.noPermission.rawValue)
}

switch command {
case "move":
    guard let x = parseDouble(args, 2), let y = parseDouble(args, 3) else { exitCode = .badArgs; break }
    exitCode = moveMouse(to: CGPoint(x: x, y: y)) ? .ok : .eventFailed
case "click":
    guard let x = parseDouble(args, 2), let y = parseDouble(args, 3) else { exitCode = .badArgs; break }
    let button: CGMouseButton = (args.count > 4 && args[4] == "right") ? .right : .left
    exitCode = clickMouse(at: CGPoint(x: x, y: y), button: button) ? .ok : .eventFailed
case "type":
    guard args.count >= 3 else { exitCode = .badArgs; break }
    exitCode = typeText(args[2]) ? .ok : .eventFailed
case "key":
    guard args.count >= 3 else { exitCode = .badArgs; break }
    if keyCodeTable[args[2].lowercased()] == nil {
        FileHandle.standardError.write("unsupported key name: \(args[2])\n".data(using: .utf8)!)
        exitCode = .badArgs
    } else {
        exitCode = pressKey(args[2]) ? .ok : .eventFailed
    }
case "scroll":
    guard args.count >= 3, let delta = Int32(args[2]) else { exitCode = .badArgs; break }
    exitCode = scrollWheel(deltaY: delta) ? .ok : .eventFailed
default:
    FileHandle.standardError.write("unknown command: \(command)\n".data(using: .utf8)!)
    exitCode = .badArgs
}

exit(exitCode.rawValue)
