# AX and DX task benchmark

Run the same tasks against independently pinned app fixtures and agent versions.
The ten prompts in `tasks.json` cover coding agents changing an application and
runtime agents using it. These are task-completion trials: `pracht eval` remains
the deterministic regression suite for explicit protocol calls.

## Prepare a fixture

Create a local Git repository for each baseline. Use equivalent initial data,
authenticated accounts, denied resources, and a production smoke test. Commit
all prerequisites, lockfiles, and acceptance programs, then record its full SHA.
A repair task must start with the same seeded fault in each framework.

Include full Pracht, another framework, and that framework with standalone
`@pracht/capabilities` as separate baselines. Pin framework, runtime, package
manager, agent, model, tool configuration, and the fixture's source commit. Keep
documentation access and resource limits comparable. Do not call a comparison
fair if one fixture arrives with more of the requested task already implemented.

Each task lists the observable criteria every baseline must check. Write one
command per criterion: it exits 0 only if that observation holds. Use HTTP or
browser probes for state and access policy; use a separate evaluator for criteria
such as the final explanation. Runtime fixtures must have a test approval
channel and an independent record of approval and mutation order.

The same agent can edit acceptance programs, so run checks through an evaluator
outside the disposable checkout. Do not trust an agent-authored assertion or its
own claim of success. Evaluators may use `PRACHT_TASK_WORKSPACE` to inspect the
result. Keep hidden expectations outside the workspace and task prompt. Run only
in disposable test accounts with synthetic data.

## Configure a run

Create a config file outside the fixture repository, for example
`.tmp/axdx/pracht.json`. It must configure every criterion for each selected task:

```json
{
  "framework": "pracht",
  "frameworkVersion": "the exact installed version",
  "source": "/absolute/path/to/app-fixture",
  "revision": "0000000000000000000000000000000000000000",
  "agent": {
    "name": "your-agent-wrapper",
    "version": "pinned wrapper revision",
    "model": "exact model identifier",
    "command": ["/absolute/path/to/agent-wrapper"]
  },
  "setup": [["pnpm", "install", "--frozen-lockfile"]],
  "tasks": {
    "repair-loader": {
      "context": "The seeded project is Aurora. Keep the existing access policy.",
      "setup": [],
      "checks": {
        "detail-repaired": ["/absolute/path/to/evaluator", "detail-repaired"],
        "auth-preserved": ["/absolute/path/to/evaluator", "auth-preserved"],
        "exposure-preserved": ["/absolute/path/to/evaluator", "exposure-preserved"]
      }
    }
  }
}
```

Replace the all-zero SHA with the fixture commit. `source` resolves relative to
the config file and must be a local repository. Commands are argv arrays and do
not pass through a shell. Shell syntax works only if you explicitly configure a
shell executable. Setup commands run to completion; they are not service
supervisors. Agent wrappers and evaluators must start and stop any services they
need within their own command lifetime. Runtime fixtures need persistent state shared by the agent and evaluators: an in-memory server owned by the agent is stopped before checks run. Have evaluators restart the service over that persistent test store or use a fixture service whose lifecycle is managed outside these commands.

List prompts, then run repeated fresh trials:

```sh
node bench/tasks/run.mjs --list
node bench/tasks/run.mjs --config .tmp/axdx/pracht.json \
  --task repair-loader --repeats 3 --out .tmp/axdx/results/pracht-repair
```

Each trial clones only committed source into an independent temporary checkout,
runs setup, gives the prompt to the agent on stdin, then runs every acceptance
check. It removes the checkout afterward. The original working tree is not used
as the agent's workspace. Uncommitted edits and installed dependencies are not
copied. A command defaults to a 15-minute timeout; override it with
`--timeout-ms`. Background processes in that command's process group are stopped
when it exits or times out. Output logs are capped at 1 MB per command.

The wrapper receives `PRACHT_TASK_PROMPT_FILE`, `PRACHT_TASK_WORKSPACE`, and
`PRACHT_TASK_METRICS_FILE`. It may write measured telemetry to the metrics file:

```json
{
  "interventions": 0,
  "toolCalls": 12,
  "inputTokens": 20000,
  "outputTokens": 1800,
  "repairCycles": 2
}
```

Use counts from the agent host or a human observer. Omit metrics your host does
not expose; missing values remain `null`. Never infer zero interventions or zero
context use from absent telemetry. A repair cycle is a failed validation followed
by a corrective edit; use this definition for every baseline. Count any human
hint, manual edit, or approval beyond the task's prescribed approval channel as
an intervention.

## Read the result

Choose a fresh output directory for each run; existing trial directories are
never overwritten. Each trial stores its config, prompt, suite/configuration
hashes, runner hash, command timeout, harness Node/OS/architecture, bounded logs,
and `result.json`. A passing
trial requires the agent command and every criterion to succeed. Setup failures,
agent failures, timeouts, and failed criteria stay in the denominator. Missing or
invalid telemetry is reported separately and never counted as a zero.

`summary.json` groups trials by framework version, fixture SHA, agent version,
model, command, suite/configuration/runner hashes, harness runtime, and task.
The configuration hash includes the command timeout. It reports
success rate, median agent duration, and each metric's median plus observation count. Agent duration excludes setup and
acceptance checks; total trial duration is also recorded. Do not compare medians
without the success rates and sample counts beside them.

Run at least three trials per task and baseline, alternate baseline order, retain
failed runs, and publish raw records with your observations. Record human review
effort separately using the same rubric. These results measure these tasks,
fixtures, and agent versions; they are not a universal framework ranking. The
harness ships without comparative scores.
