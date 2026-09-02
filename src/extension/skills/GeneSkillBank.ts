/**
 * GeneSkillBank.ts
 * PilotDeck Gene-Skill Bank: bridge between evolution genes and executable skills
 * 
 * PR #A: feat(skills): add GeneSkillBank for gene-driven skill evolution
 * Author: Xuanji-58 (from NousResearch/hermes-agent)
 * 
 * This system enables:
 * 1. Rating skills by effectiveness (F score, ΔG contribution)
 * 2. Automatically converting genes to skills
 * 3. Skill evolution (old skills degrade, new skills created)
 * 4. Skill inheritance between Workspaces
 */

import type {
  SkillCreateInput,
  SkillCreateResult,
  SkillSummary,
} from './types.js';
import type { GeneNetwork } from '../../workspace/selfEvolution.js';

export interface GeneSkillEntry {
  geneId: string;
  geneF: number;           // Fitness score
  geneDeltaG: number;     // ΔG contribution
  skillName: string;       // Hermes-style skill name
  skillCategory: string;   // e.g. "autonomous-ai-agents"
  filePath: string;        // skill markdown path
  inheritedFrom?: string;  // parent gene ID
  lastUsed?: Date;
  useCount: number;
  createdAt: Date;
}

export interface GeneSkillBankOptions {
  skillsDir: string;
  geneNetwork: GeneNetwork;
}

/**
 * GeneSkillBank bridges the evolution gene network to executable skills.
 * 
 * Key concept (from Hermes Agent):
 * - Genes have F (fitness) and ΔG (delta growth) scores
 * - High-F genes should become Skills
 * - Skills can evolve as their underlying genes evolve
 * - Skills can be inherited by child Workspaces
 */
export class GeneSkillBank {
  private readonly entries: Map<string, GeneSkillEntry> = new Map();
  private readonly options: GeneSkillBankOptions;

  constructor(options: GeneSkillBankOptions) {
    this.options = options;
  }

  /**
   * Evaluate a skill's effectiveness based on telemetry data.
   * Returns F score and ΔG contribution.
   */
  async evaluateSkillEffectiveness(skillName: string): Promise<{f: number; deltaG: number}> {
    const entry = this.findBySkillName(skillName);
    if (!entry) {
      return { f: 1.0, deltaG: 10 }; // Default baseline
    }

    // Calculate effectiveness from usage patterns
    const recencyBonus = entry.lastUsed
      ? Math.max(0, 1 - (Date.now() - entry.lastUsed.getTime()) / (30 * 24 * 60 * 60 * 1000))
      : 0;
    const usageBonus = Math.min(entry.useCount / 100, 1.0) * 0.5;

    const f = 1.0 + recencyBonus * 2 + usageBonus * entry.geneF;
    const deltaG = entry.geneDeltaG * (1 + recencyBonus * 0.5);

    return { f: Math.min(f, 10.0), deltaG };
  }

  /**
   * Convert a gene from the gene network into an executable skill.
   */
  async createSkillFromGene(
    geneId: string,
    skillInput: SkillCreateInput,
  ): Promise<SkillCreateResult> {
    const gene = await this.options.geneNetwork.getGene(geneId);
    if (!gene) {
      throw new Error(`Gene ${geneId} not found in gene network`);
    }

    const entry: GeneSkillEntry = {
      geneId,
      geneF: gene.F,
      geneDeltaG: gene.deltaG,
      skillName: skillInput.name,
      skillCategory: skillInput.category ?? 'xuanji',
      filePath: `${this.options.skillsDir}/${skillInput.category ?? 'xuanji'}/${skillInput.name}.md`,
      lastUsed: undefined,
      useCount: 0,
      createdAt: new Date(),
    };

    this.entries.set(geneId, entry);

    return {
      success: true,
      skillName: skillInput.name,
      skillPath: entry.filePath,
    };
  }

  /**
   * Evolve an existing skill based on new gene fitness data.
   * Called when the gene network updates gene F scores.
   */
  async evolveSkill(skillName: string, newF: number): Promise<void> {
    const entry = this.findBySkillName(skillName);
    if (!entry) return;

    const oldF = entry.geneF;
    entry.geneF = newF;

    // Evolve ΔG based on F change
    const fRatio = newF / oldF;
    entry.geneDeltaG = entry.geneDeltaG * fRatio;

    // If F dropped significantly, mark for potential pruning
    if (newF < 2.0) {
      console.warn(`[GeneSkillBank] Skill ${skillName} gene F dropped to ${newF} — consider pruning`);
    }
  }

  /**
   * Propagate a high-F gene as a new skill to a child WorkSpace.
   * Child Workspaces inherit capabilities from parent Workspaces.
   */
  async propagateGeneToWorkspace(
    sourceWsId: string,
    geneId: string,
    targetWsId: string,
  ): Promise<void> {
    const entry = this.entries.get(geneId);
    if (!entry) return;

    if (entry.geneF < 3.5) {
      console.info(`[GeneSkillBank] Skipping propagation: gene ${geneId} F=${entry.geneF} < 3.5 threshold`);
      return;
    }

    // Create inherited entry
    const inheritedEntry: GeneSkillEntry = {
      ...entry,
      geneId: `${geneId}:${targetWsId}`,
      inheritedFrom: geneId,
      createdAt: new Date(),
    };

    this.entries.set(inheritedEntry.geneId, inheritedEntry);
    console.info(`[GeneSkillBank] Propagated gene ${geneId} (F=${entry.geneF}) to workspace ${targetWsId}`);
  }

  /**
   * Record skill usage for telemetry.
   */
  async recordSkillUsage(skillName: string): Promise<void> {
    const entry = this.findBySkillName(skillName);
    if (entry) {
      entry.useCount++;
      entry.lastUsed = new Date();
    }
  }

  /**
   * Get all skills sorted by ΔG contribution (most valuable first).
   */
  async getTopSkills(limit = 10): Promise<GeneSkillEntry[]> {
    const sorted = Array.from(this.entries.values())
      .sort((a, b) => b.geneDeltaG - a.geneDeltaG);
    return sorted.slice(0, limit);
  }

  private findBySkillName(skillName: string): GeneSkillEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.skillName === skillName) return entry;
    }
    return undefined;
  }
}
