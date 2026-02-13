import { BrowserWindow, ipcMain, app, dialog, shell } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import { Config } from '../config/types';
import { loadConfig, saveConfig, getDefaultRegions } from '../config/config';
import { getLogPath } from '../utils/logger';
import { APP_VERSION, GIT_HASH } from '../version';
import { checkForUpdates, UpdateInfo, getGitHubRepoUrl, getGitHubReleasesUrl } from '../utils/update-checker';

let settingsWindow: BrowserWindow | null = null;
let logWatcher: fs.FSWatcher | null = null;
let cachedUpdateInfo: UpdateInfo | null = null;

export function sendUpdateInfo(info: UpdateInfo): void {
  cachedUpdateInfo = info;
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('update-info', info);
  }
}

export function createSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    // Ensure dock icon is visible on macOS
    if (process.platform === 'darwin') {
      app.dock?.show();
    }
    return settingsWindow;
  }

  settingsWindow = new BrowserWindow({
    width: 600,
    height: 750,
    minWidth: 500,
    minHeight: 600,
    resizable: true,
    minimizable: true,
    maximizable: true,
    closable: true,
    skipTaskbar: false,  // Ensure it shows in dock/taskbar
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    title: 'Brighter Merchant',
    backgroundColor: '#1e1e1e',
  });

  // Remove menu bar completely
  settingsWindow.setMenu(null);

  const config = loadConfig();
  const logPath = getLogPath();
  const githubRepoUrl = getGitHubRepoUrl();
  const githubReleasesUrl = getGitHubReleasesUrl();
  const html = generateSettingsHTML(config, APP_VERSION, GIT_HASH, logPath, githubRepoUrl, githubReleasesUrl);
  settingsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  
  // Ensure window is visible and in dock
  settingsWindow.show();
  
  // Ensure dock icon is visible on macOS
  if (process.platform === 'darwin') {
    app.dock?.show();
  }

  setupLogWatcher();

  settingsWindow.on('close', (e) => {
    if (logWatcher) {
      logWatcher.close();
      logWatcher = null;
    }
    settingsWindow = null;
    app.quit();
  });

  return settingsWindow;
}

export function sendSessionUpdate(data: any): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('session-update', data);
  }
}

function setupLogWatcher(): void {
  const logPath = getLogPath();
  if (!logPath || !fs.existsSync(logPath)) return;

  logWatcher = fs.watch(logPath, (eventType) => {
    if (eventType === 'change' && settingsWindow && !settingsWindow.isDestroyed()) {
      const stats = fs.statSync(logPath);
      const readSize = Math.min(stats.size, 50000);
      const buffer = Buffer.alloc(readSize);
      const fd = fs.openSync(logPath, 'r');
      fs.readSync(fd, buffer, 0, readSize, stats.size - readSize);
      fs.closeSync(fd);
      settingsWindow.webContents.send('log-update', buffer.toString('utf8'));
    }
  });
}

export function setupSettingsIPC(onConfigChanged: (config: Config) => void, getOcrPerfStats?: () => Record<string, { count: number; avg: number; max: number; total: number }>): void {
  ipcMain.on('settings-update', (_event, newConfig: Config) => {
    saveConfig(newConfig);
    onConfigChanged(newConfig);
  });

  ipcMain.on('settings-reset-regions', (_event) => {
    const config = loadConfig();
    config.regions = getDefaultRegions();
    saveConfig(config);
    onConfigChanged(config);
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('config-updated', config);
    }
  });

  ipcMain.handle('settings-get-config', () => {
    return loadConfig();
  });

  ipcMain.handle('settings-get-log', () => {
    const logPath = getLogPath();
    if (!logPath || !fs.existsSync(logPath)) return '';
    const stats = fs.statSync(logPath);
    const readSize = Math.min(stats.size, 50000);
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(logPath, 'r');
    fs.readSync(fd, buffer, 0, readSize, stats.size - readSize);
    fs.closeSync(fd);
    return buffer.toString('utf8');
  });

  // Update checker handlers
  ipcMain.handle('check-for-updates', async () => {
    cachedUpdateInfo = await checkForUpdates();
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('update-info', cachedUpdateInfo);
    }
    return cachedUpdateInfo;
  });

  ipcMain.handle('get-cached-update-info', () => {
    return cachedUpdateInfo;
  });

  ipcMain.on('open-external-url', (_event, url: string) => {
    shell.openExternal(url);
  });

  ipcMain.on('open-log-folder', () => {
    const logPath = getLogPath();
    if (logPath && fs.existsSync(logPath)) {
      shell.showItemInFolder(logPath);
    }
  });

  ipcMain.on('restart-app', () => {
    app.relaunch();
    app.exit(0);
  });

  // Performance metrics handler with min/max tracking
  let lastCpuUsage = process.cpuUsage();
  let lastCpuTime = Date.now();
  let sampleCount = 0;
  let currentCpuPercent = 0; // Store the last calculated CPU percentage
  
  // Min/max tracking for all metrics
  const stats = {
    cpu: { min: Infinity, max: 0 },
    memory: { min: Infinity, max: 0 },
    heapUsed: { min: Infinity, max: 0 },
    tickTime: { min: Infinity, max: 0 },
    ocrTime: { min: Infinity, max: 0 },
    screenshotTime: { min: Infinity, max: 0 },
    pathfinderTime: { min: Infinity, max: 0 },
  };

  // Background metrics collection (runs every second)
  setInterval(() => {
    const currentCpuUsage = process.cpuUsage(lastCpuUsage);
    const currentTime = Date.now();
    const elapsedMs = currentTime - lastCpuTime;
    
    if (elapsedMs > 100) { // Only update if at least 100ms has passed
      // CPU usage is in microseconds, elapsed is in milliseconds
      // Formula: (user + system microseconds) / (elapsed ms * 1000) * 100
      currentCpuPercent = Math.min(100, ((currentCpuUsage.user + currentCpuUsage.system) / (elapsedMs * 1000)) * 100);
      const memUsage = process.memoryUsage();
      
      sampleCount++;
      // Skip first few samples as they're often inaccurate
      if (sampleCount > 2) {
        stats.cpu.min = Math.min(stats.cpu.min, currentCpuPercent);
        stats.cpu.max = Math.max(stats.cpu.max, currentCpuPercent);
        stats.memory.min = Math.min(stats.memory.min, memUsage.rss);
        stats.memory.max = Math.max(stats.memory.max, memUsage.rss);
        stats.heapUsed.min = Math.min(stats.heapUsed.min, memUsage.heapUsed);
        stats.heapUsed.max = Math.max(stats.heapUsed.max, memUsage.heapUsed);
      }
      
      // Track OCR perf min/max
      if (getOcrPerfStats) {
        const perfStats = getOcrPerfStats();
        if (perfStats['tick_total']?.avg) {
          stats.tickTime.min = Math.min(stats.tickTime.min, perfStats['tick_total'].avg);
          stats.tickTime.max = Math.max(stats.tickTime.max, perfStats['tick_total'].avg);
        }
        const ocrTime = (perfStats['title_ocr']?.avg || 0) + (perfStats['rest_ocr']?.avg || 0);
        if (ocrTime > 0) {
          stats.ocrTime.min = Math.min(stats.ocrTime.min, ocrTime);
          stats.ocrTime.max = Math.max(stats.ocrTime.max, ocrTime);
        }
        if (perfStats['screenshot_capture']?.avg) {
          stats.screenshotTime.min = Math.min(stats.screenshotTime.min, perfStats['screenshot_capture'].avg);
          stats.screenshotTime.max = Math.max(stats.screenshotTime.max, perfStats['screenshot_capture'].avg);
        }
        if (perfStats['find_best_bounties']?.avg) {
          stats.pathfinderTime.min = Math.min(stats.pathfinderTime.min, perfStats['find_best_bounties'].avg);
          stats.pathfinderTime.max = Math.max(stats.pathfinderTime.max, perfStats['find_best_bounties'].avg);
        }
      }
      
      // Update baseline for next measurement
      lastCpuUsage = process.cpuUsage();
      lastCpuTime = currentTime;
    }
  }, 1000);

  ipcMain.handle('get-performance-metrics', () => {
    const memUsage = process.memoryUsage();

    // OCR performance stats
    let ocrPerf = null;
    if (getOcrPerfStats) {
      const perfStats = getOcrPerfStats();
      ocrPerf = {
        avgTickTime: perfStats['tick_total']?.avg || null,
        avgOcrTime: (perfStats['title_ocr']?.avg || 0) + (perfStats['rest_ocr']?.avg || 0) || null,
        avgScreenshotTime: perfStats['screenshot_capture']?.avg || null,
        avgPathfinderTime: perfStats['find_best_bounties']?.avg || null,
      };
    }

    return {
      cpuUsage: currentCpuPercent,
      cpuMin: stats.cpu.min === Infinity ? null : stats.cpu.min,
      cpuMax: stats.cpu.max === 0 ? null : stats.cpu.max,
      memoryUsage: memUsage.rss,
      memoryMin: stats.memory.min === Infinity ? null : stats.memory.min,
      memoryMax: stats.memory.max === 0 ? null : stats.memory.max,
      workerCount: os.cpus()?.length ?? 4,
      memory: {
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        external: memUsage.external,
        rss: memUsage.rss,
        heapUsedMin: stats.heapUsed.min === Infinity ? null : stats.heapUsed.min,
        heapUsedMax: stats.heapUsed.max === 0 ? null : stats.heapUsed.max,
      },
      ocrPerf,
      ocrPerfMinMax: {
        tickTime: { min: stats.tickTime.min === Infinity ? null : stats.tickTime.min, max: stats.tickTime.max === 0 ? null : stats.tickTime.max },
        ocrTime: { min: stats.ocrTime.min === Infinity ? null : stats.ocrTime.min, max: stats.ocrTime.max === 0 ? null : stats.ocrTime.max },
        screenshotTime: { min: stats.screenshotTime.min === Infinity ? null : stats.screenshotTime.min, max: stats.screenshotTime.max === 0 ? null : stats.screenshotTime.max },
        pathfinderTime: { min: stats.pathfinderTime.min === Infinity ? null : stats.pathfinderTime.min, max: stats.pathfinderTime.max === 0 ? null : stats.pathfinderTime.max },
      },
    };
  });
}

function generateSettingsHTML(config: Config, version: string, gitHash: string, logPath: string, githubRepoUrl: string, githubReleasesUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Brighter Merchant</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: #1a1a1a;
      color: #e0e0e0;
      font-size: 14px;
      height: 100vh;
      display: flex;
      flex-direction: column;
      line-height: 1.5;
    }
    
    /* Custom Scrollbar */
    ::-webkit-scrollbar {
      width: 12px;
      height: 12px;
    }
    ::-webkit-scrollbar-track {
      background: #1a1a1a;
    }
    ::-webkit-scrollbar-thumb {
      background: #3a3a3a;
      border-radius: 6px;
      border: 2px solid #1a1a1a;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: #4a4a4a;
    }
    
    /* Tabs */
    .tabs {
      display: flex;
      background: #222;
      border-bottom: 1px solid #333;
      flex-shrink: 0;
    }
    .tab {
      padding: 14px 24px;
      cursor: pointer;
      border: none;
      background: transparent;
      color: #888;
      font-size: 13px;
      font-weight: 500;
      transition: all 0.15s ease;
      border-bottom: 2px solid transparent;
    }
    .tab:hover { color: #ccc; background: #282828; }
    .tab.active { color: #fff; background: #1a1a1a; border-bottom-color: #0078d4; }
    
    /* Update Banner */
    .update-banner {
      display: none;
      background: #4a4520;
      border-bottom: 1px solid #5a5530;
      padding: 10px 16px;
      margin: 0 24px;
      border-radius: 6px;
      margin-top: 16px;
      flex-shrink: 0;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .update-banner.visible { display: flex; }
    .update-banner .message {
      color: #fbbf24;
      font-size: 13px;
      font-weight: 500;
    }
    .update-banner .btn-update {
      background: #ca8a04;
      color: #fff;
      border: none;
      padding: 6px 14px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
    }
    .update-banner .btn-update:hover { background: #a16207; }
    .update-banner .btn-dismiss {
      background: transparent;
      color: #888;
      border: none;
      padding: 4px 8px;
      cursor: pointer;
      font-size: 16px;
    }
    .update-banner .btn-dismiss:hover { color: #ccc; }

    /* Restart Banner */
    .restart-banner {
      display: none;
      background: #4a3520;
      border: 1px solid #8b5a2b;
      border-radius: 6px;
      padding: 12px 16px;
      margin: 16px 24px;
      align-items: center;
      gap: 12px;
    }
    .restart-banner.visible { display: flex; }
    .restart-banner .message {
      flex: 1;
      color: #fb923c;
      font-size: 13px;
      font-weight: 500;
    }
    .restart-banner .btn-restart {
      padding: 6px 16px;
      background: #ea580c;
      color: #fff;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
    }
    .restart-banner .btn-restart:hover { background: #c2410c; }
    
    /* Tab Content */
    .tab-content {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
      display: none;
    }
    .tab-content.active { display: block; }
    
    /* Typography */
    h1 { font-size: 22px; font-weight: 600; margin-bottom: 24px; color: #fff; }
    h2 { 
      font-size: 11px; 
      font-weight: 600; 
      margin: 0 0 12px 0; 
      color: #888; 
      text-transform: uppercase; 
      letter-spacing: 0.5px; 
    }
    
    /* Sections */
    .section { 
      background: #242424; 
      padding: 14px; 
      border-radius: 8px; 
      margin-bottom: 12px; 
      border: 1px solid #2a2a2a;
    }
    .section h2 { margin-top: 0; }
    
    /* Forms */
    .form-group { margin-bottom: 16px; }
    .form-group:last-child { margin-bottom: 0; }
    label { 
      display: block; 
      margin-bottom: 6px; 
      color: #ccc; 
      font-size: 13px;
      font-weight: 500;
    }
    input[type="text"], input[type="number"], select {
      width: 100%;
      padding: 10px 12px;
      background: #1a1a1a;
      border: 1px solid #3a3a3a;
      border-radius: 6px;
      color: #e0e0e0;
      font-size: 14px;
      transition: border-color 0.15s ease;
    }
    input:focus, select:focus { outline: none; border-color: #0078d4; }
    input.invalid { border-color: #d43; background: #2a1a1a; }
    .checkbox-group { display: flex; align-items: center; gap: 10px; }
    .checkbox-group input { width: auto; }
    .checkbox-group label { margin-bottom: 0; }
    .shortcut-group { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    
    /* Toggle Switch */
    .switch-group { display: flex; align-items: center; gap: 12px; }
    .switch-label { color: #ccc; font-size: 14px; font-weight: 500; }
    .switch {
      position: relative;
      display: inline-block;
      width: 48px;
      height: 26px;
    }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider {
      position: absolute;
      cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background-color: #3a3a3a;
      transition: 0.2s;
      border-radius: 26px;
    }
    .slider:before {
      position: absolute;
      content: "";
      height: 20px;
      width: 20px;
      left: 3px;
      bottom: 3px;
      background-color: #888;
      transition: 0.2s;
      border-radius: 50%;
    }
    input:checked + .slider { background-color: #16a34a; }
    input:checked + .slider:before { transform: translateX(22px); background-color: #fff; }
    input:focus + .slider { box-shadow: 0 0 0 2px rgba(22, 163, 74, 0.3); }
    
    /* Buttons */
    button {
      padding: 10px 16px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: all 0.15s ease;
    }
    .btn-danger { background: #c53030; color: white; }
    .btn-danger:hover { background: #b52828; }
    .btn-toggle { background: #2563eb; color: white; }
    .btn-toggle:hover { background: #1d4ed8; }
    .btn-toggle.active { background: #16a34a; }
    .btn-toggle.active:hover { background: #15803d; }
    .btn-secondary { background: #3a3a3a; color: #ccc; }
    .btn-secondary:hover { background: #4a4a4a; }
    .btn-link {
      background: transparent;
      color: #60a5fa;
      padding: 0;
      font-size: inherit;
      text-decoration: underline;
      cursor: pointer;
    }
    .btn-link:hover { color: #93c5fd; }
    
    /* Hints */
    .hint { 
      font-size: 12px; 
      color: #666; 
      margin-top: 6px; 
      line-height: 1.4;
    }
    
    /* About Page */
    .app-info { text-align: center; padding: 20px 0 16px; }
    .app-info h1 { font-size: 24px; margin-bottom: 4px; }
    .app-info .version { color: #888; font-size: 14px; margin-bottom: 4px; }
    .app-info .github-link { margin-bottom: 0; }
    .app-info .github-link a { color: #60a5fa; text-decoration: none; font-size: 12px; }
    .app-info .github-link a:hover { text-decoration: underline; }
    
    /* Update Status */
    .update-status {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
      text-align: center;
    }
    .update-status.has-update {
      background: #2a2a1a;
      border-color: #4a4520;
    }
    .update-status.up-to-date {
      background: #1a2a1a;
      border-color: #2a4a2a;
    }
    .update-status .status-text { color: #888; font-size: 13px; margin-bottom: 12px; }
    .update-status .status-text.new-version { color: #fbbf24; }
    .update-status .status-text.current-version { color: #4ade80; }
    .update-status .btn-check-updates {
      background: #2563eb;
      color: white;
      padding: 8px 16px;
      margin-right: 8px;
    }
    .update-status .btn-check-updates:hover { background: #1d4ed8; }
    .update-status .btn-check-updates:disabled { background: #3a3a3a; color: #666; cursor: not-allowed; }
    .update-status .btn-download {
      background: #ca8a04;
      color: white;
      padding: 8px 16px;
    }
    .update-status .btn-download:hover { background: #a16207; }
    
    /* Info Grid (Performance, About) */
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .info-item { 
      background: #1a1a1a; 
      padding: 14px; 
      border-radius: 6px; 
      border: 1px solid #2a2a2a;
    }
    .info-item .label { 
      color: #888; 
      font-size: 11px; 
      text-transform: uppercase;
      letter-spacing: 0.3px;
      margin-bottom: 6px; 
    }
    .info-item .value { 
      color: #fff; 
      font-size: 18px;
      font-weight: 600;
    }
    .info-item .hint { 
      margin-top: 8px; 
      font-size: 11px;
      color: #555;
    }
    
    /* Log Tab */
    .log-container {
      background: #0d0d0d;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      height: calc(100vh - 140px);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .log-header {
      padding: 12px 16px;
      background: #1a1a1a;
      border-bottom: 1px solid #2a2a2a;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .log-header-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .log-header-top span:first-child { font-weight: 500; color: #ccc; }
    .log-header-buttons {
      display: flex;
      gap: 8px;
    }
    .log-header .path { 
      font-size: 11px; 
      color: #555; 
      font-family: 'SF Mono', Monaco, monospace; 
      word-break: break-all;
    }
    .log-header .btn-copy {
      padding: 6px 12px;
      background: #2a2a2a;
      color: #ccc;
      border: 1px solid #3a3a3a;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      white-space: nowrap;
      transition: all 0.15s ease;
    }
    .log-header .btn-copy:hover { background: #333; }
    .log-header .btn-copy.copied { background: #2a5; border-color: #2a5; color: #fff; }
    .log-content {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      font-family: 'SF Mono', Monaco, 'Menlo', monospace;
      font-size: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-all;
      color: #999;
    }
    
    /* Stat Cards (Session, Performance) */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 16px;
    }
    .stat-card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      padding: 16px;
      text-align: center;
    }
    .stat-card .value {
      font-size: 28px;
      font-weight: 700;
      color: #fff;
      margin-bottom: 4px;
      font-variant-numeric: tabular-nums;
    }
    .stat-card .label {
      font-size: 11px;
      color: #888;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .stat-card .hint {
      margin-top: 8px;
      font-size: 11px;
      color: #555;
    }
    .stat-card.highlight .value { color: #4ade80; }
    
    /* Session Tab Specific */
    .current-route {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      padding: 16px;
    }
    .current-route .steps {
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 13px;
      line-height: 1.8;
      color: #ccc;
      white-space: pre-wrap;
    }
    .status-badge {
      display: inline-block;
      padding: 5px 12px;
      border-radius: 16px;
      font-size: 12px;
      font-weight: 600;
    }
    .status-badge.computing { background: #4a4520; color: #fbbf24; }
    .status-badge.optimal { background: #1a3a2a; color: #4ade80; }
    .status-badge.not-optimal { background: #3a1a1a; color: #f87171; }
    .status-badge.idle { background: #2a2a2a; color: #888; }
    .bounty-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }
    .bounty-tag {
      background: #2a2a2a;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      color: #999;
      font-weight: 500;
    }
    .bounty-tag.active { background: #1a3a2a; color: #4ade80; }
    .bounty-tag.board { background: #1a2a3a; color: #60a5fa; }
    
    /* Collapsible Section */
    .collapsible-section {
      background: #242424;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 12px;
    }
    .collapsible-header {
      padding: 14px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      user-select: none;
      transition: background 0.15s ease;
    }
    .collapsible-header:hover {
      background: #2a2a2a;
    }
    .collapsible-header h2 {
      margin: 0;
    }
    .collapsible-arrow {
      color: #888;
      font-size: 14px;
      transition: transform 0.2s ease;
    }
    .collapsible-section.expanded .collapsible-arrow {
      transform: rotate(90deg);
    }
    .collapsible-content {
      display: none;
      padding: 0 14px 14px 14px;
    }
    .collapsible-section.expanded .collapsible-content {
      display: block;
    }
  </style>
</head>
<body>
  <div class="tabs">
    <button class="tab active" data-tab="session">Session</button>
    <button class="tab" data-tab="settings">Settings</button>
    <button class="tab" data-tab="log">Log</button>
    <button class="tab" data-tab="about">About</button>
  </div>

  <div id="updateBanner" class="update-banner">
    <span class="message">🎉 A new version is available: <span id="bannerVersion"></span></span>
    <div>
      <button class="btn-update" onclick="openReleaseUrl()">Download Update</button>
      <button class="btn-dismiss" onclick="dismissBanner()">×</button>
    </div>
  </div>

  <div id="restartBanner" class="restart-banner">
    <span class="message">⚠️ Settings changed - restart required to apply</span>
    <button class="btn-restart" onclick="restartApp()">Restart Now</button>
  </div>

  <div id="session" class="tab-content active">
    <!-- Board Timer -->
    <div class="stat-card highlight" style="margin-bottom: 20px; padding: 24px;">
      <div class="value" id="boardTimer" style="font-size: 48px;">0:01:59</div>
      <div class="label">Next Board Refresh</div>
    </div>
    
    <div class="stats-grid">
      <div class="stat-card highlight">
        <div class="value" id="totalKp">0.00</div>
        <div class="label">Total KP</div>
      </div>
      <div class="stat-card">
        <div class="value" id="kpPerHour">0.00</div>
        <div class="label">KP / Hour</div>
      </div>
      <div class="stat-card">
        <div class="value" id="bountiesCompleted">0</div>
        <div class="label">Bounties</div>
      </div>
      <div class="stat-card">
        <div class="value" id="sessionDuration">00:00:00</div>
        <div class="label">Session Time</div>
      </div>
    </div>

    <div class="section">
      <h2>Current Status</h2>
      <div style="display: flex; align-items: center; gap: 10px;">
        <span id="statusBadge" class="status-badge idle">Idle</span>
        <span id="boardStatus" style="color: #888; font-size: 13px;">Board: Closed</span>
      </div>
    </div>

    <div class="section">
      <h2>Current Route</h2>
      <div class="current-route">
        <div id="currentSteps" class="steps">No active route</div>
      </div>
    </div>

    <div class="section">
      <h2>Active Bounties</h2>
      <div id="activeBounties" class="bounty-list">
        <span style="color: #666;">None detected</span>
      </div>
    </div>

    <div class="section">
      <h2>Board Bounties</h2>
      <div id="boardBounties" class="bounty-list">
        <span style="color: #666;">Board not open</span>
      </div>
    </div>

    <div class="collapsible-section" id="ocrDebugSection">
      <div class="collapsible-header" onclick="toggleCollapsible('ocrDebugSection')">
        <h2>Advanced - OCR Debug</h2>
        <span class="collapsible-arrow">▶</span>
      </div>
      <div class="collapsible-content">
        <div class="section" style="margin-bottom: 12px;">
          <h2>Active Bounty Slots (Raw OCR)</h2>
          <div id="activeOcrDebug" style="font-family: 'SF Mono', Monaco, monospace; font-size: 12px; color: #888; line-height: 1.8;">
            <span style="color: #666;">No data</span>
          </div>
        </div>
        <div class="section">
          <h2>Board Bounty Slots (Raw OCR)</h2>
          <div id="boardOcrDebug" style="font-family: 'SF Mono', Monaco, monospace; font-size: 12px; color: #888; line-height: 1.8;">
            <span style="color: #666;">No data</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div id="settings" class="tab-content">
    <h1>Settings</h1>
    
    <div class="section">
      <h2>Game Settings</h2>
      <div class="form-group">
        <label for="detectiveLevel">Detective Level (1-500)</label>
        <input type="number" id="detectiveLevel" min="1" max="500" value="${config.detectiveLevel ?? 500}">
      </div>
      <div class="form-group checkbox-group">
        <input type="checkbox" id="isBattleOfFortuneholdCompleted" ${config.isBattleOfFortuneholdCompleted ? 'checked' : ''}>
        <label for="isBattleOfFortuneholdCompleted">Battle of Fortunehold Completed</label>
      </div>
    </div>

    <div class="section">
      <h2>OCR Settings</h2>
      <div class="form-group">
        <label for="ocrMethod">OCR Method</label>
        <select id="ocrMethod">
          <option value="auto" ${config.ocrMethod === 'auto' ? 'selected' : ''}>Auto</option>
          <option value="native" ${config.ocrMethod === 'native' ? 'selected' : ''}>Native (Tesseract CLI)</option>
          <option value="tesseract-js" ${config.ocrMethod === 'tesseract-js' ? 'selected' : ''}>Tesseract.js</option>
        </select>
        <div class="hint">Auto will use native Tesseract if available, otherwise Tesseract.js</div>
      </div>
    </div>

    <div class="section">
      <h2>Pathfinding</h2>
      <div class="form-group">
        <label for="pathfindingQuality">Pathfinding Quality</label>
        <select id="pathfindingQuality">
          <option value="1" ${(config.pathfindingQuality ?? 5) === 1 ? 'selected' : ''}>1 - Fast (heavy pruning)</option>
          <option value="2" ${(config.pathfindingQuality ?? 5) === 2 ? 'selected' : ''}>2 - Balanced</option>
          <option value="3" ${(config.pathfindingQuality ?? 5) === 3 ? 'selected' : ''}>3 - Thorough</option>
          <option value="4" ${(config.pathfindingQuality ?? 5) === 4 ? 'selected' : ''}>4 - More Thorough</option>
          <option value="5" ${(config.pathfindingQuality ?? 5) === 5 ? 'selected' : ''}>5 - Optimal (no pruning, default)</option>
        </select>
        <div class="hint">Higher quality = better routes but slower calculation. Level 5 evaluates all combinations.</div>
      </div>
    </div>

    <div class="section">
      <h2>Keyboard Shortcuts</h2>
      <div class="hint" style="margin-bottom: 10px;">Use CmdOrCtrl for cross-platform compatibility. Restart required for changes.</div>
      <div class="shortcut-group">
        <div class="form-group">
          <label for="toggleEditMode">Toggle Edit Mode</label>
          <div class="hint">Enable dragging/resizing overlay regions</div>
          <input type="text" id="toggleEditMode" value="${config.keyboardShortcuts?.toggleEditMode ?? 'CmdOrCtrl+J'}">
        </div>
        <div class="form-group">
          <label for="toggleVisibility">Toggle Visibility</label>
          <div class="hint">Show or hide the entire overlay</div>
          <input type="text" id="toggleVisibility" value="${config.keyboardShortcuts?.toggleVisibility ?? 'CmdOrCtrl+K'}">
        </div>
      </div>
      <div class="shortcut-group">
        <div class="form-group">
          <label for="forceRecalculateBounties">Force Recalculate</label>
          <div class="hint">Recalculate optimal bounties now</div>
          <input type="text" id="forceRecalculateBounties" value="${config.keyboardShortcuts?.forceRecalculateBounties ?? 'CmdOrCtrl+N'}">
        </div>
        <div class="form-group">
          <label for="openSettings">Open Settings</label>
          <div class="hint">Focus this settings window</div>
          <input type="text" id="openSettings" value="${config.keyboardShortcuts?.openSettings ?? 'CmdOrCtrl+,'}">
        </div>
      </div>
    </div>

    <div class="section">
      <h2>UI Layout</h2>
      <div class="form-group">
        <label for="chatBoxFontSize">Chat Box Font Size (px)</label>
        <input type="number" id="chatBoxFontSize" min="10" max="50" value="${config.chatBoxFontSize ?? 23}">
        <div class="hint">Font size for the chat box overlay (10-50px)</div>
      </div>
      <div class="form-group" style="display: flex; gap: 24px; align-items: flex-start;">
        <div>
          <div class="switch-group">
            <label class="switch">
              <input type="checkbox" id="editModeSwitch" onchange="toggleEditMode()">
              <span class="slider"></span>
            </label>
            <span class="switch-label">Edit Mode</span>
          </div>
          <div class="hint">Enable dragging/resizing overlay regions</div>
        </div>
        <div>
          <button type="button" class="btn-danger" onclick="resetRegions()">Reset UI Layout to Defaults</button>
          <div class="hint">Reset all overlay region positions and sizes</div>
        </div>
      </div>
    </div>

    <div class="section">
      <h2>Updates</h2>
      <div class="form-group checkbox-group">
        <input type="checkbox" id="checkForUpdatesOnStartup" ${config.checkForUpdatesOnStartup !== false ? 'checked' : ''}>
        <label for="checkForUpdatesOnStartup">Check for updates on startup</label>
      </div>
    </div>
  </div>

  <div id="log" class="tab-content">
    <div class="log-container">
      <div class="log-header">
        <div class="log-header-top">
          <span>Session Log</span>
          <div class="log-header-buttons">
            <button class="btn-copy" onclick="openLogFolder()">📁 Open Folder</button>
            <button class="btn-copy" onclick="copyLog()">📋 Copy Log</button>
          </div>
        </div>
        <span class="path">${logPath}</span>
      </div>
      <div id="logContent" class="log-content">Loading...</div>
    </div>
  </div>

  <div id="about" class="tab-content">
    <div class="app-info">
      <h1>Brighter Merchant</h1>
      <div class="version">Version ${version} (${gitHash})</div>
      <div class="github-link">
        <a href="#" onclick="openWebsite(); return false;">Website</a>
        <span style="color: #555; margin: 0 8px;">•</span>
        <a href="#" onclick="openGitHub(); return false;">GitHub</a>
      </div>
    </div>

    <div class="section">
      <h2>Updates</h2>
      <div id="updateStatus" class="update-status">
        <div id="updateStatusText" class="status-text">Click to check for updates</div>
        <div>
          <button id="btnCheckUpdates" class="btn-check-updates" onclick="checkUpdates()">Check for Updates</button>
          <button id="btnDownloadUpdate" class="btn-download" style="display: none;" onclick="openReleaseUrl()">Download Update</button>
        </div>
      </div>
    </div>

    <div class="section">
      <h2>System Information</h2>
      <div class="info-grid">
        <div class="info-item">
          <div class="label">Platform</div>
          <div class="value">${process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'}</div>
        </div>
        <div class="info-item">
          <div class="label">CPU Cores</div>
          <div class="value">${require('os').cpus()?.length ?? 4}</div>
        </div>
        <div class="info-item">
          <div class="label">Electron</div>
          <div class="value">${process.versions.electron}</div>
        </div>
        <div class="info-item">
          <div class="label">Node.js</div>
          <div class="value">${process.versions.node}</div>
        </div>
      </div>
    </div>

    <div class="collapsible-section">
      <div class="collapsible-header" onclick="toggleAdvanced()">
        <h2>Advanced</h2>
        <span class="collapsible-arrow">▶</span>
      </div>
      <div class="collapsible-content">
        <div class="info-grid" style="margin-bottom: 16px;">
          <div class="info-item">
            <div class="label">Utility Processes</div>
            <div class="value" id="workerCount">${Math.max(2, (require('os').cpus()?.length ?? 4) - 1)}</div>
          </div>
          <div class="info-item">
            <div class="label">Chrome</div>
            <div class="value">${process.versions.chrome}</div>
          </div>
        </div>

        <h2 style="margin-bottom: 12px;">OCR Performance</h2>
        <div class="info-grid">
          <div class="info-item">
            <div class="label">Tick Time (avg)</div>
            <div class="value" id="avgTickTime">--</div>
            <div class="hint">Min: <span id="tickTimeMin">--</span> / Max: <span id="tickTimeMax">--</span></div>
          </div>
          <div class="info-item">
            <div class="label">OCR Time (avg)</div>
            <div class="value" id="avgOcrTime">--</div>
            <div class="hint">Min: <span id="ocrTimeMin">--</span> / Max: <span id="ocrTimeMax">--</span></div>
          </div>
          <div class="info-item">
            <div class="label">Screenshot (avg)</div>
            <div class="value" id="avgScreenshotTime">--</div>
            <div class="hint">Min: <span id="screenshotTimeMin">--</span> / Max: <span id="screenshotTimeMax">--</span></div>
          </div>
          <div class="info-item">
            <div class="label">Pathfinder (avg)</div>
            <div class="value" id="avgPathfinderTime">--</div>
            <div class="hint">Min: <span id="pathfinderTimeMin">--</span> / Max: <span id="pathfinderTimeMax">--</span></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const { ipcRenderer } = require('electron');

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(tab.dataset.tab).classList.add('active');
        
        if (tab.dataset.tab === 'log') {
          loadLog();
        }
        if (tab.dataset.tab === 'about') {
          startPerformanceUpdates();
        } else {
          stopPerformanceUpdates();
        }
      });
    });

    // Performance tab updates
    let performanceInterval = null;

    function startPerformanceUpdates() {
      updatePerformance();
      performanceInterval = setInterval(updatePerformance, 1000);
    }

    function stopPerformanceUpdates() {
      if (performanceInterval) {
        clearInterval(performanceInterval);
        performanceInterval = null;
      }
    }

    async function updatePerformance() {
      try {
        const metrics = await ipcRenderer.invoke('get-performance-metrics');
        if (!metrics) return;

        const fmtMs = (v) => v !== null ? v.toFixed(0) + ' ms' : '--';

        // Pathfinder
        document.getElementById('workerCount').textContent = metrics.workerCount;

        // OCR Performance
        if (metrics.ocrPerf) {
          document.getElementById('avgTickTime').textContent = fmtMs(metrics.ocrPerf.avgTickTime);
          document.getElementById('avgOcrTime').textContent = fmtMs(metrics.ocrPerf.avgOcrTime);
          document.getElementById('avgScreenshotTime').textContent = fmtMs(metrics.ocrPerf.avgScreenshotTime);
          document.getElementById('avgPathfinderTime').textContent = fmtMs(metrics.ocrPerf.avgPathfinderTime);
        }

        // OCR Performance min/max
        if (metrics.ocrPerfMinMax) {
          document.getElementById('tickTimeMin').textContent = fmtMs(metrics.ocrPerfMinMax.tickTime.min);
          document.getElementById('tickTimeMax').textContent = fmtMs(metrics.ocrPerfMinMax.tickTime.max);
          document.getElementById('ocrTimeMin').textContent = fmtMs(metrics.ocrPerfMinMax.ocrTime.min);
          document.getElementById('ocrTimeMax').textContent = fmtMs(metrics.ocrPerfMinMax.ocrTime.max);
          document.getElementById('screenshotTimeMin').textContent = fmtMs(metrics.ocrPerfMinMax.screenshotTime.min);
          document.getElementById('screenshotTimeMax').textContent = fmtMs(metrics.ocrPerfMinMax.screenshotTime.max);
          document.getElementById('pathfinderTimeMin').textContent = fmtMs(metrics.ocrPerfMinMax.pathfinderTime.min);
          document.getElementById('pathfinderTimeMax').textContent = fmtMs(metrics.ocrPerfMinMax.pathfinderTime.max);
        }
      } catch (err) {
        console.error('Failed to get performance metrics:', err);
      }
    }

    ipcRenderer.on('performance-update', (e, metrics) => {
      // Only update if about tab is active and advanced section is expanded
      const aboutTab = document.getElementById('about');
      if (aboutTab && aboutTab.classList.contains('active')) {
        updatePerformance();
      }
    });

    // Session data updates
    ipcRenderer.on('session-update', (e, data) => {
      updateSessionDisplay(data);
    });

    function updateSessionDisplay(data) {
      if (!data) return;

      // Update stats
      if (data.sessionStats) {
        const kp = (data.sessionStats.totalKpEarned / 100).toFixed(2);
        const duration = data.sessionStats.sessionDurationSeconds;
        const kpPerHour = duration > 0 
          ? ((data.sessionStats.totalKpEarned / (duration / 3600)) / 100).toFixed(2)
          : '0.00';

        document.getElementById('totalKp').textContent = kp;
        document.getElementById('kpPerHour').textContent = kpPerHour;
        document.getElementById('bountiesCompleted').textContent = data.sessionStats.totalBountiesCompleted || 0;

        const hours = Math.floor(duration / 3600);
        const minutes = Math.floor((duration % 3600) / 60);
        const seconds = Math.floor(duration % 60);
        document.getElementById('sessionDuration').textContent = 
          (hours < 10 ? '0' : '') + hours + ':' +
          (minutes < 10 ? '0' : '') + minutes + ':' +
          (seconds < 10 ? '0' : '') + seconds;
      }

      // Update status
      const statusBadge = document.getElementById('statusBadge');
      if (data.status === 'computing') {
        statusBadge.textContent = '⏳ Computing';
        statusBadge.className = 'status-badge computing';
      } else if (data.status === 'optimal') {
        statusBadge.textContent = '✓ Optimal';
        statusBadge.className = 'status-badge optimal';
      } else if (data.status === 'not-optimal') {
        statusBadge.textContent = '✗ Not Optimal';
        statusBadge.className = 'status-badge not-optimal';
      } else {
        statusBadge.textContent = 'Idle';
        statusBadge.className = 'status-badge idle';
      }

      // Board status
      document.getElementById('boardStatus').textContent = 
        data.boardOpen ? 'Board: Open' : 'Board: Closed';

      // Update timer
      const nowSec = Date.now() / 1000;
      const elapsedSec = (nowSec + 9) % 120;
      const remainingSec = 120 - elapsedSec;
      const min = Math.floor(remainingSec / 60);
      const sec = Math.floor(remainingSec % 60);

      // Current route
      if (data.steps) {
        // Remove the stats line (first line with [time | KP | KP/D]) since it's shown above
        let stepsHtml = data.steps.replace(/^\\[.*?\\]\\n?/, '');
        document.getElementById('currentSteps').innerHTML = stepsHtml || 'No active route';
      } else {
        document.getElementById('currentSteps').innerHTML = 'No active route';
      }

      // Active bounties
      const activeBountiesEl = document.getElementById('activeBounties');
      if (data.activeBounties && Object.keys(data.activeBounties).length > 0) {
        const bounties = Object.entries(data.activeBounties).filter(([_, b]) => b); // Filter out any undefined/null
        if (bounties.length > 0) {
          activeBountiesEl.innerHTML = bounties
            .map(([index, bountyKey]) => {
              const rarity = data.activeBountyRarities && data.activeBountyRarities[index] ? data.activeBountyRarities[index] : null;
              return '<span class="bounty-tag active">' + formatBountyName(bountyKey, rarity) + '</span>';
            })
            .join('');
        } else {
          activeBountiesEl.innerHTML = '<span style="color: #666;">None detected</span>';
        }
      } else {
        activeBountiesEl.innerHTML = '<span style="color: #666;">None detected</span>';
      }

      // Board bounties
      const boardBountiesEl = document.getElementById('boardBounties');
      if (data.boardOpen && data.boardBounties && Object.keys(data.boardBounties).length > 0) {
        const bounties = Object.entries(data.boardBounties).filter(([_, b]) => b); // Filter out any undefined/null
        if (bounties.length > 0) {
          boardBountiesEl.innerHTML = bounties
            .map(([index, bountyKey]) => {
              const rarity = data.boardBountyRarities && data.boardBountyRarities[index] ? data.boardBountyRarities[index] : null;
              return '<span class="bounty-tag board">' + formatBountyName(bountyKey, rarity) + '</span>';
            })
            .join('');
        } else {
          boardBountiesEl.innerHTML = '<span style="color: #666;">None detected</span>';
        }
      } else {
        boardBountiesEl.innerHTML = '<span style="color: #666;">' + 
          (data.boardOpen ? 'None detected' : 'Board not open') + '</span>';
      }

      // Update OCR debug info
      if (data.rawOcrText) {
        // Active bounty slots
        const activeOcrDebugEl = document.getElementById('activeOcrDebug');
        let activeOcrHtml = '';
        for (let i = 1; i <= 6; i++) {
          const key = 'activeBountyRegion' + i;
          const text = data.rawOcrText[key] || '';
          const detected = data.activeBounties && data.activeBounties[i] ? data.activeBounties[i] : '';
          const rarity = data.activeBountyRarities && data.activeBountyRarities[i] ? data.activeBountyRarities[i] : null;
          const matchType = data.matchTypes && data.matchTypes[key] ? data.matchTypes[key] : null;
          const fuzzyMatches = data.fuzzyDebug && data.fuzzyDebug[key] ? data.fuzzyDebug[key] : null;
          
          activeOcrHtml += '<div style="margin-bottom: 12px;">';
          activeOcrHtml += '<span style="color: #60a5fa;">Slot ' + i + ':</span> ';
          activeOcrHtml += '<span style="color: ' + (text ? '#ccc' : '#555') + ';">"' + (text || '(empty)') + '"</span>';
          if (detected) {
            const matchColor = matchType === 'exact' ? '#4ade80' : '#fbbf24';
            const matchLabel = matchType === 'exact' ? '✓' : '~';
            activeOcrHtml += ' <span style="color: ' + matchColor + ';">' + matchLabel + ' ' + formatBountyName(detected, rarity) + '</span>';
            if (matchType === 'fuzzy') {
              activeOcrHtml += ' <span style="color: #888; font-size: 11px;">(fuzzy)</span>';
            }
          }
          // Show fuzzy match debug info
          if (fuzzyMatches && fuzzyMatches.length > 0) {
            activeOcrHtml += '<div style="margin-left: 20px; margin-top: 4px; font-size: 11px; color: #888;">';
            activeOcrHtml += 'Top matches: ';
            for (let j = 0; j < Math.min(3, fuzzyMatches.length); j++) {
              const m = fuzzyMatches[j];
              if (j > 0) activeOcrHtml += ', ';
              activeOcrHtml += formatBountyName(m.bountyKey) + ' (' + m.score.toFixed(2) + ')';
            }
            activeOcrHtml += '</div>';
          }
          activeOcrHtml += '</div>';
        }
        activeOcrDebugEl.innerHTML = activeOcrHtml || '<span style="color: #666;">No data</span>';

        // Board bounty slots
        const boardOcrDebugEl = document.getElementById('boardOcrDebug');
        let boardOcrHtml = '';
        for (let i = 1; i <= 6; i++) {
          const key = 'boardRegion' + i;
          const text = data.rawOcrText[key] || '';
          const detected = data.boardBounties && data.boardBounties[i] ? data.boardBounties[i] : '';
          const rarity = data.boardBountyRarities && data.boardBountyRarities[i] ? data.boardBountyRarities[i] : null;
          const matchType = data.matchTypes && data.matchTypes[key] ? data.matchTypes[key] : null;
          const fuzzyMatches = data.fuzzyDebug && data.fuzzyDebug[key] ? data.fuzzyDebug[key] : null;
          
          boardOcrHtml += '<div style="margin-bottom: 12px;">';
          boardOcrHtml += '<span style="color: #60a5fa;">Slot ' + i + ':</span> ';
          boardOcrHtml += '<span style="color: ' + (text ? '#ccc' : '#555') + ';">"' + (text || '(empty)') + '"</span>';
          if (detected) {
            const matchColor = matchType === 'exact' ? '#4ade80' : '#fbbf24';
            const matchLabel = matchType === 'exact' ? '✓' : '~';
            boardOcrHtml += ' <span style="color: ' + matchColor + ';">' + matchLabel + ' ' + formatBountyName(detected, rarity) + '</span>';
            if (matchType === 'fuzzy') {
              boardOcrHtml += ' <span style="color: #888; font-size: 11px;">(fuzzy)</span>';
            }
          }
          // Show fuzzy match debug info
          if (fuzzyMatches && fuzzyMatches.length > 0) {
            boardOcrHtml += '<div style="margin-left: 20px; margin-top: 4px; font-size: 11px; color: #888;">';
            boardOcrHtml += 'Top matches: ';
            for (let j = 0; j < Math.min(3, fuzzyMatches.length); j++) {
              const m = fuzzyMatches[j];
              if (j > 0) boardOcrHtml += ', ';
              boardOcrHtml += formatBountyName(m.bountyKey) + ' (' + m.score.toFixed(2) + ')';
            }
            boardOcrHtml += '</div>';
          }
          boardOcrHtml += '</div>';
        }
        boardOcrDebugEl.innerHTML = boardOcrHtml || '<span style="color: #666;">No data</span>';
      }
    }

    function formatBountyName(key, rarity) {
      // Convert SNAKE_CASE to Title Case with spaces
      const name = key.split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
      
      // Add rarity suffix if present
      if (rarity) {
        const rarityLabel = rarity.charAt(0).toUpperCase() + rarity.slice(1);
        return name + ' (' + rarityLabel + ')';
      }
      
      return name;
    }

    // Update board timer every second
    setInterval(() => {
      const nowSec = Date.now() / 1000;
      const elapsedSec = (nowSec + 9) % 120;
      const remainingSec = 120 - elapsedSec;
      const min = Math.floor(remainingSec / 60);
      const sec = Math.floor(remainingSec % 60);
      
      // Update prominent board timer
      const formatted = '0:' + (min < 10 ? '0' : '') + min + ':' + (sec < 10 ? '0' : '') + sec;
      document.getElementById('boardTimer').textContent = formatted;
      
    }, 1000);

    async function loadLog() {
      const log = await ipcRenderer.invoke('settings-get-log');
      const logContent = document.getElementById('logContent');
      logContent.textContent = log || 'No log data available';
      logContent.scrollTop = logContent.scrollHeight;
    }

    async function copyLog() {
      const { clipboard } = require('electron');
      const logContent = document.getElementById('logContent');
      const buttons = document.querySelectorAll('.log-header-buttons .btn-copy');
      const btn = buttons[1]; // Second button is Copy Log
      try {
        clipboard.writeText(logContent.textContent);
        btn.textContent = '✓ Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = '📋 Copy Log';
          btn.classList.remove('copied');
        }, 2000);
      } catch (err) {
        console.error('Failed to copy:', err);
      }
    }

    function openLogFolder() {
      ipcRenderer.send('open-log-folder');
    }

    ipcRenderer.on('log-update', (e, log) => {
      const logContent = document.getElementById('logContent');
      if (logContent) {
        logContent.textContent = log;
        logContent.scrollTop = logContent.scrollHeight;
      }
    });

    function getFormData() {
      const detectiveLevelInput = document.getElementById('detectiveLevel');
      let detectiveLevel = parseInt(detectiveLevelInput.value);
      if (isNaN(detectiveLevel) || detectiveLevel < 1) detectiveLevel = 1;
      if (detectiveLevel > 500) detectiveLevel = 500;
      
      const chatBoxFontSizeInput = document.getElementById('chatBoxFontSize');
      let chatBoxFontSize = parseInt(chatBoxFontSizeInput.value);
      if (isNaN(chatBoxFontSize) || chatBoxFontSize < 10) chatBoxFontSize = 10;
      if (chatBoxFontSize > 50) chatBoxFontSize = 50;
      
      return {
        chatBoxFontSize,
        checkForUpdatesOnStartup: document.getElementById('checkForUpdatesOnStartup').checked,
        detectiveLevel,
        isBattleOfFortuneholdCompleted: document.getElementById('isBattleOfFortuneholdCompleted').checked,
        ocrMethod: document.getElementById('ocrMethod').value,
        pathfindingQuality: parseInt(document.getElementById('pathfindingQuality').value),
        keyboardShortcuts: {
          toggleEditMode: document.getElementById('toggleEditMode').value,
          toggleVisibility: document.getElementById('toggleVisibility').value,
          forceRecalculateBounties: document.getElementById('forceRecalculateBounties').value,
          openSettings: document.getElementById('openSettings').value,
        }
      };
    }

    async function saveConfig() {
      const currentConfig = await ipcRenderer.invoke('settings-get-config');
      const formData = getFormData();
      const newConfig = { ...currentConfig, ...formData };
      
      // Check if restart-required settings changed
      const restartRequired = 
        currentConfig.ocrMethod !== newConfig.ocrMethod ||
        currentConfig.pathfindingQuality !== newConfig.pathfindingQuality;
      
      ipcRenderer.send('settings-update', newConfig);
      
      // Apply chat box font size immediately without restart
      if (currentConfig.chatBoxFontSize !== newConfig.chatBoxFontSize) {
        ipcRenderer.send('update-chat-font-size', newConfig.chatBoxFontSize);
      }
      
      if (restartRequired) {
        showRestartBanner();
      }
    }

    function resetRegions() {
      if (confirm('Reset all UI regions to default positions?')) {
        ipcRenderer.send('settings-reset-regions');
      }
    }

    async function toggleEditMode() {
      ipcRenderer.send('toggle-edit-mode');
      // Update switch state after a short delay to allow the mode to change
      setTimeout(updateEditModeSwitch, 100);
    }

    async function updateEditModeSwitch() {
      const isEditMode = await ipcRenderer.invoke('get-edit-mode');
      const switchEl = document.getElementById('editModeSwitch');
      if (switchEl) {
        switchEl.checked = isEditMode;
      }
    }

    // Update edit mode switch state periodically (in case it changes via keyboard shortcut)
    setInterval(updateEditModeSwitch, 1000);

    function validateDetectiveLevel() {
      const input = document.getElementById('detectiveLevel');
      const value = parseInt(input.value);
      if (isNaN(value) || value < 1 || value > 500) {
        input.classList.add('invalid');
      } else {
        input.classList.remove('invalid');
      }
    }

    function validateChatBoxFontSize() {
      const input = document.getElementById('chatBoxFontSize');
      const value = parseInt(input.value);
      if (isNaN(value) || value < 10 || value > 50) {
        input.classList.add('invalid');
      } else {
        input.classList.remove('invalid');
      }
    }

    document.querySelectorAll('#settings input, #settings select').forEach(el => {
      el.addEventListener('change', saveConfig);
      el.addEventListener('input', () => {
        if (el.id === 'detectiveLevel') {
          validateDetectiveLevel();
        } else if (el.id === 'chatBoxFontSize') {
          validateChatBoxFontSize();
        }
      });
    });

    // Also save config when about page checkbox changes
    document.getElementById('checkForUpdatesOnStartup').addEventListener('change', saveConfig);

    // Update checker functions
    const GITHUB_REPO_URL = '${githubRepoUrl}';
    const GITHUB_RELEASES_URL = '${githubReleasesUrl}';
    const WEBSITE_URL = 'https://joenye.github.io/brightermerchant/';
    let currentUpdateInfo = null;
    let bannerDismissed = false;

    function openWebsite() {
      ipcRenderer.send('open-external-url', WEBSITE_URL);
    }

    function openGitHub() {
      ipcRenderer.send('open-external-url', GITHUB_REPO_URL);
    }

    function openReleaseUrl() {
      if (currentUpdateInfo && currentUpdateInfo.releaseUrl) {
        ipcRenderer.send('open-external-url', currentUpdateInfo.releaseUrl);
      } else {
        ipcRenderer.send('open-external-url', GITHUB_RELEASES_URL);
      }
    }

    function dismissBanner() {
      bannerDismissed = true;
      document.getElementById('updateBanner').classList.remove('visible');
    }

    function restartApp() {
      ipcRenderer.send('restart-app');
    }

    function showRestartBanner() {
      document.getElementById('restartBanner').classList.add('visible');
    }

    function toggleAdvanced() {
      const section = document.querySelector('.collapsible-section');
      section.classList.toggle('expanded');
      
      // Start updating performance metrics when expanded
      if (section.classList.contains('expanded')) {
        updatePerformance();
      }
    }

    function toggleCollapsible(sectionId) {
      const section = document.getElementById(sectionId);
      if (section) {
        section.classList.toggle('expanded');
      }
    }

    function showUpdateBanner(info) {
      if (bannerDismissed || !info.hasUpdate) return;
      document.getElementById('bannerVersion').textContent = 'v' + info.latestVersion;
      document.getElementById('updateBanner').classList.add('visible');
    }

    function updateUpdateStatus(info) {
      currentUpdateInfo = info;
      const statusEl = document.getElementById('updateStatus');
      const statusText = document.getElementById('updateStatusText');
      const btnCheck = document.getElementById('btnCheckUpdates');
      const btnDownload = document.getElementById('btnDownloadUpdate');

      btnCheck.disabled = false;
      btnCheck.textContent = 'Check for Updates';
      statusEl.classList.remove('has-update', 'up-to-date');

      if (info.error) {
        statusText.textContent = 'Failed to check: ' + info.error;
        statusText.className = 'status-text';
        btnDownload.style.display = 'none';
      } else if (info.hasUpdate) {
        statusText.textContent = '🎉 New version available: v' + info.latestVersion + ' (you have v' + info.currentVersion + ')';
        statusText.className = 'status-text new-version';
        statusEl.classList.add('has-update');
        btnDownload.style.display = 'inline-block';
        showUpdateBanner(info);
      } else if (info.latestVersion) {
        statusText.textContent = '✓ You are running the latest version (v' + info.currentVersion + ')';
        statusText.className = 'status-text current-version';
        statusEl.classList.add('up-to-date');
        btnDownload.style.display = 'none';
      }
    }

    async function checkUpdates() {
      const btnCheck = document.getElementById('btnCheckUpdates');
      const statusText = document.getElementById('updateStatusText');
      
      btnCheck.disabled = true;
      btnCheck.textContent = 'Checking...';
      statusText.textContent = 'Checking for updates...';
      statusText.className = 'status-text';

      try {
        const info = await ipcRenderer.invoke('check-for-updates');
        updateUpdateStatus(info);
      } catch (err) {
        statusText.textContent = 'Failed to check for updates';
        btnCheck.disabled = false;
        btnCheck.textContent = 'Check for Updates';
      }
    }

    // Check for cached update info on load, and auto-check if enabled
    (async function initUpdateCheck() {
      const cachedInfo = await ipcRenderer.invoke('get-cached-update-info');
      if (cachedInfo) {
        updateUpdateStatus(cachedInfo);
      }
    })();

    // Listen for update info from main process (e.g., startup check)
    ipcRenderer.on('update-info', (e, info) => {
      updateUpdateStatus(info);
    });

    ipcRenderer.on('config-updated', (e, config) => {
      document.getElementById('chatBoxFontSize').value = config.chatBoxFontSize ?? 23;
      document.getElementById('detectiveLevel').value = config.detectiveLevel ?? 500;
      document.getElementById('isBattleOfFortuneholdCompleted').checked = config.isBattleOfFortuneholdCompleted ?? true;
      document.getElementById('ocrMethod').value = config.ocrMethod ?? 'auto';
      document.getElementById('pathfindingQuality').value = config.pathfindingQuality ?? 5;
      document.getElementById('checkForUpdatesOnStartup').checked = config.checkForUpdatesOnStartup !== false;
      document.getElementById('toggleEditMode').value = config.keyboardShortcuts?.toggleEditMode ?? '';
      document.getElementById('toggleVisibility').value = config.keyboardShortcuts?.toggleVisibility ?? '';
      document.getElementById('forceRecalculateBounties').value = config.keyboardShortcuts?.forceRecalculateBounties ?? '';
      document.getElementById('openSettings').value = config.keyboardShortcuts?.openSettings ?? '';
    });
  </script>
</body>
</html>`;
}
