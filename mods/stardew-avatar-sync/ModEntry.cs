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

public sealed class ModEntry : StardewModdingAPI.Mod
{
    private const string ConfigFileName = "active-avatar.json";

    private FileSystemWatcher? _watcher;
    private volatile bool _dirty;
    private DateTime _dirtyAt = DateTime.MinValue;
    private Texture2D? _sprite;
    /** 4=旧版 64×128（仅待机/行走）；6=96×128（多动作/表情列）。 */
    private int _spriteColumns;
    private Harmony? _harmony;

    public override void Entry(IModHelper helper)
    {
        DrawPatch.Mod = this;
        _harmony = new Harmony(ModManifest.UniqueID);
        // 挂 FarmerRenderer.draw 的 12 参主实现（9 参重载只是两行转发，会被 JIT 内联，Harmony 拦不到；
        // FashionSense 等成熟 Mod 也是挂这个主实现），直接复用原版算好的屏幕坐标、缩放支点、
        // 层深与逐帧偏移，只替换 base 贴图帧。
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
            ApplyPreset(Game1.player, config);
            _sprite = LoadSprite(config.SpriteSheetPath);
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
            // 96×128 = 4 行（下/右/上/左）× 6 列（待机+3 行走+动作+表情）；
            // 64×128 为旧版兼容（缺动作/表情列时回退待机）
            if (texture.Height != 128 || (texture.Width != 96 && texture.Width != 64))
            {
                Monitor.Log($"像素表尺寸应为 96x128（或旧版 64x128），实际 {texture.Width}x{texture.Height}，回落原版预设", LogLevel.Warn);
                return null;
            }
            _spriteColumns = texture.Width / 16;
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

    internal Texture2D? SpriteFor(Farmer farmer)
    {
        // 只替换本端玩家；联机多开时每个游戏实例各自安装 Mod、各自读取自己的 active-avatar.json
        return farmer.IsLocalPlayer ? _sprite : null;
    }

    /// <summary>Harmony 前缀：有合法像素表且非原版专属姿态时，接管 base 身体层的绘制。</summary>
    internal static class DrawPatch
    {
        internal static ModEntry? Mod;

        // 原版 1.6 走路序列（反编译核对）：walk 0/8/16/24 为 1,0,2,0，run 32..56 为 8 帧。
        // 像素表第 2/3/4 列（索引 1/2/3）是左脚在前/右脚在前/双脚过渡；用 1,3,2,3
        // 比原版 1,0,2,0 多一个过渡帧，四相位循环更顺，且始终有脚在动。
        private static readonly int[] WalkPose = { 1, 3, 2, 3 };
        private static bool _loggedTakeover;

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
            // 原版专属姿态交还原版绘制，避免像素表摆出错误姿势：
            // 洗澡/坐下/骑马/木筏/游泳/睡觉/晕倒/弹弓（手臂与瞄准线在 renderer 内部）
            if (who.bathingClothes.Value || who.IsSitting() || who.isRidingHorse() || who.isRafting
                || who.swimming.Value || who.isInBed.Value || who.usingSlingshot)
            {
                return true;
            }
            if (currentFrame == 104 || currentFrame == 105) return true;

            var farmerSprite = who.FarmerSprite;
            if (farmerSprite == null) return true;
            if (!_loggedTakeover)
            {
                _loggedTakeover = true;
                mod.Monitor.Log($"已接管玩家身体绘制（像素表 {texture.Width}x{texture.Height}，{mod._spriteColumns} 列）", LogLevel.Trace);
            }
            int column = SelectColumn(who, farmerSprite, mod._spriteColumns);
            // 像素表行序：下/右/上/左；原版 FacingDirection：0 上 / 1 右 / 2 下 / 3 左
            int row = who.FacingDirection switch
            {
                0 => 2,
                1 => 1,
                2 => 0,
                3 => 3,
                _ => 0,
            };
            var source = new Rectangle(column * 16, row * 32, 16, 32);

            var drawPosition = new Vector2((float)Math.Floor(position.X), (float)Math.Floor(position.Y));
            // 原版逐帧偏移：X 用 xOffset，Y 用 positionOffset（两者单位都是 1× 像素）
            var frameOffset = new Vector2(animationFrame.xOffset * 4f, animationFrame.positionOffset * 4f);
            var depth = FarmerRenderer.GetLayerDepth(layerDepth, FarmerRenderer.FarmerSpriteLayers.Base);
            b.Draw(
                texture,
                drawPosition + origin + frameOffset,
                source,
                overrideColor,
                rotation,
                origin,
                4f * scale,
                SpriteEffects.None,
                depth);
            return false;
        }

        private static int SelectColumn(Farmer who, FarmerSprite sprite, int columns)
        {
            int anim = sprite.currentSingleAnimation;
            bool walk = anim >= 0 && anim < 32 && anim % 8 == 0;
            bool run = anim >= 32 && anim < 64 && anim % 8 == 0;
            bool carryWalk = anim >= 96 && anim < 128 && anim % 8 == 0;
            bool carryRun = anim >= 128 && anim < 160 && anim % 8 == 0;
            bool locomotion = walk || run || carryWalk || carryRun;
            bool moving = who.isMoving() || who.movedDuringLastTick();

            // 表情：原版 doEmote 用 animateOnce(AnimationFrame[]) 播身体动作（currentSingleAnimation = -1）
            if (columns >= 6 && who.IsEmoting && sprite.PauseForSingleAnimation && anim < 0)
                return 5;
            // 工具/挥砍/钓鱼/吃喝/抓取：动作列（原版这些动画索引都 >= 64）
            if (!locomotion && (who.UsingTool || sprite.PauseForSingleAnimation || anim >= 64))
                return columns >= 5 ? 4 : 3;
            if (locomotion && moving)
                return WalkPose[Math.Abs(sprite.currentAnimationIndex) % WalkPose.Length];
            if (who.UsingTool || sprite.PauseForSingleAnimation)
                return columns >= 5 ? 4 : 3;
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
