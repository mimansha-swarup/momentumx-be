import { GenerationKind } from "./pipeline.js";

const defaults: Record<GenerationKind, number> = {
  ideas: 3, script: 5, hooks: 1, title: 1,
  description: 2, thumbnail: 1, shorts: 1, prefill: 0,
};

// Independent packaging items can fail/retry separately; their default total is 4.
// A new kind must have a price. Prefill is always free, including onboarding.
export const CREDIT_COSTS = Object.fromEntries(Object.entries(defaults).map(([kind, fallback]) => {
  const configured = kind === "prefill" ? undefined : process.env[`CREDIT_COST_${kind.toUpperCase()}`];
  const cost = configured === undefined ? fallback : Number(configured);
  if ((configured !== undefined && !/^\d+$/.test(configured)) || !Number.isSafeInteger(cost) || cost < 0) throw new Error(`Invalid CREDIT_COST_${kind.toUpperCase()}`);
  return [kind, cost];
})) as Record<GenerationKind, number>;
