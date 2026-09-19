export default {
  branches: ["main"],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/changelog",
    [
      "@semantic-release/npm",
      {
        npmPublish: false,
      },
    ],
    [
      // build AFTER the npm plugin bumped package.json, so binaries embed the new version
      // NOTE: exec v7 option is `prepareCmd` (`prepareCommand` is silently ignored!)
      "@semantic-release/exec",
      {
        prepareCmd: "bun run build",
      },
    ],
    [
      "@semantic-release/git",
      {
        assets: ["package.json", "CHANGELOG.md"],
        message:
          "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
      },
    ],
    [
      "@semantic-release/github",
      {
        assets: [{ path: "dist/squanchy-*", label: "squanchy binary" }],
      },
    ],
  ],
};
