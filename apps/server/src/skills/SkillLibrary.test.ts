// @effect-diagnostics nodeBuiltinImport:off - fixtures build git remotes and inspect links synchronously, outside the service under test.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, SkillLibraryError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SkillLibrary from "./SkillLibrary.ts";

const CLAUDE_ID = ProviderInstanceId.make("claude-test");
const CODEX_ID = ProviderInstanceId.make("codex-test");

interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly claudeHome: string;
  /** Local stand-ins for GitHub, keyed by `owner/repo`. */
  readonly remotes: Map<string, string>;
}

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  })
    .toString()
    .trim();

const writeSkill = (directory: string, description: string) => {
  NodeFS.mkdirSync(directory, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(directory, "SKILL.md"),
    `---\nname: ${NodePath.basename(directory)}\ndescription: ${description}\n---\nBody\n`,
  );
};

/** Creates a git repository at `owner/repo` whose files are skill folders. */
const makeRemote = (sandbox: Sandbox, repository: string, skills: Record<string, string>) => {
  const directory = NodePath.join(sandbox.root, "remotes", repository);
  NodeFS.mkdirSync(directory, { recursive: true });
  git(directory, "init", "-q", "-b", "main");
  for (const [relative, description] of Object.entries(skills)) {
    writeSkill(NodePath.join(directory, relative), description);
  }
  NodeFS.writeFileSync(NodePath.join(directory, "README.md"), "fixture\n");
  git(directory, "add", "-A");
  git(directory, "commit", "-q", "-m", "init");
  sandbox.remotes.set(repository, directory);
  return directory;
};

const makeSandbox = (): Sandbox => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-skill-library-"));
  const home = NodePath.join(root, "home");
  const claudeHome = NodePath.join(root, "claude");
  NodeFS.mkdirSync(home, { recursive: true });
  return { root, home, claudeHome, remotes: new Map() };
};

const providerInstance = (instanceId: ProviderInstanceId, driver: string) =>
  ({
    instanceId,
    driverKind: ProviderDriverKind.make(driver),
    enabled: true,
  }) as unknown as ProviderInstance;

const makeLayer = (sandbox: Sandbox) => {
  const instances = [
    providerInstance(CLAUDE_ID, "claudeAgent"),
    providerInstance(CODEX_ID, "codex"),
  ];
  const layerInstanceRegistry = Layer.effect(
    ProviderInstanceRegistry.ProviderInstanceRegistry,
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<void>();
      return ProviderInstanceRegistry.ProviderInstanceRegistry.of({
        getInstance: (id) => Effect.succeed(instances.find((entry) => entry.instanceId === id)),
        listInstances: Effect.succeed(instances),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: PubSub.subscribe(changes),
      });
    }),
  );
  // Clones point at the local fixture remotes instead of GitHub.
  const layerGit = Layer.effect(
    GitVcsDriver.GitVcsDriver,
    GitVcsDriver.make.pipe(
      Effect.map((service) =>
        GitVcsDriver.GitVcsDriver.of({
          ...service,
          execute: (input) =>
            service.execute({
              ...input,
              args: input.args.map((arg) => {
                const repository = /^https:\/\/github\.com\/(.+)\.git$/.exec(arg)?.[1];
                const remote =
                  repository === undefined ? undefined : sandbox.remotes.get(repository);
                return remote === undefined ? arg : `file://${remote}`;
              }),
            }),
        }),
      ),
    ),
  ).pipe(Layer.provide(VcsProcess.layer));
  return SkillLibrary.layer.pipe(
    Layer.provide(layerInstanceRegistry),
    Layer.provide(layerGit),
    Layer.provide(
      ServerSettings.layerTest({
        providerInstances: {
          [CLAUDE_ID]: { driver: "claudeAgent", config: { homePath: sandbox.claudeHome } },
          [CODEX_ID]: {
            driver: "codex",
            environment: [{ name: "HOME", value: sandbox.home, sensitive: false }],
          },
        },
      }),
    ),
    Layer.provideMerge(ServerConfig.layerTest(sandbox.root, NodePath.join(sandbox.root, "t3"))),
    Layer.provideMerge(NodeServices.layer),
  );
};

const withLibrary = <A, E>(
  sandbox: Sandbox,
  body: (library: SkillLibrary.SkillLibrary["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const library = yield* SkillLibrary.SkillLibrary;
    return yield* body(library);
  }).pipe(
    Effect.provide(makeLayer(sandbox)),
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(sandbox.root, { recursive: true, force: true })),
    ),
  );

const agentsDirectory = (sandbox: Sandbox) => NodePath.join(sandbox.home, ".agents", "skills");
const claudeDirectory = (sandbox: Sandbox) => NodePath.join(sandbox.claudeHome, "skills");
const linkTarget = (link: string) =>
  NodeFS.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()
    ? NodeFS.realpathSync(link)
    : undefined;

describe("SkillLibrary", () => {
  it.effect(
    "links each skill once into every provider folder, preferring the generic build",
    () => {
      const sandbox = makeSandbox();
      // Shaped like repositories that ship one build per agent plus a skills folder.
      makeRemote(sandbox, "acme/design", {
        ".agents/skills/polish": "generic polish",
        ".cursor/skills/polish": "cursor polish",
        "skills/engineering/review": "code review",
      });
      return withLibrary(sandbox, (library) =>
        Effect.gen(function* () {
          const state = yield* library.add({ repository: "acme/design" });

          expect(state.sources).toHaveLength(1);
          expect(state.sources[0]?.skills).toEqual([
            { name: "review", description: "code review", enabled: true },
            { name: "polish", description: "generic polish", enabled: true },
          ]);
          expect(state.targets.map((target) => target.directory).toSorted()).toEqual(
            [agentsDirectory(sandbox), claudeDirectory(sandbox)].toSorted(),
          );
          expect(state.conflicts).toEqual([]);
          for (const directory of [agentsDirectory(sandbox), claudeDirectory(sandbox)]) {
            expect(linkTarget(NodePath.join(directory, "polish"))).toMatch(
              /acme[/\\]design[/\\]\.agents[/\\]skills[/\\]polish$/,
            );
            expect(
              NodeFS.readFileSync(NodePath.join(directory, "review", "SKILL.md"), "utf8"),
            ).toContain("code review");
          }
        }),
      );
    },
  );

  it.effect("never replaces a skill the user installed, and reports the clash", () => {
    const sandbox = makeSandbox();
    makeRemote(sandbox, "acme/tools", { "skills/review": "library review" });
    writeSkill(NodePath.join(agentsDirectory(sandbox), "review"), "my own review");
    return withLibrary(sandbox, (library) =>
      Effect.gen(function* () {
        const state = yield* library.add({ repository: "acme/tools" });

        expect(state.conflicts).toEqual([
          { repository: "acme/tools", skill: "review", directory: agentsDirectory(sandbox) },
        ]);
        expect(
          NodeFS.readFileSync(
            NodePath.join(agentsDirectory(sandbox), "review", "SKILL.md"),
            "utf8",
          ),
        ).toContain("my own review");
        expect(linkTarget(NodePath.join(claudeDirectory(sandbox), "review"))).toBeDefined();
      }),
    );
  });

  it.effect("turns skills off and back on, and removing a repository unlinks it", () => {
    const sandbox = makeSandbox();
    makeRemote(sandbox, "acme/tools", { "skills/review": "review", "skills/plan": "plan" });
    const reviewLink = NodePath.join(agentsDirectory(sandbox), "review");
    const planLink = NodePath.join(agentsDirectory(sandbox), "plan");
    return withLibrary(sandbox, (library) =>
      Effect.gen(function* () {
        yield* library.add({ repository: "acme/tools" });

        const off = yield* library.setEnabled({
          repository: "acme/tools",
          skill: "review",
          enabled: false,
        });
        expect(off.sources[0]?.skills.find((skill) => skill.name === "review")?.enabled).toBe(
          false,
        );
        expect(linkTarget(reviewLink)).toBeUndefined();
        expect(linkTarget(planLink)).toBeDefined();

        yield* library.setEnabled({ repository: "acme/tools", enabled: false });
        expect(linkTarget(planLink)).toBeUndefined();
        yield* library.setEnabled({ repository: "acme/tools", enabled: true });
        expect(linkTarget(reviewLink)).toBeDefined();

        const removed = yield* library.remove({ repository: "acme/tools" });
        expect(removed.sources).toEqual([]);
        expect(NodeFS.readdirSync(agentsDirectory(sandbox))).toEqual([]);
        expect(NodeFS.readdirSync(claudeDirectory(sandbox))).toEqual([]);
      }),
    );
  });

  it.effect("updates to the latest commit and leaves new skills off", () => {
    const sandbox = makeSandbox();
    const remote = makeRemote(sandbox, "acme/tools", { "skills/review": "review v1" });
    return withLibrary(sandbox, (library) =>
      Effect.gen(function* () {
        const added = yield* library.add({ repository: "acme/tools" });

        writeSkill(NodePath.join(remote, "skills", "review"), "review v2");
        writeSkill(NodePath.join(remote, "skills", "plan"), "plan");
        git(remote, "add", "-A");
        git(remote, "commit", "-q", "-m", "more");
        const updated = yield* library.update({ repository: "acme/tools" });

        expect(updated.sources[0]?.commit).toBe(git(remote, "rev-parse", "HEAD"));
        expect(updated.sources[0]?.commit).not.toBe(added.sources[0]?.commit);
        expect(updated.sources[0]?.skills).toEqual([
          { name: "plan", description: "plan", enabled: false },
          { name: "review", description: "review v2", enabled: true },
        ]);
        expect(linkTarget(NodePath.join(agentsDirectory(sandbox), "plan"))).toBeUndefined();
      }),
    );
  });

  it.effect("cleans up broken links left by another T3 install but keeps foreign links", () => {
    const sandbox = makeSandbox();
    makeRemote(sandbox, "acme/tools", { "skills/review": "review" });
    const agents = agentsDirectory(sandbox);
    NodeFS.mkdirSync(agents, { recursive: true });
    const gone = NodePath.join(
      sandbox.root,
      "old-worktree",
      "skill-library",
      "repos",
      "x",
      "y",
      "z",
    );
    NodeFS.symlinkSync(gone, NodePath.join(agents, "stale"));
    const elsewhere = NodePath.join(sandbox.root, "elsewhere");
    writeSkill(elsewhere, "hand linked");
    NodeFS.symlinkSync(elsewhere, NodePath.join(agents, "mine"));
    return withLibrary(sandbox, (library) =>
      Effect.gen(function* () {
        yield* library.add({ repository: "acme/tools" });

        expect(NodeFS.readdirSync(agents).toSorted()).toEqual(["mine", "review"]);
      }),
    );
  });

  it.effect("rejects repositories without skills and repeated adds", () => {
    const sandbox = makeSandbox();
    makeRemote(sandbox, "acme/empty", {});
    makeRemote(sandbox, "acme/tools", { "skills/review": "review" });
    return withLibrary(sandbox, (library) =>
      Effect.gen(function* () {
        const empty = yield* library.add({ repository: "acme/empty" }).pipe(Effect.flip);
        expect(empty).toBeInstanceOf(SkillLibraryError);
        expect(empty.reason).toBe("no_skills");

        yield* library.add({ repository: "acme/tools" });
        const again = yield* library.add({ repository: "ACME/Tools" }).pipe(Effect.flip);
        expect(again.reason).toBe("already_added");
        expect((yield* library.list).sources.map((source) => source.repository)).toEqual([
          "acme/tools",
        ]);
      }),
    );
  });
});
