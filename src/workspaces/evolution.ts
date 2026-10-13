/**
 * PilotDeck WorkSpace Self-Evolution Module
 * 
 * 每个WorkSpace维护自己的ΔG轨迹，实现数据驱动的skill积累和性能优化
 * 
 * ΔG = (C · Λ · Ω · τ) / (H · t) × Φ_self_loop
 */

import type { WorkSpace } from '../types/workspace';

export interface EvolutionParams {
  /** Context capacity - memory compression rate */
  memoryEfficiency: number;
  /** Logic chains - task chain length */
  taskChainLength: number;
  /** Domain视野 - skills diversity */
  skillsDiversity: number;
  /** Time density - uptime vs tasks ratio */
  uptimeEfficiency: number;
  /** Complexity - average task complexity */
  taskComplexity: number;
  /** Elapsed time - total work time */
  totalTime: number;
}

export interface WorkSpaceEvolution {
  workspaceId: string;
  currentDeltaG: number;
  previousDeltaG: number;
  generation: number;
  genes: EvolutionGene[];
  trajectory: DeltaGPoint[];
}

export interface EvolutionGene {
  id: string;
  fitness: number;
  deltaG: number;
  source: 'memory' | 'skill' | 'routing' | 'task';
  acquiredAt: number;
}

export interface DeltaGPoint {
  timestamp: number;
  deltaG: number;
  taskId: string;
}

/** SPW-R enhancement factor from neuroscience */
const SPW_R_FACTOR = 3.38;

/**
 * Compute ΔG for a WorkSpace
 */
export function computeWorkSpaceDeltaG(params: EvolutionParams): number {
  const { memoryEfficiency, taskChainLength, skillsDiversity, uptimeEfficiency, taskComplexity, totalTime } = params;
  
  if (taskComplexity === 0 || totalTime === 0) return 0;
  
  const C = memoryEfficiency;
  const Lambda = taskChainLength;
  const Omega = skillsDiversity;
  const Tau = uptimeEfficiency;
  const H = taskComplexity;
  const t = totalTime;
  
  return (C * Lambda * Omega * Tau) / (H * t) * SPW_R_FACTOR;
}

/**
 * Evolve a WorkSpace after task completion
 */
export function evolveWorkSpace(
  workspace: WorkSpace,
  task: Task,
  previousDeltaG: number
): WorkSpaceEvolution {
  const params: EvolutionParams = {
    memoryEfficiency: workspace.memory.compressionRate,
    taskChainLength: task.chainLength,
    skillsDiversity: workspace.skills.diversity,
    uptimeEfficiency: workspace.uptime / (workspace.tasks.completed + 1),
    taskComplexity: task.avgComplexity,
    totalTime: workspace.totalTime + task.duration,
  };
  
  const currentDeltaG = computeWorkSpaceDeltaG(params);
  const generation = workspace.generation + 1;
  
  // Extract new genes from successful task execution
  const newGenes = extractGenes(workspace, task, currentDeltaG);
  
  // Merge with existing genes, keeping high-fitness ones
  const mergedGenes = mergeGenePool(workspace.genes, newGenes);
  
  return {
    workspaceId: workspace.id,
    currentDeltaG,
    previousDeltaG,
    generation,
    genes: mergedGenes,
    trajectory: [
      ...workspace.trajectory,
      { timestamp: Date.now(), deltaG: currentDeltaG, taskId: task.id },
    ],
  };
}

/**
 * Extract genes from task execution
 */
function extractGenes(workspace: WorkSpace, task: Task, deltaG: number): EvolutionGene[] {
  const genes: EvolutionGene[] = [];
  
  if (task.memoryUsage < workspace.memory.avgUsage * 0.8) {
    genes.push({ id: `gene_${Date.now()}_mem`, fitness: deltaG, deltaG: deltaG * 0.1, source: 'memory', acquiredAt: Date.now() });
  }
  
  if (task.chainLength > workspace.tasks.avgChainLength) {
    genes.push({ id: `gene_${Date.now()}_task`, fitness: deltaG, deltaG: deltaG * 0.15, source: 'task', acquiredAt: Date.now() });
  }
  
  if (task.routingScore && task.routingScore > workspace.routing.avgScore) {
    genes.push({ id: `gene_${Date.now()}_route`, fitness: deltaG, deltaG: deltaG * 0.2, source: 'routing', acquiredAt: Date.now() });
  }
  
  return genes;
}

/**
 * Merge gene pool - keep top performers, cull weak ones
 */
function mergeGenePool(existing: EvolutionGene[], newGenes: EvolutionGene[]): EvolutionGene[] {
  const pool = [...existing, ...newGenes];
  
  // Sort by fitness and keep top 50
  return pool
    .sort((a, b) => b.fitness - a.fitness)
    .slice(0, 50);
}

/**
 * Get evolution report for a WorkSpace
 */
export function getEvolutionReport(workspace: WorkSpace): string {
  const latest = workspace.evolution;
  const delta = latest.currentDeltaG - latest.previousDeltaG;
  const trend = delta > 0 ? '📈 improving' : delta < 0 ? '📉 declining' : '➡️ stable';
  
  return `WorkSpace Evolution Report: ${workspace.name}
Generation: ${latest.generation}
ΔG: ${latest.currentDeltaG.toFixed(3)} (${delta > 0 ? '+' : ''}${delta.toFixed(3)})
Trend: ${trend}
Genes: ${latest.genes.length}
Top Gene: ${latest.genes[0]?.id || 'none'}
Trajectory Length: ${latest.trajectory.length}
`;
}
