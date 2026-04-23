#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// Drop-in replacement for nano-banana — same tool surface, current
// model IDs. The original broke when Google retired
// `gemini-2.5-flash-image-preview` from v1beta; we default to the
// closest-to-GA `gemini-2.5-flash-image` and let callers override via
// env so nothing strands us again.

const DEFAULT_MODEL = process.env.GEMINI_IMAGE_MODEL ?? 'gemini-2.5-flash-image';
const OUTPUT_DIR =
  process.env.GEMINI_IMAGE_OUTPUT_DIR ??
  join(homedir(), '.gemini-image-mcp', 'images');

type ImageInfo = {
  path: string;
  bytes: number;
  mimeType: string;
  model: string;
  prompt: string;
  createdAt: string;
};

let lastImage: ImageInfo | null = null;
let tokenOverride: string | null = null;

function resolveApiKey(): string | null {
  return (
    tokenOverride ??
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_API_KEY ??
    null
  );
}

function client(): GoogleGenAI {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error(
      'No Gemini API key configured. Set GEMINI_API_KEY in your environment, or call `configure_gemini_token`.',
    );
  }
  return new GoogleGenAI({ apiKey });
}

async function ensureOutputDir(): Promise<string> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  return OUTPUT_DIR;
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  return 'bin';
}

function sanitizeStem(prompt: string): string {
  return (
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'image'
  );
}

async function writeImageFile(
  data: Buffer,
  mimeType: string,
  prompt: string,
): Promise<string> {
  const dir = await ensureOutputDir();
  const stem = sanitizeStem(prompt);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `${stamp}_${stem}.${extensionFor(mimeType)}`);
  await writeFile(path, data);
  return path;
}

type GeminiPart = {
  text?: string;
  inlineData?: { data?: string; mimeType?: string };
};

function extractImagePart(response: unknown): {
  data: Buffer;
  mimeType: string;
} {
  const candidates =
    (response as { candidates?: Array<{ content?: { parts?: GeminiPart[] } }> })
      ?.candidates ?? [];
  for (const candidate of candidates) {
    const parts = candidate.content?.parts ?? [];
    for (const part of parts) {
      const inline = part.inlineData;
      if (inline?.data) {
        return {
          data: Buffer.from(inline.data, 'base64'),
          mimeType: inline.mimeType ?? 'image/png',
        };
      }
    }
  }
  throw new Error(
    'Model returned no image. The prompt may have triggered a safety block, or the model ID may not support image output.',
  );
}

async function generate(prompt: string): Promise<ImageInfo> {
  const ai = client();
  const response = await ai.models.generateContent({
    model: DEFAULT_MODEL,
    contents: prompt,
  });
  const { data, mimeType } = extractImagePart(response);
  const path = await writeImageFile(data, mimeType, prompt);
  const info: ImageInfo = {
    path,
    bytes: data.byteLength,
    mimeType,
    model: DEFAULT_MODEL,
    prompt,
    createdAt: new Date().toISOString(),
  };
  lastImage = info;
  return info;
}

async function edit(
  sourcePath: string,
  prompt: string,
): Promise<ImageInfo> {
  const absolute = isAbsolute(sourcePath)
    ? sourcePath
    : resolve(process.cwd(), sourcePath);
  const sourceStat = await stat(absolute).catch(() => null);
  if (!sourceStat?.isFile()) {
    throw new Error(`Source image not found at ${absolute}`);
  }
  const bytes = await readFile(absolute);
  const mimeType = absolute.toLowerCase().endsWith('.jpg')
    ? 'image/jpeg'
    : absolute.toLowerCase().endsWith('.jpeg')
      ? 'image/jpeg'
      : absolute.toLowerCase().endsWith('.webp')
        ? 'image/webp'
        : 'image/png';
  const ai = client();
  const response = await ai.models.generateContent({
    model: DEFAULT_MODEL,
    contents: [
      { text: prompt },
      { inlineData: { mimeType, data: bytes.toString('base64') } },
    ],
  });
  const { data, mimeType: resultMime } = extractImagePart(response);
  const outPath = await writeImageFile(data, resultMime, prompt);
  const info: ImageInfo = {
    path: outPath,
    bytes: data.byteLength,
    mimeType: resultMime,
    model: DEFAULT_MODEL,
    prompt,
    createdAt: new Date().toISOString(),
  };
  lastImage = info;
  return info;
}

const server = new McpServer({
  name: 'gemini-image',
  version: '0.1.0',
});

server.registerTool(
  'generate_image',
  {
    description:
      'Generate a NEW image from a text prompt. Use this ONLY when creating a completely new image, not when modifying an existing one.',
    inputSchema: {
      prompt: z
        .string()
        .min(1)
        .describe('Text prompt describing the NEW image to create from scratch'),
    },
  },
  async ({ prompt }: { prompt: string }) => {
    const info = await generate(prompt);
    return {
      content: [
        {
          type: 'text',
          text: `Image saved to ${info.path} (${info.bytes} bytes, ${info.mimeType}, model ${info.model}).`,
        },
      ],
    };
  },
);

server.registerTool(
  'edit_image',
  {
    description:
      'Edit an existing image on disk. Provide the source path and a prompt describing the change.',
    inputSchema: {
      source_path: z
        .string()
        .min(1)
        .describe('Absolute or relative path to the existing image on disk.'),
      prompt: z
        .string()
        .min(1)
        .describe('Describe the edit to apply (e.g. "add a red hat").'),
    },
  },
  async ({ source_path, prompt }: { source_path: string; prompt: string }) => {
    const info = await edit(source_path, prompt);
    return {
      content: [
        {
          type: 'text',
          text: `Edited image saved to ${info.path} (${info.bytes} bytes, ${info.mimeType}, model ${info.model}).`,
        },
      ],
    };
  },
);

server.registerTool(
  'continue_editing',
  {
    description:
      'Apply another edit on top of the most recent image produced by this MCP session.',
    inputSchema: {
      prompt: z
        .string()
        .min(1)
        .describe('Describe the next edit to apply to the last image.'),
    },
  },
  async ({ prompt }: { prompt: string }) => {
    if (!lastImage) {
      throw new Error(
        'No previous image in this session. Call generate_image or edit_image first.',
      );
    }
    const info = await edit(lastImage.path, prompt);
    return {
      content: [
        {
          type: 'text',
          text: `Edited image saved to ${info.path} (${info.bytes} bytes, ${info.mimeType}, model ${info.model}).`,
        },
      ],
    };
  },
);

server.registerTool(
  'get_last_image_info',
  {
    description:
      'Get information about the last generated/edited image in this session (file path, size, etc.). Use this to check what image is currently available for continue_editing.',
    inputSchema: {},
  },
  async () => {
    if (!lastImage) {
      return {
        content: [{ type: 'text', text: 'No image has been generated yet in this session.' }],
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(lastImage, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  'configure_gemini_token',
  {
    description:
      'Set the Gemini API key for this MCP session. Overrides GEMINI_API_KEY from the environment until the server restarts.',
    inputSchema: {
      token: z.string().min(1).describe('Gemini API key (kept in memory only).'),
    },
  },
  async ({ token }: { token: string }) => {
    tokenOverride = token;
    return {
      content: [
        {
          type: 'text',
          text: 'Gemini API token set for this session (in-memory only; not persisted).',
        },
      ],
    };
  },
);

server.registerTool(
  'get_configuration_status',
  {
    description: 'Check if a Gemini API key is configured and show which source it came from.',
    inputSchema: {},
  },
  async () => {
    const apiKey = resolveApiKey();
    if (!apiKey) {
      return {
        content: [
          {
            type: 'text',
            text: 'No Gemini API key configured. Set GEMINI_API_KEY or call configure_gemini_token.',
          },
        ],
      };
    }
    const source = tokenOverride
      ? 'in-session override (configure_gemini_token)'
      : process.env.GEMINI_API_KEY
        ? 'env var GEMINI_API_KEY'
        : 'env var GOOGLE_API_KEY';
    return {
      content: [
        {
          type: 'text',
          text: `Gemini API key configured (source: ${source}). Model: ${DEFAULT_MODEL}. Output dir: ${OUTPUT_DIR}.`,
        },
      ],
    };
  },
);

async function main() {
  await ensureOutputDir().catch(() => {});
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `gemini-image MCP ready — model=${DEFAULT_MODEL}, outputDir=${OUTPUT_DIR}`,
  );
}

// Hint for the unused import lint.
void dirname;

main().catch((err) => {
  console.error('Fatal error in gemini-image MCP:', err);
  process.exit(1);
});
