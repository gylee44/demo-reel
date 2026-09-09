import type { Plan, Scene } from './index.ts';

/** Transitive scene/data dependencies: only later affected scenes are invalidated. */
export function affectedScenes(plan: Plan, selected: string[]): string[] {
  if (selected.some(id => !plan.scenes.some(s => s.id === id))) throw new Error('INVALID_PLAN');
  const affected = new Set(selected); const changed = new Set<string>();
  for (const scene of plan.scenes) {
    if (scene.dependsOn.some(id => affected.has(id)) || [...scene.effects.reads, ...scene.effects.writes].some(k => changed.has(k))) affected.add(scene.id);
    if (affected.has(scene.id)) scene.effects.writes.forEach(k => changed.add(k));
  }
  return plan.scenes.filter(s => affected.has(s.id)).map(s => s.id);
}
export function sceneDuration(scene: Scene, audioMs: number, actionEndMs: number): number {
  if (![audioMs, actionEndMs].every(v => Number.isFinite(v) && v >= 0)) throw new Error('INVALID_DURATION');
  const result = Math.ceil(Math.max(audioMs, actionEndMs) + scene.timing.tailHoldMs);
  if (result > scene.timing.maxDurationMs) throw new Error('DURATION_EXCEEDED');
  return result;
}
export function totalDuration(durations: number[], max = 75000): number {
  if (!durations.length || durations.some(n => !Number.isFinite(n) || n <= 0)) throw new Error('INVALID_DURATION');
  const result = durations.reduce((a, b) => a + b, 0);
  if (result > max) throw new Error('DURATION_EXCEEDED');
  return result;
}
export function mayRepeat(completed: boolean, safe: boolean): 'already_completed' | 'repeat' | 'needs_action' {
  if (completed === safe) return 'needs_action';
  return completed ? 'already_completed' : 'repeat';
}
