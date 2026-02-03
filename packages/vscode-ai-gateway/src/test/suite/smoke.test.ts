/// <reference types="mocha" />

import * as assert from "node:assert/strict";
import * as vscode from "vscode";

suite("Smoke tests", () => {
  test("basic test runs", function () {
    console.log("Basic test is running!");
    assert.ok(true, "Basic test passed");
  });

  test("vscode API is available", function () {
    console.log("Checking vscode API...");
    assert.ok(vscode, "vscode should exist");
    assert.ok(vscode.extensions, "vscode.extensions should exist");
    console.log("vscode API is available");
  });

  test("can list extensions", function () {
    console.log("Listing extensions...");
    const extensions = vscode.extensions.all;
    console.log(`Found ${extensions.length} extensions`);
    assert.ok(extensions.length >= 0, "Should be able to list extensions");
  });
});
