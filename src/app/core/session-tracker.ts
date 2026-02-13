import * as fs from 'fs';
import * as path from 'path';
import { SessionStats } from '../config/types';
import { bounties as bountyData } from '../../algorithm/bounties';
import { getLogsDir } from '../utils/paths';

/**
 * Format a timestamp for logging (HH:MM:SS.mmm)
 */
function formatTimestamp(): string {
  const now = new Date();
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const seconds = now.getSeconds().toString().padStart(2, '0');
  const ms = now.getMilliseconds().toString().padStart(3, '0');
  return `${hours}:${minutes}:${seconds}.${ms}`;
}

export class SessionTracker {
  private stats: SessionStats = {
    totalKpEarned: 0,
    totalDurationSeconds: 0,
    totalBountiesCompleted: 0,
    bountyTypeCounts: new Map<string, number>(),
    sessionStartTime: Date.now()
  };

  private logPath: string;

  constructor() {
    const logsDir = getLogsDir();
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    this.logPath = path.join(logsDir, 'sessions.log');
    console.log('[init] Sessions file:', this.logPath);
    this.writeSessionStartMarker();
  }

  private writeSessionStartMarker(): void {
    try {
      const ts = formatTimestamp();
      const sessionStartMarker = `\n${'='.repeat(80)}\n[${ts}] [SESSION START]\n${'='.repeat(80)}\n\n`;
      fs.appendFileSync(this.logPath, sessionStartMarker, 'utf8');
    } catch (err) {
      console.error("Failed to write session start marker to log file:", err);
    }
  }

  recordBountyCompletion(bountyKey: string, rarityMultiplier: number = 1): void {
    const baseKp = (bountyData as any)[bountyKey]?.kp || 0;
    const bountyKp = baseKp * rarityMultiplier;
    this.stats.totalBountiesCompleted++;
    this.stats.totalKpEarned += bountyKp;
    this.stats.bountyTypeCounts.set(
      bountyKey,
      (this.stats.bountyTypeCounts.get(bountyKey) || 0) + 1
    );

    this.logBountyCompletion(bountyKey, bountyKp);
  }

  recordRunCompletion(
    runBounties: string[],
    actualTimeSeconds: number,
    estimatedTimeSeconds: number
  ): void {
    this.stats.totalDurationSeconds += actualTimeSeconds;
    this.logRunCompletion(runBounties, actualTimeSeconds, estimatedTimeSeconds);
  }

  private logBountyCompletion(bountyKey: string, bountyKp: number): void {
    const sessionDurationSeconds = (Date.now() - this.stats.sessionStartTime) / 1000;
    const sessionDurationMinutes = Math.floor(sessionDurationSeconds / 60);

    const bountyBreakdown: string[] = [];
    for (const [bountyType, count] of this.stats.bountyTypeCounts.entries()) {
      bountyBreakdown.push(`${bountyType}:${count}`);
    }

    const kpPerHour = sessionDurationSeconds > 0
      ? (this.stats.totalKpEarned / (sessionDurationSeconds / 3600)) / 100
      : 0;

    const line1 = `[session] Bounty completed: ${bountyKey} (+${(bountyKp / 100).toFixed(2)} KP)`;
    const line2 = `[session] Session stats: ` +
      `Total=${this.stats.totalBountiesCompleted} bounties, ` +
      `KP=${(this.stats.totalKpEarned / 100).toFixed(2)}, ` +
      `Duration=${Math.floor(this.stats.totalDurationSeconds / 60)}m ${Math.floor(this.stats.totalDurationSeconds % 60)}s, ` +
      `Session=${sessionDurationMinutes}m, ` +
      `Est KP/hr=${kpPerHour.toFixed(2)}`;
    const line3 = `[session] Bounty breakdown: ${bountyBreakdown.join(', ')}`;

    console.log(line1);
    console.log(line2);
    console.log(line3);
  }

  private logRunCompletion(
    runBounties: string[],
    actualTimeSeconds: number,
    estimatedTimeSeconds: number
  ): void {
    const ts = formatTimestamp();
    const sessionDurationSeconds = (Date.now() - this.stats.sessionStartTime) / 1000;
    const sessionDurationMinutes = Math.floor(sessionDurationSeconds / 60);
    const kpPerHour = sessionDurationSeconds > 0
      ? (this.stats.totalKpEarned / (sessionDurationSeconds / 3600)) / 100
      : 0;

    const bountyBreakdown: string[] = [];
    for (const [bountyType, count] of this.stats.bountyTypeCounts.entries()) {
      bountyBreakdown.push(`${bountyType}:${count}`);
    }

    try {
      let logEntry = `[${ts}] `;

      if (runBounties.length > 0) {
        const bountyCounts = new Map<string, number>();
        for (const bounty of runBounties) {
          bountyCounts.set(bounty, (bountyCounts.get(bounty) || 0) + 1);
        }
        const bountiesList = Array.from(bountyCounts.entries())
          .map(([bounty, count]) => count > 1 ? `${bounty}:${count}` : bounty)
          .join(', ');

        const actualMin = Math.floor(actualTimeSeconds / 60);
        const actualSec = Math.floor(actualTimeSeconds % 60);
        const estMin = Math.floor(estimatedTimeSeconds / 60);
        const estSec = Math.floor(estimatedTimeSeconds % 60);
        const diff = actualTimeSeconds - estimatedTimeSeconds;
        const diffStr = diff >= 0 ? `+${diff.toFixed(1)}s` : `${diff.toFixed(1)}s`;

        logEntry += `[run] Completed: ${bountiesList} | ` +
          `Est: ${estMin}m ${estSec}s | Actual: ${actualMin}m ${actualSec}s | Diff: ${diffStr}\n`;
      }

      logEntry += `[${ts}] [session] Total=${this.stats.totalBountiesCompleted} bounties, ` +
        `KP=${(this.stats.totalKpEarned / 100).toFixed(2)}, ` +
        `Duration=${Math.floor(this.stats.totalDurationSeconds / 60)}m ${Math.floor(this.stats.totalDurationSeconds % 60)}s, ` +
        `Session=${sessionDurationMinutes}m, ` +
        `Est KP/hr=${kpPerHour.toFixed(2)}\n` +
        `[${ts}] [session] Bounty breakdown: ${bountyBreakdown.join(', ')}\n\n`;

      fs.appendFileSync(this.logPath, logEntry, 'utf8');
    } catch (err) {
      console.error('[run] Failed to write to log file:', err);
    }
  }

  getStats(): SessionStats {
    return this.stats;
  }

  getLogPath(): string {
    return this.logPath;
  }
}
