// server/agent/stagehandBrowserAgent.ts
//
// Stateful Vercel AI SDK + Stagehand v4 browser-agent runtime.
//
// Source of truth: live V4 docs (llms.txt index) + installed
// `@browserbasehq/stagehand@4` declarations. V4 integration guides used:
// - v4/first-steps/installation.md (published SDK, explicit env passing)
// - v4/integrations/overview.md (persistent browser, run/snapshot/screenshot
//   tool contract, one client session per agent run)
// - v4/integrations/vercel-ai-sdk.md (single MCP-client lifetime; reconnecting
//   per call starts a new browser and loses state)
//
// Verified example status (2026-09-06):
// - Maintained Vercel AI example EXISTS in the Stagehand monorepo at
//   packages/integrations/vercel-ai (src + tests + README, facade MCP server
//   over stdio exposing run/snapshot/screenshot).
// - NO matching Vercel example in browserbase/integrations (only
//   convex-stagehand, eve-browserbase, openclaw-browserbase).
// - The monorepo integrations are experimental source-only: they are NOT
//   published as standalone adapters and require cloning + pnpm + turbo build
//   of `@browserbasehq/stagehand-integrations`. This project uses npm and must
//   not depend on a Git URL / local checkout / unpublished companion package,
//   so this module implements the same tool contract and session lifetime with
//   the framework's native tool API (`tool()` from `ai`) backed directly by
//   the published `@browserbasehq/stagehand@4` SDK.
//
// Security boundary (per overview.md): `run` executes model-authored
// JavaScript in the browser. Browser isolation alone is not a code-execution
// sandbox; use Browserbase as the isolation boundary for untrusted tasks and
// treat authenticated sessions as privileged.

import { tool } from "ai";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import {
  Stagehand,
  browserbase,
  localBrowser,
} from "@browserbasehq/stagehand";
import type {
  Page,
  StagehandBrowser,
  StagehandCreateOptions,
} from "@browserbasehq/stagehand";

export const STAGEHAND_AGENT_TOOL_NAMES = [
  "snapshot",
  "run",
  "screenshot",
] as const;

export interface StagehandAgentEnvConfig {
  /** "browserbase" when BROWSERBASE_API_KEY is set (or STAGEHAND_BROWSER=browserbase), else "local". */
  browser: "local" | "browserbase";
  browserbaseApiKey?: string;
  browserbaseProjectId?: string;
  stagehandModelName?: string;
  stagehandModelApiKey?: string;
  /** Non-secret marker attached as Browserbase userMetadata for verification sessions. */
  setupVerificationMarker?: string;
  /**
   * Local-Chrome profile directory. Defaults to `<cwd>/.stagehand-profile`
   * (override with STAGEHAND_LOCAL_PROFILE_DIR). A stable owned profile is
   * used instead of chrome-launcher's temp profile because temp-profile
   * removal fails with EPERM on Windows (observed: permission denied on the
   * lighthouse.* dir even after the browser exits). One agent run owns the
   * profile; concurrent runs need distinct dirs.
   */
  localProfileDir: string;
}

/**
 * Read secrets from the environment and pass them explicitly. Stagehand does
 * NOT load `.env` itself; callers load it (this repo uses `dotenv/config`).
 * Never print, commit, or embed the returned credential fields.
 */
export function readStagehandAgentConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): StagehandAgentEnvConfig {
  const apiKey = env.BROWSERBASE_API_KEY?.trim() || undefined;
  const browser =
    env.STAGEHAND_BROWSER?.trim() === "browserbase" || apiKey
      ? "browserbase"
      : "local";
  return {
    browser,
    browserbaseApiKey: apiKey,
    browserbaseProjectId: env.BROWSERBASE_PROJECT_ID?.trim() || undefined,
    stagehandModelName: env.STAGEHAND_MODEL_NAME?.trim() || undefined,
    stagehandModelApiKey: env.STAGEHAND_MODEL_API_KEY?.trim() || undefined,
    setupVerificationMarker:
      env.STAGEHAND_SETUP_VERIFICATION?.trim() || undefined,
    localProfileDir:
      env.STAGEHAND_LOCAL_PROFILE_DIR?.trim() ||
      path.resolve(process.cwd(), ".stagehand-profile"),
  };
}

export interface StagehandAgentCleanupReport {
  stagehand: "closed" | "failed" | "skipped";
  browser: "closed" | "failed" | "skipped";
  /** Error messages only (never credentials). */
  errors: string[];
}

interface Closable {
  close(): Promise<unknown>;
}

/**
 * Close Stagehand and the browser with independent guarded calls so one
 * cleanup failure cannot prevent the other (Promise.allSettled equivalent
 * written explicitly). Never throws; failures are recorded in the report.
 */
export async function closeBrowserAndStagehand(
  stagehand: Closable | null,
  browser: Closable | null,
): Promise<StagehandAgentCleanupReport> {
  const report: StagehandAgentCleanupReport = {
    stagehand: stagehand ? "closed" : "skipped",
    browser: browser ? "closed" : "skipped",
    errors: [],
  };
  if (stagehand) {
    try {
      await stagehand.close();
    } catch (err) {
      report.stagehand = "failed";
      report.errors.push(
        `stagehand.close failed: ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }
  if (browser) {
    // Local Chrome teardown on Windows can race the browser process exit
    // (EPERM removing the temp profile dir). Retry briefly; the final
    // outcome is still recorded honestly, never swallowed.
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await browser.close();
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    if (lastError) {
      report.browser = "failed";
      report.errors.push(
        `browser.close failed: ${(lastError as Error)?.message ?? String(lastError)}`,
      );
    }
  }
  return report;
}

export interface StagehandAgentRuntime {
  readonly browser: StagehandBrowser;
  readonly stagehand: Stagehand;
  readonly config: StagehandAgentEnvConfig;
  readonly closed: boolean;
  /** Resolve the shared active page (creates one if the context is empty). */
  activePage(): Promise<Page>;
  /** Idempotent guarded teardown; see closeBrowserAndStagehand. */
  close(): Promise<StagehandAgentCleanupReport>;
}

/**
 * Create the shared browser + Stagehand instance ONCE per agent run. All
 * registered tools close over this runtime so cookies, tabs, page state, and
 * session identity survive across calls. Do NOT call this per tool call.
 */
export async function createStagehandAgentRuntime(
  config: StagehandAgentEnvConfig,
): Promise<StagehandAgentRuntime> {
  let browser: StagehandBrowser;
  if (config.browser === "browserbase") {
    if (!config.browserbaseApiKey) {
      throw new Error(
        "STAGEHAND_BROWSER=browserbase requires BROWSERBASE_API_KEY.",
      );
    }
    browser = await browserbase.launch({
      apiKey: config.browserbaseApiKey,
      ...(config.browserbaseProjectId
        ? { projectId: config.browserbaseProjectId }
        : {}),
      ...(config.setupVerificationMarker
        ? {
            userMetadata: {
              setup_verification: config.setupVerificationMarker,
            },
          }
        : {}),
    });
  } else {
    fs.mkdirSync(config.localProfileDir, { recursive: true });
    browser = await localBrowser.launch({
      headless: true,
      userDataDir: config.localProfileDir,
      preserveUserDataDir: true,
    });
  }

  let stagehand: Stagehand;
  try {
    const createOptions: StagehandCreateOptions = { browser };
    // Optional model for Stagehand AI methods (act/extract/observe). When
    // unset, Model Gateway selects one automatically. Passed through for the
    // SDK schema to validate; kept untyped here so an arbitrary env-provided
    // model name cannot break the strongly-typed `browser` field above.
    if (config.stagehandModelName) {
      (createOptions as Record<string, unknown>).model = {
        modelName: config.stagehandModelName,
        ...(config.stagehandModelApiKey
          ? { apiKey: config.stagehandModelApiKey }
          : {}),
      };
    }
    stagehand = await Stagehand.create(createOptions);
  } catch (err) {
    // Creation failed after the browser launched: release it before surfacing
    // the original error so a half-initialized run never leaks a browser.
    await browser.close().catch(() => {});
    throw err;
  }

  let closedFlag = false;
  let closeReport: Promise<StagehandAgentCleanupReport> | null = null;
  const runtime: StagehandAgentRuntime = {
    browser,
    stagehand,
    config,
    get closed() {
      return closedFlag;
    },
    async activePage(): Promise<Page> {
      const context = browser.context;
      const active = await context.activePage().catch(() => undefined);
      if (active) return active;
      const pages = await context.pages();
      if (pages[0]) return pages[0];
      return context.newPage();
    },
    async close(): Promise<StagehandAgentCleanupReport> {
      if (!closeReport) {
        closeReport = closeBrowserAndStagehand(stagehand, browser).then(
          (report) => {
            closedFlag = true;
            return report;
          },
        );
      }
      return closeReport;
    },
  };
  return runtime;
}

const snapshotActionSchema = z.object({
  op: z.enum(["click", "hover", "fill", "type", "press", "select"]),
  /** CSS selector for element-targeted ops (`press` uses global keyPress). */
  selector: z.string().min(1),
  /** Value for fill/type/select, or key name for press. */
  text: z.string().optional(),
  key: z.string().optional(),
});

const runInputSchema = z.object({
  /** Navigate the shared page. */
  goto: z.string().url().optional(),
  /** Natural-language browser action via Stagehand.act. */
  act: z.string().min(1).optional(),
  /** JavaScript evaluated in the page (facade `code` is an alias). */
  evaluate: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
  /** Deterministic element ops executed against the shared page. */
  actions: z.array(snapshotActionSchema).min(1).optional(),
});

/**
 * Native Vercel AI SDK tools exposing the documented V4 tool contract
 * (snapshot / run / screenshot) against the SHARED runtime. All tools use the
 * same browser/session; navigation by `run` is visible to `snapshot`.
 */
export function createStagehandAgentTools(runtime: StagehandAgentRuntime) {
  const snapshot = tool({
    description:
      "Read a compact accessibility snapshot of the shared active page. " +
      "Take another snapshot after navigation or when IDs become stale.",
    inputSchema: z.object({
      includeIframes: z.boolean().optional(),
    }),
    execute: async (input) => {
      const page = await runtime.activePage();
      const [url, title, snap] = await Promise.all([
        page.url(),
        page.title(),
        page.snapshot(
          input.includeIframes === undefined
            ? undefined
            : { includeIframes: input.includeIframes },
        ),
      ]);
      return {
        url,
        title,
        snapshot: snap.formattedTree,
        snapshotLength: snap.formattedTree.length,
      };
    },
  });

  const run = tool({
    description:
      "Operate the shared browser page: navigate (goto), act with natural " +
      "language (act), evaluate JavaScript in the page (evaluate/code), or " +
      "apply deterministic element actions (actions). Exactly one operation " +
      "per call. State persists across calls.",
    inputSchema: runInputSchema,
    execute: async (input) => {
      const ops = [
        input.goto !== undefined,
        input.act !== undefined,
        input.evaluate !== undefined,
        input.code !== undefined,
        input.actions !== undefined,
      ].filter(Boolean).length;
      if (ops !== 1) {
        throw new Error(
          "run accepts exactly one of: goto, act, evaluate, code, actions.",
        );
      }
      const page = await runtime.activePage();
      if (input.goto !== undefined) {
        await page.goto(input.goto);
        return {
          ok: true as const,
          op: "goto" as const,
          url: await page.url(),
          title: await page.title(),
        };
      }
      if (input.act !== undefined) {
        const result = await runtime.stagehand.act(input.act);
        return {
          ok: true as const,
          op: "act" as const,
          message: result.data.message,
          actionDescription: result.data.actionDescription,
        };
      }
      const script = input.evaluate ?? input.code;
      if (script !== undefined) {
        const value: unknown = await page.evaluate(script);
        let preview: string;
        try {
          preview = JSON.stringify(value) ?? String(value);
        } catch {
          preview = String(value);
        }
        return {
          ok: true as const,
          op: "evaluate" as const,
          valueType: typeof value,
          valuePreview: preview.slice(0, 2000),
        };
      }
      const applied: string[] = [];
      for (const action of input.actions ?? []) {
        // `press` has no element-level API in the V4 SDK; Page.keyPress is
        // global, so the selector is intentionally ignored for that op.
        if (action.op === "press") {
          await page.keyPress(action.key ?? action.text ?? "Enter");
        } else {
          const locator = page.locator(action.selector);
          if (action.op === "click") await locator.click();
          else if (action.op === "hover") await locator.hover();
          else if (action.op === "fill") {
            if (action.text === undefined)
              throw new Error("fill requires text.");
            await locator.fill(action.text);
          } else if (action.op === "type") {
            if (action.text === undefined)
              throw new Error("type requires text.");
            await locator.type(action.text);
          } else {
            if (action.text === undefined)
              throw new Error("select requires text.");
            await locator.selectOption(action.text);
          }
        }
        applied.push(action.op);
      }
      return { ok: true as const, op: "actions" as const, applied };
    },
  });

  const screenshot = tool({
    description:
      "Capture the shared active page as PNG for visual inspection.",
    inputSchema: z.object({
      fullPage: z.boolean().optional(),
    }),
    execute: async (input) => {
      const page = await runtime.activePage();
      const [url, title, bytes] = await Promise.all([
        page.url(),
        page.title(),
        page.screenshot(
          input.fullPage === undefined
            ? undefined
            : { fullPage: input.fullPage },
        ),
      ]);
      const base64 = Buffer.from(bytes).toString("base64");
      return {
        mimeType: "image/png",
        url,
        title,
        base64,
        base64Length: base64.length,
      };
    },
  });

  return { snapshot, run, screenshot };
}

export type StagehandAgentTools = ReturnType<
  typeof createStagehandAgentTools
>;

export function assertStagehandAgentToolContract(tools: {
  [key: string]: unknown;
}): asserts tools is StagehandAgentTools {
  const names = Object.keys(tools).sort();
  const expected = [...STAGEHAND_AGENT_TOOL_NAMES].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(
      `Stagehand tool contract mismatch: expected [${expected.join(", ")}], got [${names.join(", ")}].`,
    );
  }
}

export interface StagehandAgentRunResult<T> {
  result: T;
  cleanup: StagehandAgentCleanupReport;
}

/**
 * Run agent work against ONE shared runtime and close it exactly once when
 * the run ends (success, failure, or cancellation). Cleanup uses independent
 * guarded calls:
 * - a work error is always rethrown unmasked, with the cleanup report
 *   attached as `(error as { stagehandCleanup })`;
 * - work success + cleanup failure throws a cleanup error instead of
 *   claiming a clean close.
 */
export async function withStagehandAgent<T>(
  config: StagehandAgentEnvConfig,
  work: (ctx: {
    runtime: StagehandAgentRuntime;
    tools: StagehandAgentTools;
  }) => Promise<T>,
  overrides?: {
    /** Test seam: substitute the shared-runtime factory. */
    createRuntime?: (
      config: StagehandAgentEnvConfig,
    ) => Promise<StagehandAgentRuntime>;
  },
): Promise<StagehandAgentRunResult<T>> {
  const runtime = await (overrides?.createRuntime
    ? overrides.createRuntime(config)
    : createStagehandAgentRuntime(config));
  const tools = createStagehandAgentTools(runtime);
  let result: T;
  try {
    result = await work({ runtime, tools });
  } catch (workError) {
    const cleanup = await runtime.close();
    (workError as { stagehandCleanup?: StagehandAgentCleanupReport }).stagehandCleanup =
      cleanup;
    throw workError;
  }
  const cleanup = await runtime.close();
  if (cleanup.errors.length > 0) {
    throw new Error(
      `Agent work succeeded but cleanup failed: ${cleanup.errors.join(" | ")}`,
    );
  }
  return { result, cleanup };
}
