import {
  AuthSettingsWriteScope,
  PROVIDER_DISPLAY_NAMES,
  parseSkillLibraryRepository,
  type EnvironmentId,
  type SkillLibraryConflict,
  type SkillLibrarySource,
  type SkillLibraryTarget,
} from "@t3tools/contracts";
import { ChevronDownIcon, MoreVertical, PlusIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import {
  skillLibraryAdd,
  skillLibraryRemove,
  skillLibrarySetEnabled,
  skillLibraryState,
  skillLibraryUpdate,
} from "../../state/skillLibrary";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

export function SkillsSettingsPanel() {
  const { environment } = useSettingsScope();
  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  return (
    <SettingsPageContainer>
      <SkillLibrarySection key={environmentId ?? "disconnected"} environmentId={environmentId} />
    </SettingsPageContainer>
  );
}

function SkillLibrarySection({ environmentId }: { environmentId: EnvironmentId | null }) {
  const canEdit = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const query = useEnvironmentQuery(
    environmentId === null ? null : skillLibraryState({ environmentId, input: {} }),
  );
  const add = useAtomCommand(skillLibraryAdd);
  const [draft, setDraft] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const repository = draft === null ? null : parseSkillLibraryRepository(draft);
  const state = query.data;

  const submit = async () => {
    if (environmentId === null || repository === null) return;
    setAdding(true);
    try {
      const result = await add({ environmentId, input: { repository } });
      if (result._tag === "Success") setDraft(null);
    } finally {
      setAdding(false);
    }
  };

  let body: ReactNode;
  if (environmentId === null) {
    body = <Notice>Connect this environment to manage its skills.</Notice>;
  } else if (state === null) {
    body = query.error ? (
      <Notice>{query.error}</Notice>
    ) : (
      <Notice>
        <Spinner className="size-3.5" /> Loading skills…
      </Notice>
    );
  } else if (state.sources.length === 0 && draft === null) {
    body = (
      <Notice>
        Add a GitHub repository of skills, such as mattpocock/skills. Every provider on this
        environment can use them.
      </Notice>
    );
  } else {
    body = state.sources.map((source) => (
      <SkillRepository
        key={source.repository}
        environmentId={environmentId}
        source={source}
        conflicts={state.conflicts.filter((conflict) => conflict.repository === source.repository)}
        canEdit={canEdit}
      />
    ));
  }

  return (
    <>
      <SettingsSection
        {...searchableSetting("skill-library")}
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={environmentId === null || !canEdit || draft !== null}
            onClick={() => setDraft("")}
          >
            <PlusIcon /> Add from GitHub
          </Button>
        }
      >
        {draft !== null ? (
          <form
            className="flex items-center gap-2 px-3 py-3 sm:px-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Input
              size="sm"
              autoFocus
              aria-label="GitHub repository"
              placeholder="owner/repo or a GitHub URL"
              value={draft}
              disabled={adding}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !adding) setDraft(null);
              }}
            />
            <Button size="sm" type="submit" disabled={repository === null || adding}>
              {adding ? "Adding…" : "Add"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              disabled={adding}
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
          </form>
        ) : null}
        {body}
      </SettingsSection>
      {state && state.sources.length > 0 ? <LinkedFolders targets={state.targets} /> : null}
    </>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground sm:px-4">
      {children}
    </p>
  );
}

function LinkedFolders({ targets }: { targets: ReadonlyArray<SkillLibraryTarget> }) {
  if (targets.length === 0) {
    return (
      <p className="px-3 text-xs text-muted-foreground sm:px-4">
        No enabled provider on this environment reads skills from a folder T3 can link into.
      </p>
    );
  }
  return (
    <div className="space-y-1 px-3 text-xs text-muted-foreground sm:px-4">
      <p>Skills are linked into:</p>
      <ul className="space-y-0.5">
        {targets.map((target) => (
          <li key={target.directory} className="flex flex-wrap gap-x-2">
            <code className="font-mono text-foreground/80">{target.directory}</code>
            <span>
              {target.drivers.map((driver) => PROVIDER_DISPLAY_NAMES[driver] ?? driver).join(", ")}
            </span>
          </li>
        ))}
      </ul>
      <p>Running agents see changes after Restart agent session.</p>
    </div>
  );
}

function SkillRepository({
  environmentId,
  source,
  conflicts,
  canEdit,
}: {
  environmentId: EnvironmentId;
  source: SkillLibrarySource;
  conflicts: ReadonlyArray<SkillLibraryConflict>;
  canEdit: boolean;
}) {
  const setEnabled = useAtomCommand(skillLibrarySetEnabled);
  const update = useAtomCommand(skillLibraryUpdate);
  const remove = useAtomCommand(skillLibraryRemove);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<"update" | "remove" | "toggle" | null>(null);
  const { repository } = source;
  const enabledCount = source.skills.filter((skill) => skill.enabled).length;
  const blockedSkills = new Set(conflicts.map((conflict) => conflict.skill));
  const disabled = !canEdit || busy !== null;

  const run = async (kind: NonNullable<typeof busy>, action: () => Promise<unknown>) => {
    setBusy(kind);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  };
  const toggle = (enabled: boolean, skill?: string) =>
    void run("toggle", () =>
      setEnabled({
        environmentId,
        input: { repository, enabled, ...(skill === undefined ? {} : { skill }) },
      }),
    );

  const summary = [
    `${enabledCount} of ${source.skills.length} on`,
    busy === "update" ? "updating…" : `updated ${formatRelativeTimeLabel(source.updatedAt)}`,
    ...(blockedSkills.size > 0 ? [`${blockedSkills.size} not linked`] : []),
  ].join(" · ");

  return (
    <div>
      <div className="flex items-center gap-3 px-3 py-3 sm:px-4">
        <RepositoryAvatar owner={repository.split("/")[0] ?? repository} />
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <span className="truncate">{repository}</span>
            <ChevronDownIcon
              className={cn("size-3.5 shrink-0 text-muted-foreground", expanded && "rotate-180")}
            />
          </span>
          <span className="block truncate text-xs text-muted-foreground">{summary}</span>
        </button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost-muted"
                disabled={disabled}
                aria-label={`${repository} options`}
              />
            }
          >
            <MoreVertical />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              onClick={() =>
                void run("update", () => update({ environmentId, input: { repository } }))
              }
            >
              Update
            </MenuItem>
            <MenuItem
              onClick={() =>
                void ensureLocalApi().shell.openExternal(`https://github.com/${repository}`)
              }
            >
              View on GitHub
            </MenuItem>
            <MenuItem
              variant="destructive"
              onClick={() =>
                void run("remove", () => remove({ environmentId, input: { repository } }))
              }
            >
              Remove
            </MenuItem>
          </MenuPopup>
        </Menu>
        <Switch
          aria-label={`Use skills from ${repository}`}
          checked={enabledCount === source.skills.length}
          mixed={enabledCount > 0 && enabledCount < source.skills.length}
          disabled={disabled}
          onCheckedChange={(checked) => toggle(checked)}
        />
      </div>
      {expanded ? (
        <ul className="divide-y divide-border/40 border-t border-border/50 bg-muted/20">
          {source.skills.map((skill) => (
            <li key={skill.name} className="flex items-start gap-3 py-2.5 ps-14 pe-3 sm:pe-4">
              <div className="min-w-0 flex-1">
                <p className="font-mono text-xs text-foreground">{skill.name}</p>
                {skill.description ? (
                  <p className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>
                ) : null}
                {skill.enabled && blockedSkills.has(skill.name) ? (
                  <p className="text-xs text-warning">
                    Not linked where another skill already uses this name.
                  </p>
                ) : null}
              </div>
              <Switch
                size="sm"
                aria-label={`Use ${skill.name}`}
                checked={skill.enabled}
                disabled={disabled}
                onCheckedChange={(checked) => toggle(checked, skill.name)}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The owner's GitHub avatar, falling back to their initial when it cannot load. */
function RepositoryAvatar({ owner }: { owner: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-muted text-sm font-medium text-muted-foreground">
      {failed ? (
        owner.slice(0, 1).toUpperCase()
      ) : (
        <img
          src={`https://github.com/${owner}.png?size=64`}
          alt=""
          className="size-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
