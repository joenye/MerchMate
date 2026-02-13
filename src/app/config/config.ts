import * as fs from 'fs';
import * as path from 'path';
import { Config, Regions } from './types';
import { getAppDataDir } from '../utils/paths';

function getConfigPath(): string {
  return path.join(getAppDataDir(), 'config.json');
}

const DEFAULT_REGIONS: Regions = {
  activeBountyRegion1: { x: 20, y: 150, width: 300, height: 70, color: 'rgba(0, 0, 0, 0.65)', title: 'Active Bounty 1' },
  activeBountyRegion2: { x: 20, y: 230, width: 300, height: 70, color: 'rgba(0, 0, 0, 0.65)', title: 'Active Bounty 2' },
  activeBountyRegion3: { x: 20, y: 310, width: 300, height: 70, color: 'rgba(0, 0, 0, 0.65)', title: 'Active Bounty 3' },
  activeBountyRegion4: { x: 20, y: 390, width: 300, height: 70, color: 'rgba(0, 0, 0, 0.65)', title: 'Active Bounty 4' },
  activeBountyRegion5: { x: 20, y: 470, width: 300, height: 70, color: 'rgba(0, 0, 0, 0.65)', title: 'Active Bounty 5' },
  activeBountyRegion6: { x: 20, y: 550, width: 300, height: 70, color: 'rgba(0, 0, 0, 0.65)', title: 'Active Bounty 6' },
  boardRegion1: { x: 500, y: 80, width: 380, height: 100, color: 'rgba(0, 0, 0, 0.65)', title: 'Guild Board 1' },
  boardRegion2: { x: 500, y: 190, width: 380, height: 100, color: 'rgba(0, 0, 0, 0.65)', title: 'Guild Board 2' },
  boardRegion3: { x: 500, y: 300, width: 380, height: 100, color: 'rgba(0, 0, 0, 0.65)', title: 'Guild Board 3' },
  boardRegion4: { x: 500, y: 410, width: 380, height: 100, color: 'rgba(0, 0, 0, 0.65)', title: 'Guild Board 4' },
  boardRegion5: { x: 500, y: 520, width: 380, height: 100, color: 'rgba(0, 0, 0, 0.65)', title: 'Guild Board 5' },
  boardRegion6: { x: 500, y: 630, width: 380, height: 100, color: 'rgba(0, 0, 0, 0.65)', title: 'Guild Board 6' },
  bountyBoardTitleRegion: { x: 580, y: 20, width: 220, height: 50, color: 'rgba(0, 0, 0, 0.7)', title: 'Board Title' },
  chatRegion: { x: 350, y: 650, width: 1000, height: 255, color: 'rgba(42, 42, 42, 0.9)', title: 'Chat Box' },
};

// Regions saved to config only include position and size (color and title are constants)
const DEFAULT_REGIONS_FOR_CONFIG: { [key: string]: { x: number; y: number; width: number; height: number } } = {
  activeBountyRegion1: { x: 20, y: 150, width: 300, height: 70 },
  activeBountyRegion2: { x: 20, y: 230, width: 300, height: 70 },
  activeBountyRegion3: { x: 20, y: 310, width: 300, height: 70 },
  activeBountyRegion4: { x: 20, y: 390, width: 300, height: 70 },
  activeBountyRegion5: { x: 20, y: 470, width: 300, height: 70 },
  activeBountyRegion6: { x: 20, y: 550, width: 300, height: 70 },
  boardRegion1: { x: 500, y: 80, width: 380, height: 100 },
  boardRegion2: { x: 500, y: 190, width: 380, height: 100 },
  boardRegion3: { x: 500, y: 300, width: 380, height: 100 },
  boardRegion4: { x: 500, y: 410, width: 380, height: 100 },
  boardRegion5: { x: 500, y: 520, width: 380, height: 100 },
  boardRegion6: { x: 500, y: 630, width: 380, height: 100 },
  bountyBoardTitleRegion: { x: 580, y: 20, width: 220, height: 50 },
  chatRegion: { x: 350, y: 650, width: 1000, height: 255 },
};

const DEFAULT_CONFIG: Config = {
  chatBoxFontSize: 23,
  checkForUpdatesOnStartup: true,
  detectiveLevel: 500,
  isBattleOfFortuneholdCompleted: true,
  keyboardShortcuts: {
    forceRecalculateBounties: 'CmdOrCtrl+N',
    openSettings: 'CmdOrCtrl+,',
    toggleEditMode: 'CmdOrCtrl+J',
    toggleVisibility: 'CmdOrCtrl+K',
  },
  ocrMethod: 'auto',
  pathfindingQuality: 5,
  regions: DEFAULT_REGIONS_FOR_CONFIG as any,
};

// Keys that are valid in the config (excluding regions which is handled separately)
const VALID_CONFIG_KEYS = new Set([
  'chatBoxFontSize',
  'checkForUpdatesOnStartup',
  'detectiveLevel',
  'isBattleOfFortuneholdCompleted',
  'keyboardShortcuts',
  'ocrMethod',
  'pathfindingQuality',
  'regions',
]);

// Valid nested keys for objects that need migration
const VALID_KEYBOARD_SHORTCUTS = new Set([
  'forceRecalculateBounties',
  'openSettings',
  'toggleEditMode',
  'toggleVisibility',
]);

function createDefaultConfig(configPath: string): Config {
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
  console.log('[config] Created default config at:', configPath);
  return { ...DEFAULT_CONFIG };
}

function sortObjectKeys(obj: any): any {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj;
  }
  
  const sorted: any = {};
  const keys = Object.keys(obj).sort();
  
  for (const key of keys) {
    sorted[key] = sortObjectKeys(obj[key]);
  }
  
  return sorted;
}

function validateAndMigrateConfig(config: any, configPath: string): Config {
  let modified = false;
  
  // Check for unrecognized keys and remove them
  const unrecognizedKeys: string[] = [];
  for (const key of Object.keys(config)) {
    if (!VALID_CONFIG_KEYS.has(key)) {
      unrecognizedKeys.push(key);
      delete config[key];
      modified = true;
    }
  }
  
  if (unrecognizedKeys.length > 0) {
    console.log('[config] Removed unrecognized keys:', unrecognizedKeys.join(', '));
  }
  
  // Add missing keys with defaults
  const addedKeys: string[] = [];
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    if (!(key in config)) {
      (config as any)[key] = value;
      addedKeys.push(key);
      modified = true;
    }
  }
  
  if (addedKeys.length > 0) {
    console.log('[config] Added missing keys with defaults:', addedKeys.join(', '));
  }
  
  // Validate and migrate keyboardShortcuts nested keys
  if (config.keyboardShortcuts && typeof config.keyboardShortcuts === 'object') {
    const shortcuts = config.keyboardShortcuts;
    const defaultShortcuts = DEFAULT_CONFIG.keyboardShortcuts!;
    
    // Remove unrecognized shortcut keys
    const unrecognizedShortcuts: string[] = [];
    for (const key of Object.keys(shortcuts)) {
      if (!VALID_KEYBOARD_SHORTCUTS.has(key)) {
        unrecognizedShortcuts.push(key);
        delete shortcuts[key];
        modified = true;
      }
    }
    if (unrecognizedShortcuts.length > 0) {
      console.log('[config] Removed unrecognized keyboard shortcuts:', unrecognizedShortcuts.join(', '));
    }
    
    // Add missing shortcut keys with defaults
    const addedShortcuts: string[] = [];
    for (const [key, value] of Object.entries(defaultShortcuts)) {
      if (!(key in shortcuts)) {
        shortcuts[key] = value;
        addedShortcuts.push(key);
        modified = true;
      }
    }
    if (addedShortcuts.length > 0) {
      console.log('[config] Added missing keyboard shortcuts:', addedShortcuts.join(', '));
    }
  }
  
  // Validate and migrate regions - add any missing regions with defaults
  if (config.regions && typeof config.regions === 'object') {
    // Remove deprecated timerRegion
    if ('timerRegion' in config.regions) {
      delete config.regions.timerRegion;
      console.log('[config] Removed deprecated timerRegion');
      modified = true;
    }
    
    const addedRegions: string[] = [];
    for (const [key, value] of Object.entries(DEFAULT_REGIONS)) {
      if (!(key in config.regions)) {
        // Only save position and size for new regions
        config.regions[key] = {
          x: value.x,
          y: value.y,
          width: value.width,
          height: value.height,
        };
        addedRegions.push(key);
        modified = true;
      } else {
        // Strip color and title from existing regions (they're constants)
        const region = config.regions[key];
        if ('color' in region || 'title' in region) {
          config.regions[key] = {
            x: region.x,
            y: region.y,
            width: region.width,
            height: region.height,
          };
          modified = true;
        }
      }
    }
    if (addedRegions.length > 0) {
      console.log('[config] Added missing regions:', addedRegions.join(', '));
    }
  }
  
  // Sort keys alphabetically
  const sortedConfig = sortObjectKeys(config);
  
  // Save updated config if modified (always save to ensure sorted)
  try {
    const currentContent = fs.readFileSync(configPath, 'utf8');
    const newContent = JSON.stringify(sortedConfig, null, 2);
    if (currentContent !== newContent) {
      fs.writeFileSync(configPath, newContent, 'utf8');
      console.log('[config] Updated config file');
    }
  } catch (err) {
    console.error('[config] Failed to save updated config:', err);
  }
  
  return sortedConfig as Config;
}

export function loadConfig(): Config {
  const configPath = getConfigPath();
  console.log('[config] Loading from:', configPath);
  
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      console.log('[config] Loaded successfully');
      return validateAndMigrateConfig(config, configPath);
    } catch (err) {
      console.error("[config] Error reading config file:", err);
      return { ...DEFAULT_CONFIG };
    }
  } else {
    return createDefaultConfig(configPath);
  }
}

export function saveConfig(config: Config): void {
  const configPath = getConfigPath();
  const sortedConfig = sortObjectKeys(config);
  fs.writeFileSync(configPath, JSON.stringify(sortedConfig, null, 2), 'utf8');
  console.log('[config] Saved config');
}

export function getDefaultConfig(): Config {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

export function getDefaultRegions(): Regions {
  return JSON.parse(JSON.stringify(DEFAULT_REGIONS));
}

export { getConfigPath };
