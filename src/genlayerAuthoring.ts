// Contract authoring helpers for the GenLayer MCP server.
//
// Two capabilities, both pure and dependency-free so they are easy to test:
//   - scaffoldContract(): emit a working starter Intelligent Contract for a
//     chosen template, with the runner header pinned and the common GenVM
//     deploy-killers already avoided.
//   - lintContractSource(): static checks that catch the mistakes that make a
//     contract finalize with `invalid_contract` (no stack trace) or fail
//     consensus, before you ever spend a deploy on it.
//
// Nothing here is copied from any third-party package; the rules come from the
// public GenLayer docs/skills and from deploy failures observed firsthand.

// Pinned production runner. `py-genlayer:test` / `:latest` are local-only aliases
// and are rejected by every GenLayer network.
export const RUNNER_HEADER =
  '# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }';

// ── Linter ───────────────────────────────────────────────────────────────────

export type LintLevel = "error" | "warning" | "info";

export interface LintFinding {
  level: LintLevel;
  line: number; // 1-based; 0 when not tied to a specific line
  rule: string;
  message: string;
  hint?: string;
}

export interface LintResult {
  ok: boolean; // true when there are no errors
  errors: number;
  warnings: number;
  infos: number;
  findings: LintFinding[];
}

const RUNNER_LINE_RE = /^#\s*\{.*?"Depends"\s*:\s*"(py-genlayer[\w.-]*(?::[^"]*)?)"/;

export function lintContractSource(source: string): LintResult {
  const findings: LintFinding[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const add = (level: LintLevel, line: number, rule: string, message: string, hint?: string) =>
    findings.push(hint ? { level, line, rule, message, hint } : { level, line, rule, message });

  // 1. Runner header must be the first non-blank line.
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (l !== undefined && l.trim() !== "") {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    add("error", 0, "empty-file", "Contract source is empty.");
    return summarize(findings);
  }

  const headerLine = lines[headerIdx] ?? "";
  const headerMatch = headerLine.match(RUNNER_LINE_RE);
  if (!headerMatch) {
    add(
      "error",
      headerIdx + 1,
      "missing-runner-header",
      "First line must be a pinned runner header.",
      `Add as the very first line: ${RUNNER_HEADER}`
    );
  } else {
    const dep = headerMatch[1] ?? "";
    if (/:test\b/.test(dep) || /:latest\b/.test(dep)) {
      add("error", headerIdx + 1, "runner-alias", `Runner "${dep}" is a local-only alias and is rejected by all GenLayer networks.`, "Pin a concrete version hash, e.g. py-genlayer:1jb45aa8…");
    } else if (!/:[0-9a-z]{40,}/.test(dep) && !dep.includes("py-genlayer-multi") && !dep.includes("py-lib")) {
      add("error", headerIdx + 1, "unpinned-runner", `Runner "${dep}" is not pinned to a version hash.`, "Pin a concrete runner version hash.");
    }

    // 2. THE big one: no comment lines may sit between the header and the first
    //    line of code. They break GenVM's dependency-header parsing and the
    //    deploy fails with a bare `invalid_contract` and no stack trace.
    for (let i = headerIdx + 1; i < lines.length; i += 1) {
      const cur = lines[i];
      if (cur === undefined) continue;
      const t = cur.trim();
      if (t === "") continue;
      if (t.startsWith("#")) {
        // allow a multi-line Seq/Depends JSON header block (starts with `# {` / `# "`)
        const looksLikeHeaderJson = /^#\s*[{"\[\]}]/.test(t) || /Depends|Seq/.test(t);
        if (!looksLikeHeaderJson) {
          add(
            "error",
            i + 1,
            "comment-after-header",
            "Comment line directly after the runner header. This breaks GenVM header parsing and the deploy fails with a bare `invalid_contract`.",
            "Move description comments to below the imports."
          );
        }
        continue;
      }
      break; // first real code line reached
    }
  }

  // 3. Structural essentials.
  if (!/^\s*from\s+genlayer\s+import\s+\*/m.test(source)) {
    add("error", 0, "missing-import", "Missing `from genlayer import *`.", "Add it right after the runner header.");
  }
  if (!/class\s+\w+\s*\(\s*gl\.Contract\s*\)/.test(source)) {
    add("error", 0, "missing-contract-class", "No `class Name(gl.Contract)` found. A contract needs exactly one.");
  }
  if (!/@gl\.public\.(view|write)/.test(source)) {
    add("warning", 0, "no-public-methods", "No `@gl.public.view` / `@gl.public.write` methods. The contract has no callable surface.");
  }

  // 4. Per-line checks for the GenVM Python subset and storage anti-patterns.
  lines.forEach((raw, i) => {
    const line = raw.replace(/#.*$/, ""); // ignore trailing comments
    const ln = i + 1;
    if (/^\s*for\s+\S+\s+in\s+/.test(line)) {
      add("warning", ln, "for-loop", "`for` loops can be rejected by the GenVM Python subset. Reference contracts use `while` only.", "Rewrite as a `while` loop with an index counter.");
    }
    if (/\bsorted\s*\(/.test(line)) add("warning", ln, "sorted", "`sorted()` is not supported by the GenVM Python subset.", "Sort manually with a `while` loop (selection sort).");
    if (/\.sort\s*\(/.test(line)) add("warning", ln, "list-sort", "`.sort()` is not supported by the GenVM Python subset.", "Sort manually with a `while` loop.");
    if (/\blambda\b/.test(line)) add("warning", ln, "lambda", "`lambda` is not supported by the GenVM Python subset.", "Use a named helper or inline the logic.");

    // storage type hints: plain Python containers/ints as field/param annotations
    if (/^\s+\w+\s*:\s*(list|dict)\b/.test(line)) {
      add("warning", ln, "python-container", "Use `DynArray[T]` / `TreeMap[K, V]` for storage, not `list` / `dict`.");
    }
    if (/self\.\w+\s*:\s*\w+\s*=/.test(line)) {
      add("warning", ln, "init-annotation", "Storage fields are class-level annotations, not annotated assignments in __init__.", "Declare `field: T` at class level; set only the value in __init__.");
    }
    // LLM call without consensus wrapper on the same logical line is a common bug,
    // but too noisy to assert here; left to the write-contract guidance.
  });

  // 5. Money/float hint.
  if (/:\s*float\b/.test(source)) {
    add("info", 0, "float-money", "Using `float`? For money/cross-chain values prefer `u256` at atto-scale (value * 10**18).");
  }

  return summarize(findings);
}

function summarize(findings: LintFinding[]): LintResult {
  const errors = findings.filter((f) => f.level === "error").length;
  const warnings = findings.filter((f) => f.level === "warning").length;
  const infos = findings.filter((f) => f.level === "info").length;
  return { ok: errors === 0, errors, warnings, infos, findings };
}

// ── Scaffolder ─────────────────────────────────────────────────────────────────

export type ContractTemplate = "storage" | "llm-judge" | "web-oracle" | "token";

export const CONTRACT_TEMPLATES: Record<ContractTemplate, string> = {
  storage: "Minimal persisted key/value store. Good first contract to learn storage + public methods.",
  "llm-judge": "AI judge: fetches a URL and scores it 0-100 with an LLM under validator consensus (the GenLayer superpower).",
  "web-oracle": "Reads an external JSON API and exposes a verified value via the equivalence principle.",
  token: "Simple in-contract balances with a transfer, demonstrating TreeMap storage + access checks (no LLM)."
};

export interface ScaffoldResult {
  template: ContractTemplate;
  className: string;
  code: string;
  summary: string;
  nextSteps: string[];
}

function toClassName(name: string | undefined, fallback: string): string {
  const base = (name ?? "").replace(/[^A-Za-z0-9]/g, " ").trim();
  if (!base) return fallback;
  return base
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

export function scaffoldContract(template: ContractTemplate, contractName?: string): ScaffoldResult {
  const className = toClassName(contractName, defaultClassName(template));
  const code = `${RUNNER_HEADER}\n${TEMPLATE_BODIES[template](className)}`;
  return {
    template,
    className,
    code,
    summary: CONTRACT_TEMPLATES[template],
    nextSteps: [
      "Lint it: paste the code into `genlayer_lint_contract` before deploying.",
      "Test fast in direct mode, then run an integration test against consensus.",
      "Deploy with the GenLayer CLI or genlayer-js, waiting for FINALIZED before reading.",
      "Inspect the deployed contract here with `genlayer_get_contract_snapshot`."
    ]
  };
}

function defaultClassName(template: ContractTemplate): string {
  switch (template) {
    case "storage": return "KeyValueStore";
    case "llm-judge": return "Judge";
    case "web-oracle": return "PriceOracle";
    case "token": return "MiniToken";
  }
}

// Each body starts on the line *immediately* after the runner header — no
// comment in between, on purpose (see the comment-after-header lint rule).
const TEMPLATE_BODIES: Record<ContractTemplate, (cls: string) => string> = {
  storage: (cls) => `from genlayer import *


# ${cls}: a minimal persisted key/value store.
class ${cls}(gl.Contract):
    owner: Address
    entries: TreeMap[str, str]
    keys: DynArray[str]

    def __init__(self):
        self.owner = gl.message.sender_account

    @gl.public.write
    def set_value(self, key: str, value: str) -> None:
        if key not in self.entries:
            self.keys.append(key)
        self.entries[key] = value

    @gl.public.view
    def get_value(self, key: str) -> str:
        if key not in self.entries:
            return ""
        return self.entries[key]

    @gl.public.view
    def all_keys(self) -> list:
        out = []
        i = 0
        while i < len(self.keys):
            out.append(self.keys[i])
            i += 1
        return out
`,

  "llm-judge": (cls) => `from genlayer import *

import json


# ${cls}: scores a web resource 0-100 with an LLM under validator consensus.
class ${cls}(gl.Contract):
    last_score: u256

    def __init__(self):
        self.last_score = u256(0)

    @gl.public.write
    def judge(self, url: str, criteria: str) -> typing.Any:
        score = self._score(url, criteria)
        self.last_score = u256(score)
        return {"url": url, "score": score, "stands_out": score >= 60}

    def _score(self, url: str, criteria: str) -> int:
        def leader_fn() -> typing.Any:
            page = ""
            try:
                response = gl.nondet.web.request(url, method="GET")
                page = response.body.decode("utf-8", errors="ignore")[:6000]
            except Exception:
                page = "[unreachable]"

            prompt = (
                "You are a strict judge. Score this resource 0-100 against the "
                "criteria. Return ONLY JSON: {\\"score\\": <0-100>}.\\n"
                "Criteria: " + criteria + "\\nResource (" + url + "):\\n" + page
            )
            raw = gl.nondet.exec_prompt(prompt)
            data = raw if isinstance(raw, dict) else json.loads(
                str(raw)[str(raw).find("{"): str(raw).rfind("}") + 1]
            )
            try:
                score = int(round(float(str(data.get("score", 0)).strip())))
            except (ValueError, TypeError):
                score = 0
            return max(0, min(100, score))

        def validator_fn(leaders_res: gl.vm.Result) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return False
            mine = leader_fn()
            theirs = leaders_res.calldata
            # Agree on the score band, not the exact number (equivalence principle).
            return (mine // 25) == (int(theirs) // 25)

        return gl.vm.run_nondet_unsafe(leader_fn, validator_fn)

    @gl.public.view
    def get_last_score(self) -> int:
        return int(self.last_score)
`,

  "web-oracle": (cls) => `from genlayer import *

import json


# ${cls}: reads an external JSON API and verifies the value across validators.
class ${cls}(gl.Contract):
    last_value: str

    def __init__(self):
        self.last_value = ""

    @gl.public.write
    def refresh(self, api_url: str, json_field: str) -> str:
        value = self._fetch_field(api_url, json_field)
        self.last_value = value
        return value

    def _fetch_field(self, api_url: str, json_field: str) -> str:
        def fetch() -> str:
            response = gl.nondet.web.request(api_url, method="GET")
            if response.status >= 400:
                raise gl.vm.UserError("[EXTERNAL] API returned " + str(response.status))
            data = json.loads(response.body.decode("utf-8"))
            # Return only the stable field you care about, not volatile metadata.
            return str(data[json_field])

        # Deterministic JSON API -> validators must reproduce the exact value.
        return gl.eq_principle.strict_eq(fetch)

    @gl.public.view
    def get_last_value(self) -> str:
        return self.last_value
`,

  token: (cls) => `from genlayer import *


# ${cls}: in-contract balances with a transfer. No LLM, pure storage + checks.
class ${cls}(gl.Contract):
    owner: Address
    total_supply: u256
    balances: TreeMap[str, u256]

    def __init__(self, initial_supply: int):
        self.owner = gl.message.sender_account
        self.total_supply = u256(initial_supply)
        self.balances[str(gl.message.sender_account)] = u256(initial_supply)

    @gl.public.view
    def balance_of(self, account: str) -> int:
        if account not in self.balances:
            return 0
        return int(self.balances[account])

    @gl.public.write
    def transfer(self, to: str, amount: int) -> None:
        sender = str(gl.message.sender_account)
        amt = u256(amount)
        sender_balance = self.balances[sender] if sender in self.balances else u256(0)
        if sender_balance < amt:
            raise gl.vm.UserError("[EXPECTED] Insufficient balance")
        self.balances[sender] = sender_balance - amt
        to_balance = self.balances[to] if to in self.balances else u256(0)
        self.balances[to] = to_balance + amt

    @gl.public.view
    def get_total_supply(self) -> int:
        return int(self.total_supply)
`
};
