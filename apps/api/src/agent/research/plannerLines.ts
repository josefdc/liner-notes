/**
 * The research planner's own status lines (node `research_manager`). They carry its progress;
 * the planner's reasoning is model text and is never a status line (it is logged at debug level
 * only). A `{name}` in a line is filled by `plannerLine`.
 */
export const PLANNER_LINES = {
  starting: "Starting the research steps",
  finished: "Research steps finished",
  planning: "Choosing follow-up step {step} of at most {steps}",
  ended: "Research ended early: {reason}",
} as const;

/** A planner line with its `{name}` parts filled from `values`. */
export function plannerLine(
  template: string,
  values: Record<string, string | number> = {},
): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
}
