// Whale Isle Avatar Sync（T-M6-62）：把鲸屿当前桌宠形象同步成星露谷玩家像素外观。
//
// 安全边界：
//   - active-avatar.json 由鲸屿主进程原子写入；本 Mod 只读，FileSystemWatcher 回调只置
//     dirty 标记，真正的 JSON 解析与 Texture2D 重载都在 GameLoop.UpdateTicked 主线程完成
//     （XNA 非线程安全）；
//   - spriteSheetPath 只取文件名（拒绝目录穿越），坏图/尺寸不符自动回落原版外观预设；
//   - 预设只改外观字段（发色/发型/衣裤/肤色/帽子/名字），不写任何存档数据。
//
// 本文件 API 已按本机 SMAPI 4.5.2 + Stardew 1.6 程序集反射核对：
//   changeHairStyle(int) / changeShirt(string) / changeSkinColor(int,bool) /
//   FarmerRenderer.MarkSpriteDirty() / GameLoop.SaveLoaded / Multiplayer.ModMessageReceived。
using System.Text.Json;
using HarmonyLib;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Characters;

namespace WhaleIsleAvatar;

public sealed class AvatarPreset
{
    public int Hair { get; set; }
    public string HairColor { get; set; } = "#8a5a2b";
    public int Shirt { get; set; }
    public string PantsColor { get; set; } = "#3b5bdb";
    public int Skin { get; set; }
    public int HatId { get; set; } = -1;
}

public sealed class AvatarConfig
{
    public int Version { get; set; }
    public string CharacterId { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public AvatarPreset Preset { get; set; } = new();
    public string? SpriteSheetPath { get; set; }
}

/// <summary>联机广播载荷（只含外观，不含任何凭据/存档数据）。</summary>
public sealed class AvatarBroadcast
{
    public string CharacterId { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public AvatarPreset Preset { get; set; } = new();
}

public sealed class ModEntry : StardewModdingAPI.Mod
{
    private const string ConfigFileName = "active-avatar.json";
    private const string MessageType = "WhaleIsleAvatarSync";

    private FileSystemWatcher? _watcher;
    private volatile bool _dirty;
    private DateTime _dirtyAt = DateTime.MinValue;
    private Texture2D? _sprite;
    private AvatarConfig _current = new();
    private readonly Dictionary<long, AvatarBroadcast> _peers = new();
    private Harmony? _harmony;

    public override void Entry(IModHelper helper)
    {
        DrawPatch.Mod = this;
        _harmony = new Harmony(ModManifest.UniqueID);
        _harmony.Patch(
            original: AccessTools.Method(typeof(Farmer), nameof(Farmer.draw), new[] { typeof(SpriteBatch) }),
            prefix: new HarmonyMethod(typeof(DrawPatch), nameof(DrawPatch.Prefix)));

        helper.Events.GameLoop.UpdateTicked += OnUpdateTicked;
        helper.Events.GameLoop.SaveLoaded += (_, _) => { MarkDirty(); Broadcast(); };
        helper.Events.Multiplayer.PeerConnected += (_, _) => Broadcast();
        helper.Events.Multiplayer.ModMessageReceived += OnMessageReceived;

        StartWatcher();
        MarkDirty();
    }

    private void StartWatcher()
    {
        try
        {
            _watcher = new FileSystemWatcher(Helper.DirectoryPath, ConfigFileName)
            {
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.FileName,
                EnableRaisingEvents = true,
            };
            _watcher.Changed += (_, _) => MarkDirty();
            _watcher.Created += (_, _) => MarkDirty();
            _watcher.Renamed += (_, _) => MarkDirty();
        }
        catch (Exception ex)
        {
            Monitor.Log($"FileSystemWatcher 启动失败（外观同步退化为重载存档时生效）：{ex.Message}", LogLevel.Warn);
        }
    }

    private void MarkDirty()
    {
        _dirty = true;
        _dirtyAt = DateTime.UtcNow;
    }

    private void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
    {
        if (!_dirty) return;
        // 200ms 去抖：主进程原子写（tmp+rename）可能触发两次事件
        if ((DateTime.UtcNow - _dirtyAt).TotalMilliseconds < 200) return;
        _dirty = false;
        Reload();
    }

    /// <summary>主进程写的是 camelCase JSON；System.Text.Json 默认大小写敏感，必须显式 camelCase + 忽略大小写。</summary>
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    private void Reload()
    {
        try
        {
            var path = Path.Combine(Helper.DirectoryPath, ConfigFileName);
            if (!File.Exists(path)) { _sprite = null; return; }
            var config = JsonSerializer.Deserialize<AvatarConfig>(File.ReadAllText(path), JsonOptions);
            if (config == null || config.Version != 1)
            {
                Monitor.Log("active-avatar.json 版本不符，忽略本次热切换", LogLevel.Warn);
                return;
            }
            _current = config;
            ApplyPreset(Game1.player, config);
            _sprite = LoadSprite(config.SpriteSheetPath);
            Broadcast();
        }
        catch (Exception ex)
        {
            Monitor.Log($"active-avatar.json 读取失败（保持上一次外观）：{ex.Message}", LogLevel.Warn);
        }
    }

    private Texture2D? LoadSprite(string? spriteSheetPath)
    {
        if (string.IsNullOrWhiteSpace(spriteSheetPath)) return null;
        // 只取文件名，拒绝任何目录穿越
        var fileName = Path.GetFileName(spriteSheetPath);
        if (fileName != spriteSheetPath)
        {
            Monitor.Log("spriteSheetPath 含目录成分，已拒绝", LogLevel.Warn);
            return null;
        }
        var fullPath = Path.Combine(Helper.DirectoryPath, fileName);
        if (!File.Exists(fullPath)) return null;
        try
        {
            var texture = Helper.ModContent.Load<Texture2D>(fileName);
            if (texture.Width != 64 || texture.Height != 128)
            {
                Monitor.Log($"像素表尺寸应为 64x128，实际 {texture.Width}x{texture.Height}，回落原版预设", LogLevel.Warn);
                return null;
            }
            return texture;
        }
        catch (Exception ex)
        {
            Monitor.Log($"像素表加载失败（回落原版预设）：{ex.Message}", LogLevel.Warn);
            return null;
        }
    }

    private void ApplyPreset(Farmer farmer, AvatarConfig config)
    {
        if (config.DisplayName.Length > 0 && farmer.Name != config.DisplayName)
            farmer.Name = config.DisplayName;
        farmer.changeHairStyle(Math.Max(0, config.Preset.Hair));
        farmer.changeHairColor(ParseColor(config.Preset.HairColor, new Color(138, 90, 43)));
        farmer.changeShirt(Math.Max(0, config.Preset.Shirt).ToString());
        farmer.changePantsColor(ParseColor(config.Preset.PantsColor, new Color(59, 91, 219)));
        farmer.changeSkinColor(Math.Max(0, config.Preset.Skin), true);
        if (config.Preset.HatId >= 0) farmer.changeHat(config.Preset.HatId);
        farmer.FarmerRenderer.MarkSpriteDirty();
    }

    private static Color ParseColor(string hex, Color fallback)
    {
        if (hex.Length == 7 && hex[0] == '#'
            && int.TryParse(hex.Substring(1, 2), System.Globalization.NumberStyles.HexNumber, null, out var r)
            && int.TryParse(hex.Substring(3, 2), System.Globalization.NumberStyles.HexNumber, null, out var g)
            && int.TryParse(hex.Substring(5, 2), System.Globalization.NumberStyles.HexNumber, null, out var b))
            return new Color(r, g, b);
        return fallback;
    }

    private void Broadcast()
    {
        if (!Context.IsMultiplayer) return;
        try
        {
            Helper.Multiplayer.SendMessage(new AvatarBroadcast
            {
                CharacterId = _current.CharacterId,
                DisplayName = _current.DisplayName,
                Preset = _current.Preset,
            }, MessageType, new[] { MessageType });
        }
        catch (Exception ex)
        {
            Monitor.Log($"联机外观广播失败：{ex.Message}", LogLevel.Trace);
        }
    }

    private void OnMessageReceived(object? sender, ModMessageReceivedEventArgs e)
    {
        if (e.Type != MessageType || e.FromPlayerID == Game1.player.UniqueMultiplayerID) return;
        var payload = e.ReadAs<AvatarBroadcast>();
        if (payload == null) return;
        _peers[e.FromPlayerID] = payload;
    }

    internal Texture2D? SpriteFor(Farmer farmer)
    {
        // 只有本端玩家有像素表；其他玩家由各自客户端的 Mod 用预设/像素表渲染
        return farmer.IsLocalPlayer ? _sprite : null;
    }

    /// <summary>Harmony 前缀：有合法像素表时完全接管绘制，否则交给原版。</summary>
    internal static class DrawPatch
    {
        internal static ModEntry? Mod;

        internal static bool Prefix(Farmer __instance, SpriteBatch b)
        {
            var mod = Mod;
            if (mod == null) return true;
            var texture = mod.SpriteFor(__instance);
            if (texture == null) return true;

            var direction = __instance.FacingDirection switch
            {
                0 => 0, // 下
                1 => 1, // 右
                2 => 2, // 上
                3 => 3, // 左
                _ => 0,
            };
            // 上一 tick 真的移动过才播行走帧，静止用第 0 帧（待机）
            var moving = __instance.movedDuringLastTick();
            var frame = moving ? Math.Clamp(__instance.FarmerSprite.CurrentFrame, 0, 3) : 0;
            var source = new Rectangle(frame * 16, direction * 32, 16, 32);
            var zoom = Game1.options.zoomLevel;
            var viewport = Game1.viewport;
            var position = new Vector2(
                (__instance.Position.X - viewport.X) * zoom,
                (__instance.Position.Y - viewport.Y) * zoom);
            var layerDepth = Math.Max(0f, (__instance.Position.Y + 32f) / 10000f);
            b.Draw(texture, position, source, Color.White, 0f, Vector2.Zero, zoom, SpriteEffects.None, layerDepth);
            return false;
        }
    }

    protected override void Dispose(bool disposing)
    {
        _watcher?.Dispose();
        _harmony?.UnpatchAll(ModManifest.UniqueID);
        base.Dispose(disposing);
    }
}
