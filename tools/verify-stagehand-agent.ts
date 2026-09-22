// tools/verify-stagehand-agent.ts
//
// Verification for the stateful Vercel AI SDK + Stagehand v4 integration.
// Invokes the REGISTERED tool objects' framework-level execution contract
// (tools.<name>.execute(...)) directly. A full LLM-driven agent loop is NOT
// run here (no model-provider credential in this environment); that gap is
// reported at the end. A direct call to a private helper would not satisfy
// framework integration verification, so every browser assertion below goes
// through `tools.*.execute`.
//
// Run: npx tsx tools/verify-stagehand-agent.ts
// Prints no credentials (only key-presence booleans and non-secret evidence).

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import {
  assertStagehandAgentToolContract,
  closeBrowserAndStagehand,
  createStagehandAgentTools,
  createStagehandAgentRuntime,
  readStagehandAgentConfigFromEnv,
  withStagehandAgent,
  STAGEHAND_AGENT_TOOL_NAMES,
} from "../server/agent/stagehandBrowserAgent";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function readInstalledVersion(dir: string): string {
  const pkgPath = path.join("node_modules", dir, "package.json");
  const raw = fs.readFileSync(pkgPath, "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

function optionsFor(toolCallId: string) {
  return {
    toolCallId,
    messages: [] as never[],
    context: undefined as never,
  };
}

async function main(): Promise<void> {
  const stagehandVersion = readInstalledVersion("@browserbasehq/stagehand");
  const aiVersion = readInstalledVersion("ai");
  const zodVersion = readInstalledVersion("zod");
  console.log(
    `resolved versions: @browserbasehq/stagehand=${stagehandVersion} ai=${aiVersion} zod=${zodVersion}`,
  );
  assert(
    stagehandVersion.startsWith("4."),
    "Stagehand must resolve a published major-V4 release",
  );

  const config = readStagehandAgentConfigFromEnv();
  console.log(
    `config: browser=${config.browser} ` +
      `hasBrowserbaseKey=${Boolean(config.browserbaseApiKey)} ` +
      `hasModelKey=${Boolean(config.stagehandModelApiKey)} ` +
      `hasAgentModelKey=${Boolean(process.env.OPENAI_API_KEY)}`,
  );

  // ---- Part A: shared runtime + framework tool contract (success path) ----
  const runtime = await createStagehandAgentRuntime(config);
  const tools = createStagehandAgentTools(runtime);
  try {
    assertStagehandAgentToolContract(tools);
    console.log(
      `tool contract: registered [${[...STAGEHAND_AGENT_TOOL_NAMES].sort().join(", ")}]`,
    );

    // Call 1 through the framework contract: navigate.
    const navigated = (await tools.run.execute(
      { goto: "https://example.com" },
      optionsFor("verify-run-goto"),
    )) as { url: string; title: string };
    assert(
      navigated.url.includes("example.com"),
      `run.goto should land on example.com (got ${navigated.url})`,
    );
    assert(
      navigated.title.length > 0,
      "run.goto should report a non-empty title",
    );
    console.log(
      `run.goto ok: url=${navigated.url} title=${JSON.stringify(navigated.title)}`,
    );

    // Call 2 through the framework contract: snapshot observes call-1 state
    // on the SAME browser/session (statefulness proof).
    const snap = (await tools.snapshot.execute(
      {},
      optionsFor("verify-snapshot"),
    )) as { url: string; title: string; snapshot: string };
    assert(
      snap.url.includes("example.com"),
      "snapshot (call 2) must observe the navigation from run (call 1)",
    );
    assert(
      snap.snapshot.includes("Example"),
      "snapshot tree should contain the example.com content marker",
    );
    console.log(
      `snapshot ok: same-session url=${snap.url} treeChars=${snap.snapshot.length}`,
    );

    // Call 3: page evaluation through the framework contract.
    const evaluated = (await tools.run.execute(
      { evaluate: "document.title" },
      optionsFor("verify-run-eval"),
    )) as { valuePreview: string };
    assert(
      evaluated.valuePreview.includes("Example"),
      "evaluate(document.title) should match the navigated page",
    );
    console.log(`run.evaluate ok: preview=${evaluated.valuePreview}`);

    // Call 4: screenshot through the framework contract.
    const shot = (await tools.screenshot.execute(
      {},
      optionsFor("verify-screenshot"),
    )) as { base64Length: number };
    assert(shot.base64Length > 0, "screenshot must return image bytes");
    console.log(`screenshot ok: base64Length=${shot.base64Length}`);

    // Error path on the shared runtime: an empty run op must reject but the
    // session must stay usable afterwards.
    let invalidRejected = false;
    try {
      await tools.run.execute({}, optionsFor("verify-run-invalid"));
    } catch {
      invalidRejected = true;
    }
    assert(invalidRejected, "run with no operation must reject");
    const afterError = (await tools.snapshot.execute(
      {},
      optionsFor("verify-snapshot-after-error"),
    )) as { url: string };
    assert(
      afterError.url.includes("example.com"),
      "shared session must survive a failed tool call",
    );
    console.log("error-path ok: invalid call rejected, session survived");
  } finally {
    const cleanup = await runtime.close();
    assert(
      cleanup.errors.length === 0,
      `success-path cleanup must be clean (got ${cleanup.errors.join(" | ")})`,
    );
    assert(
      cleanup.stagehand === "closed" && cleanup.browser === "closed",
      "both stagehand and browser must report closed",
    );
    assert(runtime.closed, "runtime must report closed after close()");
    console.log(
      `cleanup ok: stagehand=${cleanup.stagehand} browser=${cleanup.browser}`,
    );
  }

  // ---- Part B: runner failure path (original error never masked) ----
  const sentinel = "sentinel-work-error-verify";
  let caught: unknown = null;
  try {
    await withStagehandAgent(config, async ({ tools: runnerTools }) => {
      await runnerTools.run.execute(
        { goto: "https://example.com" },
        optionsFor("verify-runner-goto"),
      );
      throw new Error(sentinel);
    });
  } catch (err) {
    caught = err;
  }
  assert(
    caught instanceof Error && caught.message === sentinel,
    "runner must rethrow the original work error unmasked",
  );
  const attached = (caught as { stagehandCleanup?: unknown }).stagehandCleanup;
  assert(attached !== undefined, "runner must attach the cleanup report");
  console.log("runner failure-path ok: original error preserved + cleanup ran");

  // ---- Part C: cleanup independence (fake closers, no browser needed) ----
  let browserCloseAttempted = false;
  const fakeReport = await closeBrowserAndStagehand(
    {
      close: async () => {
        throw new Error("boom-stagehand");
      },
    },
    {
      close: async () => {
        browserCloseAttempted = true;
      },
    },
  );
  assert(
    fakeReport.stagehand === "failed" && fakeReport.browser === "closed",
    "a stagehand cleanup failure must not prevent browser cleanup",
  );
  assert(browserCloseAttempted, "browser.close must be attempted independently");
  assert(
    fakeReport.errors.length === 1 &&
      fakeReport.errors[0].includes("boom-stagehand"),
    "cleanup errors must be recorded separately",
  );
  console.log("cleanup-independence ok: stagehand failed, browser still closed");

  // ---- Part D: success + cleanup failure reports failure (fake runtime) ----
  let runnerThrewCleanupError = false;
  try {
    await withStagehandAgent(
      config,
      async () => "work-result",
      {
        createRuntime: async () => ({
          browser: {} as never,
          stagehand: {} as never,
          config,
          closed: true,
          activePage: async () => {
            throw new Error("unused");
          },
          close: async () => ({
            stagehand: "failed" as const,
            browser: "closed" as const,
            errors: ["stagehand.close failed: boom"],
          }),
        }),
      },
    );
  } catch (err) {
    runnerThrewCleanupError =
      err instanceof Error && /cleanup failed/.test(err.message);
  }
  assert(
    runnerThrewCleanupError,
    "work success + cleanup failure must throw instead of claiming clean close",
  );
  console.log("cleanup-failure-reporting ok: success not claimed on bad close");

  // ---- Remaining gaps (honestly reported, not claimed as passing) ----
  if (!process.env.OPENAI_API_KEY) {
    console.log(
      "GAP: full LLM-driven agent loop not run (no OPENAI_API_KEY); " +
        "verification used the registered tools' framework execute contract directly.",
    );
  }
  if (config.browser !== "browserbase") {
    console.log(
      "GAP: Browserbase cloud session check not applicable (local-Chrome " +
        "verification, no BROWSERBASE_API_KEY); no cloud session to correlate.",
    );
  } else {
    console.log(
      "NOTE: Browserbase mode requested; correlate the session via " +
        "`browse cloud sessions list --format table --limit 5` (bounded) " +
        "using the non-secret setup_verification marker when set.",
    );
  }
  console.log("VERIFY_STAGEHAND_AGENT: PASS");
}

if (
  !process.env.VITEST &&
  process.argv.some((arg) => arg.endsWith("verify-stagehand-agent.ts"))
) {
  main().catch((err) => {
    console.error(
      `VERIFY_STAGEHAND_AGENT: FAIL: ${(err as Error)?.message ?? String(err)}`,
    );
    process.exit(1);
  });
}
