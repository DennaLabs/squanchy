import type { PrBundle } from "../../src/github/pr";

export const fixtureBundle: PrBundle = {
  repo: "acme/widgets",
  prNumber: 42,
  title: "Add login endpoint",
  body: "Implements POST /login with password auth.",
  author: "dev1",
  baseSha: "aaa111",
  headSha: "bbb222",
  truncated: false,
  files: [
    {
      path: "src/login.ts",
      status: "modified",
      additions: 3,
      deletions: 1,
      patch: ["@@ -1,4 +1,6 @@", " import x from 'y';", "+const q = req.body.q;", "+db.run(`SELECT ${q}`);", " export {};"].join("\n"),
    },
    {
      path: "README.md",
      status: "added",
      additions: 1,
      deletions: 0,
      patch: "@@ -0,0 +1 @@\n+hello",
    },
  ],
};
