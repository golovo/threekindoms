# Three Kingdoms HD-2D（三国 HD-2D）

一款回合制三国战略游戏的 HD-2D 重制：像素角色立在 3D 地形上，加上实时光影、景深与后期。玩法规则和数值参照 1992 年 FC 游戏《三國志II 覇王の大陸》。游戏用浏览器运行（three.js），也能打包成 Electron 桌面版。

> 本项目是非官方、非商业的同人重制，与 Bandai Namco 无关。仓库里没有原版 ROM 或任何原版素材，运行也不需要它们。立绘等美术由 AI 生成，经人工筛选与修改。

## 项目结构

```
hd2d-mvp/
  index.html          游戏入口
  save-editor.html    存档（记录）编辑器
  vignettes.html      命令演出预览页
  src/
    core/             规则层，不依赖渲染：
                        game.js 战略层与全部命令、ai.js 战略 AI、warcore.js 开战与战后写回、
                        field.js 战争地图、tactical.js 白兵、skirmish.js 白兵与单挑结算、
                        saveedit.js 记录编辑、ahuinan.js 阿会喃漏洞模式
    war/              战争地图 3D 视图（board、units、overlay、camera、pick、interact、play、probe）
    *.js              three.js 场景（strategy*.js 战略地图、warview.js 战场、tacticalview.js 白兵、
                      duelview.js 单挑等）与流程、界面（app.js、ui.js、ui.css）
  data/
    game-data.json    武将、城市、地图、事件等全部规则数据
    base-map.json     原版 30 城的治所经纬度、模型等级与河岸
    thanks.txt        片尾鸣谢名单
  mods/               数据包（加城、加势力、加武将，只写 JSON），sample-cities 是范本
  assets/             美术、3D 模型与音效（素材包，见下文）；manifest.json 列出可选资源
  tests/              测试（*.test.mjs），公共辅助函数在 game.mjs
  tools/              开发服务器、无头浏览器、截图与检查、模拟，以及美术切图与烘焙脚本
  desktop/            Electron 打包脚本
```

## 获取代码与素材

仓库的 git 里只有代码和数据。美术、3D 模型、音效和图标只放在 [Releases](https://github.com/tianlin/threekindoms/releases) 的素材包 `threekindoms-assets-<版本>.zip` 里。

```bash
git clone https://github.com/tianlin/threekindoms.git
cd threekindoms
# 从 Releases 下载与代码对应的素材包（跟进 main 就用最新的），解压到仓库根目录：
unzip -o ~/Downloads/threekindoms-assets-0.3.7.zip
shasum -a 256 -c ASSETS.sha256 | grep -v ': OK$'    # 没有输出就说明素材齐全
```

素材文件已经写进 `.gitignore`，解压后不会出现在 `git status` 里。根目录的 `ASSETS.sha256` 列出了每个素材文件和它的哈希：
- 解压后如果 git 显示 `ASSETS.sha256` 被修改，说明素材包和代码版本不一致，请换用对应版本的素材包。
- 缺少素材时，开发服务器、`tests/lfs-pointer.test.mjs` 和桌面版打包都会提示你先解压素材包。

### 背景音乐（单独下载）

背景音乐不在素材包里，单独放在 Releases 的 `threekindoms-bgm-remix-<版本>.zip`，解压位置同样是仓库根目录。音乐包只在曲目有变化时才发新版，用 Releases 里最新的那个即可：

```bash
unzip -o ~/Downloads/threekindoms-bgm-remix-0.3.6.zip
(cd hd2d-mvp/assets/audio/remix && shasum -a 256 -c SHA256SUMS | grep -v ': OK$')    # 没有输出就说明齐全
```

文件会放到 `hd2d-mvp/assets/audio/remix/`，这个目录也在 `.gitignore` 里。游戏启动时会自动找到并播放这些文件，不用改任何设置；桌面版打包也会把它们带上。

## 运行

需要 Node.js 22 以上和 Python 3。

```bash
npm --prefix hd2d-mvp/desktop install     # 首次：安装 three.js、字体和 Electron
python3 hd2d-mvp/tools/serve.py 8677      # 启动开发服务器
```

然后用浏览器打开 http://localhost:8677/hd2d-mvp/ 。在网址后面加 `?mute` 可以静音。

背景音乐来自上面的 Remix 音乐包。没解压音乐包时，只有战略、战争、白兵三处有代码实时合成的简易替代音乐，其他场景是静音的。音效使用素材包里的文件。

## 诊断日志（桌面版）

桌面版把运行记录写在 `~/.config/Three Kingdoms HD-2D/logs/`（Windows 在 `%APPDATA%\Three Kingdoms HD-2D\logs\`）：

- `startup.log`：启动过程、缺失文件、页面报错。
- `game.log`：游戏内时间线——界面、年月、回合、对话框、帧计数、长任务、显存/内存；主进程每两秒探活，主线程被卡住或画面不再出帧时写下 `[stall]`，AI 回合或淡入卡住时写下 `[softlock]`。跨启动追加，超过 8 MB 时轮转为 `game.prev.log`。

遇到卡死、黑屏或无响应，请在游戏里打开「☰ 系统 → 说明 → 打开日志文件夹」，把 `game.log` 和 `startup.log` 一起发来；两份记录能说明卡住时在哪个画面、哪一月、谁的回合，以及最后几秒发生了什么。

## 测试

浏览器测试用 Playwright 驱动本机 Chrome 的无头模式，需要先装 Playwright（`npm i -g playwright`）和 Google Chrome。

```bash
node --test hd2d-mvp/tests/artcoverage.test.mjs                  # 单个测试文件
node --test --test-concurrency=1 'hd2d-mvp/tests/*.test.mjs'     # 全部测试（较慢，war.test 约 10 分钟）
```

## 打包桌面版

需要 `cwebp`（macOS 上用 `brew install webp` 安装，Fedora 上用 `sudo dnf install libwebp-tools`）。

```bash
npm --prefix hd2d-mvp/desktop run dist:mac    # macOS dmg（arm64 与 x64）
npm --prefix hd2d-mvp/desktop run dist:win    # Windows x64 zip
npm --prefix hd2d-mvp/desktop run dist:linux  # Linux AppImage 与 tar.gz（在 Linux 上构建）
npm --prefix hd2d-mvp/desktop run dist:dir    # 只出 macOS 的 .app 目录，最快
npm --prefix hd2d-mvp/desktop start           # 直接用 Electron 运行游戏（需要先执行一次 build-app）
```

这几个命令都会先运行 `build-app.mjs`，把游戏快照到 `hd2d-mvp/desktop/app/`，产物放在 `hd2d-mvp/desktop/release/`。

### Linux（Fedora 等）

```bash
sudo dnf install libwebp-tools nodejs python3
npm --prefix hd2d-mvp/desktop install
npm --prefix hd2d-mvp/desktop run dist:linux
```

产物有两个，都不需要 root：

- `threekindoms-<版本>-linux-x86_64.AppImage`：单文件，`chmod +x` 后双击或直接运行。Fedora 上如果提示找不到 `libfuse.so.2`，先 `sudo dnf install fuse-libs`，或者改用 `./threekindoms-*.AppImage --appimage-extract-and-run` 免挂载运行。
- `threekindoms-<版本>-linux-x64.tar.gz`：解压到任意目录，运行里面的 `threekindoms`，完全不依赖 FUSE。

游戏存档、窗口位置和启动日志在 `~/.config/Three Kingdoms HD-2D/`。AppImage 由 electron-builder 启动时自带 `--no-sandbox`（AppImage 内无法保留 setuid 沙箱）；tar.gz 版则由系统决定，遇到沙箱报错同样可以加 `--no-sandbox`。

## 许可

- 源代码：MIT，见 [LICENSE](LICENSE)。
- `hd2d-mvp/assets/` 下的美术、3D 模型与生成音频：CC BY-NC 4.0，不可商用，见 [LICENSE-ART](LICENSE-ART)。
- 第三方组件：见 [NOTICE](NOTICE)。

代码注释里提到的 `research/`、`analysis/` 等路径，指向作者没有公开的逆向研究资料。`data/game-data.json` 就是由这些资料导出的。要加城、加势力、加武将或改开局，请写数据包，不要直接改它：

- 在 `hd2d-mvp/mods/<包名>/` 放 `pack.json` 和需要的 `cities.json`、`roads.json`、`factions.json`、`officers.json`，写法照 `mods/sample-cities/` 和 `mods/README.md`；
- 用 `node hd2d-mvp/tools/check_pack.mjs hd2d-mvp/mods/<包名>` 校验，`node hd2d-mvp/tools/check_pack.mjs --all --index` 把它登记进标题画面的数据包列表；
- 打开 `?pack=<包名>` 载入它；数据包还在试验阶段，标题画面的「数据包」按钮默认隐藏，网址加 `?packs` 才显示。
