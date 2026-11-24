# assets/pet-packs — 随包桌宠素材（T-M6-45）

本目录**不手工编辑**，由 `pnpm sync:pet-packs` 从上游仓库幂等拉取；打包时经
`apps/desktop-host/package.json` 的 `build.extraResources` 原样进入安装包
`Resources/pet-packs/`（开发态由主进程 `resolvePetPacksDir()` 指向本目录）。

```
assets/pet-packs/
├── aboutme-pets/          hunmer/aboutme-pets：pets.json + preview.json + pets/<id>/（9 包，~1.9GB）
├── crosspet/              lokicorvus/crosspet：characters/（8 基础 + 7 皮肤 + egg-* 彩蛋）+ 8 套手写字体
├── fonts/                 上首软糖体.ttf（PC2005-cloud/dsh-pet，气泡字体）
└── SYNC-MANIFEST.json     最近一次同步的文件数/字节数（由脚本写入，入库便于核对）
```

- 二进制文件**不入 Git**（见根 `.gitignore`）：2GB 级素材只在本机与安装包内存在。
- 主进程只读协议：`whale-pet://<group>/<relative-path>`，只允许
  `webp/png/m4a/woff2/ttf/json`，严格拒绝 `..`、绝对路径与反斜杠（413/403/404 见 `pet-packs.spec.ts`）。
- 许可：aboutme-pets 为 MIT（各包内 `LICENSE-assets.txt` / `LICENSE-code.txt`）；
  crosspet 角色立绘为 CC BY-NC-SA 4.0（`crosspet/characters/LICENSE.md`）；
  上首软糖体字体本体许可未单独声明。全部按 `DEV_ONLY_NON_COMMERCIAL` 使用，
  台账见 `docs/THIRD_PARTY_NOTICES.md` §3。

同步失败时可安全重跑（按文件字节数断点续传）：

```bash
pnpm sync:pet-packs                    # 全量
pnpm sync:pet-packs --only crosspet    # 单来源
pnpm sync:pet-packs --dry-run          # 只打印计划
```
