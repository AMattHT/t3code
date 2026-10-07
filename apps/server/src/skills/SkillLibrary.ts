/**
 * SkillLibrary keeps GitHub skill repositories once per environment and links
 * each enabled skill into the skills folders providers already read, so one
 * install reaches every provider:
 *
 * - `~/.agents/skills`: Codex, Cursor, Grok, OpenCode, and Pi.
 * - Each Claude instance's `<config dir>/skills`; Claude ignores `.agents`.
 * - `~/.gemini/config/skills`: Antigravity, whose private profile links back to it.
 *
 * A link belongs to the library only when it points into this library's
 * `repos` folder, so reconciling never touches a skill installed by hand.
 *
 * @module skills/SkillLibrary
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's symlink has no type argument, and Windows needs a junction to link without elevation.
import * as NodeFSP from "node:fs/promises";

import {
  ClaudeSettings,
  IsoDateTime,
  ProviderDriverKind,
  SkillLibraryError,
  SkillLibraryRepository,
  type ProviderInstanceConfig,
  type SkillLibraryConflict,
  type SkillLibraryRepositoryInput,
  type SkillLibrarySetEnabledInput,
  type SkillLibraryState,
  type SkillLibraryTarget,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import {
  antigravityUserSkillDirectories,
  resolveAntigravityUserHome,
} from "../provider/Drivers/AntigravitySkills.ts";
import {
  parseSkillFrontmatter,
  resolveClaudeConfigDirPath,
} from "../provider/Drivers/ClaudeSkills.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const LIBRARY_DIRECTORY = "skill-library";
/** Every library's checkouts sit below this segment; see `isStaleLibraryLink`. */
const REPOSITORIES_DIRECTORY = "repos";
const MANIFEST_FILE = "library.json";
const DOWNLOAD_TIMEOUT_MS = 120_000;
// No tty means a credential prompt would hang forever, so tell git to fail.
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "__pycache__"]);
// The folder name becomes the link name in provider folders.
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const AGENTS_DRIVERS = new Set(
  ["codex", "cursor", "grok", "opencode", "pi"].map((kind) => ProviderDriverKind.make(kind)),
);
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const ANTIGRAVITY_DRIVER = ProviderDriverKind.make("antigravity");

const ManifestSource = Schema.Struct({
  repository: SkillLibraryRepository,
  commit: Schema.String,
  updatedAt: IsoDateTime,
  enabledSkills: Schema.Array(Schema.String),
});
type ManifestSource = typeof ManifestSource.Type;

const Manifest = Schema.Struct({ sources: Schema.Array(ManifestSource) });
type Manifest = typeof Manifest.Type;

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

interface RepositorySkill {
  readonly name: string;
  readonly directory: string;
  readonly description?: string;
}

interface LinkPlan {
  readonly targets: ReadonlyArray<SkillLibraryTarget>;
  readonly conflicts: ReadonlyArray<SkillLibraryConflict>;
  readonly create: ReadonlyArray<{ readonly link: string; readonly target: string }>;
  readonly remove: ReadonlyArray<string>;
}

const sameRepository = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

export class SkillLibrary extends Context.Service<
  SkillLibrary,
  {
    readonly list: Effect.Effect<SkillLibraryState, SkillLibraryError>;
    readonly add: (
      input: SkillLibraryRepositoryInput,
    ) => Effect.Effect<SkillLibraryState, SkillLibraryError>;
    /** Pulls the repository's latest default branch. */
    readonly update: (
      input: SkillLibraryRepositoryInput,
    ) => Effect.Effect<SkillLibraryState, SkillLibraryError>;
    readonly remove: (
      input: SkillLibraryRepositoryInput,
    ) => Effect.Effect<SkillLibraryState, SkillLibraryError>;
    readonly setEnabled: (
      input: SkillLibrarySetEnabledInput,
    ) => Effect.Effect<SkillLibraryState, SkillLibraryError>;
    /** Makes provider folders match the library; runs on start and provider changes. */
    readonly reconcile: Effect.Effect<void, SkillLibraryError>;
  }
>()("t3/skills/SkillLibrary") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const instanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const platform = yield* HostProcessPlatform;
  const lock = yield* Semaphore.make(1);

  const libraryRoot = path.join(config.stateDir, LIBRARY_DIRECTORY);
  const repositoriesRoot = path.join(libraryRoot, REPOSITORIES_DIRECTORY);
  const manifestPath = path.join(libraryRoot, MANIFEST_FILE);
  const checkoutPath = (repository: string) =>
    path.join(repositoriesRoot, ...repository.toLowerCase().split("/"));
  const isInside = (root: string, candidate: string) =>
    candidate === root || candidate.startsWith(`${root}${path.sep}`);

  const storageError =
    (operation: SkillLibraryError["operation"], repository?: string) => (cause: unknown) =>
      new SkillLibraryError({
        operation,
        reason: "storage_failed",
        ...(repository === undefined ? {} : { repository }),
        cause,
      });

  const readManifest = (operation: SkillLibraryError["operation"]) =>
    fs.readFileString(manifestPath).pipe(
      Effect.flatMap(decodeManifest),
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed<Manifest>({ sources: [] }),
      ),
      Effect.mapError(storageError(operation)),
    );

  const writeManifest = (operation: SkillLibraryError["operation"], manifest: Manifest) =>
    writeFileStringAtomically({
      filePath: manifestPath,
      contents: `${JSON.stringify(manifest, null, 2)}\n`,
    }).pipe(Effect.mapError(storageError(operation)));

  /** A link's absolute target, or undefined when the entry is not a link. */
  const readLinkTarget = (link: string) =>
    fs.readLink(link).pipe(
      Effect.map((value): string | undefined => path.resolve(path.dirname(link), value)),
      Effect.orElseSucceed(() => undefined),
    );

  const isDirectory = (candidate: string) =>
    fs.stat(candidate).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  const readSkill = Effect.fn("SkillLibrary.readSkill")(function* (
    name: string,
    directory: string,
  ) {
    const skillFile = path.join(directory, "SKILL.md");
    const info = yield* fs.stat(skillFile).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return undefined;
    if (!SKILL_NAME_PATTERN.test(name)) return undefined;
    const contents =
      info.value.size <= MAX_SKILL_FILE_BYTES
        ? yield* fs.readFileString(skillFile).pipe(Effect.orElseSucceed(() => ""))
        : "";
    const frontmatter = parseSkillFrontmatter(contents);
    const description = frontmatter.kind === "parsed" ? frontmatter.description : undefined;
    return {
      name,
      directory,
      ...(description ? { description } : {}),
    } satisfies RepositorySkill;
  });

  /**
   * Finds skills the way `npx skills add` does: a root SKILL.md is the whole
   * repository; otherwise the common containers in priority order, and only
   * when those are empty, a bounded walk of everything. Repositories that ship
   * one build per agent (`.claude/skills`, `.cursor/skills`, ...) resolve to
   * the first copy because the first folder with a name wins. Links inside a
   * checkout are skipped so a repository cannot point a skill elsewhere on disk.
   */
  const discoverSkills = Effect.fn("SkillLibrary.discoverSkills")(function* (repository: string) {
    const root = checkoutPath(repository);
    const rootSkill = yield* readSkill(repository.split("/")[1] ?? "", root);
    if (rootSkill) return [rootSkill];

    const found = new Map<string, RepositorySkill>();
    const walk = (directory: string, depth: number, maxDepth: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        const entries = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
        for (const entry of [...entries].sort()) {
          if (SKIP_DIRECTORIES.has(entry)) continue;
          const child = path.join(directory, entry);
          if ((yield* readLinkTarget(child)) !== undefined) continue;
          if (!(yield* isDirectory(child))) continue;
          const skill = yield* readSkill(entry, child);
          if (skill) {
            if (!found.has(skill.name)) found.set(skill.name, skill);
            continue;
          }
          if (depth < maxDepth) yield* walk(child, depth + 1, maxDepth);
        }
      });

    yield* walk(root, 1, 1);
    for (const container of ["skills", ".agents/skills", ".claude/skills"]) {
      yield* walk(path.join(root, ...container.split("/")), 1, 3);
    }
    if (found.size === 0) yield* walk(root, 1, 5);
    return [...found.values()];
  });

  /** The skills folder each provider instance reads, or undefined when unsupported. */
  const skillsDirectoryFor = Effect.fn("SkillLibrary.skillsDirectoryFor")(function* (
    instance: ProviderInstanceConfig,
  ) {
    const environment = mergeProviderInstanceEnvironment(instance.environment, process.env);
    const home = resolveAntigravityUserHome(platform, environment);
    if (instance.driver === CLAUDE_DRIVER) {
      const settings = decodeClaudeSettings(instance.config ?? {});
      if (Option.isNone(settings)) return undefined;
      const configDirectory = yield* resolveClaudeConfigDirPath(settings.value, environment);
      return path.join(configDirectory, "skills");
    }
    if (instance.driver === ANTIGRAVITY_DRIVER) {
      return antigravityUserSkillDirectories(path, path.join(home, ".gemini"))[0];
    }
    if (AGENTS_DRIVERS.has(instance.driver)) {
      return path.join(home, ".agents", "skills");
    }
    // ACP registry agents load skills in ways T3 cannot see.
    return undefined;
  });

  const resolveTargets = Effect.fn("SkillLibrary.resolveTargets")(function* (
    operation: SkillLibraryError["operation"],
  ) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(storageError(operation)),
    );
    const configs = deriveProviderInstanceConfigMap(settings);
    const drivers = new Map<string, Set<ProviderDriverKind>>();
    for (const instance of yield* instanceRegistry.listInstances) {
      const instanceConfig = configs[instance.instanceId];
      if (!instance.enabled || instanceConfig === undefined) continue;
      const directory = yield* skillsDirectoryFor(instanceConfig);
      if (directory === undefined) continue;
      const kinds = drivers.get(directory) ?? new Set<ProviderDriverKind>();
      kinds.add(instance.driverKind);
      drivers.set(directory, kinds);
    }
    return [...drivers].map(([directory, kinds]) => ({ directory, drivers: [...kinds] }));
  });

  /**
   * A link from another T3 install on this machine (a deleted dev worktree,
   * say) whose checkout no longer exists. Removing it is safe: the link is
   * already broken, and its target path proves it was a library link.
   */
  const isStaleLibraryLink = (target: string) =>
    target.includes(
      `${path.sep}${LIBRARY_DIRECTORY}${path.sep}${REPOSITORIES_DIRECTORY}${path.sep}`,
    )
      ? fs.exists(target).pipe(
          Effect.map((exists) => !exists),
          Effect.orElseSucceed(() => false),
        )
      : Effect.succeed(false);

  /**
   * Works out the links each provider folder should hold. The first enabled
   * skill with a name claims it; a later repository's skill of the same name,
   * or a folder entry T3 does not own, makes that skill a conflict there.
   */
  const planLinks = Effect.fn("SkillLibrary.planLinks")(function* (
    operation: SkillLibraryError["operation"],
    manifest: Manifest,
  ) {
    const targets = yield* resolveTargets(operation);
    const owners = new Map<
      string,
      RepositorySkill & { readonly repository: SkillLibraryRepository }
    >();
    const shadowed: Array<{ readonly repository: SkillLibraryRepository; readonly name: string }> =
      [];
    for (const source of manifest.sources) {
      for (const skill of yield* discoverSkills(source.repository)) {
        if (!source.enabledSkills.includes(skill.name)) continue;
        if (owners.has(skill.name))
          shadowed.push({ repository: source.repository, name: skill.name });
        else owners.set(skill.name, { ...skill, repository: source.repository });
      }
    }

    const conflicts: Array<SkillLibraryConflict> = [];
    const create: Array<{ link: string; target: string }> = [];
    const remove: Array<string> = [];
    for (const { directory } of targets) {
      const linked = new Set<string>();
      const blocked = new Set<string>();
      for (const entry of yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []))) {
        const link = path.join(directory, entry);
        const target = yield* readLinkTarget(link);
        if (target !== undefined && isInside(repositoriesRoot, target)) {
          if (owners.get(entry)?.directory === target) linked.add(entry);
          else remove.push(link);
        } else if (target !== undefined && (yield* isStaleLibraryLink(target))) {
          remove.push(link);
        } else {
          blocked.add(entry);
        }
      }
      for (const [name, owner] of owners) {
        if (linked.has(name)) continue;
        if (blocked.has(name)) {
          conflicts.push({ repository: owner.repository, skill: name, directory });
        } else {
          create.push({ link: path.join(directory, name), target: owner.directory });
        }
      }
      for (const { repository, name } of shadowed) {
        conflicts.push({ repository, skill: name, directory });
      }
    }
    return { targets, conflicts, create, remove } satisfies LinkPlan;
  });

  const applyPlan = Effect.fn("SkillLibrary.applyPlan")(function* (plan: LinkPlan) {
    for (const link of plan.remove) {
      yield* fs
        .remove(link)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not remove a skill library link.", { link, error }),
          ),
        );
    }
    for (const { link, target } of plan.create) {
      yield* Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(link), { recursive: true });
        // Junctions need no privileges on Windows, unlike directory symlinks.
        yield* Effect.tryPromise(() =>
          NodeFSP.symlink(target, link, platform === "win32" ? "junction" : "dir"),
        );
      }).pipe(
        // A provider folder T3 cannot write only costs that provider the skill.
        Effect.catch((error) =>
          Effect.logWarning("Could not link a skill into a provider folder.", { link, error }),
        ),
      );
    }
  });

  const stateFrom = Effect.fn("SkillLibrary.stateFrom")(function* (
    manifest: Manifest,
    plan: LinkPlan,
  ) {
    const sources = yield* Effect.forEach(manifest.sources, (source) =>
      discoverSkills(source.repository).pipe(
        Effect.map((skills) => ({
          repository: source.repository,
          commit: source.commit,
          updatedAt: source.updatedAt,
          skills: skills.map((skill) => ({
            name: skill.name,
            ...(skill.description ? { description: skill.description } : {}),
            enabled: source.enabledSkills.includes(skill.name),
          })),
        })),
      ),
    );
    return {
      sources,
      targets: plan.targets,
      conflicts: plan.conflicts,
    } satisfies SkillLibraryState;
  });

  /** Applies the manifest to provider folders and returns the resulting state. */
  const sync = Effect.fn("SkillLibrary.sync")(function* (
    operation: SkillLibraryError["operation"],
    manifest: Manifest,
  ) {
    const plan = yield* planLinks(operation, manifest);
    yield* applyPlan(plan);
    return yield* stateFrom(manifest, plan);
  });

  const findSource = (
    operation: SkillLibraryError["operation"],
    manifest: Manifest,
    repository: string,
  ) => {
    const source = manifest.sources.find((candidate) =>
      sameRepository(candidate.repository, repository),
    );
    return source === undefined
      ? Effect.fail(new SkillLibraryError({ operation, reason: "not_added", repository }))
      : Effect.succeed(source);
  };

  const headCommit = (operation: SkillLibraryError["operation"], repository: string, cwd: string) =>
    git.execute({ operation: "SkillLibrary.headCommit", cwd, args: ["rev-parse", "HEAD"] }).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.mapError(storageError(operation, repository)),
    );

  const list = Effect.gen(function* () {
    const manifest = yield* readManifest("list");
    return yield* stateFrom(manifest, yield* planLinks("list", manifest));
  }).pipe(Effect.withSpan("SkillLibrary.list"));

  const add = Effect.fn("SkillLibrary.add")(function* (input: SkillLibraryRepositoryInput) {
    const { repository } = input;
    const manifest = yield* readManifest("add");
    if (manifest.sources.some((source) => sameRepository(source.repository, repository))) {
      return yield* new SkillLibraryError({
        operation: "add",
        reason: "already_added",
        repository,
      });
    }
    const destination = checkoutPath(repository);
    const storageFailed = storageError("add", repository);
    // Clone beside the destination and move it into place, so a failed or
    // interrupted download never leaves a half checkout where skills are read.
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
        const staging = yield* Effect.acquireRelease(
          fs.makeTempDirectory({ directory: repositoriesRoot, prefix: ".download-" }),
          (directory) => fs.remove(directory, { recursive: true }).pipe(Effect.ignore),
        );
        yield* git
          .execute({
            operation: "SkillLibrary.add",
            cwd: staging,
            args: ["clone", "--depth", "1", "--", `https://github.com/${repository}.git`, "repo"],
            env: GIT_ENV,
            timeoutMs: DOWNLOAD_TIMEOUT_MS,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SkillLibraryError({
                  operation: "add",
                  reason: "download_failed",
                  repository,
                  cause,
                }),
            ),
          );
        // A leftover checkout from an earlier failed add is not in the manifest.
        yield* fs
          .remove(destination, { recursive: true, force: true })
          .pipe(Effect.mapError(storageFailed));
        yield* fs
          .rename(path.join(staging, "repo"), destination)
          .pipe(Effect.mapError(storageFailed));
      }).pipe(Effect.catchTags({ PlatformError: (cause) => Effect.fail(storageFailed(cause)) })),
    );

    const skills = yield* discoverSkills(repository);
    if (skills.length === 0) {
      yield* fs.remove(destination, { recursive: true }).pipe(Effect.ignore);
      return yield* new SkillLibraryError({ operation: "add", reason: "no_skills", repository });
    }
    const next: Manifest = {
      sources: [
        ...manifest.sources,
        {
          repository,
          commit: yield* headCommit("add", repository, destination),
          updatedAt: DateTime.formatIso(yield* DateTime.now),
          enabledSkills: skills.map((skill) => skill.name),
        },
      ],
    };
    yield* writeManifest("add", next);
    return yield* sync("add", next);
  });

  const update = Effect.fn("SkillLibrary.update")(function* (input: SkillLibraryRepositoryInput) {
    const manifest = yield* readManifest("update");
    const source = yield* findSource("update", manifest, input.repository);
    const cwd = checkoutPath(source.repository);
    const downloadError = (cause: unknown) =>
      new SkillLibraryError({
        operation: "update",
        reason: "download_failed",
        repository: source.repository,
        cause,
      });
    yield* git
      .execute({
        operation: "SkillLibrary.update",
        cwd,
        args: ["fetch", "--depth", "1", "origin", "HEAD"],
        env: GIT_ENV,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
      })
      .pipe(Effect.mapError(downloadError));
    yield* git
      .execute({
        operation: "SkillLibrary.update",
        cwd,
        args: ["reset", "--hard", "FETCH_HEAD"],
        env: GIT_ENV,
      })
      .pipe(Effect.mapError(downloadError));
    const commit = yield* headCommit("update", source.repository, cwd);
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const updated: Manifest = {
      sources: manifest.sources.map((candidate) =>
        candidate === source ? { ...candidate, commit, updatedAt } : candidate,
      ),
    };
    yield* writeManifest("update", updated);
    return yield* sync("update", updated);
  });

  const remove = Effect.fn("SkillLibrary.remove")(function* (input: SkillLibraryRepositoryInput) {
    const manifest = yield* readManifest("remove");
    const source = yield* findSource("remove", manifest, input.repository);
    const next: Manifest = {
      sources: manifest.sources.filter((candidate) => candidate !== source),
    };
    yield* writeManifest("remove", next);
    // Unlink before deleting so provider folders never hold broken links.
    const state = yield* sync("remove", next);
    yield* fs
      .remove(checkoutPath(source.repository), { recursive: true })
      .pipe(Effect.mapError(storageError("remove", source.repository)));
    return state;
  });

  const setEnabled = Effect.fn("SkillLibrary.setEnabled")(function* (
    input: SkillLibrarySetEnabledInput,
  ) {
    const manifest = yield* readManifest("setEnabled");
    const source = yield* findSource("setEnabled", manifest, input.repository);
    const available = (yield* discoverSkills(source.repository)).map((skill) => skill.name);
    if (input.skill !== undefined && !available.includes(input.skill)) {
      return yield* new SkillLibraryError({
        operation: "setEnabled",
        reason: "unknown_skill",
        repository: source.repository,
      });
    }
    const changed = input.skill === undefined ? available : [input.skill];
    const enabledSkills = input.enabled
      ? [...new Set([...source.enabledSkills, ...changed])]
      : source.enabledSkills.filter((name) => !changed.includes(name));
    const next: Manifest = {
      sources: manifest.sources.map((candidate) =>
        candidate === source ? { ...candidate, enabledSkills } : candidate,
      ),
    };
    yield* writeManifest("setEnabled", next);
    return yield* sync("setEnabled", next);
  });

  const reconcile = Effect.gen(function* () {
    yield* applyPlan(yield* planLinks("list", yield* readManifest("list")));
  }).pipe(Effect.withSpan("SkillLibrary.reconcile"));

  const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const serialized = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    lock.withPermits(1)(run(effect));

  return SkillLibrary.of({
    list: run(list),
    add: (input) => serialized(add(input)),
    update: (input) => serialized(update(input)),
    remove: (input) => serialized(remove(input)),
    setEnabled: (input) => serialized(setEnabled(input)),
    reconcile: serialized(reconcile),
  });
});

/**
 * Reconciles in the background on start and whenever provider instances
 * change, so a new Claude home or a newly enabled provider gets the skills.
 */
export const layer = Layer.effect(
  SkillLibrary,
  Effect.gen(function* () {
    const library = yield* make;
    const instanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const changes = yield* instanceRegistry.subscribeChanges;
    const reconcileLogged = library.reconcile.pipe(
      Effect.catch((error) => Effect.logWarning("Skill library reconcile failed.", { error })),
    );
    yield* Effect.forkScoped(
      reconcileLogged.pipe(
        Effect.andThen(Stream.runForEach(Stream.fromSubscription(changes), () => reconcileLogged)),
      ),
    );
    return library;
  }),
);
