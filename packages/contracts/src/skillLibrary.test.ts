import { describe, expect, it } from "@effect/vitest";

import { parseSkillLibraryRepository } from "./skillLibrary.ts";

describe("parseSkillLibraryRepository", () => {
  it("accepts the forms people paste and returns owner/repo", () => {
    for (const input of [
      "mattpocock/skills",
      " mattpocock/skills ",
      "github.com/mattpocock/skills",
      "https://github.com/mattpocock/skills",
      "https://www.github.com/mattpocock/skills.git",
      "https://github.com/mattpocock/skills/tree/main/skills/engineering",
    ]) {
      expect(parseSkillLibraryRepository(input)).toBe("mattpocock/skills");
    }
  });

  it("rejects anything that is not a GitHub repository", () => {
    for (const input of ["", "skills", "mattpocock/", "-bad/repo", "owner/..", "a b/c"]) {
      expect(parseSkillLibraryRepository(input)).toBeNull();
    }
  });
});
