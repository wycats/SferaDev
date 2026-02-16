# RFC Consolidation

Consolidate the RFCs touching a topic area so they tell a coherent, parsimonious story — reflecting either implemented reality or a clear plan.

## The Axiom

> RFC consolidation happens just-in-time, scoped to the topic being worked on — not as a separate bulk activity. Tension, duplication, or overlap between RFCs should map onto implementation cleanup work to be done at the same time. An RFC collection that has been consolidated but whose code hasn't been aligned is worse than the original mess — it creates a false sense of order.

## When to Use

Before starting implementation work on a topic that has accumulated RFCs across stages.

## Input

1. **Topic** — What you're about to work on (e.g., "chat history", "CLI tool architecture")
2. **Context** — What the current implementation actually looks like

## How This Works

This is a **collaborative** process between you and the user. You do the research and analysis; the user makes the judgment calls. You should surface ambiguities, tensions, and tradeoffs — not resolve them silently.

### Step 1: Discover

Search `docs/rfcs/` for RFCs related to the topic:

- Grep for keywords and synonyms
- Grep for related function/type/binary names from the codebase
- Scan stage directories for titles that might be related
- Check `docs/rfcs/withdrawn/` — withdrawn RFCs are context

**Watch for migration duplicates**: The RFC migration created many `0xxx` / `10xxx` pairs with identical content at different stages. These are systematic — actively look for them, don't just stumble on them. You'll also find duplicates outside your topic scope; it's fine to clean those up opportunistically.

### Step 2: Read and Understand

Read each discovered RFC **fully**. For each one, understand:

- What it proposes
- Whether it was implemented (check the codebase)
- How it relates to the other RFCs in the cluster
- Whether it's a duplicate of another RFC (the migration created many `0xxx` / `10xxx` pairs with identical content)

### Step 3: Present Your Analysis

Present the RFCs to the user in tiers:

- **Tier 1: Directly about the topic** — RFCs whose primary subject is the thing we're about to work on
- **Tier 2: Architecture it plugs into** — RFCs about the systems the topic interacts with
- **Tier 3: Tangentially related** — RFCs that mention the topic but aren't about it

For each RFC, give:

- A 2-3 sentence summary of what it says
- Whether it matches reality (was it implemented? has the implementation diverged?)
- Any tensions or contradictions with other RFCs in the cluster

**Do NOT produce a mechanical table with categories.** The point is to build shared understanding, not to classify.

### Step 4: Discuss

Surface the judgment calls **one at a time** as structured questions with concrete options (and room for freeform input). Don't dump all questions in prose — structured choices let the user respond quickly when the answer is obvious and elaborate when it isn't.

Examples of good judgment-call questions:

- "These two RFCs say contradictory things about X — which direction do we want?"
- "This RFC envisioned X but we built Y — should the RFC be updated to match reality, or does the original vision still matter?"
- "This RFC is a duplicate of that one — the Stage N version has more detail, should we just delete the other?"

**The user's questions are inputs, not just approvals.** When the user pushes back or asks a clarifying question, that's a signal to go deeper — check the codebase, re-read the RFC, revise your analysis. Some of the best insights come from the user questioning your initial categorization.

### Step 5: Execute Together

Once you and the user agree on what the collection should look like, make the changes:

- **Delete** empty/skeleton RFCs (no content worth preserving)
- **Withdraw** RFCs whose ideas were explored but rejected — move to `withdrawn/` with rationale
- **Delete duplicates** — when two RFCs have identical content (e.g., migration artifacts), delete the lower-stage one
- **Update** RFCs that are directionally correct but factually stale
- **Add rationale** — consolidation often reveals design principles that were previously implicit. When you discover a principled boundary (e.g., "meta-tools vs. work tools"), write it into the relevant RFC so future readers understand the _why_, not just the _what_.
- **Surface tensions as tasks** — if two RFCs disagree and the disagreement implies code work, create a task

## Anti-Patterns

**The Mechanical Pipeline**: Producing a recon table → getting approval → executing without questions. If you can consolidate 20 RFCs without asking any questions, something is wrong. The ambiguities are the point.

**Scope Creep**: Consolidating RFCs that aren't related to the current topic. Stay scoped.

**Paper-Only Consolidation**: Making the RFCs look coherent without aligning the code. If an RFC says "we use approach X" but the code uses approach Y, that's a task, not just an RFC edit.
