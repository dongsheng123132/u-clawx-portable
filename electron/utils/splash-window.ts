import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, app, nativeImage } from 'electron';
import { isPortableMode } from './paths';

/**
 * 启动首屏（splash）：双击后立刻可见的窗口。
 *
 * 背景（pc-8308 工单，2026-08-24）：便携版从 U 盘冷启动要 40~60 秒，而主窗口要等
 * telemetry/proxy/menu/extensions 初始化完才创建——用户双击后约 20 秒内屏幕上
 * 什么都不出现，体感就是「打不开」，于是反复连点（第二实例检测静默吞掉，更慌）。
 *
 * 设计约束：
 * - 不动现有启动链路：splash 是旁路，initialize() 一行不改；主窗 ready-to-show
 *   时自动关掉。E2E 模式完全不启用。
 * - 纯静态 HTML，无渲染依赖：文件从 resources/ 读出来直接 loadURL(data:)，
 *   不走 Vite 构建，不引 preload。
 * - 失败静默：任何异常都吞掉并跳过 splash——首屏只是体验优化，绝不能反过来
 *   挡住真正的应用启动。
 */

const SPLASH_WIDTH = 420;
const SPLASH_HEIGHT = 260;

function buildSplashHtml(): string {
  // 窗口图标由 getSplashIcon() 提供；页内 logo 用文字版式，避免 file:// 资源
  // 在 data: URL 页面里被 CSP/加载时序卡住——首屏要的是绝对不失败的渲染。
  const iconTag = `<div class="logo logo-text">U-ClawX</div>`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; background: #10141d; overflow: hidden;
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    -webkit-user-select: none; user-select: none; }
  .wrap { height: 100%; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 18px; }
  .logo { width: 72px; height: 72px; }
  .logo-text { display: flex; align-items: center; justify-content: center;
    color: #ff5a4e; font-size: 26px; font-weight: 700; border-radius: 16px; }
  h1 { margin: 0; color: #e8ecf3; font-size: 15px; font-weight: 500; letter-spacing: .5px; }
  p { margin: 0; color: #8b93a3; font-size: 12px; }
  .bar { width: 180px; height: 4px; border-radius: 2px; background: #232a38; overflow: hidden; }
  .bar::after { content: ""; display: block; width: 40%; height: 100%; border-radius: 2px;
    background: #ff5a4e; animation: slide 1.2s ease-in-out infinite; }
  @keyframes slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(450%); } }
</style>
</head>
<body>
<div class="wrap">
  ${iconTag}
  <h1>U-ClawX 正在启动…</h1>
  <div class="bar"></div>
  <p>从 U 盘首次启动需要约一分钟，请稍候</p>
</div>
</body>
</html>`;
}

function getSplashIcon(): Electron.NativeImage | undefined {
  try {
    const iconPath = app.isPackaged
      ? join(process.resourcesPath, 'resources', 'icons', 'icon.ico')
      : join(__dirname, '../../resources/icons/icon.ico');
    if (!existsSync(iconPath)) return undefined;
    const img = nativeImage.createFromPath(iconPath);
    return img.isEmpty() ? undefined : img;
  } catch {
    return undefined;
  }
}

let splashWindow: BrowserWindow | null = null;

/**
 * app ready 后尽早调用：创建并显示首屏。失败一律静默。
 */
export function showSplashWindow(): void {
  try {
    // E2E 模式允许多实例并行跑便携布局，splash 会污染窗口计数/焦点/截图断言。
    if (!isPortableMode() || process.env.CLAWX_E2E === '1') return;

    let html = buildSplashHtml();

    // 打包环境优先读 extraResources 里的同名文件（便于后续改文案不用重编译壳）。
    if (app.isPackaged) {
      try {
        const packaged = join(process.resourcesPath, 'resources', 'splash.html');
        html = readFileSync(packaged, 'utf8');
      } catch {
        // 用内置模板即可。
      }
    }

    splashWindow = new BrowserWindow({
      width: SPLASH_WIDTH,
      height: SPLASH_HEIGHT,
      center: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: false,
      frame: false,
      show: false,
      title: 'U-ClawX',
      icon: getSplashIcon(),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    splashWindow.setMenuBarVisibility(false);
    // catch：主窗就绪太快或用户从任务栏关掉 splash 时，窗口会在导航完成前
    // 被 destroy，loadURL 以 ERR_ABORTED reject——这是预期路径，吞掉。
    void splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => {});
    splashWindow.once('ready-to-show', () => {
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show();
    });
    // 保险丝：主窗异常导致 ready-to-show 永不来时，首屏最多留 2 分钟，
    // 避免一个孤儿小窗挂在用户桌面上。
    const splash = splashWindow;
    setTimeout(() => {
      try {
        if (splash && !splash.isDestroyed()) splash.destroy();
      } catch {
        // ignore
      }
      if (splashWindow === splash) splashWindow = null;
    }, 120_000);
  } catch {
    splashWindow = null;
  }
}

/**
 * 主窗 ready-to-show 时调用：关掉首屏（存在才关，幂等）。
 */
export function closeSplashWindow(): void {
  try {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.destroy();
    }
  } catch {
    // ignore
  } finally {
    splashWindow = null;
  }
}
