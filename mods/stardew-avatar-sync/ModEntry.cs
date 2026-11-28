// Whale Isle Avatar Sync（T-M6-62 升级：多分辨率自适应 1×/2×/4×/8× + 程序化灵动动画）。
//
// 安全边界：
//   - active-avatar.json 由鲸屿主进程原子写入；本 Mod 只读，FileSystemWatcher 回调只置
//     dirty 标记，真正的 JSON 解析与 Texture2D 重载都在 GameLoop.UpdateTicked 主线程完成
//     （XNA 非线程安全）；
//   - spriteSheetPath 只取文件名（拒绝目录穿越），坏图/尺寸不符自动回落原版外观预设；
//   - 预设只改外观字段（发色/发型/衣裤/肤色/帽子/名字），不写任何存档数据。
//
// 分辨率自适应：
//   - 自动识别 4 行 × (6 或 4) 列、每格 1:2 比例的贴图：
//     1× (96×128 / 64×128, 16×32 帧) · 2× (192×256, 32×64 帧) · 4× (384×512, 64×128 帧) · 8× (768×1024)；
//   - 以脚底中心 (cellW/2, cellH) 作为统一锚点与缩放支点，保证所有分辨率与原版农夫 100% 脚底重合，
//     并支持柔和脚底阴影、待机微呼吸、行走弹性微跳与微倾、动作挤压拉伸（受 liveliness 开关控制）。
using System.Text.Json;
using HarmonyLib;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;

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
    public bool Enabled { get; set; } = true;
    public string CharacterId { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public AvatarPreset Preset { get; set; } = new();
    public string? SpriteSheetPath { get; set; }
    public string? SpriteTier { get; set; }
    public bool Liveliness { get; set; } = true;
    public bool SyncDisplayName { get; set; } = true;
}

public sealed class NativeFarmerBackup
{
    public string Name { get; set; } = "";
    public int Hair { get; set; }
    public string HairColor { get; set; } = "#8a5a2b";
    public string ShirtId { get; set; } = "0";
    public string PantsColor { get; set; } = "#3b5bdb";
    public int Skin { get; set; }
    public string? HatItemId { get; set; }
    public bool TouchedHat { get; set; }
    public bool TouchedName { get; set; }
}

public sealed class ModEntry : StardewModdingAPI.Mod
{
    private const string ConfigFileName = "active-avatar.json";
    private const string BackupFileName = "native-backup.json";

    private FileSystemWatcher? _watcher;
    private volatile bool _dirty;
    private DateTime _dirtyAt = DateTime.MinValue;
    private Texture2D? _sprite;
    private int _spriteColumns;
    private int _cellWidth = 16;
    private int _cellHeight = 32;
    private bool _liveliness = true;
    private Harmony? _harmony;

    public override void Entry(IModHelper helper)
    {
        DrawPatch.Mod = this;
        _harmony = new Harmony(ModManifest.UniqueID);
        // 挂 FarmerRenderer.draw 的 12 参主实现（9 参重载会被 JIT 内联，Harmony 拦不到），
        // 直接复用原版算好的屏幕坐标、缩放支点、层深与逐帧偏移，替换 base 贴图帧并叠加灵动微动画。
        _harmony.Patch(
            original: AccessTools.Method(typeof(FarmerRenderer), nameof(FarmerRenderer.draw), new[]
            {
                typeof(SpriteBatch), typeof(FarmerSprite.AnimationFrame), typeof(int), typeof(Rectangle),
                typeof(Vector2), typeof(Vector2), typeof(float), typeof(int), typeof(Color),
                typeof(float), typeof(float), typeof(Farmer),
            }),
            prefix: new HarmonyMethod(typeof(DrawPatch), nameof(DrawPatch.Prefix)));

        helper.Events.GameLoop.UpdateTicked += OnUpdateTicked;
        helper.Events.GameLoop.SaveLoaded += (_, _) =>
        {
            _dirty = false;
            Reload();
        };

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
            if (!File.Exists(path))
            {
                DeactivateSync();
                return;
            }
            var config = JsonSerializer.Deserialize<AvatarConfig>(File.ReadAllText(path), JsonOptions);
            if (config == null || config.Version != 1)
            {
                Monitor.Log("active-avatar.json 版本不符，忽略本次热切换", LogLevel.Warn);
                return;
            }
            if (!config.Enabled)
            {
                DeactivateSync(config);
                return;
            }
            _liveliness = config.Liveliness;
            if (Context.IsWorldReady && Game1.player != null)
            {
                EnsureNativeBackup(Game1.player, config);
                ApplyPreset(Game1.player, config);
            }
            _sprite = LoadSprite(config.SpriteSheetPath);
            DrawPatch.ResetTakeoverLog();
        }
        catch (Exception ex)
        {
            Monitor.Log($"active-avatar.json 读取失败（保持上一次外观）：{ex.Message}", LogLevel.Warn);
        }
    }

    private void DeactivateSync(AvatarConfig? lastConfig = null)
    {
        bool hadSprite = _sprite != null;
        _sprite = null;
        DrawPatch.ResetTakeoverLog();
        bool restored = false;
        if (Context.IsWorldReady && Game1.player != null)
        {
            restored = RestoreNativeIfPresent(Game1.player, lastConfig);
        }
        if (hadSprite || restored)
        {
            Monitor.Log("已关闭桌宠形象同步，游戏内角色已恢复原生外观", LogLevel.Info);
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
            // 自适应多分辨率与宽幅防裁切画格：4 行 × (6 或 4) 列；单格高 32/64/128/256，支持 1:1 宽幅 / 3:4 / 旧版 1:2
            if (texture.Height <= 0 || texture.Height % 4 != 0)
            {
                Monitor.Log($"精灵表高度需为 4 的倍数，实际 {texture.Width}x{texture.Height}，回落原版预设", LogLevel.Warn);
                return null;
            }
            int cellH = texture.Height / 4;
            bool validHeight = cellH == 32 || cellH == 64 || cellH == 128 || cellH == 256;
            int cols = texture.Width % 6 == 0 ? 6 : (texture.Width % 4 == 0 ? 4 : 0);
            int cellW = cols > 0 ? texture.Width / cols : 0;
            bool validWidth = cellW > 0 && (
                cellW == cellH
                || cellW * 4 == cellH * 3
                || cellW * 2 == cellH);
            if (cols == 4 && texture.Width % 6 == 0)
            {
                int w6 = texture.Width / 6;
                if (w6 == cellH || w6 * 4 == cellH * 3 || w6 * 2 == cellH)
                {
                    cols = 6;
                    cellW = w6;
                    validWidth = true;
                }
            }
            if (!validHeight || cols == 0 || !validWidth)
            {
                Monitor.Log(
                    $"精灵表尺寸不符（支持 1x 192x128 / 2x 384x256 / 4x 768x512 及旧版 1:2），实际 {texture.Width}x{texture.Height}，回落原版预设",
                    LogLevel.Warn);
                return null;
            }
            _cellWidth = cellW;
            _cellHeight = cellH;
            _spriteColumns = cols;
            return texture;
        }
        catch (Exception ex)
        {
            Monitor.Log($"精灵表加载失败（回落原版预设）：{ex.Message}", LogLevel.Warn);
            return null;
        }
    }

    private static string BackupKey(Farmer farmer)
        => string.IsNullOrWhiteSpace(Constants.SaveFolderName)
            ? farmer.UniqueMultiplayerID.ToString()
            : $"{Constants.SaveFolderName}:{farmer.UniqueMultiplayerID}";

    private static string FormatHex(Color c) => $"#{c.R:x2}{c.G:x2}{c.B:x2}";

    private Dictionary<string, NativeFarmerBackup> ReadBackups()
    {
        try
        {
            var path = Path.Combine(Helper.DirectoryPath, BackupFileName);
            if (!File.Exists(path)) return new Dictionary<string, NativeFarmerBackup>();
            return JsonSerializer.Deserialize<Dictionary<string, NativeFarmerBackup>>(File.ReadAllText(path), JsonOptions)
                ?? new Dictionary<string, NativeFarmerBackup>();
        }
        catch
        {
            return new Dictionary<string, NativeFarmerBackup>();
        }
    }

    private void WriteBackups(Dictionary<string, NativeFarmerBackup> backups)
    {
        try
        {
            var path = Path.Combine(Helper.DirectoryPath, BackupFileName);
            var temp = path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(backups, JsonOptions));
            File.Move(temp, path, overwrite: true);
        }
        catch (Exception ex)
        {
            Monitor.Log($"native-backup.json 写入失败：{ex.Message}", LogLevel.Warn);
        }
    }

    private void EnsureNativeBackup(Farmer farmer, AvatarConfig config)
    {
        var key = BackupKey(farmer);
        var backups = ReadBackups();
        bool touchHat = config.Preset.HatId >= 0;
        bool touchName = config.SyncDisplayName && config.DisplayName.Length > 0;
        if (backups.TryGetValue(key, out var existing))
        {
            bool changed = false;
            if (touchHat && !existing.TouchedHat) { existing.TouchedHat = true; changed = true; }
            if (touchName && !existing.TouchedName) { existing.TouchedName = true; changed = true; }
            if (changed) WriteBackups(backups);
            return;
        }
        backups[key] = new NativeFarmerBackup
        {
            Name = farmer.Name ?? "",
            Hair = farmer.hair.Value,
            HairColor = FormatHex(farmer.hairstyleColor.Value),
            ShirtId = farmer.GetShirtId() ?? "0",
            PantsColor = FormatHex(farmer.GetPantsColor()),
            Skin = farmer.skin.Value,
            HatItemId = farmer.hat.Value?.ItemId,
            TouchedHat = touchHat,
            TouchedName = touchName,
        };
        WriteBackups(backups);
    }

    private bool RestoreNativeIfPresent(Farmer farmer, AvatarConfig? lastConfig = null)
    {
        var key = BackupKey(farmer);
        var backups = ReadBackups();
        if (!backups.TryGetValue(key, out var backup))
        {
            // 兼容旧版 0.3.x 已写过预设但尚无 native-backup.json 的存档：若农夫当前仍穿着该预设外观，则复位为星露谷默认原版外观
            if (lastConfig != null
                && farmer.hair.Value == Math.Max(0, lastConfig.Preset.Hair)
                && FormatHex(farmer.hairstyleColor.Value).Equals(lastConfig.Preset.HairColor, StringComparison.OrdinalIgnoreCase))
            {
                farmer.changeHairStyle(0);
                farmer.changeHairColor(new Color(138, 90, 43));
                farmer.changeShirt("0");
                farmer.changePantsColor(new Color(46, 85, 181));
                farmer.changeSkinColor(0, true);
                farmer.FarmerRenderer.MarkSpriteDirty();
                return true;
            }
            return false;
        }
        farmer.changeHairStyle(Math.Max(0, backup.Hair));
        farmer.changeHairColor(ParseColor(backup.HairColor, new Color(138, 90, 43)));
        farmer.changeShirt(string.IsNullOrWhiteSpace(backup.ShirtId) ? "0" : backup.ShirtId);
        farmer.changePantsColor(ParseColor(backup.PantsColor, new Color(59, 91, 219)));
        farmer.changeSkinColor(Math.Max(0, backup.Skin), true);
        if (backup.TouchedHat)
        {
            if (string.IsNullOrWhiteSpace(backup.HatItemId))
                farmer.hat.Value = null;
            else
                farmer.hat.Value = ItemRegistry.Create<StardewValley.Objects.Hat>("(H)" + backup.HatItemId.Replace("(H)", ""));
        }
        if (backup.TouchedName && !string.IsNullOrWhiteSpace(backup.Name))
        {
            farmer.Name = backup.Name;
        }
        farmer.FarmerRenderer.MarkSpriteDirty();
        backups.Remove(key);
        WriteBackups(backups);
        return true;
    }

    private void ApplyPreset(Farmer farmer, AvatarConfig config)
    {
        if (config.SyncDisplayName && config.DisplayName.Length > 0 && farmer.Name != config.DisplayName)
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

    internal Texture2D? SpriteFor(Farmer farmer)
    {
        // 只替换本端玩家；联机多开时每个游戏实例各自安装 Mod、各自读取自己的 active-avatar.json
        return farmer.IsLocalPlayer ? _sprite : null;
    }

    /// <summary>Harmony 前缀：有合法精灵表且非原版专属姿态时，接管 base 身体层的绘制。</summary>
    internal static class DrawPatch
    {
        internal static ModEntry? Mod;

        // 节拍对齐原版 FarmerSprite 4 相位循环（0/2 为落地过渡，1/3 为迈步推地）：
        // 侧面用第 4 列（索引 3）柔和过渡；上下走避开第 4 列（AI 常画成内八交叉或双手合十），改用清晰自然的第 1 列（索引 0）居中站姿过渡。
        private static readonly int[] SideWalkPose = { 3, 1, 3, 2 };
        private static readonly int[] VerticalWalkPose = { 0, 1, 0, 2 };
        private static bool _loggedTakeover;

        internal static void ResetTakeoverLog() => _loggedTakeover = false;

        internal static bool Prefix(
            SpriteBatch b,
            FarmerSprite.AnimationFrame animationFrame,
            int currentFrame,
            Rectangle sourceRect,
            Vector2 position,
            Vector2 origin,
            float layerDepth,
            int facingDirection,
            Color overrideColor,
            float rotation,
            float scale,
            Farmer who)
        {
            var mod = Mod;
            if (mod == null) return true;
            if (FarmerRenderer.isDrawingForUI) return true;
            var texture = mod.SpriteFor(who);
            if (texture == null) return true;
            // 原版专属姿态交还原版绘制，避免精灵表摆出错误姿势：
            // 洗澡/坐下/骑马/木筏/游泳/睡觉/晕倒/弹弓（手臂与瞄准线在 renderer 内部）
            if (who.bathingClothes.Value || who.IsSitting() || who.isRidingHorse() || who.isRafting
                || who.swimming.Value || who.isInBed.Value || who.usingSlingshot)
            {
                return true;
            }
            if (currentFrame == 104 || currentFrame == 105) return true;

            var farmerSprite = who.FarmerSprite;
            if (farmerSprite == null) return true;

            int cellW = mod._cellWidth;
            int cellH = mod._cellHeight;
            int cols = mod._spriteColumns;
            if (!_loggedTakeover)
            {
                _loggedTakeover = true;
                mod.Monitor.Log(
                    $"已接管玩家身体绘制（精灵表 {texture.Width}x{texture.Height}，{cellW}x{cellH}/帧，{cols} 列，灵动动画 {(mod._liveliness ? "开" : "关")}）",
                    LogLevel.Info);
            }

            int column = SelectColumn(who, farmerSprite, cols, out int animPhase, out bool isMoving, out bool isAction, out bool isEmote);
            // 精灵表行序：下/右/上/左；原版 FacingDirection：0 上 / 1 右 / 2 下 / 3 左
            int row = who.FacingDirection switch
            {
                0 => 2,
                1 => 1,
                2 => 0,
                3 => 3,
                _ => 0,
            };
            var source = new Rectangle(column * cellW, row * cellH, cellW, cellH);

            // 屏幕上按高度（128px）严格等比对齐原版农夫身高，兼容 1:1 宽幅 / 3:4 / 旧版 1:2
            float baseDrawScale = (128f / cellH) * scale;
            var drawPosition = new Vector2((float)Math.Floor(position.X), (float)Math.Floor(position.Y));
            // 行走/奔跑期间分离地面阴影坐标与步态抬脚起伏，消除原版跑步 positionOffset=-2 导致的地面阴影与身体猛跳 -8px
            var frameOffset = isMoving
                ? new Vector2(animationFrame.xOffset * 4f, 0f)
                : new Vector2(animationFrame.xOffset * 4f, animationFrame.positionOffset * 4f);

            var screenOrigin = drawPosition + origin + frameOffset;
            var footScreenPos = screenOrigin + new Vector2((8f - origin.X) * 4f * scale, (32f - origin.Y) * 4f * scale);
            var pivotOrigin = new Vector2(cellW * 0.5f, cellH);

            float squashX = 1f;
            float squashY = 1f;
            float bounceY = 0f;
            float extraRotation = 0f;

            if (isMoving)
            {
                // 迈步相位（animPhase == 1 或 3）：节拍同步的轻快单步轻抬（约 2–2.5px），不再叠加异步正弦抖动或 -8px 猛跳
                bool stepBeat = (animPhase & 1) == 1;
                bool verticalWalk = who.FacingDirection == 0 || who.FacingDirection == 2;
                float liftPx = mod._liveliness ? (verticalWalk ? 2.2f : 2.8f) : 1.5f;
                if (stepBeat)
                {
                    bounceY = -liftPx * scale;
                    if (mod._liveliness)
                    {
                        squashY = 1.018f;
                        squashX = 0.988f;
                    }
                }
                if (mod._liveliness)
                {
                    if (who.FacingDirection == 1) extraRotation = 0.028f;
                    else if (who.FacingDirection == 3) extraRotation = -0.028f;
                    else if (stepBeat) extraRotation = animPhase == 1 ? 0.020f : -0.020f; // 上下走微幅重心左右交替
                }
            }
            else if (mod._liveliness)
            {
                double t = Game1.currentGameTime?.TotalGameTime.TotalSeconds ?? 0.0;
                if (isAction || isEmote)
                {
                    // 挥工具/钓鱼/表情：轻快弹性脉冲
                    float pulse = (float)Math.Sin(t * 14.0);
                    squashY = 1f + 0.032f * pulse;
                    squashX = 1f - 0.022f * pulse;
                    bounceY = -Math.Max(0f, pulse) * 1.8f * scale;
                }
                else
                {
                    // 待机微呼吸（约 2.6 秒柔和起伏，脚底锁死不浮空）
                    float breath = (float)Math.Sin(t * 2.4);
                    squashY = 1f + 0.018f * breath;
                    squashX = 1f - 0.010f * breath;
                }
            }

            var depth = FarmerRenderer.GetLayerDepth(layerDepth, FarmerRenderer.FarmerSpriteLayers.Base);

            // 柔和脚底地面投影（贴合地面，不再跟随起身步态上下瞬移）
            if (mod._liveliness && Game1.shadowTexture != null)
            {
                var shadowTex = Game1.shadowTexture;
                float shadowScale = (1f - Math.Min(0.14f, Math.Abs(bounceY) * 0.025f)) * 4f * scale;
                var shadowOrigin = new Vector2(shadowTex.Width * 0.5f, shadowTex.Height * 0.5f);
                var shadowPos = new Vector2(footScreenPos.X, footScreenPos.Y - 4f * scale);
                b.Draw(
                    shadowTex,
                    shadowPos,
                    null,
                    Color.White * 0.58f,
                    0f,
                    shadowOrigin,
                    new Vector2(shadowScale * 1.05f, shadowScale * 0.85f),
                    SpriteEffects.None,
                    Math.Max(0f, depth - 0.0001f));
            }

            b.Draw(
                texture,
                footScreenPos + new Vector2(0f, bounceY),
                source,
                overrideColor,
                rotation + extraRotation,
                pivotOrigin,
                new Vector2(baseDrawScale * squashX, baseDrawScale * squashY),
                SpriteEffects.None,
                depth);
            return false;
        }

        private static int SelectColumn(
            Farmer who,
            FarmerSprite sprite,
            int columns,
            out int animPhase,
            out bool isMoving,
            out bool isAction,
            out bool isEmote)
        {
            int anim = sprite.currentSingleAnimation;
            bool walk = anim >= 0 && anim < 32 && anim % 8 == 0;
            bool run = anim >= 32 && anim < 64 && anim % 8 == 0;
            bool carryWalk = anim >= 96 && anim < 128 && anim % 8 == 0;
            bool carryRun = anim >= 128 && anim < 160 && anim % 8 == 0;
            bool locomotion = walk || run || carryWalk || carryRun;
            bool moving = who.isMoving() || who.movedDuringLastTick();

            animPhase = Math.Abs(sprite.currentAnimationIndex) % 4;
            isMoving = false;
            isAction = false;
            isEmote = false;

            // 表情：原版 doEmote 用 animateOnce(AnimationFrame[]) 播身体动作（currentSingleAnimation = -1）
            if (columns >= 6 && who.IsEmoting && sprite.PauseForSingleAnimation && anim < 0)
            {
                isEmote = true;
                return 5;
            }
            // 工具/挥砍/钓鱼/吃喝/抓取：动作列（原版这些动画索引都 >= 64）
            if (!locomotion && (who.UsingTool || sprite.PauseForSingleAnimation || anim >= 64))
            {
                isAction = true;
                return columns >= 5 ? 4 : 3;
            }
            if (locomotion && moving)
            {
                isMoving = true;
                bool verticalWalk = who.FacingDirection == 0 || who.FacingDirection == 2;
                if (verticalWalk || columns < 4) return VerticalWalkPose[animPhase];
                return SideWalkPose[animPhase];
            }
            if (who.UsingTool || sprite.PauseForSingleAnimation)
            {
                isAction = true;
                return columns >= 5 ? 4 : 3;
            }
            // 待机（原版 showNotCarrying 会借用 32/48 的站姿帧，不能按跑步处理）
            return 0;
        }
    }

    protected override void Dispose(bool disposing)
    {
        _watcher?.Dispose();
        _harmony?.UnpatchAll(ModManifest.UniqueID);
        base.Dispose(disposing);
    }
}
