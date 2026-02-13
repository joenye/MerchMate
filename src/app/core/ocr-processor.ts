import { Region, Regions, FindBestArgs, FindBestResult, Step } from '../config/types';
import { BOUNTY_NAMES } from '../config/constants';
import { resolveBountyKeyFromName } from '../utils/bounty-resolver';
import { fuzzyMatchBounty, fuzzyMatchBountyWithDebug } from '../utils/fuzzy-bounty-matcher';
import { execTesseractFromBuffer } from '../utils/tesseract';
import { mapWithConcurrency } from '../utils/async';
import { PerfWindow, nowMsHiRes, fmtMs } from '../utils/perf';
import { PathfinderUtilityPool } from '../workers/pathfinder-utility';
import { SessionTracker } from './session-tracker';

const sharp = require('sharp') as typeof import('sharp');

interface InFlightFind {
  signature: string;
  startedAtMs: number;
  promise: Promise<void>;
}

interface OCRProcessorOptions {
  concurrency?: number;
  scale?: number;
  ocrMethod?: 'native' | 'tesseract-js' | 'auto';
  perfWindowSec?: number;
  warnFindBestMs?: number;
  warnTickMs?: number;
  pathfinderTimeoutMs?: number;
  dropGraceMs?: number;
  detectiveLevel: number;
  battleOfFortuneholdCompleted: boolean;
  /** Pathfinding quality: 1 = heavy pruning, 5 = no pruning. Default: 5 */
  pathfindingQuality?: number;
}

export class OCRProcessor {
  // Detected bounties
  public activeBounties: { [index: number]: string } = {};
  public boardBounties: { [index: number]: string } = {};
  
  // Bounty rarity tracking (uncommon, rare, epic) - separate for active and board
  public activeBountyRarities: { [index: number]: 'uncommon' | 'rare' | 'epic' | null } = {};
  public boardBountyRarities: { [index: number]: 'uncommon' | 'rare' | 'epic' | null } = {};
  
  // Raw OCR text for debugging
  public rawOcrText: { [key: string]: string } = {};
  
  // Match type tracking for debugging (exact vs fuzzy)
  public matchTypes: { [key: string]: 'exact' | 'fuzzy' } = {};
  
  // Fuzzy match debug info (top 3 candidates with scores)
  public fuzzyDebug: { [key: string]: Array<{ bountyKey: string; score: number; nameScore: number; fromScore: number; toScore: number; positionBonus: number }> } = {};
  
  // UI indicators
  public activeDrops: number[] = [];
  public boardPickups: number[] = [];
  
  // Current optimal solution
  public steps: Step[] = [];
  public kp: number = 0;
  public distanceSeconds: number = NaN;
  
  // Display values (preserved after cache clear)
  public displaySteps: Step[] = [];
  public displayKp: number = 0;
  public displayDistanceSeconds: number = NaN;
  
  // Run completion state
  public runCompleted: boolean = false;
  public runEndsWithTeleportToMarket: boolean = false;

  // State tracking
  private stepIdx: number = 0;
  private prevActiveBounties: { [index: number]: string } = {};
  public prevOptimalBounties: string[] = [];
  private prevAllBountiesSignature: string = '';
  public prevBoardOpenSignature: boolean = false;
  
  // Processing state
  private processingScreenshot = false;
  public inFlightFind: InFlightFind | null = null;
  private launchedAtLeastOnce = false;
  
  // Timer tracking
  public runStartTime: number = 0;
  public actualRunTimeSeconds: number = 0;
  private runBounties: string[] = [];
  private runEstimatedTime: number = 0;
  
  // Grace period for new bounties
  private readonly dropGraceMs: number;
  private recentActiveAdds = new Map<number, number>();
  
  // Consistency check interval
  private lastConsistencyCheck: number = 0;
  private readonly consistencyCheckIntervalMs: number = 30000; // Increased to 30 seconds
  
  // Debounced recalculation when adjusting bounties with board open
  private adjustmentDebounceTimer: NodeJS.Timeout | null = null;
  private readonly adjustmentDebounceMs: number = 500; // 2 second debounce
  
  // Configuration
  private readonly concurrency: number;
  private readonly scale: number;
  private readonly ocrMethod: 'native' | 'tesseract-js' | 'auto';
  private readonly perf: PerfWindow;
  private readonly warnFindBestMs: number;
  private readonly warnTickMs: number;
  private readonly pathfinderTimeoutMs: number;
  private readonly pathfinderPool: PathfinderUtilityPool;
  private detectiveLevel: number;
  private battleOfFortuneholdCompleted: boolean;
  private pathfindingQuality: number;
  
  // Session tracking
  private readonly sessionTracker: SessionTracker;
  
  // Force optimal flag
  private forceOptimal: boolean = false;

  constructor(options: OCRProcessorOptions) {
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.scale = options.scale ?? 1.0;
    this.ocrMethod = options.ocrMethod ?? 'native';
    this.perf = new PerfWindow(Math.max(5, options.perfWindowSec ?? 30) * 1000);
    this.warnFindBestMs = options.warnFindBestMs ?? 250;
    this.warnTickMs = options.warnTickMs ?? 3000;
    this.pathfinderTimeoutMs = options.pathfinderTimeoutMs ?? 20000;
    this.dropGraceMs = Math.max(0, options.dropGraceMs ?? 2000);
    this.detectiveLevel = options.detectiveLevel;
    this.battleOfFortuneholdCompleted = options.battleOfFortuneholdCompleted;
    this.pathfindingQuality = options.pathfindingQuality ?? 5;
    
    this.sessionTracker = new SessionTracker();

    // Use utility process pool for better V8 JIT performance
    this.pathfinderPool = new PathfinderUtilityPool();
    this.pathfinderPool.setConfig(this.detectiveLevel, this.battleOfFortuneholdCompleted);
  }

  async shutdown(): Promise<void> {
    await this.pathfinderPool.terminate();
    // Import and call shutdown function from tesseract utils
    const { shutdownTesseract } = await import('../utils/tesseract');
    await shutdownTesseract();
  }

  /**
   * Warm up the pathfinder worker pool
   * Call this at app startup to avoid cold start latency
   */
  async warmup(): Promise<void> {
    await this.pathfinderPool.warmup();
  }

  getSessionStats() {
    return this.sessionTracker.getStats();
  }

  getPerfStats() {
    return this.perf.getStats();
  }

  setPathfindingQuality(quality: number): void {
    const oldQuality = this.pathfindingQuality;
    this.pathfindingQuality = Math.max(1, Math.min(5, quality));
    if (oldQuality !== this.pathfindingQuality) {
      console.log(`[config] Pathfinding quality changed: ${oldQuality} -> ${this.pathfindingQuality}`);
    }
  }

  setDetectiveLevel(level: number): void {
    const oldLevel = this.detectiveLevel;
    this.detectiveLevel = Math.max(1, Math.min(500, level));
    if (oldLevel !== this.detectiveLevel) {
      console.log(`[config] Detective level changed: ${oldLevel} -> ${this.detectiveLevel}`);
      this.pathfinderPool.setConfig(this.detectiveLevel, this.battleOfFortuneholdCompleted);
    }
  }

  setBattleOfFortuneholdCompleted(completed: boolean): void {
    const oldValue = this.battleOfFortuneholdCompleted;
    this.battleOfFortuneholdCompleted = completed;
    if (oldValue !== this.battleOfFortuneholdCompleted) {
      console.log(`[config] Battle of Fortunehold completed changed: ${oldValue} -> ${this.battleOfFortuneholdCompleted}`);
      this.pathfinderPool.setConfig(this.detectiveLevel, this.battleOfFortuneholdCompleted);
    }
  }

  forceOptimalRecalculation(): void {
    // If there's already a pathfinding in progress, wait for it to complete
    if (this.inFlightFind) {
      console.log('[optimal] Waiting for current pathfinding to complete before force recalculation...');
      this.inFlightFind.promise.finally(() => {
        this.doForceOptimalRecalculation();
      });
      return;
    }
    this.doForceOptimalRecalculation();
  }

  private doForceOptimalRecalculation(): void {
    this.forceOptimal = true;
    console.log('[optimal] Clearing cached solution for forced recalculation');
    this.prevOptimalBounties = [];
    this.kp = 0;
    this.distanceSeconds = NaN;

    const allBounties = [...Object.values(this.activeBounties), ...Object.values(this.boardBounties)];
    if (allBounties.length > 0) {
      const signature = this.makeAllBountiesSignature(allBounties);
      const boardOpen = this.prevBoardOpenSignature;
      this.launchFindBestIfNeeded(allBounties, boardOpen, signature, 'forceOptimal');
    } else {
      console.log('[optimal] No bounties available to recalculate');
      this.forceOptimal = false;
    }
  }

  /**
   * Check if pathfinding is currently in progress
   */
  isPathfinding(): boolean {
    return this.inFlightFind !== null;
  }

  async processScreenshot(
    encodedImageBuffer: Buffer,
    imageWidth: number,
    imageHeight: number,
    regions: Regions,
    mode: 'full' | 'active' | 'title-only' = 'full'
  ): Promise<void> {
    if (this.processingScreenshot) return;
    this.processingScreenshot = true;

    const tickT0 = nowMsHiRes();

    try {
      const scaledWidth = Math.max(1, Math.round(imageWidth * this.scale));
      const scaledHeight = Math.max(1, Math.round(imageHeight * this.scale));

      let base = sharp(encodedImageBuffer);
      if (this.scale !== 1.0) {
        base = base.resize(scaledWidth, scaledHeight);
      }

      // Title OCR - always do this to detect board open state
      const titleKey = "bountyBoardTitleRegion";
      const titleT0 = nowMsHiRes();
      const titleResult = regions[titleKey]
        ? await this.recognizeRegion(base, regions[titleKey], scaledWidth, scaledHeight)
        : { text: "" };
      this.perf.add('title_ocr', nowMsHiRes() - titleT0);

      const boardOpen = titleResult.text.includes("TIES");

      // If title-only mode, just update board state and return (don't process bounty results)
      if (mode === 'title-only') {
        // Only update the board open signature, don't touch bounty data
        if (boardOpen !== this.prevBoardOpenSignature) {
          // Reset run completed flag when board opens
          if (boardOpen && this.runCompleted) {
            this.runCompleted = false;
            this.displaySteps = [];
            this.displayKp = 0;
            this.displayDistanceSeconds = NaN;
          }
          this.prevBoardOpenSignature = boardOpen;
        }
        return;
      }

      const activeKeys = Object.keys(regions).filter(k => k.startsWith("activeBountyRegion"));
      const boardKeys = Object.keys(regions).filter(k => k.startsWith("boardRegion"));

      // Determine which regions to OCR based on mode
      let keysToOCR: string[];
      if (mode === 'active') {
        // Active mode - only active bounty regions
        keysToOCR = activeKeys;
      } else {
        // Full mode - active regions + board regions if board is open
        keysToOCR = [
          ...activeKeys,
          ...(boardOpen ? boardKeys : [])
        ];
      }

      const restT0 = nowMsHiRes();
      const regionResults = await mapWithConcurrency(keysToOCR, this.concurrency, async (key) => {
        const region = regions[key];
        // Mark bounty regions for rarity detection
        const regionWithRarity = { ...region, detectRarity: key.startsWith('activeBountyRegion') || key.startsWith('boardRegion') };
        const res = await this.recognizeRegion(base, regionWithRarity, scaledWidth, scaledHeight);
        return { key, text: res.text, rarity: res.rarity };
      });
      this.perf.add('rest_ocr', nowMsHiRes() - restT0);

      const pr0 = nowMsHiRes();
      await this.processOCRResultsAsync([{ key: titleKey, text: titleResult.text }, ...regionResults], boardOpen);
      this.perf.add('process_results_total', nowMsHiRes() - pr0);

    } finally {
      const tickDt = nowMsHiRes() - tickT0;
      this.perf.add('tick_total', tickDt);
      if (tickDt >= this.warnTickMs) {
        console.warn(`[perf] tick slow: ${fmtMs(tickDt)} (ocrConcurrency=${this.concurrency}, scale=${this.scale})`);
      }
      this.perf.maybeLog('[perf]');
      this.processingScreenshot = false;
    }
  }

  private clampRect(left: number, top: number, width: number, height: number, maxW: number, maxH: number) {
    let l = Math.max(0, Math.min(left, maxW - 1));
    let t = Math.max(0, Math.min(top, maxH - 1));
    let w = Math.max(1, width);
    let h = Math.max(1, height);
    if (l + w > maxW) w = Math.max(1, maxW - l);
    if (t + h > maxH) h = Math.max(1, maxH - t);
    return { left: l, top: t, width: w, height: h };
  }

  /**
   * Detect bounty rarity based on OCR text
   * Returns 'uncommon' (2x), 'rare' (3x), 'epic' (4x), or null (1x)
   */
  private detectBountyRarityFromText(text: string): 'uncommon' | 'rare' | 'epic' | null {
    const textLower = text.toLowerCase();
    
    if (textLower.includes('epic')) {
      return 'epic'; // 4x multiplier
    }
    
    if (textLower.includes('rare')) {
      return 'rare'; // 3x multiplier
    }
    
    if (textLower.includes('uncommon')) {
      return 'uncommon'; // 2x multiplier
    }
    
    return null; // Normal bounty (1x multiplier)
  }

  private async recognizeRegion(
    base: import('sharp').Sharp,
    region: Region,
    scaledImageWidth: number,
    scaledImageHeight: number
  ): Promise<{ text: string; rarity?: 'uncommon' | 'rare' | 'epic' | null }> {
    let left = Math.round(region.x * this.scale);
    let top = Math.round(region.y * this.scale);
    let width = Math.round(region.width * this.scale);
    let height = Math.round(region.height * this.scale);

    // Handle DPI scaling on Windows
    if (process.platform === 'win32') {
      // Get the DPI scale factor from Electron
      const { screen } = require('electron');
      const { OverlayController } = require('../../');
      
      // Calculate scale factor from physical to DIP coordinates
      const physicalBounds = OverlayController.targetBounds;
      const dipBounds = screen.screenToDipRect(null, physicalBounds);
      const dpiScaleFactor = physicalBounds.width / dipBounds.width;
      
      // Scale region coordinates to match physical screenshot
      left = Math.round(left * dpiScaleFactor);
      top = Math.round(top * dpiScaleFactor);
      width = Math.round(width * dpiScaleFactor);
      height = Math.round(height * dpiScaleFactor);
    }

    const rect = this.clampRect(left, top, width, height, scaledImageWidth, scaledImageHeight);

    const croppedBuffer = await base
      .clone()
      .extract({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
      .png()
      .toBuffer();

    const text = await execTesseractFromBuffer(croppedBuffer, this.ocrMethod);
    const cleanText = text.replace(/\s/g, "");
    
    // Detect rarity for bounty regions (not title region)
    let rarity: 'uncommon' | 'rare' | 'epic' | null = null;
    if (region && (region as any).detectRarity) {
      rarity = this.detectBountyRarityFromText(text);
    }
    
    return { text: cleanText, rarity };
  }

  private makeAllBountiesSignature(allBounties: string[]): string {
    return allBounties.slice().sort().join('|');
  }

  private async computeFindBest(
    allBounties: string[],
    boardOpen: boolean,
    signature: string
  ): Promise<FindBestResult> {
    // Map quality level (1-5) to pruning options
    // Level 1: Heavy pruning (100 combos, 0.90 threshold)
    // Level 2: Moderate pruning (200 combos, 0.92 threshold)
    // Level 3: Default (400 combos, 0.95 threshold)
    // Level 4: Light pruning (800 combos, 0.98 threshold)
    // Level 5: No pruning (all combos)
    const qualitySettings: Record<number, { maxCombinations: number; pruningThreshold: number }> = {
      1: { maxCombinations: 100, pruningThreshold: 0.90 },
      2: { maxCombinations: 200, pruningThreshold: 0.92 },
      3: { maxCombinations: 400, pruningThreshold: 0.95 },
      4: { maxCombinations: 800, pruningThreshold: 0.98 },
      5: { maxCombinations: Infinity, pruningThreshold: 1.0 },
    };

    const pruningOptions = this.forceOptimal
      ? { maxCombinations: Infinity, pruningThreshold: 1.0 }
      : qualitySettings[this.pathfindingQuality] ?? qualitySettings[5];

    // Convert index-based rarities to bounty-key-based rarities
    const bountyRarities: { [bountyKey: string]: 'uncommon' | 'rare' | 'epic' | null } = {};
    for (const [indexStr, bountyKey] of Object.entries(this.activeBounties)) {
      const index = Number(indexStr);
      if (this.activeBountyRarities[index]) {
        bountyRarities[bountyKey] = this.activeBountyRarities[index];
      }
    }
    for (const [indexStr, bountyKey] of Object.entries(this.boardBounties)) {
      const index = Number(indexStr);
      if (this.boardBountyRarities[index]) {
        bountyRarities[bountyKey] = this.boardBountyRarities[index];
      }
    }

    const args: FindBestArgs = {
      allBounties,
      detectiveLevel: this.detectiveLevel,
      battleOfFortuneholdCompleted: this.battleOfFortuneholdCompleted,
      bountyRarities,
      pruningOptions
    };
    const fb0 = nowMsHiRes();

    try {
      const res = await this.pathfinderPool.findBest(args, this.pathfinderTimeoutMs);

      const dt = nowMsHiRes() - fb0;
      this.perf.add('find_best_bounties', dt);

      if (dt >= this.warnFindBestMs) {
        console.warn(`[perf] findBestBounties slow: ${fmtMs(dt)} boardOpen=${boardOpen} sig='${signature}' allBounties=${allBounties.length}`);
      }

      if (this.forceOptimal) {
        console.log(`[optimal] Optimal calculation completed in ${fmtMs(dt)}`);
        this.forceOptimal = false;
      }

      return res;
    } catch (e: any) {
      const dt = nowMsHiRes() - fb0;
      this.perf.add('find_best_bounties', dt);
      console.error(`[perf] findBestBounties FAILED after ${fmtMs(dt)} boardOpen=${boardOpen} sig='${signature}':`, e?.stack ?? e);
      this.forceOptimal = false;
      throw e;
    }
  }

  private launchFindBestIfNeeded(
    allBounties: string[],
    boardOpen: boolean,
    signature: string,
    reason: string
  ): void {
    if (this.inFlightFind && this.inFlightFind.signature === signature) return;

    if (this.inFlightFind) {
      const ageMs = Date.now() - this.inFlightFind.startedAtMs;
      if (ageMs > this.pathfinderTimeoutMs + 1000) {
        console.warn(`[perf] in-flight findBest stale (${ageMs}ms). Clearing and retrying. prevSig='${this.inFlightFind.signature}' newSig='${signature}'`);
        this.inFlightFind = null;
      } else {
        return;
      }
    }

    this.launchedAtLeastOnce = true;

    const startedAtMs = Date.now();
    console.log(`[perf] recompute optimal: reason=${reason} boardOpen=${boardOpen} all=${allBounties.length} sig='${signature}'`);

    const promise = (async () => {
      try {
        const optimalResp = await this.computeFindBest(allBounties, boardOpen, signature);

        const newEfficiency = optimalResp.kp / optimalResp.distance;
        const currentEfficiency = this.prevOptimalBounties.length > 0 && this.distanceSeconds > 0
          ? this.kp / this.distanceSeconds
          : 0;

        if (currentEfficiency === 0 || newEfficiency > currentEfficiency) {
          const improvement = newEfficiency - currentEfficiency;
          console.log(`[optimal] Accepting new solution: KP/D=${newEfficiency.toFixed(4)} (prev=${currentEfficiency.toFixed(4)}, improvement=${improvement.toFixed(4)})`);

          this.prevOptimalBounties = optimalResp.bounties;
          this.kp = optimalResp.kp;
          this.distanceSeconds = optimalResp.distance;
          
          // Only update display values if run is not completed
          // This preserves the metrics for the "run completed" message
          if (!this.runCompleted) {
            this.displayKp = optimalResp.kp;
            this.displayDistanceSeconds = optimalResp.distance;
          }

          if (this.stepIdx > 0 && optimalResp.actions.length > 0) {
            const currentlyHaveItems = new Set<string>();
            for (const bountyKey of Object.values(this.activeBounties)) {
              currentlyHaveItems.add(bountyKey);
            }

            const filteredSteps = [];
            for (const step of optimalResp.actions) {
              const s = step as any;
              if (s?.type === 'buy' && currentlyHaveItems.has(s.item)) {
                continue;
              }
              filteredSteps.push(step);
              if (s?.type === 'buy') {
                currentlyHaveItems.add(s.item);
              } else if (s?.type === 'sell') {
                currentlyHaveItems.delete(s.item);
              }
            }

            this.steps = filteredSteps;
            this.stepIdx = 0;
            // Only update displaySteps if run is not completed
            if (!this.runCompleted) {
              this.displaySteps = filteredSteps;
            }
          } else {
            this.steps = optimalResp.actions;
            // Only update displaySteps if run is not completed
            if (!this.runCompleted) {
              this.displaySteps = optimalResp.actions;
            }
          }
        } else {
          const difference = newEfficiency - currentEfficiency;
          console.log(`[optimal] Rejecting new solution: KP/D=${newEfficiency.toFixed(4)} not better than current=${currentEfficiency.toFixed(4)} (difference=${difference.toFixed(4)})`);
        }

        this.prevAllBountiesSignature = signature;
      } catch {
        // keep previous state
      } finally {
        if (this.inFlightFind?.signature === signature) this.inFlightFind = null;
      }
    })();

    this.inFlightFind = { signature, startedAtMs, promise };
  }

  private async processOCRResultsAsync(
    results: { key: string, text: string, rarity?: 'uncommon' | 'rare' | 'epic' | null }[],
    boardOpen: boolean
  ): Promise<void> {
    const detectedActive: { [index: number]: string } = {};
    const detectedBoard: { [index: number]: string } = {};
    const detectedActiveRarities: { [index: number]: 'uncommon' | 'rare' | 'epic' | null } = {};
    const detectedBoardRarities: { [index: number]: 'uncommon' | 'rare' | 'epic' | null } = {};

    // Store raw OCR text for debugging
    this.rawOcrText = {};
    this.matchTypes = {};
    for (const { key, text } of results) {
      this.rawOcrText[key] = text;
    }

    for (const { key, text, rarity } of results) {
      if (!text) continue;
      if (key === "bountyBoardTitleRegion") continue;

      // Try strict matching first, but only if the bounty name appears early in the text
      // This prevents false matches like "Soap" appearing in "SoapStall" at the end
      let bountyKey: string | null = null;
      let matchType: 'exact' | 'fuzzy' = 'exact';
      
      // Always get fuzzy match debug info for display
      const fuzzyResult = fuzzyMatchBountyWithDebug(text);
      
      // Normalize text for case-insensitive matching
      const textLower = text.toLowerCase();
      
      // Sort bounty names by length (longest first) to match more specific names first
      // This prevents "Painting" from matching before "PortraitPainting"
      const sortedBountyNames = Array.from(BOUNTY_NAMES).sort((a, b) => b.length - a.length);
      
      for (const bountyName of sortedBountyNames) {
        const bountyNameLower = bountyName.toLowerCase();
        if (textLower.includes(bountyNameLower) && textLower.includes("6")) {
          // Check if the bounty name appears in the first 40% of the text
          const nameIndex = textLower.indexOf(bountyNameLower);
          const relativePosition = nameIndex / textLower.length;
          
          if (relativePosition < 0.4) {
            // Name appears early - likely the actual bounty name
            bountyKey = resolveBountyKeyFromName(bountyName);
            matchType = 'exact';
            break;
          }
        }
      }
      
      // If strict matching fails, use fuzzy matching result
      if (!bountyKey) {
        bountyKey = fuzzyResult.bountyKey;
        if (bountyKey) {
          matchType = 'fuzzy';
        }
      }
      
      // Always store fuzzy debug info for UI display
      if (fuzzyResult.topMatches.length > 0) {
        this.fuzzyDebug[key] = fuzzyResult.topMatches;
      }
      
      if (bountyKey) {
        this.matchTypes[key] = matchType;
        if (key.startsWith("activeBountyRegion")) {
          const index = parseInt(key.replace("activeBountyRegion", ""), 10);
          detectedActive[index] = bountyKey;
          detectedActiveRarities[index] = rarity || null;
        } else if (key.startsWith("boardRegion")) {
          const index = parseInt(key.replace("boardRegion", ""), 10);
          detectedBoard[index] = bountyKey;
          detectedBoardRarities[index] = rarity || null;
        }
      }
    }
    
    // Store previous rarities before updating (needed for bounty completion detection)
    const prevActiveRarities = { ...this.activeBountyRarities };
    
    // Update bounty rarities separately for active and board
    this.activeBountyRarities = detectedActiveRarities;
    this.boardBountyRarities = detectedBoardRarities;

    // Track newly-added active bounties
    const now = Date.now();
    const prevActiveIndices = new Set(Object.keys(this.prevActiveBounties).map(Number));
    const currActiveIndices = Object.keys(detectedActive).map(Number);

    for (const idx of currActiveIndices) {
      if (!prevActiveIndices.has(idx)) {
        this.recentActiveAdds.set(idx, now + this.dropGraceMs);
      }
    }
    for (const [idx, expiresAt] of this.recentActiveAdds.entries()) {
      if (expiresAt <= now) this.recentActiveAdds.delete(idx);
      else if (!(idx in detectedActive)) this.recentActiveAdds.delete(idx);
    }

    const allBounties = [...Object.values(detectedActive), ...Object.values(detectedBoard)];
    const signature = this.makeAllBountiesSignature(allBounties);

    const boardTransition = boardOpen !== this.prevBoardOpenSignature;
    const signatureChanged = signature !== this.prevAllBountiesSignature;

    const firstRun = !this.launchedAtLeastOnce;

    // Reset run completed flag and clear display values when board opens
    if (boardTransition && boardOpen) {
      this.runCompleted = false;
      // Clear display values so old run info doesn't persist
      this.displaySteps = [];
      this.displayKp = 0;
      this.displayDistanceSeconds = NaN;
    }

    // Timer management
    if (boardTransition && !boardOpen && this.prevBoardOpenSignature) {
      this.runStartTime = Date.now();
      this.actualRunTimeSeconds = 0;
      this.runBounties = [...this.prevOptimalBounties];
      this.runEstimatedTime = this.distanceSeconds;
      console.log('[timer] Run started - board closed');
      
      // When board closes, recalculate route based on actual active bounties only
      // This ensures we don't show DROP indicators for bounties the user chose to keep
      const activeBountyList = Object.values(detectedActive);
      if (activeBountyList.length > 0) {
        const activeSignature = this.makeAllBountiesSignature(activeBountyList);
        const optimalSignature = this.makeAllBountiesSignature(this.prevOptimalBounties);
        
        if (activeSignature !== optimalSignature) {
          console.log('[optimal] Board closed with different bounties than optimal, recalculating for active bounties only');
          this.prevOptimalBounties = [];
          this.kp = 0;
          this.distanceSeconds = NaN;
          this.steps = [];
          this.displaySteps = [];
          this.launchFindBestIfNeeded(activeBountyList, false, activeSignature, 'boardClosedRecalc');
        }
      }
    }

    // Update board bounties early so we can use them for change detection
    // Persist board bounties to prevent ACCEPT flickering from OCR failures
    let updatedBoard: { [index: number]: string };
    if (!boardOpen) {
      updatedBoard = {};
    } else {
      updatedBoard = { ...this.boardBounties };
      // Only update board bounties if:
      // 1. The slot was empty before (new detection)
      // 2. The detected bounty is different AND we have high confidence (exact match)
      for (const idx in detectedBoard) {
        const newBounty = detectedBoard[Number(idx)];
        const oldBounty = this.boardBounties[Number(idx)];
        const matchType = this.matchTypes[`boardRegion${idx}`];
        
        // Always update if slot was empty
        if (!oldBounty) {
          updatedBoard[Number(idx)] = newBounty;
        }
        // Only update if exact match (high confidence) or same bounty
        else if (matchType === 'exact' || newBounty === oldBounty) {
          updatedBoard[Number(idx)] = newBounty;
        }
        // Otherwise keep the old value (fuzzy match might be wrong)
      }
      
      // Clear slots that are no longer detected (bounty was accepted)
      // Compare detected vs persisted board bounty counts
      const prevBoardCount = Object.keys(this.boardBounties).length;
      const currBoardCount = Object.keys(detectedBoard).length;
      if (currBoardCount < prevBoardCount) {
        // Board count decreased - clear slots that aren't detected
        for (const idx in updatedBoard) {
          if (!(idx in detectedBoard)) {
            delete updatedBoard[Number(idx)];
          }
        }
        
        // User accepted a bounty, trigger debounced recalculation
        this.scheduleAdjustmentRecalculation();
      }
    }

    const prevActiveCount = Object.keys(this.prevActiveBounties).length;
    const currActiveCount = Object.keys(detectedActive).length;
    const addingBounties = currActiveCount > prevActiveCount;

    // Use updatedBoard for comparison to avoid false positives from OCR noise
    const prevBoardBounties = Object.values(this.boardBounties).sort().join(',');
    const currBoardBounties = Object.values(updatedBoard).sort().join(',');
    const boardBountiesChanged = boardOpen && prevBoardBounties !== currBoardBounties;

    const haveOptimal = this.prevOptimalBounties.length > 0;
    const activeBountyKeys = Object.values(detectedActive).sort().join(',');
    const optimalBountyKeys = this.prevOptimalBounties.slice().sort().join(',');
    const activeMatchesOptimal = activeBountyKeys === optimalBountyKeys;
    const adjustingBounties = haveOptimal && !activeMatchesOptimal && boardOpen;

    const shouldRecompute = (firstRun || boardTransition ||
                            (signatureChanged && boardBountiesChanged) ||
                            (signatureChanged && addingBounties && !adjustingBounties) ||
                            (activeMatchesOptimal && signatureChanged) ||
                            (boardOpen && !haveOptimal && allBounties.length > 0));

    if (shouldRecompute) {
      const reason = firstRun ? 'firstRun'
                   : boardTransition ? 'boardTransition'
                   : boardBountiesChanged ? 'boardRefresh'
                   : (boardOpen && !haveOptimal) ? 'boardOpenNoOptimal'
                   : activeMatchesOptimal ? 'readyForNext'
                   : 'addingBounties';

      if (firstRun || boardTransition) {
        this.stepIdx = 0;
      }

      this.launchFindBestIfNeeded(allBounties, boardOpen, signature, reason);
    }
    
    this.prevBoardOpenSignature = boardOpen;

    const hasOptimal = this.prevOptimalBounties.length > 0;
    if (!hasOptimal) {
      this.activeDrops = [];
      this.boardPickups = [];
      this.activeBounties = detectedActive;
      this.boardBounties = detectedBoard;
      this.prevActiveBounties = { ...detectedActive };
      return;
    }

    const optimalBounties = this.prevOptimalBounties;

    // Calculate activeDrops - only show DROP indicators when board is open
    const recomputeInFlight = !!this.inFlightFind;
    if (recomputeInFlight || !boardOpen) {
      // Don't show DROP indicators when:
      // 1. A recompute is in flight (state is uncertain)
      // 2. Board is closed (user can't drop bounties anyway, and optimal may include board bounties they didn't pick up)
      this.activeDrops = [];
    } else {
      const activeDrops: number[] = [];
      const bountyIndices: { [bounty: string]: number[] } = {};
      for (const idxStr in detectedActive) {
        const idx = Number(idxStr);
        const bounty = detectedActive[idx];

        if (!bountyIndices[bounty]) bountyIndices[bounty] = [];
        bountyIndices[bounty].push(idx);
      }

      for (const bounty in bountyIndices) {
        const indices = bountyIndices[bounty].sort((a, b) => a - b);
        const allowed = optimalBounties.filter(b => b === bounty).length;

        if (indices.length > allowed) {
          const extras = indices.slice(0, indices.length - allowed);
          for (const idx of extras) {
            const expiresAt = this.recentActiveAdds.get(idx);
            if (expiresAt && expiresAt > Date.now()) {
              continue;
            }
            activeDrops.push(idx);
          }
        }
      }

      this.activeDrops = activeDrops;
    }

    // Persist bounty knowledge to prevent flickering
    // Only update if we detect a bounty (add/change) or if slot is confirmed empty
    // This prevents OCR failures from causing eyes to flicker
    
    // Update active bounties - persist previous detections
    const updatedActive: { [index: number]: string } = { ...this.activeBounties };
    for (const idx in detectedActive) {
      updatedActive[Number(idx)] = detectedActive[Number(idx)];
    }
    
    // Clear slots when count decreased (bounty completed or dropped)
    if (currActiveCount < prevActiveCount) {
      // Keep only detected bounties when count decreased
      for (const idx in updatedActive) {
        if (!(idx in detectedActive)) {
          delete updatedActive[Number(idx)];
        }
      }
      
      // If board is open and user is adjusting bounties, trigger debounced recalculation
      if (boardOpen) {
        this.scheduleAdjustmentRecalculation();
      }
    }
    
    // Board bounties were already updated earlier for change detection

    // Handle bounty completion - use counts calculated before persistence
    let completedBounty: string | undefined;
    let completedBountyIndex: number | undefined;

    if (prevActiveCount > currActiveCount && (prevActiveCount - currActiveCount) === 1) {
      const prevBountyCounts = new Map<string, number>();
      const currBountyCounts = new Map<string, number>();

      for (const bounty of Object.values(this.prevActiveBounties)) {
        prevBountyCounts.set(bounty, (prevBountyCounts.get(bounty) || 0) + 1);
      }

      for (const bounty of Object.values(detectedActive)) {
        currBountyCounts.set(bounty, (currBountyCounts.get(bounty) || 0) + 1);
      }

      for (const [bounty, prevCount] of prevBountyCounts.entries()) {
        const currCount = currBountyCounts.get(bounty) || 0;
        if (currCount < prevCount) {
          completedBounty = bounty;
          // Find which index had this bounty
          for (const [idx, b] of Object.entries(this.prevActiveBounties)) {
            if (b === bounty && !(idx in detectedActive)) {
              completedBountyIndex = Number(idx);
              break;
            }
          }
          break;
        }
      }

      if (completedBounty) {
        // Only record completion and advance steps when board is closed
        // When board is open, user is just dropping bounties to adjust their selection
        if (!boardOpen) {
          // Get rarity multiplier for the completed bounty - use previous rarities since current ones don't include the completed bounty
          const rarity = completedBountyIndex !== undefined ? prevActiveRarities[completedBountyIndex] : null;
          const rarityMultiplier = rarity === 'epic' ? 4 : rarity === 'rare' ? 3 : rarity === 'uncommon' ? 2 : 1;
          
          this.sessionTracker.recordBountyCompletion(completedBounty, rarityMultiplier);

          let completedStepIdx = -1;
          for (let idx = 0; idx < this.steps.length; idx++) {
            const step = this.steps[idx] as any;
            if (step && step.type === "sell" && step.item === completedBounty) {
              completedStepIdx = idx;
              break;
            }
          }
          if (completedStepIdx !== -1) {
            this.stepIdx += completedStepIdx + 1;
            this.steps = this.steps.slice(completedStepIdx + 1);
            this.displaySteps = this.steps;
          }
          
          // Sanity check: verify all remaining active bounties have a sell in the remaining steps
          // This catches cases where OCR loses a bounty (e.g., misread or dropped) but we still have others
          const remainingActiveBounties = Object.values(detectedActive);
          if (remainingActiveBounties.length > 0) {
            const sellsInSteps = new Set<string>();
            for (const step of this.steps) {
              if ((step as any).type === 'sell') {
                sellsInSteps.add((step as any).item);
              }
            }
            
            const missingBounties = remainingActiveBounties.filter(b => !sellsInSteps.has(b));
            if (missingBounties.length > 0) {
              console.log(`[sanity] Remaining bounties missing from steps: ${missingBounties.join(', ')}. Triggering recalculation.`);
              const activeBountyList = remainingActiveBounties;
              const activeSignature = this.makeAllBountiesSignature(activeBountyList);
              this.prevOptimalBounties = [];
              this.kp = 0;
              this.distanceSeconds = NaN;
              this.steps = [];
              this.displaySteps = [];
              this.stepIdx = 0; // Reset stepIdx so new route includes BUY steps
              this.launchFindBestIfNeeded(activeBountyList, false, activeSignature, 'sanityCheckFailed');
            }
          }
        }
      }
    }

    // Check if all bounties completed
    if (currActiveCount === 0 && prevActiveCount > 0 && completedBounty) {
      const hasRunTiming = this.runStartTime > 0;
      if (hasRunTiming) {
        this.actualRunTimeSeconds = (Date.now() - this.runStartTime) / 1000;
        console.log(`[timer] All bounties completed! Actual time: ${this.actualRunTimeSeconds.toFixed(1)}s, Estimated: ${this.runEstimatedTime.toFixed(1)}s`);
        this.sessionTracker.recordRunCompletion(this.runBounties, this.actualRunTimeSeconds, this.runEstimatedTime);
      } else {
        console.log(`[timer] All bounties completed! (No timing data - run started before app launch)`);
      }

      // Check if route ended with teleport to market (for completion message)
      const stepsToCheck = this.displaySteps.length > 0 ? this.displaySteps : this.steps;
      this.runEndsWithTeleportToMarket = false;
      for (let i = stepsToCheck.length - 1; i >= 0; i--) {
        const step = stepsToCheck[i] as any;
        if (step?.type === 'return') continue; // Skip return step
        if (step?.type === 'teleport' && (step.location === 'Crenopolis Market' || step.location === 'Market')) {
          this.runEndsWithTeleportToMarket = true;
        }
        break; // Only check the last non-return step
      }

      console.log(`[optimal] Clearing cached solution to allow new bounties`);
      this.prevOptimalBounties = [];
      this.kp = 0;
      this.distanceSeconds = NaN;
      this.steps = [];
      // Don't clear displaySteps/displayKp/displayDistanceSeconds - preserve for "run completed" display
      this.runCompleted = true;
      this.runBounties = [];
      this.runEstimatedTime = 0;
    }

    this.activeBounties = updatedActive;
    this.boardBounties = updatedBoard;
    this.prevActiveBounties = { ...updatedActive };
    
    // Calculate boardPickups - use updatedBoard (persisted) instead of detectedBoard
    // This prevents ACCEPT flickering when OCR temporarily fails to detect board bounties
    if (boardOpen) {
      let boardPickups: number[] = [];
      const sortedBoardIndices = Object.keys(updatedBoard).map(Number).sort((a, b) => a - b);
      const pickupCount: { [bounty: string]: number } = {};
      for (const idx of sortedBoardIndices) {
        const bounty = updatedBoard[idx];

        if (optimalBounties.includes(bounty)) {
          const allowed = optimalBounties.filter(b => b === bounty).length;
          const activeCount = Object.values(updatedActive).filter(b => b === bounty).length;
          const current = pickupCount[bounty] || 0;
          if (activeCount + current < allowed) {
            boardPickups.push(idx);
            pickupCount[bounty] = current + 1;
          }
        }
      }
      this.boardPickups = boardPickups;
    } else {
      this.boardPickups = [];
    }
    
    this.activeBounties = updatedActive;
    this.boardBounties = updatedBoard;
    this.prevActiveBounties = { ...updatedActive };
    
    // Periodic consistency check: verify steps can complete active bounties
    await this.checkStepsConsistency(updatedActive, boardOpen);
  }
  
  /**
   * Verify that the current steps can feasibly complete all active bounties.
   * If not, trigger a recalculation.
   */
  private async checkStepsConsistency(
    activeBounties: { [index: number]: string },
    boardOpen: boolean
  ): Promise<void> {
    const now = Date.now();
    if (now - this.lastConsistencyCheck < this.consistencyCheckIntervalMs) {
      return;
    }
    this.lastConsistencyCheck = now;
    
    // Skip check if board is open (user is still adjusting bounties)
    if (boardOpen) {
      return;
    }
    
    // Skip if no active bounties
    const activeBountyList = Object.values(activeBounties);
    if (activeBountyList.length === 0) {
      return;
    }
    
    // Skip if pathfinding is in progress
    if (this.inFlightFind) {
      return;
    }
    
    // Skip if we have no steps (waiting for initial calculation)
    if (this.steps.length === 0) {
      return;
    }
    
    // Count bounties that need to be sold
    const activeBountyCounts = new Map<string, number>();
    for (const bounty of activeBountyList) {
      activeBountyCounts.set(bounty, (activeBountyCounts.get(bounty) || 0) + 1);
    }
    
    // Count sell steps in current plan
    const sellStepCounts = new Map<string, number>();
    for (const step of this.steps) {
      const s = step as any;
      if (s?.type === 'sell') {
        sellStepCounts.set(s.item, (sellStepCounts.get(s.item) || 0) + 1);
      }
    }
    
    // Check if every active bounty has a corresponding sell step
    let inconsistent = false;
    for (const [bounty, activeCount] of activeBountyCounts) {
      const sellCount = sellStepCounts.get(bounty) || 0;
      if (sellCount < activeCount) {
        console.warn(`[consistency] Missing sell step for ${bounty}: have ${sellCount} sell steps but ${activeCount} active bounties`);
        inconsistent = true;
        break;
      }
    }
    
    if (inconsistent) {
      console.log('[consistency] Steps inconsistent with active bounties, triggering recalculation');
      
      // Clear cached solution and recalculate based on current active bounties only
      this.prevOptimalBounties = [];
      this.kp = 0;
      this.distanceSeconds = NaN;
      this.steps = [];
      this.displaySteps = [];
      this.stepIdx = 0; // Reset stepIdx so new route includes BUY steps
      
      const signature = this.makeAllBountiesSignature(activeBountyList);
      this.launchFindBestIfNeeded(activeBountyList, false, signature, 'consistencyFix');
    }
  }
  
  /**
   * Schedule a debounced recalculation when user is adjusting bounties with board open
   * This prevents constant recalculations as they drop/accept bounties
   */
  private scheduleAdjustmentRecalculation(): void {
    // Clear existing timer
    if (this.adjustmentDebounceTimer) {
      clearTimeout(this.adjustmentDebounceTimer);
    }
    
    // Schedule new recalculation
    this.adjustmentDebounceTimer = setTimeout(() => {
      console.log('[adjustment] Debounce period ended, recalculating optimal bounties');
      
      // Clear cached solution to force recalculation
      this.prevOptimalBounties = [];
      this.kp = 0;
      this.distanceSeconds = NaN;
      
      // Trigger recalculation with current bounties
      const allBounties = [...Object.values(this.activeBounties), ...Object.values(this.boardBounties)];
      if (allBounties.length > 0) {
        const signature = this.makeAllBountiesSignature(allBounties);
        this.launchFindBestIfNeeded(allBounties, true, signature, 'adjustmentDebounce');
      }
      
      this.adjustmentDebounceTimer = null;
    }, this.adjustmentDebounceMs);
  }
}
