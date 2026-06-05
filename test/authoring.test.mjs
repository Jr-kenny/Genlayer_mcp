// Tests for the contract authoring module (scaffolder + linter).
// Zero dependencies: uses the built-in node:test runner against built dist.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import pkg from "../dist/genlayerAuthoring.js";

const { scaffoldContract, scaffoldTest, lintContractSource, CONTRACT_TEMPLATES } = pkg;
const TEMPLATES = Object.keys(CONTRACT_TEMPLATES);

test("every scaffolded contract lints with zero errors", () => {
  for (const t of TEMPLATES) {
    const { code } = scaffoldContract(t, "My Sample Thing");
    const result = lintContractSource(code);
    assert.equal(result.errors, 0, `${t} produced lint errors: ${JSON.stringify(result.findings)}`);
    assert.equal(result.warnings, 0, `${t} produced lint warnings: ${JSON.stringify(result.findings)}`);
  }
});

test("scaffolded contract name becomes a PascalCase class", () => {
  assert.equal(scaffoldContract("storage", "my cool store").className, "MyCoolStore");
  assert.equal(scaffoldContract("token", "").className, "MiniToken"); // falls back to default
});

test("lint flags a comment directly under the runner header", () => {
  const src = [
    '# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }',
    "# my contract",
    "from genlayer import *",
    "class C(gl.Contract):",
    "    @gl.public.view",
    "    def f(self) -> int:",
    "        return 1"
  ].join("\n");
  const r = lintContractSource(src);
  assert.ok(r.findings.some((f) => f.rule === "comment-after-header" && f.level === "error"));
});

test("lint rejects unpinned / alias runners", () => {
  const alias = lintContractSource('# { "Depends": "py-genlayer:test" }\nfrom genlayer import *\nclass C(gl.Contract):\n    @gl.public.view\n    def f(self) -> int:\n        return 1');
  assert.ok(alias.findings.some((f) => f.rule === "runner-alias" && f.level === "error"));
});

test("lint flags forbidden sandbox imports", () => {
  const src = '# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }\nfrom genlayer import *\nimport os\nimport random\nclass C(gl.Contract):\n    @gl.public.view\n    def f(self) -> int:\n        return 1';
  const r = lintContractSource(src);
  const forbidden = r.findings.filter((f) => f.rule === "forbidden-import");
  assert.equal(forbidden.length, 2);
  assert.ok(forbidden.every((f) => f.level === "error"));
});

test("lint warns on GenVM Python-subset constructs", () => {
  const src = '# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }\nfrom genlayer import *\nclass C(gl.Contract):\n    @gl.public.view\n    def f(self):\n        for x in [1, 2]:\n            pass\n        return sorted([2, 1])';
  const r = lintContractSource(src);
  assert.ok(r.findings.some((f) => f.rule === "for-loop"));
  assert.ok(r.findings.some((f) => f.rule === "sorted"));
});

test("a clean minimal contract passes", () => {
  const src = '# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }\nfrom genlayer import *\nclass C(gl.Contract):\n    value: u256\n    def __init__(self):\n        self.value = u256(0)\n    @gl.public.view\n    def get(self) -> int:\n        return int(self.value)';
  const r = lintContractSource(src);
  assert.equal(r.ok, true, JSON.stringify(r.findings));
});

test("every test scaffold uses the genlayer-test fixtures", () => {
  for (const t of TEMPLATES) {
    const { code, path } = scaffoldTest(t, "My Sample Thing");
    assert.match(code, /direct_deploy/);
    assert.match(path, /^tests\/direct\/test_.+\.py$/);
  }
});

test("web-using templates mock the network in their tests", () => {
  assert.match(scaffoldTest("llm-judge").code, /mock_llm/);
  assert.match(scaffoldTest("web-oracle").code, /mock_web/);
});

test("templates use the canonical documented APIs (not legacy forms)", () => {
  const judge = scaffoldContract("llm-judge").code;
  const oracle = scaffoldContract("web-oracle").code;
  // Canonical web + LLM APIs per the GenLayer docs / write-contract skill.
  assert.match(judge, /gl\.nondet\.web\.get\(/);
  assert.match(judge, /gl\.nondet\.exec_prompt\(prompt, response_format="json"\)/);
  assert.match(oracle, /gl\.nondet\.web\.get\(/);
  // sender uses the documented accessor.
  assert.match(scaffoldContract("storage").code, /gl\.message\.sender_account/);
  // No legacy gl.nondet.web.request form in any template.
  for (const t of TEMPLATES) {
    assert.doesNotMatch(scaffoldContract(t).code, /web\.request\(/, `${t} uses legacy web.request`);
  }
});

test("canonical contract-rules sheet is exported and current", () => {
  assert.equal(typeof pkg.CONTRACT_RULES_MARKDOWN, "string");
  assert.match(pkg.CONTRACT_RULES_MARKDOWN, /py-genlayer:1jb45aa8/);
  assert.match(pkg.CONTRACT_RULES_MARKDOWN, /comment lines may follow the runner header|comment directly under it|No comment lines may follow/i);
});
