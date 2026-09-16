import { describe, expect, test } from "bun:test";
import { parseDepths, DEFAULT_DEPTHS } from "../src/review/depth";

describe("parseDepths", () => {
  test("parses csv list", () => {
    expect(parseDepths("vulnerabilities,major")).toEqual(["vulnerabilities", "major"]);
  });
  test("rejects unknown", () => {
    expect(() => parseDepths("vulnerabilities,bogus")).toThrow();
  });
  test("default is vulnerabilities+major", () => {
    expect(DEFAULT_DEPTHS).toEqual(["vulnerabilities", "major"]);
  });
  test("full expands to everything", () => {
    expect(parseDepths("full")).toEqual(["vulnerabilities", "major", "minor", "nits", "full"]);
  });
  test("dedupes and trims", () => {
    expect(parseDepths(" major , nits ,major ")).toEqual(["major", "nits"]);
  });
});
