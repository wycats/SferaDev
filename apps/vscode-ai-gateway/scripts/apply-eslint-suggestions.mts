#!/usr/bin/env -S pnpm dlx tsx
/**
 * Script to programmatically apply ESLint suggestions.
 *
 * ESLint suggestions are fixes that aren't auto-applied by `--fix` because
 * they could theoretically change behavior. However, with strict TypeScript
 * typing, if removing a `?.` would crash, TypeScript would catch it at compile time.
 *
 * Usage:
 *   pnpm dlx tsx scripts/apply-eslint-suggestions.mts
 */

import { resolve } from "node:path";
import {
  Core,
  takeRuleStatistics,
  type SuggestionFilter,
} from "eslint-interactive";

const cwd = resolve(import.meta.dirname, "..");

console.log("🔍 Linting project to find suggestions...");

const core = new Core({
  patterns: ["src"],
  cwd,
  eslintOptions: {
    type: "flat",
  },
});

const results = await core.lint();
const statistics = takeRuleStatistics(results);

// Find rules that have suggestions
const rulesWithSuggestions = statistics.filter(
  (s) => s.hasSuggestionsCount > 0,
);

console.log("\n📊 Rules with suggestions:");
for (const stat of rulesWithSuggestions) {
  console.log(`  - ${stat.ruleId}: ${stat.hasSuggestionsCount} suggestions`);
}

if (rulesWithSuggestions.length === 0) {
  console.log("  (none)");
  process.exit(0);
}

// The filter function selects which suggestion to apply
// For most rules, we just pick the first (and usually only) suggestion
const defaultFilter: SuggestionFilter = ({ suggestions }) => {
  // Return the first suggestion if available
  if (!suggestions || suggestions.length === 0) {
    return null;
  }
  return suggestions[0] ?? null;
};

// Apply suggestions for each rule
for (const stat of rulesWithSuggestions) {
  console.log(
    `\n🔧 Applying ${stat.hasSuggestionsCount} suggestions for: ${stat.ruleId}`,
  );
  try {
    await core.applySuggestions(results, [stat.ruleId], defaultFilter);
    console.log(`   ✅ Done`);
  } catch (error) {
    console.error(`   ❌ Failed:`, error);
  }
}

console.log("\n✨ All suggestions applied!");
console.log("📝 Run `pnpm tsc --noEmit` to verify changes are type-safe.");
