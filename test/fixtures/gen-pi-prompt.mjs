// Regenerates pi-prompt.json from a real Pi build, so the Pi collector is tested on the prompt Pi
// actually writes. Prints the JSON; the docs paths are rewritten by hand to /usr/local/lib/node_modules.
//   node test/fixtures/gen-pi-prompt.mjs <pi>/node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js > test/fixtures/pi-prompt.json
const { buildSystemPrompt } = await import(process.argv[2]);
const src = (p) => ({ path: p, source: "local", scope: "user", origin: "top-level", baseDir: p });
const opts = {
  cwd: "/work/proj",
  selectedTools: ["read", "bash", "edit", "write", "session_note"],
  toolSnippets: { read: "Read file contents", bash: "Execute bash commands", edit: "Make precise edits", write: "Create or overwrite files", session_note: "Write a note into the session" },
  toolGuidelines: { bash: ["Prefer rg over grep"] },
  promptGuidelines: ["Cite file paths"],
  appendSystemPrompt: "Always answer in English.",
  sections: { team_notes: "Notes an extension added." },
  contextFiles: [
    { path: "/work/proj/AGENTS.md", content: "# Project rules\nRun the tests.\n" },
    { path: "/home/u/.pi/agent/AGENTS.md", content: "Global rule: be brief." },
  ],
  skills: [
    { name: "learn-repo", description: "Learn a repo <before> a task & take notes", filePath: "/home/u/.pi/packages/git/agentbox-skills/skills/learn-repo/SKILL.md", baseDir: "/home/u/.pi/packages/git/agentbox-skills/skills/learn-repo", sourceInfo: src("/home/u/.pi/packages/git/agentbox-skills"), disableModelInvocation: false },
    { name: "systematic-debugging", description: "Root-cause a bug first", filePath: "/home/u/.pi/packages/git/agentbox-skills/skills/systematic-debugging/SKILL.md", baseDir: "/home/u/.pi/packages/git/agentbox-skills/skills/systematic-debugging", sourceInfo: src("/home/u/.pi/packages/git/agentbox-skills"), disableModelInvocation: false },
    { name: "show-me", description: "Explain with diagrams", filePath: "/home/u/.pi/packages/git/agentbox-skills/skills/show-me/SKILL.md", baseDir: "/home/u/.pi/packages/git/agentbox-skills/skills/show-me", sourceInfo: src("/home/u/.pi/packages/git/agentbox-skills"), disableModelInvocation: true },
  ],
};
process.stdout.write(JSON.stringify({ generator: "@earendil-works/pi-coding-agent 1.5.2 buildSystemPrompt", options: opts, prompt: buildSystemPrompt(opts) }, null, 2) + "\n");
