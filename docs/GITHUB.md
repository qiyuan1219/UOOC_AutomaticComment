# 上传 GitHub 并分享给同学

建议仓库名：`szu-uooc-discussion-helper`。

仓库简介可写：**深圳大学 UOOC 慕课刷讨论次数插件，支持自定义回复间隔、倒计时进度条和后台运行。**

## 网页上传

1. 在自己的 GitHub 账号下创建仓库。
2. 解压源码包 `szu-uooc-discussion-helper-v1.1.0-source.zip`。
3. 在仓库中选择「Add file → Upload files」，空仓库也可能显示上传现有文件的入口。
4. 把解压后的文件和文件夹拖入上传页，保持结构。`README.md` 应在仓库根目录，`docs/images/` 应和教程一起上传。
5. 填写提交说明，提交后检查仓库主页是否显示 README 和截图。

上传的是**解压后的源码内容**。只上传 ZIP 文件不会让主页直接展示 README。源码包已排除依赖、测试输出、旧版 ZIP、浏览器配置和原始截图。

参考：[GitHub 官方文件上传说明](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository)。

## Git 命令上传

创建空仓库后，在项目根目录运行；把占位地址换为 GitHub 提供的仓库地址：

```powershell
git init -b main
git add .
git commit -m "Add UOOC discussion helper v1.1.0"
git remote add origin <自己的GitHub仓库地址>
git push -u origin main
```

`.gitignore` 已忽略依赖、测试输出、ZIP 和 `dist/`。项目尚未指定许可证，可在发布时自行选择。

## 给同学提供安装包

1. 运行 `powershell -ExecutionPolicy Bypass -File scripts/package.ps1`。
2. 在仓库 Releases 中创建 `v1.1.0`，附上 `dist/szu-uooc-discussion-helper-v1.1.0.zip`。
3. 将仓库或 Release 链接分享给同学。他们解压后加载 `extension` 文件夹，无需 Node.js。

安装包供直接使用，源码包供上传仓库；两者都附有配图教程，图片均为匿名演示。

## 后续更新

修改 `extension/manifest.json` 的版本号，更新 `CHANGELOG.md`，重新测试和打包。脚本自动读取版本号生成文件名。更新教程中的版本号，再提交源码和对应的 Release。
