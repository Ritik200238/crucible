# CLAUDE.md — Binance build

Project rules for this build. These sit **on top of** the global rules in
`~/.claude/CLAUDE.md`, which stay in force. Where the two ever disagree, ask —
do not pick one silently.

---

## 1. No AI slop, from any angle

The work must read as though a proficient human professional wrote it, because
a human is shipping it under their own name.

In practice:

- No filler prose, no throat-clearing, no restating the obvious.
- No AI vocabulary: *delve, seamless, elevate, robust, comprehensive, unleash,
  nuanced, multifaceted, game-changing, in the world of.*
- Comments explain **why**, never what the line already says. If a comment
  restates the code, delete it.
- No decorative structure. No emoji headers, no section that exists to look
  thorough.
- Naming is plain and specific. No `helper`, `util`, `data`, `handleStuff`.
- Error messages are written for the person reading them at 2am, in full
  sentences, saying what went wrong and what to do.
- Copy is written, not generated. If a sentence could top any README on any
  project, rewrite it so it could only top this one.

## 2. Nothing half-baked

Anything commanded gets built **fully**, or it does not get started.

- No TODOs left in shipped code. No `throw new Error("not implemented")`.
- No stub that returns a hardcoded value so a screen can render.
- If a feature needs four parts, four parts get built. Three parts and a note
  is a failure, not progress.
- If something cannot be finished, say so **before** starting it, not after.

## 3. Nothing is a demo. Everything is real.

- Real data from real endpoints. No fixtures standing in for live calls.
- No mock mode that exists to make a screenshot look good.
- No fake numbers, placeholder names, or invented results anywhere in the
  product or its documentation.
- Test fixtures are allowed **only inside the test suite**, never on a path a
  user can reach.
- If a capability is not wired end to end, it is not claimed anywhere — not in
  the README, not in a comment, not in conversation.

## 4. Never guess. Follow the docs.

- Read the official documentation before writing against any API. Fetch it;
  do not recall it.
- Verify endpoints, field names, limits, and error codes against the source.
- When the docs are silent or contradictory, test the real endpoint and record
  what actually happened.
- State **NOT VERIFIED** rather than presenting an assumption as fact.
- Never invent a parameter, a response field, or a limit.

## 5. Work priority-wise

Highest priority first, then the next. Always organised.

- Agree the priority order before starting, and follow it.
- Finish the current item before opening the next.
- One coherent unit of work per commit, in priority order.
- If priorities change, say so and re-order explicitly.

---

## Permission

- **Do not create, write, or modify any file until told to build.** Plans,
  answers, and research need no permission. Code does.
- **Nothing leaves this machine without explicit approval each time.** No repo
  creation, no push, no deploy, no posting anywhere. Approval for one action is
  not approval for the next.

## Attribution

- This product is the repository owner's work. No credits, no
  acknowledgements, no "inspired by", no third-party names in the README, code
  comments, commit messages, or any user-facing copy.
- Architectural ideas are not owned by anyone and need no attribution.
- **Never copy third-party source code.** Copyleft licences would attach to
  this project. Everything here is written from scratch.

## Verification

Per the global rules: never call the work best, correct, complete, or
production-ready on the strength of having written it. Try to falsify it,
name the weaknesses and edge cases, and show the evidence. Where evidence is
missing, say **NOT VERIFIED**.
