import * as path from 'path';
import { utilityProcess, UtilityProcess, MessagePortMain } from 'electron';
import { FindBestArgs, FindBestResult } from '../config/types';

interface ComboTask {
  combo: string[];
  kp: number;
  estimatedEfficiency: number;
}

interface ComboResult {
  combo: string[];
  kp: number;
  actions: any[];
  distance: number;
}

interface UtilityResponse {
  id: number;
  ok: boolean;
  results?: ComboResult[];
  error?: string;
  timing?: {
    computeTime: number;
    totalTime: number;
    evaluated: number;
    tasks: number;
  };
}

/**
 * Manages a pool of utility processes for parallel pathfinding.
 * Uses Electron's utilityProcess API which provides better V8 performance
 * than worker_threads in Electron.
 */
export class PathfinderUtilityPool {
  private processes: UtilityProcess[] = [];
  private nextId = 1;
  private initialized = false;
  private detectiveLevel: number = 500;
  private battleOfFortuneholdCompleted: boolean = true;
  private maxProcesses: number;
  private scriptPath: string;

  constructor(maxProcesses?: number) {
    // Use CPU count - 1 to leave headroom for main process and system
    const cpuCount = require('os').cpus()?.length ?? 4;
    this.maxProcesses = maxProcesses ?? Math.max(2, cpuCount - 1);
    // The utility process script will be in dist/app/workers/
    this.scriptPath = path.join(__dirname, 'pathfinder-utility-process.js');
  }

  setConfig(detectiveLevel: number, battleOfFortuneholdCompleted: boolean): void {
    this.detectiveLevel = detectiveLevel;
    this.battleOfFortuneholdCompleted = battleOfFortuneholdCompleted;
  }

  private initPool(): void {
    if (this.initialized) return;

    console.log(`[pathfinder-utility] Initializing pool with ${this.maxProcesses} utility processes`);
    
    for (let i = 0; i < this.maxProcesses; i++) {
      const proc = utilityProcess.fork(this.scriptPath, [], {
        serviceName: `pathfinder-${i}`,
      });
      
      proc.on('exit', (code) => {
        console.warn(`[pathfinder-utility] Process ${i} exited with code ${code}`);
      });
      
      this.processes.push(proc);
    }
    
    this.initialized = true;
  }

  async warmup(): Promise<void> {
    this.initPool();

    console.log(`[pathfinder-utility] Warming up ${this.processes.length} processes...`);
    const startTime = Date.now();

    const warmupPromises = this.processes.map((proc, idx) => {
      return new Promise<void>((resolve, reject) => {
        const id = this.nextId++;
        const timeout = setTimeout(() => reject(new Error(`Warmup timeout for process ${idx}`)), 10000);

        const handler = (msg: UtilityResponse) => {
          if (msg.id !== id) return;
          proc.off('message', handler);
          clearTimeout(timeout);
          resolve();
        };

        proc.on('message', handler);
        proc.postMessage({
          id,
          type: 'warmup',
          detectiveLevel: this.detectiveLevel,
          battleOfFortuneholdCompleted: this.battleOfFortuneholdCompleted,
        });
      });
    });

    await Promise.all(warmupPromises);
    console.log(`[pathfinder-utility] Pool warmed up in ${Date.now() - startTime}ms`);
  }

  async findBest(args: FindBestArgs, timeoutMs: number): Promise<FindBestResult> {
    const { allBounties, detectiveLevel, battleOfFortuneholdCompleted, bountyRarities = {}, pruningOptions = {} } = args;
    const { maxCombinations = 400, pruningThreshold = 0.95 } = pruningOptions;

    const t0 = Date.now();

    const combinationsMod = require('../../algorithm/combinations').default;
    const bountyDataMod = require('../../algorithm/bounties').bounties;

    // Helper function to get KP with rarity multiplier
    const getBountyKp = (bountyKey: string): number => {
      const baseKp = bountyDataMod[bountyKey].kp;
      const rarity = bountyRarities[bountyKey];
      
      if (rarity === 'epic') return baseKp * 4;
      if (rarity === 'rare') return baseKp * 3;
      if (rarity === 'uncommon') return baseKp * 2;
      return baseKp;
    };

    const maxComboSize = Math.min(allBounties.length, 6);
    const combos = combinationsMod(allBounties, maxComboSize);

    const comboTasks: ComboTask[] = combos.map((combo: string[]) => {
      const kp = combo.reduce((acc: number, bounty: string) => acc + getBountyKp(bounty), 0);
      const uniqueLocations = new Set<number>();
      for (const bounty of combo) {
        uniqueLocations.add(bountyDataMod[bounty].seller.node);
        uniqueLocations.add(bountyDataMod[bounty].buyer.node);
      }
      const estimatedDistance = uniqueLocations.size * 10 + combo.length * 7;
      return { combo, kp, estimatedEfficiency: kp / estimatedDistance };
    });

    comboTasks.sort((a, b) => b.estimatedEfficiency - a.estimatedEfficiency);

    const tasksToProcess = maxCombinations === Infinity
      ? comboTasks
      : comboTasks.slice(0, maxCombinations);

    if (tasksToProcess.length === 0) {
      throw new Error('No combinations to evaluate');
    }

    this.initPool();

    const t1 = Date.now();
    const numProcesses = Math.min(this.maxProcesses, Math.ceil(tasksToProcess.length / 10));

    if (maxCombinations === Infinity) {
      console.log(`[pathfinder-utility] Processing ${tasksToProcess.length} combinations with ${numProcesses} processes (optimal mode)`);
    } else {
      console.log(`[pathfinder-utility] Processing ${tasksToProcess.length}/${comboTasks.length} combinations with ${numProcesses} processes`);
    }

    // For small task counts, use single process
    if (tasksToProcess.length <= 20) {
      return this.runOnProcess(tasksToProcess, 0, detectiveLevel, battleOfFortuneholdCompleted, pruningThreshold, timeoutMs, true) as Promise<FindBestResult>;
    }

    // Distribute tasks round-robin
    const chunks: ComboTask[][] = Array.from({ length: numProcesses }, () => []);
    for (let i = 0; i < tasksToProcess.length; i++) {
      chunks[i % numProcesses].push(tasksToProcess[i]);
    }

    const processPromises = chunks.map((chunk, idx) =>
      this.runOnProcess(chunk, idx % this.processes.length, detectiveLevel, battleOfFortuneholdCompleted, pruningThreshold, timeoutMs, false)
    );

    const chunkResults = await Promise.all(processPromises);
    const t2 = Date.now();

    let allResults: ComboResult[] = chunkResults.flat().filter(r => r !== null) as ComboResult[];
    allResults.sort((a, b) => b.kp / b.distance - a.kp / a.distance);

    console.log(`[pathfinder-utility] Completed in ${((t2 - t0) / 1000).toFixed(2)}s (prep=${t1 - t0}ms, processes=${t2 - t1}ms), found ${allResults.length} results`);

    if (allResults.length === 0) {
      throw new Error('No valid routes found');
    }

    const best = allResults[0];
    return {
      bounties: best.combo,
      kp: best.kp,
      actions: best.actions,
      distance: best.distance,
    };
  }

  private runOnProcess(
    tasks: ComboTask[],
    processIdx: number,
    detectiveLevel: number,
    battleOfFortuneholdCompleted: boolean,
    pruningThreshold: number,
    timeoutMs: number,
    returnSingle: boolean
  ): Promise<ComboResult[] | FindBestResult> {
    return new Promise((resolve, reject) => {
      const proc = this.processes[processIdx];
      if (!proc) {
        reject(new Error(`Process ${processIdx} not found`));
        return;
      }

      const id = this.nextId++;

      const timeout = setTimeout(() => {
        console.warn(`[pathfinder-utility] Process ${processIdx} timed out`);
        if (returnSingle) {
          reject(new Error(`Process timed out after ${timeoutMs}ms`));
        } else {
          resolve([]);
        }
      }, timeoutMs);

      const messageHandler = (msg: UtilityResponse) => {
        if (msg.id !== id) return;

        clearTimeout(timeout);
        proc.off('message', messageHandler);

        if (msg.ok) {
          if (returnSingle && msg.results && msg.results.length > 0) {
            const best = msg.results[0];
            resolve({
              bounties: best.combo,
              kp: best.kp,
              actions: best.actions,
              distance: best.distance,
            } as FindBestResult);
          } else {
            resolve(msg.results || []);
          }
        } else {
          console.warn(`[pathfinder-utility] Process ${processIdx} error: ${msg.error}`);
          if (returnSingle) {
            reject(new Error(msg.error || 'Process error'));
          } else {
            resolve([]);
          }
        }
      };

      proc.on('message', messageHandler);

      proc.postMessage({
        id,
        type: 'evaluateChunk',
        tasks,
        detectiveLevel,
        battleOfFortuneholdCompleted,
        roundTrip: true,
        numResults: 5,
        pruningThreshold,
      });
    });
  }

  async terminate(): Promise<void> {
    for (const proc of this.processes) {
      proc.kill();
    }
    this.processes = [];
    this.initialized = false;
  }
}
