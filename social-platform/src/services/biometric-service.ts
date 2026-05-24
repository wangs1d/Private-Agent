import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';

export interface VoicePrint {
  userId: string;
  audioData: string;
  mimeType: string;
  createdAt: string;
}

export interface FacePrint {
  userId: string;
  imageData: string;
  mimeType: string;
  createdAt: string;
}

export class BiometricService {
  private voicePrints: Map<string, VoicePrint> = new Map();
  private facePrints: Map<string, FacePrint> = new Map();
  private persistPath: string;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(persistPath: string = join(process.cwd(), 'data', 'biometrics.json')) {
    this.persistPath = persistPath;
  }

  async load(): Promise<void> {
    try {
      const data = await readFile(this.persistPath, 'utf8');
      const saved = JSON.parse(data) as { voicePrints: VoicePrint[]; facePrints: FacePrint[] };
      
      if (saved.voicePrints) {
        for (const vp of saved.voicePrints) {
          this.voicePrints.set(vp.userId, vp);
        }
      }
      
      if (saved.facePrints) {
        for (const fp of saved.facePrints) {
          this.facePrints.set(fp.userId, fp);
        }
      }
      
      console.log(`[BiometricService] Loaded ${this.voicePrints.size} voice prints, ${this.facePrints.size} face prints`);
    } catch (error) {
      console.log('[BiometricService] No existing biometrics file, starting fresh');
    }
  }

  async saveVoicePrint(
    userId: string,
    audioData: string,
    mimeType: string
  ): Promise<{ ok: true; voicePrint: VoicePrint } | { ok: false; reason: string }> {
    const now = new Date().toISOString();

    const voicePrint: VoicePrint = {
      userId,
      audioData,
      mimeType,
      createdAt: now
    };

    this.voicePrints.set(userId, voicePrint);
    await this.schedulePersist();

    return { ok: true, voicePrint };
  }

  async saveFacePrint(
    userId: string,
    imageData: string,
    mimeType: string
  ): Promise<{ ok: true; facePrint: FacePrint } | { ok: false; reason: string }> {
    const now = new Date().toISOString();

    const facePrint: FacePrint = {
      userId,
      imageData,
      mimeType,
      createdAt: now
    };

    this.facePrints.set(userId, facePrint);
    await this.schedulePersist();

    return { ok: true, facePrint };
  }

  getVoicePrint(userId: string): VoicePrint | undefined {
    return this.voicePrints.get(userId);
  }

  getFacePrint(userId: string): FacePrint | undefined {
    return this.facePrints.get(userId);
  }

  hasVoicePrint(userId: string): boolean {
    return this.voicePrints.has(userId);
  }

  hasFacePrint(userId: string): boolean {
    return this.facePrints.has(userId);
  }

  deleteVoicePrint(userId: string): boolean {
    const deleted = this.voicePrints.delete(userId);
    if (deleted) void this.schedulePersist();
    return deleted;
  }

  deleteFacePrint(userId: string): boolean {
    const deleted = this.facePrints.delete(userId);
    if (deleted) void this.schedulePersist();
    return deleted;
  }

  private schedulePersist(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    
    return new Promise((resolve) => {
      this.persistTimer = setTimeout(async () => {
        this.persistTimer = null;
        try {
          await this.persistToDisk();
          resolve();
        } catch (error) {
          console.error('[BiometricService] Persist failed:', error);
          resolve();
        }
      }, 500);
    });
  }

  private async persistToDisk(): Promise<void> {
    const data = {
      voicePrints: Array.from(this.voicePrints.values()),
      facePrints: Array.from(this.facePrints.values())
    };
    
    try {
      await mkdir(dirname(this.persistPath), { recursive: true });
      await writeFile(this.persistPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
      console.error('[BiometricService] Persist to disk failed:', error);
    }
  }
}