import { BrowserWindow, globalShortcut } from 'electron';
import { OverlayController, OVERLAY_WINDOW_OPTS } from '../../';
import { OCRData, KeyboardShortcuts, Regions } from '../config/types';
import { RegionManager } from './region-manager';
import { OCRProcessor } from '../core/ocr-processor';
import { generateOverlayHTML } from './html-generator';
import { formatSteps } from '../utils/formatting';
import { WINDOW_TITLE } from '../config/constants';
import { createSettingsWindow } from './settings-window';

// Default shortcuts (used as fallback)
const DEFAULT_SHORTCUTS: KeyboardShortcuts = {
  forceRecalculateBounties: 'CmdOrCtrl+N',
  openSettings: 'CmdOrCtrl+,',
  toggleEditMode: 'CmdOrCtrl+J',
  toggleVisibility: 'CmdOrCtrl+K',
};

export class OverlayWindow {
  window: BrowserWindow | undefined;
  private editMode = false;
  private shortcuts: KeyboardShortcuts;

  constructor(
    private regionManager: RegionManager,
    private ocrProcessor: OCRProcessor,
    shortcuts?: KeyboardShortcuts
  ) {
    this.shortcuts = shortcuts ?? DEFAULT_SHORTCUTS;
  }

  async create(): Promise<void> {
    console.log('[overlay] Creating overlay window...');
    this.window = new BrowserWindow({
      width: 10,
      height: 10,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
      ...OVERLAY_WINDOW_OPTS
    });

    const chatTitle = this.regionManager.regions.chatRegion.title;
    const regionElements = this.regionManager.generateRegionElementsHTML();
    const htmlContent = generateOverlayHTML(chatTitle, regionElements);

    this.window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);

    console.log('[overlay] Attaching to window:', WINDOW_TITLE);
    OverlayController.attachByTitle(this.window, WINDOW_TITLE, { hasTitleBarOnMac: false });
    console.log('[overlay] Attached, setting up shortcuts...');
    this.setupGlobalShortcuts();
    console.log('[overlay] Overlay window created successfully');

    this.window.on('blur', () => {
      // Don't automatically exit edit mode on blur
      // Edit mode should only be exited explicitly via toggle or when game window gets focus
      // The OverlayController 'focus' event handles when the game window gets focus
    });
  }

  // Called when the game window receives focus - exit edit mode
  exitEditMode(): void {
    if (this.editMode) {
      this.editMode = false;
      this.window?.webContents.send('edit-mode-change', false, this.getOCRDataPayload());
    }
  }

  private setupGlobalShortcuts(): void {
    globalShortcut.register(this.shortcuts.toggleEditMode, () => this.toggleEditMode());
    globalShortcut.register(this.shortcuts.toggleVisibility, () => {
      this.window?.webContents.send('visibility-change', false);
    });
    globalShortcut.register(this.shortcuts.forceRecalculateBounties, () => this.forceOptimalCalculation());
    globalShortcut.register(this.shortcuts.openSettings, () => {
      createSettingsWindow();
    });
  }

  private forceOptimalCalculation(): void {
    console.log('[optimal] Forcing optimal calculation with no pruning...');
    this.ocrProcessor.forceOptimalRecalculation();
  }

  private getOCRDataPayload(): OCRData {
    let status: 'computing' | 'optimal' | 'not-optimal' = 'not-optimal';

    if (this.ocrProcessor.inFlightFind) {
      status = 'computing';
    } else if (this.ocrProcessor.prevOptimalBounties.length > 0) {
      const activeBountyKeys = Object.values(this.ocrProcessor.activeBounties).sort().join(',');
      const optimalBountyKeys = this.ocrProcessor.prevOptimalBounties.slice().sort().join(',');
      status = activeBountyKeys === optimalBountyKeys ? 'optimal' : 'not-optimal';
    }

    // Show "Calculating..." when pathfinding is in progress and board is open
    const isCalculating = this.ocrProcessor.inFlightFind && this.ocrProcessor.prevBoardOpenSignature;
    let stepsText = isCalculating 
      ? 'Calculating...'
      : formatSteps(
          this.ocrProcessor.displaySteps.length > 0 ? this.ocrProcessor.displaySteps : this.ocrProcessor.steps,
          this.ocrProcessor.displayKp || this.ocrProcessor.kp,
          this.ocrProcessor.displayDistanceSeconds || this.ocrProcessor.distanceSeconds,
          this.ocrProcessor.runCompleted,
          this.ocrProcessor.runEndsWithTeleportToMarket
        );

    // If board is open and user has optimal bounties, add confirmation message
    const shouldShowOptimalMessage = this.ocrProcessor.prevBoardOpenSignature && status === 'optimal' && !isCalculating;
    console.log(`[optimal-message] boardOpen=${this.ocrProcessor.prevBoardOpenSignature}, status=${status}, isCalculating=${isCalculating}, shouldShow=${shouldShowOptimalMessage}`);
    
    if (shouldShowOptimalMessage) {
      console.log('[optimal-message] Adding "You have the optimal bounties" message');
      stepsText += '<br><br>You have the optimal bounties';
    }

    return {
      steps: stepsText,
      activeDrops: this.ocrProcessor.activeDrops,
      boardPickups: this.ocrProcessor.boardPickups,
      activeBountyIndices: Object.keys(this.ocrProcessor.activeBounties).map(Number),
      boardBountyIndices: Object.keys(this.ocrProcessor.boardBounties).map(Number),
      activeBounties: this.ocrProcessor.activeBounties,
      boardBounties: this.ocrProcessor.boardBounties,
      rawOcrText: this.ocrProcessor.rawOcrText,
      matchTypes: this.ocrProcessor.matchTypes,
      fuzzyDebug: this.ocrProcessor.fuzzyDebug,
      optimalBounties: this.ocrProcessor.prevOptimalBounties.slice(),
      status,
      boardOpen: this.ocrProcessor.prevBoardOpenSignature,
      sessionStats: {
        totalKpEarned: this.ocrProcessor.getSessionStats().totalKpEarned,
        sessionDurationSeconds: (Date.now() - this.ocrProcessor.getSessionStats().sessionStartTime) / 1000,
        totalBountiesCompleted: this.ocrProcessor.getSessionStats().totalBountiesCompleted,
      }
    };
  }

  toggleEditMode(): void {
    this.editMode = !this.editMode;
    this.window?.webContents.send('edit-mode-change', this.editMode, this.getOCRDataPayload());
    
    if (this.editMode) {
      // Enable mouse events on overlay and ensure it's visible
      // Use a delay to let any click events on other windows complete first
      setTimeout(() => {
        if (this.window && !this.window.isDestroyed()) {
          // Ensure overlay is visible and can receive mouse events
          this.window.showInactive();
          this.window.setIgnoreMouseEvents(false);
          this.window.setAlwaysOnTop(true, 'screen-saver');
          this.window.focus();
        }
      }, 100);
    } else {
      // Return focus to game and disable mouse events
      if (this.window && !this.window.isDestroyed()) {
        this.window.setIgnoreMouseEvents(true);
      }
      OverlayController.focusTarget();
    }
  }

  isEditMode(): boolean {
    return this.editMode;
  }

  updateRegions(regions: Regions): void {
    // Update the region manager
    Object.assign(this.regionManager.regions, regions);
    // Send to renderer to update DOM
    this.window?.webContents.send('regions-update', regions);
  }

  updateChatFontSize(fontSize: number): void {
    // Send to renderer to update chat font size
    this.window?.webContents.send('chat-font-size-update', fontSize);
  }
}
