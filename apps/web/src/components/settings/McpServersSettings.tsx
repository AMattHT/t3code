import {
  AuthSettingsWriteScope,
  parseMcpServerUrl,
  type EnvironmentId,
  type McpServerEntry,
} from "@t3tools/contracts";
import { ChevronDownIcon, MoreVertical, PlusIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { ensureLocalApi } from "../../localApi";
import {
  mcpServersAdd,
  mcpServersRemove,
  mcpServersSetEnabled,
  mcpServersSignIn,
  mcpServersSignOut,
  mcpServersState,
} from "../../state/mcpServers";
import { useEnvironmentQuery } from "../../state/query";
import { readPreparedConnection, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

// How often the list is re-read while a browser sign-in is open, and for how long.
const SIGN_IN_POLL_MS = 2_000;
const SIGN_IN_WAIT_MS = 5 * 60_000;

export function McpServersSettingsPanel() {
  const { environment } = useSettingsScope();
  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  return (
    <SettingsPageContainer>
      <McpServersSection key={environmentId ?? "disconnected"} environmentId={environmentId} />
    </SettingsPageContainer>
  );
}

function McpServersSection({ environmentId }: { environmentId: EnvironmentId | null }) {
  const canEdit = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const query = useEnvironmentQuery(
    environmentId === null ? null : mcpServersState({ environmentId, input: {} }),
  );
  const add = useAtomCommand(mcpServersAdd);
  const [draft, setDraft] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // The server whose sign-in page is open, and when it was opened.
  const [awaiting, setAwaiting] = useState<{ readonly id: string; readonly since: number } | null>(
    null,
  );
  const url = draft === null ? null : parseMcpServerUrl(draft);
  const state = query.data;
  const awaitingEntry = state?.servers.find((server) => server.id === awaiting?.id);
  const stillAwaiting = awaiting !== null && awaitingEntry?.status !== "connected";
  const { refresh } = query;

  useEffect(() => {
    if (!stillAwaiting || awaiting === null) return;
    const timer = window.setInterval(() => {
      if (Date.now() - awaiting.since > SIGN_IN_WAIT_MS) {
        window.clearInterval(timer);
        return;
      }
      refresh();
    }, SIGN_IN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [awaiting, refresh, stillAwaiting]);

  const submit = async () => {
    if (environmentId === null || url === null) return;
    setAdding(true);
    try {
      const result = await add({ environmentId, input: { url } });
      if (result._tag === "Success") setDraft(null);
    } finally {
      setAdding(false);
    }
  };

  let body: ReactNode;
  if (environmentId === null) {
    body = <Notice>Connect this environment to manage its MCP servers.</Notice>;
  } else if (state === null) {
    body = query.error ? (
      <Notice>{query.error}</Notice>
    ) : (
      <Notice>
        <Spinner className="size-3.5" /> Connecting to MCP servers…
      </Notice>
    );
  } else if (state.servers.length === 0 && draft === null) {
    body = (
      <Notice>
        Add a remote MCP server by its URL, such as https://mcp.higgsfield.ai/mcp. Sign in once and
        agents on every provider can use it.
      </Notice>
    );
  } else {
    body = state.servers.map((server) => (
      <McpServerRow
        key={server.id}
        environmentId={environmentId}
        server={server}
        canEdit={canEdit}
        waitingForSignIn={stillAwaiting && awaiting?.id === server.id}
        onSignInOpened={() => setAwaiting({ id: server.id, since: Date.now() })}
      />
    ));
  }

  return (
    <>
      <SettingsSection
        {...searchableSetting("mcp-servers")}
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={environmentId === null || !canEdit || draft !== null}
            onClick={() => setDraft("")}
          >
            <PlusIcon /> Add server
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
              aria-label="MCP server URL"
              placeholder="https://mcp.example.com/mcp"
              value={draft}
              disabled={adding}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !adding) setDraft(null);
              }}
            />
            <Button size="sm" type="submit" disabled={url === null || adding}>
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
      {state && state.servers.length > 0 ? (
        <p className="px-3 text-xs text-muted-foreground sm:px-4">
          Agents reach these through T3 Code, so they work with every provider. Running agents see
          changes after Restart agent session.
        </p>
      ) : null}
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

function statusText(server: McpServerEntry, waitingForSignIn: boolean) {
  if (waitingForSignIn) return "Finish signing in in your browser…";
  switch (server.status) {
    case "disabled":
      return "Off";
    case "connected":
      return `Connected · ${server.tools.length} ${server.tools.length === 1 ? "tool" : "tools"}`;
    case "needs_sign_in":
      return server.signedIn ? "Sign-in expired. Agents can't use it." : "Not signed in";
    case "error":
      return server.error ?? "Could not connect.";
  }
}

function McpServerRow({
  environmentId,
  server,
  canEdit,
  waitingForSignIn,
  onSignInOpened,
}: {
  environmentId: EnvironmentId;
  server: McpServerEntry;
  canEdit: boolean;
  waitingForSignIn: boolean;
  onSignInOpened: () => void;
}) {
  const setEnabled = useAtomCommand(mcpServersSetEnabled);
  const signIn = useAtomCommand(mcpServersSignIn);
  const signOut = useAtomCommand(mcpServersSignOut);
  const remove = useAtomCommand(mcpServersRemove);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const disabled = !canEdit || busy;
  const id = server.id;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const startSignIn = () =>
    void run(async () => {
      setSignInError(null);
      const connection = readPreparedConnection(environmentId);
      if (!connection) return;
      // Browsers block tabs opened after an await, so the web build reserves one first.
      const pending = window.desktopBridge ? null : window.open("", "_blank");
      if (pending) pending.opener = null;
      const result = await signIn({
        environmentId,
        input: { id, redirectBaseUrl: connection.httpBaseUrl },
      });
      if (result._tag !== "Success" || result.value._tag !== "Redirect") {
        pending?.close();
        return;
      }
      const authorizationUrl = result.value.authorizationUrl;
      try {
        if (pending) pending.location.href = authorizationUrl;
        else await ensureLocalApi().shell.openExternal(authorizationUrl);
        onSignInOpened();
      } catch {
        pending?.close();
        setSignInError("Could not open the sign-in page.");
      }
    });

  const needsSignIn = server.enabled && server.status === "needs_sign_in";

  return (
    <div>
      <div className="flex items-center gap-3 px-3 py-3 sm:px-4">
        <ServerIcon server={server} />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className="flex max-w-full items-center gap-1.5 text-left text-sm font-medium"
            aria-expanded={expanded}
            disabled={server.tools.length === 0}
            onClick={() => setExpanded((value) => !value)}
          >
            <span className="truncate">{server.name}</span>
            {server.tools.length > 0 ? (
              <ChevronDownIcon
                className={cn("size-3.5 shrink-0 text-muted-foreground", expanded && "rotate-180")}
              />
            ) : null}
          </button>
          <div className="flex min-w-0 items-center gap-1.5 text-xs">
            <span
              className={cn(
                "truncate",
                server.enabled && server.status !== "connected" && !waitingForSignIn
                  ? "text-warning"
                  : "text-muted-foreground",
              )}
            >
              {signInError ?? statusText(server, waitingForSignIn)}
            </span>
            {server.account && server.signedIn ? (
              <RedactedSensitiveText
                key={server.account}
                value={server.account}
                ariaLabel={`Toggle the account signed in to ${server.name}`}
                revealTooltip="Click to reveal account"
                hideTooltip="Click to hide account"
                className="max-w-48 truncate"
              />
            ) : null}
          </div>
        </div>
        {needsSignIn ? (
          <Button size="sm" variant="outline" disabled={disabled} onClick={startSignIn}>
            {waitingForSignIn ? "Open again" : server.signedIn ? "Reconnect" : "Sign in"}
          </Button>
        ) : null}
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost-muted"
                disabled={disabled}
                aria-label={`${server.name} options`}
              />
            }
          >
            <MoreVertical />
          </MenuTrigger>
          <MenuPopup align="end">
            {server.signedIn ? (
              <MenuItem onClick={() => void run(() => signOut({ environmentId, input: { id } }))}>
                Sign out
              </MenuItem>
            ) : null}
            <MenuItem
              variant="destructive"
              onClick={() => void run(() => remove({ environmentId, input: { id } }))}
            >
              Remove
            </MenuItem>
          </MenuPopup>
        </Menu>
        <Switch
          aria-label={`Use ${server.name}`}
          checked={server.enabled}
          disabled={disabled}
          onCheckedChange={(enabled) =>
            void run(() => setEnabled({ environmentId, input: { id, enabled } }))
          }
        />
      </div>
      {expanded ? (
        <ul className="divide-y divide-border/40 border-t border-border/50 bg-muted/20">
          {server.tools.map((tool) => (
            <li key={tool.name} className="py-2 ps-14 pe-3 sm:pe-4">
              <p className="font-mono text-xs text-foreground">{tool.name}</p>
              {tool.description ? (
                <p className="line-clamp-2 text-xs text-muted-foreground">{tool.description}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The server's own logo, or its initial while T3 has none. */
function ServerIcon({ server }: { server: McpServerEntry }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-muted text-sm font-medium text-muted-foreground">
      {server.icon ? (
        <img src={server.icon} alt="" className="size-full object-cover" />
      ) : (
        server.name.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}
