/**
 * Minimal VS Code Extension Test Runner
 *
 * No Mocha required - just runs async functions and reports results.
 * This avoids ESM/CJS compatibility issues with Mocha.
 */

import * as vscode from "vscode";

interface TestResult {
  name: string;
  passed: boolean;
  error?: Error;
  duration: number;
}

type TestFn = () => Promise<void> | void;

const tests: { name: string; fn: TestFn }[] = [];

// Simple test registration
export function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

// Run all registered tests
async function runTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (const { name, fn } of tests) {
    const start = Date.now();
    try {
      await fn();
      results.push({ name, passed: true, duration: Date.now() - start });
      console.log(`  ✓ ${name} (${Date.now() - start}ms)`);
    } catch (err) {
      results.push({
        name,
        passed: false,
        error: err instanceof Error ? err : new Error(String(err)),
        duration: Date.now() - start,
      });
      console.log(`  ✗ ${name} (${Date.now() - start}ms)`);
      console.log(`    ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return results;
}

// ============== TESTS ==============

test("Extension should be present", async () => {
  const ext = vscode.extensions.getExtension("vercel.vscode-ai-gateway");
  if (!ext) {
    throw new Error("Extension not found");
  }
});

test("Extension should activate", async () => {
  const ext = vscode.extensions.getExtension("vercel.vscode-ai-gateway");
  if (!ext) {
    throw new Error("Extension not found");
  }
  await ext.activate();
});

test("vscode.lm API should be available", async () => {
  if (!vscode.lm) {
    throw new Error("vscode.lm API not available");
  }
  console.log("    vscode.lm methods:", Object.keys(vscode.lm));
});

test("selectChatModels should return Vercel models", async () => {
  // Wait a moment for extension to fully initialize and register models
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const allModels = await vscode.lm.selectChatModels();
  const vercelModels = await vscode.lm.selectChatModels({
    vendor: "vercel",
  });

  console.log(`    Total models: ${allModels.length}`);
  console.log(`    Vercel models: ${vercelModels.length}`);

  if (vercelModels.length === 0) {
    console.log("    NOTE: No Vercel models found.");
    console.log("    This is expected if VERCEL_API_KEY env var is not set.");
    console.log("    Set VERCEL_API_KEY to test with real models.");
  }

  // Categorize all models by vendor for visibility
  const byVendor = new Map<string, typeof allModels>();
  for (const model of allModels) {
    const list = byVendor.get(model.vendor) ?? [];
    list.push(model);
    byVendor.set(model.vendor, list);
  }

  for (const [vendor, vendorModels] of byVendor) {
    console.log(`    ${vendor}: ${vendorModels.length} models`);
    for (const m of vendorModels.slice(0, 3)) {
      console.log(`      - ${m.family} (${m.id})`);
    }
    if (vendorModels.length > 3) {
      console.log(`      ... and ${vendorModels.length - 3} more`);
    }
  }
});
// ============== ENTRY POINT ==============

export async function run(): Promise<void> {
  console.log("\n=== VS Code Extension Integration Tests ===\n");

  const results = await runTests();

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  if (failed > 0) {
    throw new Error(`${failed} test(s) failed`);
  }
}
