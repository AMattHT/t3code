# MCP servers

Connect a remote MCP server once and every agent on the environment can use
it, whichever provider runs the thread. You sign in to the service once, in
T3 Code, instead of in each tool.

## Add a server

Open **Settings → MCP servers**, choose **Add server**, and paste the server's
URL, such as `https://mcp.higgsfield.ai/mcp`. If the server needs an account,
choose **Sign in** and finish in the browser tab that opens. The row shows the
server's tools once it connects.

The switch turns a server off without signing out. **Sign out** and **Remove**
are in the row's menu. When a sign-in stops working, the row offers
**Reconnect**.

Servers belong to the environment, so pick the environment in the settings
header first. On a remote environment, the sign-in page returns to that
environment through the address you use to reach it.

## Using them in a thread

Ask for what you want, such as "generate a product image with Higgsfield".
Agents find connected servers through T3 Code's `mcp_servers_list` tool and
call them with `mcp_servers_call`. Images a server returns reach the agent as
images, not text.

Running agents see added or removed servers after **Restart agent session** in
the command palette.

T3 Code connects to remote servers over HTTPS. Servers you run as a local
command are not supported here yet; add those in the provider's own settings.
