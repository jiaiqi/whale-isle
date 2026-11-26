// whale-audio-helper — V2-P3-01 真实音频播放头助手（AVAudioPlayer）
//
// 设计约束（AGENTS.md 运行时安全锁）：
// - 本程序为开发期编译的固定功能二进制，运行时由 Electron 主进程以固定子命令 + 参数数组
//   （spawn，不走 shell）调用；不读取任何配置文件，不接受任意脚本，不存在命令注入面。
// - 只做两件事：探测音频可解码时长 / 真实播放并按 100ms 回报**真实播放位置**。
//   位置取自 AVAudioPlayer.currentTime（设备时钟驱动的播放头），不是墙钟推算。
// - 播放结束/被停止/解码失败都输出结构化 JSON 行，调用方以最后一行与退出码为准。
//
// 用法：
//   whale-audio-helper probe <file>                     打印 {"type":"probe","durationMs":N}
//   whale-audio-helper play <file> [--duration-ms N]    播放并每 100ms 打印 position
//
// 输出事件（每行一个 JSON）：
//   {"type":"started","durationMs":N}
//   {"type":"position","positionMs":N,"wallMs":N}
//   {"type":"ended","positionMs":N}
//   {"type":"stopped","positionMs":N}
//   {"type":"error","reason":"..."}
//
// 退出码：0 正常结束或按 --duration-ms 截断；2 参数错误；4 文件不存在/无法解码；5 播放启动失败。
import AVFoundation
import Foundation

var stopRequested = false

func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func usage() -> Int32 {
    FileHandle.standardError.write(Data("usage: whale-audio-helper <probe|play> <file> [--duration-ms N]\n".utf8))
    return 2
}

func run() -> Int32 {
    let args = CommandLine.arguments
    guard args.count >= 3 else { return usage() }
    let command = args[1]
    guard command == "play" || command == "probe" else { return usage() }
    let path = args[2]

    var durationLimitMs = 0
    var index = 3
    while index < args.count {
        if args[index] == "--duration-ms", index + 1 < args.count, let value = Int(args[index + 1]) {
            durationLimitMs = max(0, value)
            index += 2
        } else {
            index += 1
        }
    }

    guard FileManager.default.fileExists(atPath: path) else {
        emit(["type": "error", "reason": "file_not_found: \(path)"])
        return 4
    }

    let player: AVAudioPlayer
    do {
        player = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: path))
    } catch {
        emit(["type": "error", "reason": "decode_failed: \(error.localizedDescription)"])
        return 4
    }
    guard player.prepareToPlay() else {
        emit(["type": "error", "reason": "prepare_failed"])
        return 4
    }
    let durationMs = Int((player.duration * 1000).rounded())

    if command == "probe" {
        emit(["type": "probe", "durationMs": durationMs])
        return 0
    }

    // SIGTERM/SIGINT 由 DispatchSource 转成标志位：主线程继续跑 RunLoop，能及时响应停止请求。
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    termSource.setEventHandler { stopRequested = true }
    termSource.resume()
    let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    intSource.setEventHandler { stopRequested = true }
    intSource.resume()

    guard player.play() else {
        emit(["type": "error", "reason": "play_failed"])
        return 5
    }
    emit(["type": "started", "durationMs": durationMs])
    let startedAt = Date()

    while player.isPlaying {
        let positionMs = Int((player.currentTime * 1000).rounded())
        let wallMs = Int(Date().timeIntervalSince(startedAt) * 1000)
        emit(["type": "position", "positionMs": positionMs, "wallMs": wallMs])
        if stopRequested {
            player.stop()
            emit(["type": "stopped", "positionMs": positionMs])
            return 0
        }
        if durationLimitMs > 0 && positionMs >= durationLimitMs {
            player.stop()
            emit(["type": "ended", "positionMs": positionMs])
            return 0
        }
        // 用 RunLoop 轮询而不是 usleep：主队列上的信号源才能被及时处理
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }

    emit(["type": "ended", "positionMs": Int((player.currentTime * 1000).rounded())])
    return 0
}

exit(run())
