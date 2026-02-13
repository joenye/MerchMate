import * as os from 'os';
import { app, globalShortcut, ipcMain } from 'electron';
import { loadConfig, getConfigPath, saveConfig, getDefaultRegions } from './config/config';
import { Config } from './config/types';
import { RegionManager } from './ui/region-manager';
import { OCRProcessor } from './core/ocr-processor';
import { ScreenshotManager } from './core/screenshot-manager';
import { OverlayWindow } from './ui/overlay-window';
import { setupSettingsIPC, createSettingsWindow, sendSessionUpdate, sendUpdateInfo } from './ui/settings-window';
import { preInitTesseractJS, checkNativeTesseract } from './utils/tesseract';
import { initLogger, closeLogger } from './utils/logger';
import { OverlayController } from '../';
import { APP_VERSION, GIT_HASH } from './version';
import { checkForUpdates } from './utils/update-checker';
import { setChatFontSize } from './ui/html-generator';

// Set app name early (before any windows are created)
// This affects the macOS menu bar title in development mode
app.setName('Brighter Merchant');

// Initialize logger first - all console output will be written to log file
const logPath = initLogger();
console.log(`[init] Brighter Merchant v${APP_VERSION} (${GIT_HASH})`);
console.log('[init] Log file:', logPath);

// Prevent app from quitting when all windows are closed (macOS behavior)
// The settings window close handler will explicitly quit the app
app.on('window-all-closed', () => {
  // Don't quit - let the settings window close handler manage app lifecycle
  // On macOS, apps typically stay open until explicitly quit
});

// Internal constants (not user-configurable)
const MAX_OCR_REGIONS = 13;
const OCR_SCALE = 1.0;
const PERF_WINDOW_SEC = 30;
const PERF_WARN_FIND_BEST_MS = 250;
const PERF_WARN_TICK_MS = 3000;
const PATHFINDER_TIMEOUT_MS = 60000;
const DROP_GRACE_MS = 0;

function getOcrConcurrency(): number {
  const cpuCount = os.cpus()?.length ?? 4;
  return Math.max(2, Math.min(cpuCount - 1, MAX_OCR_REGIONS));
}

async function main(): Promise<void> {
  const config = loadConfig();
  
  // User-configurable settings
  const detectiveLevel = config.detectiveLevel ?? 500;
  const battleOfFortuneholdCompleted = config.isBattleOfFortuneholdCompleted ?? true;
  const ocrMethod = config.ocrMethod ?? 'auto';

  const cpuCount = os.cpus()?.length ?? 4;
  const ocrConcurrency = getOcrConcurrency();

  console.log("[init] Detective level:", detectiveLevel);
  console.log("[init] Battle of Fortunehold completed:", battleOfFortuneholdCompleted);
  console.log("[init] CPU cores:", cpuCount);
  console.log("[init] OCR method:", ocrMethod);
  console.log("[init] OCR concurrency:", ocrConcurrency);

  // Pre-initialize OCR based on method
  if (ocrMethod === 'tesseract-js') {
    preInitTesseractJS().catch(err => console.warn('[OCR] Pre-init failed:', err));
  } else if (ocrMethod === 'auto') {
    checkNativeTesseract().then(hasNative => {
      if (!hasNative) {
        preInitTesseractJS().catch(err => console.warn('[OCR] Pre-init failed:', err));
      }
    });
  }

  const configPath = getConfigPath();
  const regionManager = new RegionManager(getDefaultRegions(), configPath, config);

  const pathfindingQuality = config.pathfindingQuality ?? 5;
  console.log("[init] Pathfinding quality:", pathfindingQuality);

  const chatBoxFontSize = config.chatBoxFontSize ?? 23;
  console.log("[init] Chat box font size:", chatBoxFontSize);
  setChatFontSize(chatBoxFontSize);

  const ocrProcessor = new OCRProcessor({
    concurrency: ocrConcurrency,
    scale: OCR_SCALE,
    ocrMethod,
    perfWindowSec: PERF_WINDOW_SEC,
    warnFindBestMs: PERF_WARN_FIND_BEST_MS,
    warnTickMs: PERF_WARN_TICK_MS,
    pathfinderTimeoutMs: PATHFINDER_TIMEOUT_MS,
    dropGraceMs: DROP_GRACE_MS,
    detectiveLevel,
    battleOfFortuneholdCompleted,
    pathfindingQuality,
  });

  ipcMain.on('update-region', (_event, newRegion) => {
    regionManager.updateRegion(newRegion);
  });

  const overlayWindow = new OverlayWindow(regionManager, ocrProcessor, config.keyboardShortcuts);
  console.log('[init] Creating overlay window...');
  await overlayWindow.create();
  console.log('[init] Overlay window created');

  let lastOverlayUpdate = 0;
  let lastOcrDataSignature = '';
  
  const screenshotManager = new ScreenshotManager(
    ocrProcessor,
    regionManager.regions,
    (ocrData) => {
      // Create a signature of the OCR data to detect actual changes
      const signature = JSON.stringify({
        activeDrops: ocrData.activeDrops,
        boardPickups: ocrData.boardPickups,
        activeBountyIndices: ocrData.activeBountyIndices,
        boardBountyIndices: ocrData.boardBountyIndices,
        status: ocrData.status,
        boardOpen: ocrData.boardOpen,
        steps: ocrData.steps
      });
      
      // Only update overlay if data actually changed
      const now = Date.now();
      if (signature !== lastOcrDataSignature && now - lastOverlayUpdate >= 500) {
        overlayWindow.window?.webContents.send('ocr-data-update', ocrData);
        lastOcrDataSignature = signature;
        lastOverlayUpdate = now;
      }
      
      // Also send to settings window for Session tab (not throttled)
      sendSessionUpdate(ocrData);
    },
    { perfWindowSec: PERF_WINDOW_SEC }
  );

  screenshotManager.start();

  // Setup settings IPC with perf stats access
  setupSettingsIPC((newConfig) => {
    console.log('[settings] Config updated');
  }, () => ({
    ...ocrProcessor.getPerfStats(),
    ...screenshotManager.getPerfStats(),
  }));

  // Override settings-update handler with overlay window reference for region updates
  ipcMain.removeAllListeners('settings-update');
  ipcMain.on('settings-update', (_event, newConfig: Config) => {
    saveConfig(newConfig);
    console.log('[settings] Config updated');
    
    let needsRecalculation = false;
    
    if (newConfig.regions) {
      overlayWindow.updateRegions(newConfig.regions);
    }
    if (newConfig.pathfindingQuality !== undefined) {
      const oldQuality = config.pathfindingQuality;
      ocrProcessor.setPathfindingQuality(newConfig.pathfindingQuality);
      if (oldQuality !== newConfig.pathfindingQuality) {
        needsRecalculation = true;
      }
    }
    if (newConfig.detectiveLevel !== undefined) {
      const oldLevel = config.detectiveLevel;
      ocrProcessor.setDetectiveLevel(newConfig.detectiveLevel);
      if (oldLevel !== newConfig.detectiveLevel) {
        needsRecalculation = true;
      }
    }
    if (newConfig.isBattleOfFortuneholdCompleted !== undefined) {
      const oldValue = config.isBattleOfFortuneholdCompleted;
      ocrProcessor.setBattleOfFortuneholdCompleted(newConfig.isBattleOfFortuneholdCompleted);
      if (oldValue !== newConfig.isBattleOfFortuneholdCompleted) {
        needsRecalculation = true;
      }
    }
    
    // Update local config reference
    Object.assign(config, newConfig);
    
    // Trigger recalculation if relevant settings changed
    if (needsRecalculation) {
      console.log('[settings] Triggering bounty recalculation due to config change');
      ocrProcessor.forceOptimalRecalculation();
    }
  });

  // Handle edit mode toggle from settings window
  ipcMain.on('toggle-edit-mode', (_event) => {
    overlayWindow.toggleEditMode();
  });

  ipcMain.handle('get-edit-mode', () => {
    return overlayWindow.isEditMode();
  });

  // Handle chat font size updates from settings window
  ipcMain.on('update-chat-font-size', (_event, fontSize: number) => {
    console.log('[settings] Chat font size updated:', fontSize);
    overlayWindow.updateChatFontSize(fontSize);
  });

  // Handle settings window visibility around overlay attachment
  // When overlay attaches to game window, it can cause settings to hide on macOS
  OverlayController.events.on('attach', () => {
    // Re-show settings window after overlay attaches (it may have been hidden)
    setTimeout(() => {
      console.log('[init] Overlay attached, ensuring settings window is visible...');
      createSettingsWindow(); // This will focus existing window or create new one
    }, 200);
  });

  // Show settings window immediately at launch
  console.log('[init] Creating settings window...');
  createSettingsWindow();

  // Warm up the pathfinder utility process pool in the background
  ocrProcessor.warmup().catch(err => console.warn('[pathfinder] Warmup failed:', err));

  // Check for updates on startup if enabled
  if (config.checkForUpdatesOnStartup !== false) {
    checkForUpdates()
      .then(info => sendUpdateInfo(info))
      .catch(err => console.warn('[update] Startup check failed:', err));
  }

  app.on('will-quit', async () => {
    screenshotManager.stop();
    globalShortcut.unregisterAll();
    await ocrProcessor.shutdown();
    closeLogger();
  });
}

app.disableHardwareAcceleration();
app.on('ready', () => {
  setTimeout(main, process.platform === 'linux' ? 1000 : 0);
});
