import { personalLayer, type Policy, type Request, type Targets } from "../src/index.ts";

export const NOW = 1_761_735_600;
export const SHA = "3f9a1c2e4b5d6f708192a3b4c5d6e7f801234567";
export const SHA2 = "aaaa1c2e4b5d6f708192a3b4c5d6e7f801234567";

export const targets: Targets = {
  repos: ["adrianmross/okayed", "adrianmross/matrix"],
  prs: [
    { repo: "adrianmross/okayed", number: 182, head: SHA },
    { repo: "adrianmross/matrix", number: 7, head: SHA2 },
  ],
  sites: [{ host: "openmeadow.org", envs: ["production", "staging"] }],
  agents: ["agent:assistant"],
};

/** Asks about everything, so narrowing is tested on its own; policy.test.ts covers the posture. */
export const policy: Policy = { layers: [personalLayer([])] };

export const mergeReq: Request = {
  id: "r_merge",
  aud: "agent:assistant",
  act: "github.pr.merge",
  res: [`github:adrianmross/okayed/pull/182@${SHA}`],
  why: "CI is green and it was reviewed",
  at: NOW - 60,
  exp: NOW + 1800,
};

export const deployReq: Request = {
  id: "r_deploy",
  aud: "agent:assistant",
  act: "site.deploy",
  res: ["site:openmeadow.org/production"],
  why: "ship the new landing page",
  at: NOW - 30,
  exp: NOW + 1800,
};
