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
    public string CharacterId { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public AvatarPreset Preset { get; set; } = new();
    public string? SpriteSheetPath { get; set; }
    public string? SpriteTier { get; set; }
    public bool Liveliness { get; set; } = true;
}

public sealed class ModEntry : StardewModdingAPI.Mod
{
    private const string ConfigFileName = "active-avatar.json";

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
        helper.Events.GameLoop.SaveLoaded += (_, _) => MarkDirty();

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
            _liveliness = config.Liveliness;
            ApplyPreset(Game1.player, config);
            _sprite = LoadSprite(config.SpriteSheetPath);
            DrawPatch.ResetTakeoverLog();
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
            // 自适应多分辨率：4 行 × (6 列或 4 列)，每帧 1:2 比例，支持 1x(16x32) / 2x(32x64) / 4x(64x128) / 8x(128x256)
            if (texture.Height <= 0 || texture.Height % 4 != 0)
            {
                Monitor.Log($"精灵表高度需为 4 的倍数，实际 {texture.Width}x{texture.Height}，回落原版预设", LogLevel.Warn);
                return null;
            }
            int cellH = texture.Height / 4;
            if (cellH % 2 != 0)
            {
                Monitor.Log($"精灵表帧高需为偶数（1:2 比例），实际 {texture.Width}x{texture.Height}，回落原版预设", LogLevel.Warn);
                return null;
            }
            int cellW = cellH / 2;
            bool validScale = cellW == 16 || cellW == 32 || cellW == 64 || cellW == 128;
            int cols = cellW > 0 && texture.Width % cellW == 0 ? texture.Width / cellW : 0;
            if (!validScale || (cols != 6 && cols != 4))
            {
                Monitor.Log(
                    $"精灵表尺寸应为 1x(96x128) / 2x(192x256) / 4x(384x512)（兼容 4 列旧图），实际 {texture.Width}x{texture.Height}，回落原版预设",
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

    internal Texture2D? SpriteFor(Farmer farmer)
    {
        // 只替换本端玩家；联机多开时每个游戏实例各自安装 Mod、各自读取自己的 active-avatar.json
        return farmer.IsLocalPlayer ? _sprite : null;
    }

    /// <summary>Harmony 前缀：有合法精灵表且非原版专属姿态时，接管 base 身体层的绘制。</summary>
    internal static class DrawPatch
    {
        internal static ModEntry? Mod;

        // 像素表第 2/3/4 列（索引 1/2/3）是左脚在前/右脚在前/双脚过渡；四相位循环更顺滑。
        private static readonly int[] WalkPose = { 1, 3, 2, 3 };
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

            int column = SelectColumn(who, farmerSprite, cols, out bool isMoving, out bool isAction, out bool isEmote);
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

            // 屏幕上与原版 16×32×4 = 64×128 完全等大的基础缩放倍率
            float baseDrawScale = (64f / cellW) * scale;
            var drawPosition = new Vector2((float)Math.Floor(position.X), (float)Math.Floor(position.Y));
            var frameOffset = new Vector2(animationFrame.xOffset * 4f, animationFrame.positionOffset * 4f);

            // 将原版 16×32 的 (position, origin) 换算为屏幕上的精确脚底中心坐标，
            // 使 1×/2×/4×/8× 所有分辨率与原版 100% 脚底重合，呼吸/弹跳均稳稳锚在脚底。
            var screenOrigin = drawPosition + origin + frameOffset;
            var footScreenPos = screenOrigin + new Vector2((8f - origin.X) * 4f * scale, (32f - origin.Y) * 4f * scale);
            var pivotOrigin = new Vector2(cellW * 0.5f, cellH);

            float squashX = 1f;
            float squashY = 1f;
            float bounceY = 0f;
            float extraRotation = 0f;

            if (mod._liveliness)
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
                else if (isMoving)
                {
                    // 行走/奔跑：步伐弹性轻跳 + 左右方向轻微前倾
                    float stride = (float)Math.Abs(Math.Sin(t * 11.5));
                    bounceY = -stride * 2.4f * scale;
                    squashY = 1f + stride * 0.022f;
                    squashX = 1f - stride * 0.015f;
                    if (who.FacingDirection == 1) extraRotation = 0.032f;
                    else if (who.FacingDirection == 3) extraRotation = -0.032f;
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

            // 柔和脚底地面投影（贴合草地/地板，消除高清立绘的「悬浮贴纸感」）
            if (mod._liveliness && Game1.shadowTexture != null)
            {
                var shadowTex = Game1.shadowTexture;
                float shadowScale = (1f - Math.Min(0.18f, Math.Abs(bounceY) * 0.03f)) * 4f * scale;
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
                return WalkPose[Math.Abs(sprite.currentAnimationIndex) % WalkPose.Length];
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
