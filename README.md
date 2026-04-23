# gemini-image-mcp

An MCP server for Gemini image generation + editing. Drop-in successor to the original `nano-banana` MCP, which stopped working once Google retired `gemini-2.5-flash-image-preview` from `v1beta` — every project that depended on it started failing with 404 `NOT_FOUND`.

Tool surface matches nano-banana 1:1, so existing MCP configs and prompts carry over. Only the model ID (and the layer between the SDK and the Gemini API) is replaced.

## Tools

| Tool | Purpose |
|---|---|
| `generate_image({ prompt })` | Generate a new image from a text prompt |
| `edit_image({ source_path, prompt })` | Edit an image that already exists on disk |
| `continue_editing({ prompt })` | Chain another edit onto the last image from this session |
| `get_last_image_info()` | Inspect the most recent output (path, size, mime) |
| `configure_gemini_token({ token })` | Set the API key in memory for this session |
| `get_configuration_status()` | Check whether a key is configured and which source it came from |

Generated + edited images are written to `~/.gemini-image-mcp/images/` by default. Override with `GEMINI_IMAGE_OUTPUT_DIR`.

## Install

One command — no clone, no checkout:

```bash
npm install -g github:amoHoban/gemini-image-mcp
```

That pulls the repo, builds `dist/`, and links a `gemini-image-mcp` binary onto your `$PATH`. To update: re-run the same command.

## Configure Claude Code

Add to your Claude Code MCP config (e.g. `~/.claude.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gemini-image": {
      "command": "gemini-image-mcp",
      "env": {
        "GEMINI_API_KEY": "your-key-here"
      }
    }
  }
}
```

If you already had the original `nano-banana` configured, replace its `command`/`args` with the two lines above. Tool names are identical — no prompt rewrites needed.

Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).

### Alternative: run from a local clone

If you'd rather not install globally:

```bash
git clone https://github.com/amoHoban/gemini-image-mcp.git
cd gemini-image-mcp
npm install && npm run build
```

Then point your MCP config at the built file:

```json
"command": "node",
"args": ["/absolute/path/to/gemini-image-mcp/dist/index.js"]
```

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | — | Gemini API key. Falls back to `GOOGLE_API_KEY`. |
| `GEMINI_IMAGE_MODEL` | `gemini-2.5-flash-image` | Override if Google rotates the GA model ID again. |
| `GEMINI_IMAGE_OUTPUT_DIR` | `~/.gemini-image-mcp/images` | Where generated + edited images are written. |

## Why the default model?

`gemini-2.5-flash-image` is the closest-to-GA image-output model at the time of writing. Preview IDs (`gemini-3.x-flash-image-preview`) get rotated by Google without notice — that's the exact failure mode that broke the original nano-banana. If Google ships a new GA ID, set `GEMINI_IMAGE_MODEL` in your MCP env until this repo publishes an update.

## License

MIT. See [`LICENSE`](LICENSE).
