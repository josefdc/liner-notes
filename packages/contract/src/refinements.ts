/**
 * Named refinements. A refinement narrows what a schema accepts without showing up in its JSON
 * Schema, so the contract snapshots list every refinement by id: adding one is a breaking
 * change for readers, removing one is additive. A refinement added without a name is listed
 * as `unnamed` and is caught the same way.
 */

import type { z } from "zod";

const ids = new WeakMap<object, string>();

/** `schema.superRefine(check)`, registered under `id`. */
export function refineNamed<S extends z.ZodType>(
  schema: S,
  id: string,
  check: (value: z.output<S>, ctx: z.RefinementCtx<z.output<S>>) => void,
): S {
  const refined = schema.superRefine(check) as S;
  const checks = (refined as unknown as { _zod: { def: { checks?: object[] } } })._zod.def.checks;
  const added = checks?.at(-1);
  if (added) ids.set(added, id);
  return refined;
}

/** The id a refinement check was registered under, or "unnamed". */
export function refinementId(check: object): string {
  return ids.get(check) ?? "unnamed";
}
