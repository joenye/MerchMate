// Core type definitions

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  title: string;
}

export type Regions = { [key: string]: Region };

export type Step =
  | { type: 'teleport'; location: string; distance: number }
  | { type: 'buy'; item: string; location: string; distance: number }
  | { type: 'sell'; item: string; location: string; distance: number }
  | { type: 'return'; location: string; distance: number };

export interface FindBestArgs {
  allBounties: string[];
  detectiveLevel: number;
  battleOfFortuneholdCompleted: boolean;
  bountyRarities?: { [bountyKey: string]: 'uncommon' | 'rare' | 'epic' | null };
  pruningOptions?: {
    maxCombinations?: number;
    pruningThreshold?: number;
  };
}

export interface FindBestResult {
  bounties: string[];
  kp: number;
  actions: Step[];
  distance: number;
}

export interface KeyboardShortcuts {
  toggleEditMode: string;
  toggleVisibility: string;
  forceRecalculateBounties: string;
  openSettings: string;
}

export interface Config {
  regions?: Regions;
  detectiveLevel?: number;
  isBattleOfFortuneholdCompleted?: boolean;
  ocrMethod?: 'native' | 'tesseract-js' | 'auto';
  keyboardShortcuts?: KeyboardShortcuts;
  /** Pathfinding quality: 1 = heavy pruning (fast), 5 = no pruning (optimal). Default: 5 */
  pathfindingQuality?: number;
  /** Check for updates on app startup. Default: true */
  checkForUpdatesOnStartup?: boolean;
  /** Chat box font size in pixels. Default: 23 */
  chatBoxFontSize?: number;
}

export interface OCRData {
  steps: string;
  activeDrops: number[];
  boardPickups: number[];
  activeBountyIndices?: number[];
  boardBountyIndices?: number[];
  activeBounties?: { [index: number]: string };
  boardBounties?: { [index: number]: string };
  activeBountyRarities?: { [index: number]: 'uncommon' | 'rare' | 'epic' | null };
  boardBountyRarities?: { [index: number]: 'uncommon' | 'rare' | 'epic' | null };
  rawOcrText?: { [key: string]: string };
  matchTypes?: { [key: string]: 'exact' | 'fuzzy' };
  fuzzyDebug?: { [key: string]: Array<{ bountyKey: string; score: number; nameScore: number; fromScore: number; toScore: number; positionBonus: number }> };
  optimalBounties?: string[]; // List of optimal bounty keys
  status?: 'computing' | 'optimal' | 'not-optimal';
  boardOpen?: boolean;
  sessionStats?: {
    totalKpEarned: number;
    sessionDurationSeconds: number;
    totalBountiesCompleted: number;
  };
}

export interface SessionStats {
  totalKpEarned: number;
  totalDurationSeconds: number;
  totalBountiesCompleted: number;
  bountyTypeCounts: Map<string, number>;
  sessionStartTime: number;
}
