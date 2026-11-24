打包暂存目录：dotnet build 后把 WhaleIsleAvatar.dll 复制到这里，electron-builder
extraResources 会把整个目录打进 Resources/mods/WhaleIsleAvatar。
没有 DLL 时安装器会如实提示「Mod 未编译」，绝不伪装可用。
