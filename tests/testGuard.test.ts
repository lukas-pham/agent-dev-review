import { describe, expect, it } from "vitest";
import { detectWeakenedTests } from "../src/core/testGuard";

const diff = (file: string, body: string, extra = "") => `diff --git a/${file} b/${file}\n${extra}--- a/${file}\n+++ b/${file}\n@@ -1,5 +1,5 @@\n${body}`;

describe("detectWeakenedTests", () => {
  it("flags removed assertions", () => {
    const out = detectWeakenedTests(diff("app/x.test.ts", ` it("works", () => {\n-  expect(sum(1, 2)).toBe(3);\n+  // TODO\n });`));
    expect(out.some((i) => /assertion/.test(i.title))).toBe(true);
  });
  it("flags skipped tests", () => {
    const out = detectWeakenedTests(diff("tests/a.spec.ts", `-it("a", () => {})\n+it.skip("a", () => {})`));
    expect(out.some((i) => /disabled/.test(i.title))).toBe(true);
  });
  it("flags deleted test files", () => {
    const out = detectWeakenedTests(diff("app/y.test.ts", "-x", "deleted file mode 100644\n"));
    expect(out[0].title).toMatch(/deleted/);
  });
  it("ignores non-test files", () => {
    expect(detectWeakenedTests(diff("app/y.ts", "-expect(1)"))).toHaveLength(0);
  });
  it("does not flag added tests", () => {
    expect(detectWeakenedTests(diff("app/z.test.ts", `+it("new", () => {\n+  expect(f()).toBe(2);\n+});`))).toHaveLength(0);
  });
});
