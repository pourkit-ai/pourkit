# Serena Documentation Reference

Everything below is extracted from Serena's published docs and is relevant to
our Docker + MCP integration for Pourkit. Sources are cited per section.

---

## 1. Running the MCP Server

Source: `https://oraios.github.io/serena/02-usage/020_running.html`

### Transport Modes

- **stdio (default)**: client starts Serena as a subprocess, communicates over
  stdin/stdout. The client owns the lifecycle.
- **Streamable HTTP**: `serena start-mcp-server --transport streamable-http --port <port>`
  You control the lifecycle; client connects to `http://localhost:<port>/mcp`.
  Pass `--host 0.0.0.0` for remote/docker access.
- **Legacy SSE**: `--transport sse` with `/sse` endpoint. Discouraged.

### Useful MCP Server CLI Flags

| Flag | Purpose |
|------|---------|
| `--project <path\|name>` | Activate project at startup |
| `--project-from-cwd` | Auto-detect project from CWD |
| `--context <context>` | Operation context (see section 3) |
| `--mode <mode>` | Enable one or more modes |
| `--add-mode <mode>` | Add mode on top of defaults |
| `--language-backend JetBrains` | Use JetBrains backend instead of LSP |
| `--open-web-dashboard <true\|false>` | Open dashboard browser on start |

### Serena is Stateful

"Serena is a stateful MCP server, and only one coding project can be active at
a time. Therefore, starting a single Serena instance and connecting it to
multiple clients is only appropriate if all clients will be working on the
same project."

This is critical for our design. A single Serena instance is single-project.
We must scope one Serena per active Pourkit Worktree, or accept that it tracks
one project identity.

---

## 2. Docker Setup

Source: `https://github.com/oraios/serena/blob/main/DOCKER.md`
Source: `https://oraios.github.io/serena/02-usage/020_running.html`

### Status

**Experimental.** Docker support is marked experimental with known limitations.

### Basic Docker Run

```shell
docker run --rm -i --network host \
  -v /path/to/projects:/workspaces/projects \
  ghcr.io/oraios/serena:latest serena
```

Mounts projects at `/workspaces/projects`. Inside container, activate project
at full path (e.g. `/workspaces/projects/my-project`).

### Docker Compose (from repo compose.yaml)

```yaml
services:
  serena:
    image: serena:latest
    volumes:
      - ./my-project:/workspace/my-project
    ports:
      - "${SERENA_PORT:-9121}:9121"
      - "${SERENA_DASHBOARD_PORT:-24282}:24282"
    environment:
      - SERENA_DOCKER=1
    command:
      - "uv run --directory . serena-mcp-server --transport sse --port 9121 --host 0.0.0.0"
```

### Docker Configuration

Within Docker, Serena config lives at `/workspaces/serena/config/`. Mount a
local config directory there to persist settings across restarts.

Required Docker-specific config settings in `serena_config.yml`:

```yaml
gui_log_window: False
web_dashboard_listen_address: 0.0.0.0
web_dashboard_open_on_launch: False
```

### Ports

| Service | Default Port | Notes |
|---------|-------------|-------|
| MCP server | 9121 | Configurable via SERENA_PORT |
| Dashboard | 24282 | Configurable via SERENA_DASHBOARD_PORT (0x5EDA) |

### Docker Limitations

- Only mounted directories work. Projects outside mounts cannot be activated.
- Projects not remembered across container restarts (unless config mounted).
- Use full path activation on first run in container.
- Language dependencies that require system-level install may not work.
- Language server installs happen inside container on demand.

---

## 3. Contexts and Modes

Source: `https://oraios.github.io/serena/02-usage/050_configuration.html`

### Contexts (environment, set at startup, immutable during session)

| Context | Purpose |
|---------|---------|
| `desktop-app` | Full toolset, default. For Claude Desktop |
| `claude-code` | Disables duplicate tools CC already has |
| `codex` | Optimized for OpenAI Codex |
| `ide` | Generic for VSCode/Cursor/Cline. Augments existing capabilities |
| `agent` | Autonomous agent scenarios (Agno, etc.) |

Contexts `ide` and `claude-code` are **single-project contexts**
(`single_project: true`). If a project is provided at startup, the toolset is
minimized to only relevant tools. The project activation tool is disabled.

For our case, `ide` context is most appropriate per Serena's own recommendation
for CLI-based coding agents like opencode.

### Modes (composable, can be combined)

| Mode | Effect |
|------|--------|
| `planning` | Focus on planning and analysis |
| `editing` | Optimize for direct code modification |
| `interactive` | Conversational back-and-forth |
| `one-shot` | Complete task in single response |
| `no-onboarding` | Skip initial onboarding |
| `no-memories` | Disable all memory tools |
| `query-projects` | Enable project querying tools |

---

## 4. Project Workflow

Source: `https://oraios.github.io/serena/02-usage/040_workflow.html`

### Project Steps

1. **Project creation**: `serena project create [options] [dir]`
   - With `--index`: also run indexing
   - With `--language <lang>`: specify languages
   - With `--name <name>`: custom project name
   - Languages auto-detected from source files
2. **Indexing**: `serena project index`
   - Pre-caches LSP symbol information
   - "Indexing has to be called only once. During regular usage, Serena will
     automatically update the index whenever files change."
3. **Project activation**: Make Serena aware of project
   - Via CLI: `--project <path|name>` at startup
   - Via agent prompt: "Activate the project /path/to/project"
4. **Onboarding**: Serena reads project structure, creates memories

### Project Configuration (`project.yml`)

Lives in `.serena/project.yml` inside project root. Configures:
- Project name
- Languages (auto-detected or explicit)
- Ignore rules
- Excluded/included tools
- Modes
- Initial prompt
- Additional workspace folders (monorepo)
- Read-only / read-write access

### Multiple Agents Accessing Single Serena Instance

"If you want multiple agents to access the same project via a single Serena
instance, you can achieve this by starting the Serena MCP server in HTTP mode
and connecting all client agents to the same HTTP endpoint."

This is exactly our desired setup for host + Sandbox access.

---

## 5. Indexing Behavior

Source: `https://oraios.github.io/serena/02-usage/040_workflow.html`

Key quotes:

- "Indexing has to be called only once."
- "During regular usage, Serena will automatically update the index whenever
  files change."
- "Especially for larger projects, it can be advisable to index the project
  after creation, pre-caching symbol information provided by the language
  server(s). This will avoid delays during the first tool invocation."

This confirms incremental updates happen automatically after initial index.
If Docker bind mounts propagate file change events correctly, Serena should
pick up edits made by Builder/Refactor agents in a Sandbox.

---

## 6. Memories and Onboarding

Source: `https://oraios.github.io/serena/02-usage/045_memories.html`

### Memory System

- **Project memories**: `.serena/memories/` in project root (versionable)
- **Global memories**: `~/.serena/memories/global/` (shared across projects)
- Format: plain Markdown files
- References use `` `mem:NAME` `` convention
- Can be organized into subdirectories (topics)

### Onboarding

- Runs automatically for new projects (when no memories exist)
- Reads project structure, creates initial memories
- Seeds `memory_maintenance` memory describing conventions
- Can be disabled by enabling `no-onboarding` or `no-memories` mode

For our use case, we likely want `no-onboarding` to avoid agent overhead on
every activation.

### Data Directory Location

Default: `~/.serena`
Override: `SERENA_HOME` environment variable

### Per-Project Serena Folder Location

`project_serena_folder_location` in serena_config.yml supports placeholders:
- `$projectDir` - absolute path to project root
- `$projectFolderName` - name of project directory

Default: `"$projectDir/.serena"`

This is configurable. For Pourkit, we may want persistent Serena home
outside the worktree to avoid dirtying issue runs.

---

## 7. Tools Surface

Source: `https://oraios.github.io/serena/01-about/035_tools.html`

### Tool Categories

| Category | Tools |
|----------|-------|
| **symbol_tools** | find_declaration, find_implementations, find_referencing_symbols, find_symbol, get_diagnostics_for_file, get_diagnostics_for_symbol (optional), get_symbols_overview, insert_after_symbol, insert_before_symbol, rename_symbol, replace_symbol_body, restart_language_server (optional), safe_delete_symbol |
| **cmd_tools** | execute_shell_command |
| **config_tools** | activate_project, get_current_config, open_dashboard (optional), remove_project (optional) |
| **file_tools** | create_text_file, delete_lines (optional), find_file, insert_at_line (optional), list_dir, read_file, replace_content, replace_lines (optional), search_for_pattern |
| **memory_tools** | delete_memory, edit_memory, list_memories, read_memory, rename_memory, write_memory |
| **query_project_tools** | list_queryable_projects (optional), query_project (optional) |
| **workflow_tools** | initial_instructions, onboarding, serena_info (optional) |

For Pourkit, we mostly want the `symbol_tools` category. The `file_tools`
and `cmd_tools` duplicate what OpenCode already provides, so using the `ide`
context would disable those duplicates.

---

## 8. Configuration

Source: `https://oraios.github.io/serena/02-usage/050_configuration.html`
Source: `src/serena/resources/serena_config.template.yml`
Source: `src/serena/resources/project.template.yml`

### Multi-Layered Configuration

1. **Global config** (`serena_config.yml`) - in `~/.serena/` or configured dir
2. **Project config** (`project.yml`) - in `.serena/` inside project
3. **Contexts and modes** - composable, enabled per session
4. **CLI parameters** - override/extend configured settings

### Key Global Settings

| Setting | Purpose |
|---------|---------|
| `language_backend` | `LSP` or `JetBrains` |
| `gui_log_window` | GUI log window (disable for Docker) |
| `web_dashboard` | Enable web dashboard |
| `web_dashboard_listen_address` | Bind address (use `0.0.0.0` for Docker) |
| `web_dashboard_open_on_launch` | Auto-open dashboard (disable for Docker) |
| `log_level` | 10=debug, 20=info, 30=warning, 40=error |
| `ls_specific_settings` | Language server-specific config |
| `ignored_paths` | Global ignore patterns |
| `excluded_tools` | Tools to disable globally |
| `base_modes` | Always-active modes |
| `default_modes` | Default modes (overridable by project/CLI) |
| `tool_timeout` | Default tool execution timeout (seconds) |
| `symbol_info_budget` | Time budget per tool call for symbol info retrieval |
| `project_serena_folder_location` | Template for per-project `.serena` folder path |
| `projects` | Registered project paths (auto-updated) |

### Key Project Settings

| Setting | Purpose |
|---------|---------|
| `project_name` | Reference name |
| `languages` | Language list for LSP servers |
| `encoding` | Text file encoding |
| `language_backend` | Per-project backend override |
| `ignore_all_files_in_gitignore` | Respect `.gitignore` |
| `ls_specific_settings` | Per-language LS config |
| `additional_workspace_folders` | Monorepo cross-package support |
| `excluded_tools` / `included_optional_tools` | Tool visibility per project |
| `default_modes` / `added_modes` | Mode configuration |
| `initial_prompt` | Always-given prompt on activation |
| `read_only` | Lock project to read-only |
| `read_only_memory_patterns` | Protect memory subsets |

---

## 9. Security

Source: `https://oraios.github.io/serena/02-usage/070_security.html`

### Threat Model

Serena assumes:
- Local machine is trusted
- MCP client (LLM) is trusted
- Code repository being worked on is trusted
- User configuration is trusted
- Package manager configuration is trusted

### Network Services (exposed by default)

- MCP server (when run in HTTP/SSE mode instead of stdio)
- Dashboard web server
- JetBrains Plugin server (when using JetBrains backend)
- Project Server (when started explicitly)

All default to `127.0.0.1` only. For Docker we need `0.0.0.0` which has
security implications within the Docker network.

### Supply Chain Security

Serena auto-downloads language server dependencies (pinned versions, SHA
verification, host allowlists for archives; npm-based LS installed with pinned
versions into Serena-managed directories).

---

## 10. Project Template Defaults

Source: `project.template.yml`

Default languages: `["python"]`
Default encoding: `"utf-8"`
Default: `ignore_all_files_in_gitignore: true`
Default: `read_only: false`
Default project folder: `.serena/` inside project root
Default: `language_backend: LSP`
Default: `line_ending: native`

---

## 11. Serena's Built-in compose.yaml

Source: `compose.yaml` from serena repo

```yaml
services:
  serena:
    image: serena:latest
    build:
      context: ./
      dockerfile: Dockerfile
      target: production
    ports:
      - "${SERENA_PORT:-9121}:9121"
      - "${SERENA_DASHBOARD_PORT:-24282}:24282"
    environment:
      - SERENA_DOCKER=1
    command:
      - "uv run --directory . serena-mcp-server --transport sse --port 9121 --host 0.0.0.0"
```

Notable: uses SSE, not streamable HTTP in this template. Would need change to
`--transport streamable-http` for our HTTP MCP setup.

---

## 12. Language Server Support

Source: `https://oraios.github.io/serena/01-about/020_programming-languages.html`

Pourkit is a TypeScript monorepo. Relevant language servers:
- **TypeScript**: `typescript-language-server` (npm, managed by Serena)
- **JavaScript**: uses TypeScript server
- **JSON**: bundled in vscode-langservers (via TypeScript LS)

Serena auto-discovers TypeScript. During Docker `project create`, Serena
installs needed LS inside container on first run.

For TypeScript in particular, Serena manages:
- `typescript` npm package (pinned version)
- `typescript-language-server` npm package (pinned version)

These go into Serena-managed directories, inside the Docker container
filesystem by default. If the container restarts without a persisted Serena
home, LS dependencies are re-downloaded.
