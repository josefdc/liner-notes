/**
 * The research planner's own status lines (node `research_manager`). Every other line that node
 * writes is the planner's reasoning: model text, shown as the model wrote it.
 *
 * The honesty guard (scripts/guard-honest.mjs) imports this file to tell the two apart in recorded
 * runs, so it has no imports and only syntax Node can strip of its types. A `{name}` in a line is
 * filled by `plannerLine`; the guard matches it as any text.
 */
export const PLANNER_LINES = {
  starting: "Starting the research steps",
  finished: "Research steps finished",
  planning: "Planning research step {step} of {steps}",
  ended: "Research ended: the research planner was unavailable ({status})",
} as const;

/** A planner line with its `{name}` parts filled from `values`. */
export function plannerLine(
  template: string,
  values: Record<string, string | number> = {},
): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
}
