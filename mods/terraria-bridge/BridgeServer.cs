/**
 * 统一桥接协议 HTTP 服务端（M7 / T-M7-T2）。
 * 接口面（与 tools/mock-harness/src/terraria-simulator.ts 完全同协议）：
 *   GET  /state                         → TerrariaStateSnapshot JSON（经 StateExporter 镜像 POCO 出站）
 *   POST /act      {actionId,tool,args} → {accepted, actionId?, reason?}
 *   GET  /action_status?id=<uuid>       → {actionId, running, receipt?}
 *   POST /cancel                        → {cancelled: boolean}
 *   GET  /health                        → {ok, gameId, bridgeVersion, gameVersion, control}
 *
 * 契约来源：packages/shared-protocol/src/index.ts 的 Zod Schema（由 pnpm gen:contracts
 * 导出 JSON Schema 供 C# 侧 CI 校验）。此处以镜像 POCO + 显式字段校验落地，
 * 严禁额外发明字段；任何越权工具在 /act 处即拒绝。
 * 思想参考 Reisenbug/TerraBlind (MIT) 的模组内 HTTP 节奏；未复制源码。
 */
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;

namespace TerrariaBridge
{
    internal static class BridgeJson
    {
        internal static readonly JsonSerializerOptions Options = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            WriteIndented = false,
        };
    }

    // ── shared-protocol 镜像 POCO（GameBridge* / TerrariaActionReceipt） ──
    internal sealed class ActionRequestDto
    {
        public string ActionId { get; set; }
        public string Tool { get; set; }
        public Dictionary<string, JsonElement> Args { get; set; } = new Dictionary<string, JsonElement>();
    }

    internal sealed class AcceptedDto
    {
        public bool Accepted { get; set; }
        public string ActionId { get; set; }
        public string Reason { get; set; }
    }

    internal sealed class ReceiptDto
    {
        public string ActionId { get; set; }
        public string Tool { get; set; }
        public string GameId { get; set; } = "terraria";
        public string Status { get; set; }
        public string Reason { get; set; }
        public long StartedAt { get; set; }
        public long CompletedAt { get; set; }
    }

    internal sealed class StatusDto
    {
        public string ActionId { get; set; }
        public bool Running { get; set; }
        public ReceiptDto Receipt { get; set; }
    }

    internal sealed class HealthDto
    {
        public bool Ok { get; set; }
        public string GameId { get; set; } = "terraria";
        public string BridgeVersion { get; set; } = "0.1.0";
        public string GameVersion { get; set; } = "1.4.4.9";
        public string Control { get; set; } = "AI_AUTOPILOT";
    }

    internal sealed class CancelDto
    {
        public bool Cancelled { get; set; }
    }

    /// <summary>HttpListener 单例；端口固定 127.0.0.1:18090（只监听本机，不暴露局域网）。</summary>
    internal sealed class BridgeServer
    {
        internal const string Endpoint = "http://127.0.0.1:18090/";
        internal static readonly BridgeServer Instance = new BridgeServer();

        private HttpListener listener;
        private CancellationTokenSource cts;
        private Thread worker;

        public void Start()
        {
            try
            {
                if (listener != null && listener.IsListening) return;
                listener = new HttpListener();
                listener.Prefixes.Add(Endpoint);
                listener.Start();
                cts = new CancellationTokenSource();
                worker = new Thread(Loop) { IsBackground = true, Name = "terraria-bridge-http" };
                worker.Start();
                BridgeLog.Info("HTTP 桥已监听 " + Endpoint);
            }
            catch (Exception e)
            {
                // 端口占用等异常只记日志：模组继续可玩，绝不崩游戏
                BridgeLog.Error("HTTP 桥启动失败：" + e.Message);
            }
        }

        public void Stop()
        {
            try
            {
                cts?.Cancel();
                if (listener != null && listener.IsListening) listener.Stop();
                listener = null;
                BridgeLog.Info("HTTP 桥已停止");
            }
            catch (Exception e)
            {
                BridgeLog.Error("HTTP 桥停止异常：" + e.Message);
            }
        }

        private void Loop()
        {
            while (cts != null && !cts.IsCancellationRequested)
            {
                HttpListenerContext context;
                try
                {
                    context = listener?.GetContext();
                }
                catch (Exception)
                {
                    break; // listener.Stop() 或异常 → 退出循环
                }
                if (context == null) break;
                ThreadPool.QueueUserWorkItem(_ => Handle(context));
            }
        }

        private static void Handle(HttpListenerContext ctx)
        {
            try
            {
                string path = ctx.Request.Url?.AbsolutePath ?? "/";
                string method = ctx.Request.HttpMethod;
                if (method == "GET" && path == "/state")
                {
                    WriteRaw(ctx, 200, StateExporter.ExportJson());
                    return;
                }
                if (method == "GET" && path == "/health")
                {
                    WriteJson(ctx, 200, new HealthDto { Control = TakeoverWatch.CurrentAuthority });
                    return;
                }
                if (method == "GET" && path == "/action_status")
                {
                    string id = ctx.Request.QueryString["id"];
                    if (string.IsNullOrEmpty(id))
                    {
                        WriteJson(ctx, 400, new { error = "缺少 id 查询参数" });
                        return;
                    }
                    WriteJson(ctx, 200, ActionController.Instance.Query(id));
                    return;
                }
                if (method == "POST" && path == "/act")
                {
                    ActionRequestDto req = ReadJson<ActionRequestDto>(ctx);
                    if (req == null || !Guid.TryParse(req.ActionId, out _) || string.IsNullOrEmpty(req.Tool))
                    {
                        WriteJson(ctx, 400, new AcceptedDto { Accepted = false, Reason = "INVALID_REQUEST" });
                        return;
                    }
                    if (!BridgeWhitelist.IsAllowed(req.Tool))
                    {
                        WriteJson(ctx, 200, new AcceptedDto { Accepted = false, Reason = "TOOL_NOT_IN_WHITELIST" });
                        return;
                    }
                    var args = new Dictionary<string, object>();
                    if (req.Args != null)
                    {
                        foreach (KeyValuePair<string, JsonElement> kv in req.Args)
                        {
                            args[kv.Key] = JsonElementToObject(kv.Value);
                        }
                    }
                    WriteJson(ctx, 200, ActionController.Instance.TryAccept(req.ActionId, req.Tool, args));
                    return;
                }
                if (method == "POST" && path == "/cancel")
                {
                    WriteJson(ctx, 200, new CancelDto { Cancelled = ActionController.Instance.Cancel() });
                    return;
                }
                WriteJson(ctx, 404, new { error = "未知接口：" + method + " " + path });
            }
            catch (Exception e)
            {
                BridgeLog.Error("HTTP 请求处理异常：" + e.Message);
                try { WriteJson(ctx, 500, new { error = "INTERNAL_ERROR" }); } catch { /* 连接已断开 */ }
            }
        }

        private static object JsonElementToObject(JsonElement e)
        {
            switch (e.ValueKind)
            {
                case JsonValueKind.String: return e.GetString();
                case JsonValueKind.Number: return e.TryGetInt64(out long l) ? (object)l : e.GetDouble();
                case JsonValueKind.True: return true;
                case JsonValueKind.False: return false;
                case JsonValueKind.Null: return null;
                default: return e.GetRawText();
            }
        }

        private static T ReadJson<T>(HttpListenerContext ctx) where T : class
        {
            using var reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8);
            string body = reader.ReadToEnd();
            if (string.IsNullOrWhiteSpace(body)) return null;
            return JsonSerializer.Deserialize<T>(body, BridgeJson.Options);
        }

        private static void WriteJson(HttpListenerContext ctx, int status, object body)
        {
            WriteRaw(ctx, status, JsonSerializer.Serialize(body, BridgeJson.Options));
        }

        private static void WriteRaw(HttpListenerContext ctx, int status, string payload)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(payload ?? string.Empty);
            ctx.Response.StatusCode = status;
            ctx.Response.ContentType = "application/json; charset=utf-8";
            ctx.Response.ContentLength64 = bytes.Length;
            ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
            ctx.Response.OutputStream.Close();
        }
    }

    /// <summary>高层工具白名单镜像（与 terraria-adapter.ts 的 TERRARIA_TOOL_WHITELIST 一致）。</summary>
    internal static class BridgeWhitelist
    {
        private static readonly HashSet<string> Allowed = new HashSet<string>(StringComparer.Ordinal)
        {
            "get_state", "move_to", "jump", "mine", "place", "attack", "aim", "use_item", "craft", "build_shelter",
            "torch", "eat", "drink_potion", "grapple", "say", "set_mode", "update_notes", "cancel_action", "wait", "flee",
            "dig_tunnel", "place_platform", "place_wall", "collect", "interact", "equip", "unequip", "light_torch",
            "retreat", "heal", "status", "stop",
        };

        internal static bool IsAllowed(string tool) => tool != null && Allowed.Contains(tool);

        internal static bool IsLongAction(string tool)
        {
            return tool == "move_to" || tool == "mine" || tool == "build_shelter" || tool == "dig_tunnel"
                || tool == "flee" || tool == "grapple" || tool == "craft" || tool == "place_platform" || tool == "wait";
        }
    }
}
