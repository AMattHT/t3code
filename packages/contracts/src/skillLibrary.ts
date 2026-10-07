import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

/**
 * Skill repositories the environment keeps once and links into every
 * provider's own skills folder. Repositories are GitHub `owner/repo` slugs.
 */

const GITHUB_REPOSITORY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

/**
 * Accepts `owner/repo`, `github.com/owner/repo`, or a GitHub URL (with or
 * without `.git` or a trailing path) and returns `owner/repo`, or null.
 */
export function parseSkillLibraryRepository(input: string): string | null {
  const trimmed = input.trim().replace(/^https?:\/\//i, "");
  const withoutHost = trimmed.replace(/^(?:www\.)?github\.com\//i, "");
  const [owner, rawRepo] = withoutHost.split(/[/?#]/);
  if (!owner || !rawRepo) return null;
  const repository = `${owner}/${rawRepo.replace(/\.git$/i, "")}`;
  return GITHUB_REPOSITORY_PATTERN.test(repository) ? repository : null;
}

export const SkillLibraryRepository = TrimmedNonEmptyString.check(
  Schema.isPattern(GITHUB_REPOSITORY_PATTERN),
);
export type SkillLibraryRepository = typeof SkillLibraryRepository.Type;

export const SkillLibrarySkill = Schema.Struct({
  /** Folder name, which is also the skill's name in every provider. */
  name: Schema.String,
  description: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
});
export type SkillLibrarySkill = typeof SkillLibrarySkill.Type;

export const SkillLibrarySource = Schema.Struct({
  repository: SkillLibraryRepository,
  commit: Schema.String,
  updatedAt: IsoDateTime,
  skills: Schema.Array(SkillLibrarySkill),
});
export type SkillLibrarySource = typeof SkillLibrarySource.Type;

/** A provider skills folder the library links into. */
export const SkillLibraryTarget = Schema.Struct({
  directory: Schema.String,
  drivers: Schema.Array(ProviderDriverKind),
});
export type SkillLibraryTarget = typeof SkillLibraryTarget.Type;

/**
 * An enabled skill that could not be linked into `directory` because another
 * skill there, or one from an earlier repository, already has its name.
 */
export const SkillLibraryConflict = Schema.Struct({
  repository: SkillLibraryRepository,
  skill: Schema.String,
  directory: Schema.String,
});
export type SkillLibraryConflict = typeof SkillLibraryConflict.Type;

export const SkillLibraryState = Schema.Struct({
  sources: Schema.Array(SkillLibrarySource),
  targets: Schema.Array(SkillLibraryTarget),
  conflicts: Schema.Array(SkillLibraryConflict),
});
export type SkillLibraryState = typeof SkillLibraryState.Type;

export const SkillLibraryRepositoryInput = Schema.Struct({
  repository: SkillLibraryRepository,
});
export type SkillLibraryRepositoryInput = typeof SkillLibraryRepositoryInput.Type;

export const SkillLibrarySetEnabledInput = Schema.Struct({
  repository: SkillLibraryRepository,
  /** One skill, or every skill in the repository when omitted. */
  skill: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
});
export type SkillLibrarySetEnabledInput = typeof SkillLibrarySetEnabledInput.Type;

export class SkillLibraryError extends Schema.TaggedError<SkillLibraryError>()(
  "SkillLibraryError",
  {
    operation: Schema.Literals(["list", "add", "update", "remove", "setEnabled"]),
    reason: Schema.Literals([
      "already_added",
      "not_added",
      "unknown_skill",
      "download_failed",
      "no_skills",
      "storage_failed",
    ]),
    repository: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const repository = this.repository ?? "The repository";
    return {
      already_added: `${repository} is already in your skills.`,
      not_added: `${repository} is not in your skills.`,
      unknown_skill: `${repository} has no skill by that name.`,
      download_failed: `${repository} could not be downloaded. Check that it is a public GitHub repository and that this environment can reach GitHub.`,
      no_skills: `${repository} has no SKILL.md files.`,
      storage_failed: "The skill library could not be read or saved on this environment.",
    }[this.reason];
  }
}
