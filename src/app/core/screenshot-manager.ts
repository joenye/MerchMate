import { nativeImage } from 'electron';
import { OverlayController } from '../../';
import { Regions, OCRData } from '../config/types';
import { OCRProcessor } from './ocr-processor';
import { PerfWindow, nowMsHiRes } from '../utils/perf';
import { sleep } from '../utils/async';
import { formatSteps } from '../utils/formatting';
import { SCREENSHOT_INTERVAL_MS, BOARD_CHECK_INTERVAL_MS, ACTIVE_BOUNTY_INTERVAL_MS } from '../config/constants';

export class ScreenshotManager {
  private stopped = false;
  private readonly perf: PerfWindow;
  private lastActiveBountyCheck = 0;

  constructor(
    private ocrProcessor: OCRProcessor,
    private regions: Regions,
    private onOCRUpdate?: (ocrData: OCRData) => void,
    private options?: { perfWindowSec?: number }
  ) {
    this.perf = new PerfWindow(Math.max(5, options?.perfWindowSec ?? 30) * 1000);
  }

  start(): void {
    this.stopped = false;

    const loop = async () => {
      while (!this.stopped) {
        // Skip entire tick while pathfinding is in progress
        if (this.ocrProcessor.isPathfinding()) {
          await sleep(50);
          continue;
        }

        const tickStartWall = Date.now();
        const tickStart = nowMsHiRes();
        const boardWasOpen = this.ocrProcessor.prevBoardOpenSignature;

        try {
          const t0 = nowMsHiRes();
          const screenshotBuffer = OverlayController.screenshot();
          this.perf.add('screenshot_capture', nowMsHiRes() - t0);

          if (screenshotBuffer && screenshotBuffer.length > 0) {
            const w = OverlayController.targetBounds.width;
            const h = OverlayController.targetBounds.height;

            const screenshotImage = nativeImage.createFromBuffer(screenshotBuffer, { width: w, height: h });

            const e0 = nowMsHiRes();
            const jpegBuffer = screenshotImage.toJPEG(80);
            this.perf.add('encode_jpeg', nowMsHiRes() - e0);

            // Determine OCR mode based on board state
            const now = Date.now();
            const shouldCheckActiveBounties = (now - this.lastActiveBountyCheck) >= ACTIVE_BOUNTY_INTERVAL_MS;
            
            if (boardWasOpen) {
              // Board is open - do full OCR
              await this.ocrProcessor.processScreenshot(jpegBuffer, w, h, this.regions, 'full');
              this.lastActiveBountyCheck = now;
            } else if (shouldCheckActiveBounties) {
              // Board closed, time for active bounty check
              await this.ocrProcessor.processScreenshot(jpegBuffer, w, h, this.regions, 'active');
              this.lastActiveBountyCheck = now;
            } else {
              // Board closed, just check if board opened
              await this.ocrProcessor.processScreenshot(jpegBuffer, w, h, this.regions, 'title-only');
            }

            // If board just opened, immediately do a full OCR to get board bounties
            const boardIsNowOpen = this.ocrProcessor.prevBoardOpenSignature;
            if (!boardWasOpen && boardIsNowOpen) {
              // Board just opened - immediately run full OCR
              const screenshotBuffer2 = OverlayController.screenshot();
              if (screenshotBuffer2 && screenshotBuffer2.length > 0) {
                const screenshotImage2 = nativeImage.createFromBuffer(screenshotBuffer2, { width: w, height: h });
                const jpegBuffer2 = screenshotImage2.toJPEG(80);
                await this.ocrProcessor.processScreenshot(jpegBuffer2, w, h, this.regions, 'full');
                this.lastActiveBountyCheck = Date.now();
              }
            }

            if (this.onOCRUpdate) {
              this.onOCRUpdate(this.buildOCRData());
            }
          }
        } catch (error) {
          console.error("Error taking screenshot / OCR:", error);
        } finally {
          this.perf.add('tick_total', nowMsHiRes() - tickStart);
          this.perf.maybeLog('[perf][screenshot]');
        }

        const elapsedWall = Date.now() - tickStartWall;
        const boardIsOpen = this.ocrProcessor.prevBoardOpenSignature;
        
        // Use different intervals based on board state
        const targetInterval = boardIsOpen ? SCREENSHOT_INTERVAL_MS : BOARD_CHECK_INTERVAL_MS;
        const delay = Math.max(0, targetInterval - elapsedWall);
        await sleep(delay);
      }
    };

    void loop();
  }

  stop(): void {
    this.stopped = true;
  }

  getPerfStats() {
    return this.perf.getStats();
  }

  private buildOCRData(): OCRData {
    let status: 'computing' | 'optimal' | 'not-optimal' = 'not-optimal';

    if (this.ocrProcessor.inFlightFind) {
      status = 'computing';
    } else if (this.ocrProcessor.prevOptimalBounties.length > 0) {
      const activeBountyKeys = Object.values(this.ocrProcessor.activeBounties).sort().join(',');
      const optimalBountyKeys = this.ocrProcessor.prevOptimalBounties.slice().sort().join(',');
      status = activeBountyKeys === optimalBountyKeys ? 'optimal' : 'not-optimal';
    }

    const stepsText = formatSteps(
      this.ocrProcessor.displaySteps.length > 0 ? this.ocrProcessor.displaySteps : this.ocrProcessor.steps,
      this.ocrProcessor.displayKp || this.ocrProcessor.kp,
      this.ocrProcessor.displayDistanceSeconds || this.ocrProcessor.distanceSeconds,
      this.ocrProcessor.runCompleted,
      this.ocrProcessor.runEndsWithTeleportToMarket
    );

    return {
      steps: stepsText,
      activeDrops: this.ocrProcessor.activeDrops,
      boardPickups: this.ocrProcessor.boardPickups,
      activeBountyIndices: Object.keys(this.ocrProcessor.activeBounties).map(Number),
      boardBountyIndices: Object.keys(this.ocrProcessor.boardBounties).map(Number),
      activeBounties: { ...this.ocrProcessor.activeBounties },
      boardBounties: { ...this.ocrProcessor.boardBounties },
      activeBountyRarities: { ...this.ocrProcessor.activeBountyRarities },
      boardBountyRarities: { ...this.ocrProcessor.boardBountyRarities },
      rawOcrText: { ...this.ocrProcessor.rawOcrText },
      matchTypes: { ...this.ocrProcessor.matchTypes },
      fuzzyDebug: { ...this.ocrProcessor.fuzzyDebug },
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
}
