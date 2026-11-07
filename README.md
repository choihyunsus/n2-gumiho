# N2 Gumiho

Gumiho is a Node.js harness for role-isolated agent work. One registered provider supplies analysis, planning, implementation and review tails. Each tail can have its own model, provider route, tool permissions and output budget.

N2R enforces preparation and final verification. Mimir stores scoped outcomes and execution evidence in the common Soul SQLite database. Gumiho exposes a library API and a command-line interface.

[한국어 문서](README.ko.md)

## Install

Requires Node.js 22 or later. Install the versioned GitHub release asset.

```sh
npm install https://github.com/choihyunsus/n2-gumiho/releases/download/v1.0.0/n2-gumiho-1.0.0.tgz
```

The runtime pins N2R 1.0.0 and Mimir 3.0.3. N2R also brings Clotho 4.0.1 and Personas 1.0.0. Gumiho source uses MIT. Mimir and Clotho carry their published non-commercial/commercial license terms. [License](LICENSE), [dependency notices](THIRD-PARTY-NOTICES).

## Run the offline example

Create a scratch workspace and a directory for its database.

```sh
mkdir demo-workspace
mkdir demo-memory
npx --no-install n2-gumiho run --adapter ./node_modules/n2-gumiho/examples/file-task.cjs --db ./demo-memory/mimir.db --workspace ./demo-workspace --project demo --agent worker --run-id first-run --task "Create the demonstration file"
npx --no-install n2-gumiho status --db ./demo-memory/mimir.db --project demo --agent worker --run-id first-run
```

This example uses deterministic provider replies, creates `gumiho-demo.txt`, and checks its actual bytes. An existing file with different content produces a failed result. To exercise coordinator mode, use `--mode coordinator` and a new run ID.

Exit code `0` means success, `1` means an error or interrupted operation, `2` means completed failed work, and `3` means the requested status record is absent.

## Connect a local model

The `ollama-workspace.cjs` adapter uses an installed Ollama model, bounded UTF-8 file tools and explicitly configured project checks. Set these environment values before loading it.

| Variable | Purpose |
| --- | --- |
| `N2_GUMIHO_MODEL` | Required installed model name |
| `N2_GUMIHO_CHECK_ARGS` | Required JSON array of arguments for a meaningful project check |
| `N2_GUMIHO_CHECK_COMMAND` | Check executable, defaulting to the current Node executable |
| `N2_GUMIHO_CHECK_TIMEOUT_MS` | Check timeout, defaulting to 120000 |
| `N2_GUMIHO_TOOL_MODE` | `native` by default, or explicit local `json` tool mode |
| `N2_GUMIHO_CONTEXT_LENGTH` | Optional Ollama context length |
| `N2_GUMIHO_THINK` | Optional JSON boolean, null, or quoted model-supported thinking level |
| `N2_GUMIHO_OLLAMA_ENDPOINT` | Optional full chat endpoint, defaulting to loopback port 11434 |

For a Node project with an actual `test` directory, PowerShell configuration can use the following values. Replace the model placeholder with an installed model.

```powershell
$env:N2_GUMIHO_MODEL = 'YOUR_INSTALLED_MODEL'
$env:N2_GUMIHO_CHECK_ARGS = '["--test","test"]'
$env:N2_GUMIHO_CONTEXT_LENGTH = '8192'
npx --no-install n2-gumiho run --adapter ./node_modules/n2-gumiho/examples/ollama-workspace.cjs --db ./memory/mimir.db --workspace ./your-project --project your-project --agent worker --run-id change-1 --task "Implement the requested change and satisfy the project tests"
```

Use Ollama's `/api/show` capability metadata and the model's documentation to select a supported thinking control. Local JSON mode constrains the response envelope and validates every dispatched tool argument. Explicit `contextLength` and `think` options become part of the provider's replay identity. [Ollama thinking controls](https://docs.ollama.com/capabilities/thinking), [context and concurrency settings](https://docs.ollama.com/faq).

The example file tools handle existing directories and UTF-8 files up to 32 KiB. Reads return a SHA-256. Writes require that hash, or `new` for creation, and check again before replacing a file. Missing files and path errors return corrective tool feedback.

## Library use

Save the following as an ES module after configuring the Ollama adapter's environment values and creating the database directory.

```js
import { Gumiho } from 'n2-gumiho';
import adapter from 'n2-gumiho/examples/ollama-workspace.cjs';

const app = await Gumiho.create({
  ...adapter,
  dbPath: './memory/mimir.db',
  workspaceRoot: './your-project',
  project: 'your-project',
  agent: 'worker',
  mode: 'pipeline',
});

try {
  const result = await app.run({
    runId: 'change-1',
    sessionId: 'session-1',
    task: 'Implement the requested change and verify it',
  });
  console.log(result.success, result.budget, result.verification);
} finally {
  await app.close();
}
```

`run` accepts an optional `AbortSignal`. `close` cancels active work and drains cooperative operations. `status(runId)` returns detailed scoped records. `inspectGumiho({dbPath, project, agent, runId})` reads a consistent status summary through a read-only SQLite connection.

## Execution modes

### Pipeline

The default flow is analysis → plan → build → native checks → independent review. A failed analysis or plan stops downstream work. Verification failures can trigger bounded repairs, with one repair round by default and a configurable maximum of three.

Default tails are `analyze`, `plan`, `build` and `verify`. Analysis, planning and review receive read-only capabilities. The build tail receives registered write-capable tools. Explicit `tails` configuration replaces the default list.

```js
const tails = [
  { id: 'analyze', role: 'analyze' },
  { id: 'plan', role: 'plan' },
  { id: 'build', role: 'build', maxOutputTokens: 4096 },
  { id: 'verify', role: 'verify', model: 'YOUR_REVIEW_MODEL' },
];
```

Use `providerId` on a tail to select another provider registered in `providers`. `tools: []` grants an empty tool set. An omitted `tools` field allows the tools compatible with the tail's read-only setting.

### Coordinator

Set `mode: 'coordinator'`. A control-only conversation inherits its model route from `coordinator.sourceTail`, defaulting to the configured first tail. Its delegation capabilities are defined separately by `coordinator.targets`.

The controller can dispatch up to four independent jobs per batch, retry failed worker jobs, inspect durable receipts, and request native verification plus independent review. Reader jobs use bounded concurrency. Write-capable jobs hold exclusive workspace admission. Each batch is persisted before child effects begin.

Completion requires resolved jobs, a successful review receipt, the current artifact hash and the current worker-evidence hash. Later worker results require renewed approval even when file contents are identical. Historical failed jobs retain their results and explicit replacement links.

```js
const coordinator = {
  sourceTail: 'plan',
  verifyTail: 'verify',
  targets: ['analyze', 'plan', 'build'],
  maxTurns: 16,
};
```

Both modes support an optional read-only advisor through `advisorTail` and `advisorMaxCalls`. Host control flow invokes plan, stalled-work and final checkpoints. Exhausted advisor budgets produce recorded skipped checkpoints. Model/provider specialization is optional.

## Provider adapters

Every factory requires explicit `id` and `model` values.

| Factory | Protocol and settings |
| --- | --- |
| `openAIResponses` | Responses API, `apiKey`, stateless output replay |
| `anthropicMessages` | Messages API, `apiKey`, API version 2026-10-21 |
| `geminiInteractions` | Interactions API, `apiKey`, chronological step replay |
| `ollamaChat` | Native calls or local JSON tool mode, optional `contextLength` and `think` |
| `openAICompatible` | Explicit full endpoint, optional key, selectable `max_completion_tokens` or `max_tokens` |

Adapters preserve supported opaque continuation records and complete function-call/result groups. Registered JSON schemas are enforced before host invocation. Provider endpoints accept HTTPS and loopback HTTP. HTTP responses are bounded, errors retain redacted diagnostics, and 429/503 retries honor bounded server delays.

Gemini's normalized generated-token count includes separately reported thinking tokens. Its output limit also covers those tokens. Select a tail output budget appropriate for the model's reasoning requirements. [Google thinking and token limits](https://aistudio.google.com/docs/thinking).

The implementations follow current function-calling and stateless-conversation contracts. [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [Claude tool-result handling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls), [Gemini function calling](https://aistudio.google.com/docs/function-calling), [Ollama chat](https://docs.ollama.com/api/chat).

Custom `ModelProvider.generate(request)` implementations return `text`, `calls`, `stop`, `model` and nullable token usage. They must honor cancellation and output ceilings. Invoke `request.onAttempt` before each actual request, including retries. Gumiho reserves an initial attempt even for custom handlers that omit that callback.

Model request IDs and host tool call IDs include the project, agent, run, job and turn identity. An interrupted invocation retains its ID on replay. Separate runs receive distinct IDs for provider or host idempotency handling.

## Tools and native verification

A `GumihoTool` declares a name, version, description, synchronous JSON object schema, capabilities and an `execute` handler. Tool results contain `success` and `output`, with optional `data` and `modifiedFiles`. Expected operational failures should return `success: false`. Thrown errors preserve an interrupted invocation for recovery.

Tool names follow N2R's ASCII identifier convention. Provider-facing aliases are generated when a name needs adaptation. Read-only tools receive filtered admission and must report their capabilities accurately. Host tools and configured check commands execute with the embedding process's permissions. The embedding host owns OS isolation, external-editor coordination and permission enforcement.

Supply a versioned `NativeVerifier`, or construct one with `commandVerifier(checks, version)`. Checks use explicit executable/argument lists, bounded output and timeouts. Independent review must return the exact snapshot hash and structured findings. Native failures, blocking findings, stale artifacts and unresolved jobs prevent a successful lifecycle result.

Review output accepts a JSON object, optionally inside one complete JSON code fence. The same field types, exact snapshot hash and blocking-finding checks apply to either representation. Additional prose or multiple blocks cause review failure.

Final native checks are refreshed to cover current external evidence. Their receipts remain linked to the N2R verification call. Review quality and test coverage depend on the selected model and the host's actual check implementation.

## Shared Soul database

Use the same explicit SQLite file as Soul and Mimir. Shared fields retain their common meanings, including `project`, `agent`, `session_id`, `source_ref`, `context`, `action` and `outcome`.

Gumiho adds six scoped tables under `gumiho_schema_version = 1`.

| Table | Stored information |
| --- | --- |
| `gumiho_runs` | Immutable run identity and resource accounting |
| `gumiho_jobs` | Tasks, isolated role results and replacement lineage |
| `gumiho_calls` | Pending/completed model and tool invocations |
| `gumiho_leases` | Scoped and workspace ownership |
| `gumiho_events` | Execution events |
| `gumiho_receipts` | Snapshots, verification and workflow receipts |

N2R adds its own lifecycle tables and records one scoped outcome when finalization succeeds. A completed failed workflow records a failure experience. Run IDs in N2R use the `gumiho-` namespace. Unversioned Gumiho tables require an explicit migration before use.

## Recovery

Reuse the same run ID, session ID, task and configuration after an interruption. Completed matching invocations replay from durable receipts. A pending idempotent operation can run again. An uncertain non-idempotent host effect raises `ReconciliationRequired`.

Inspect the actual effect, then reconcile its individual host-tool invocation with a result and evidence note.

```js
await app.reconcileTool(
  'change-1',
  'tool-INVOCATION_ID',
  { success: true, output: 'Read-back matched the expected content', modifiedFiles: ['src/example.ts'] },
  'Verified the affected file bytes against the expected result',
);
```

The CLI equivalent uses `reconcile` with `--call-id`, `--result` and `--evidence`. Composite coordinator operations resume through their child receipts. Use a new run ID after changing the engine version, model route, tool/verifier versions, budgets or workflow policy.

Completed run results describe their recorded verification point. An interrupted workflow with saved successful work must still match its evidence before it can finish. Pending model requests may have incurred provider usage, and a retry consumes another reserved attempt.

## Resource and artifact bounds

| Default | Limit |
| --- | --- |
| Local / cloud model concurrency | 1 / 2 |
| Parallel read-only jobs | 2 |
| Jobs / model attempts / tool attempts | 64 / 64 / 128 |
| Turns per job / controller | 16 / 16 |
| Requested output per tail call | 2048 tokens |
| Run output reservation | 131072 tokens |
| Model history / durable trace | 256 KiB / 32 MiB |
| Model / tool / job timeout | 120 s / 120 s / 600 s |
| Outer N2R work deadline | 1 hour |
| Snapshot file count / individual size / total bytes | 2000 / 16 MiB / 256 MiB |
| Snapshot manifest | 512 KiB |

Complete assistant/tool groups are retained during history compaction. Tails can page full job, invocation and verification receipts through the internal journal tools. Reported usage stays nullable when a provider omits it. Output reservations cap generation. Monetary estimates require provider-specific pricing and usage information.

The default snapshot policy excludes `.git`, `node_modules`, `target`, `dist` and `.next`, together with Gumiho's database sidecars. Declare another `snapshot` policy when task outputs live in those directories. Reported changes must be covered by that policy and use canonical regular-file paths. Symlinks are recorded as link metadata. Unsupported special filesystem nodes fail explicitly. A run supports up to 1024 reported file changes.

Workspace exclusion is coordinated among Gumiho workflows sharing the database. Host callbacks must cooperate with cancellation. Check-command process termination is best effort for descendant processes created outside the host's supervision.

## Development and verification

```sh
npm ci
npm test
npm run typecheck:consumer
npm audit --omit=dev --audit-level=low
npm pack
```

The suite exercises normal API and CLI entry points, real file writes and native checks, provider HTTP fixtures, role isolation, concurrent admission, killed-process recovery, transaction rollback, stale evidence, failed-job lineage and shared-schema preservation. Consumer declarations are checked as both ESM and CommonJS with dependency checking enabled. CI runs on Windows, Linux and macOS.

Live-model accuracy, latency and cost need evaluation with the chosen model, hardware and task set. The offline demonstration and HTTP fixtures provide deterministic protocol and lifecycle coverage.
