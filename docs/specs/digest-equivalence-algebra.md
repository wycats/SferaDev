# Digest Equivalence Algebra

> **Purpose**: Formal analysis of when transcript digests are equivalent across turns
> **Related**: [RFC 042](../rfcs/stage-0/042-transcript-digest-correlation.md)

## 1. Data Structures

### Message

```
Message := {
  role: Role,
  name: String?,          -- optional, often empty
  content: ContentPart[]
}

Role := User | Assistant | System
```

### ContentPart

```
ContentPart :=
  | TextPart { value: String }
  | ToolCallPart { name: String, callId: String, input: JSON }
  | ToolResultPart { name: String, callId: String, result: JSON }
  | DataPart { mimeType: String, data: Bytes }
```

### Transcript

```
Transcript := Message[]

-- Indexing
T[i] := the i-th message in transcript T
T[0..k] := prefix of T containing messages 0 through k (inclusive)
|T| := length of T
```

## 2. The Turn Model

```
Turn N:
  INPUT:  T_N     -- transcript received from VS Code
  OUTPUT: A_N     -- our assistant response (streamed)

Turn N+1:
  INPUT:  T_{N+1} -- transcript received from VS Code

  -- Structural property:
  T_{N+1} = T_N ++ [A_N] ++ [U_{N+1}]

  where:
    ++ is concatenation
    A_N is our response from Turn N (as VS Code stored it)
    U_{N+1} is the new user message
```

## 3. The Equivalence Question

We want a digest function `D` such that:

```
D(T_{N+1}[0..|T_N|-1]) = D(T_N)
```

In words: the digest of the prefix of the new transcript (excluding our response and the new user message) equals the digest of the old transcript.

### Breaking this down:

Let `k = |T_N| - 1` (index of last message in T_N).

```
T_{N+1}[0..k-1] should equal T_N[0..k-1]  -- prefix before our response
T_{N+1}[k] = A_N (as stored by VS Code)
T_N[k] = U_N (the user message we responded to)
```

Wait — this reveals a subtlety. Let me re-examine:

```
Turn N receives:   [S, U₁, A₁, U₂, A₂, ..., Uₙ]
                    \_____________________/  \_/
                     messages from before    new user msg

Turn N+1 receives: [S, U₁, A₁, U₂, A₂, ..., Uₙ, Aₙ, Uₙ₊₁]
                    \_____________________________/  \__/
                     same prefix + our response      new
```

So the equivalence we actually want is:

```
T_{N+1}[0..|T_N|-1] ≟ T_N
```

i.e., does the prefix of length `|T_N|` in `T_{N+1}` equal `T_N`?

## 4. Stability Analysis

### For messages we did NOT create (received from VS Code):

```
Let M ∈ T_N be a message we received.
Let M' ∈ T_{N+1} be the "same" message in the next turn.

Hypothesis: M = M' (byte-for-byte identical)

This assumes VS Code:
  1. Does not modify message content between turns
  2. Does not add/remove metadata
  3. Preserves ordering
```

**Status**: Unverified. Needs empirical test.

### For messages WE created (our Assistant response):

```
Let A_out be what we streamed to VS Code on Turn N.
Let A_back be what VS Code sends us on Turn N+1.

Hypothesis: A_out = A_back

This assumes:
  1. VS Code stores our streamed content verbatim
  2. No post-processing (sanitization, formatting)
  3. Tool callIds are preserved as we sent them
```

**Status**: Unverified. Needs empirical test.

## 5. Transformations We Apply

### On Output (streaming to VS Code):

```
transform_out : ResponseDelta → LanguageModelPart

transform_out(text_delta) = TextPart {
  value: appendUrlAnnotations(formatRefusal(text_delta))
}

transform_out(tool_call) = ToolCallPart {
  name: tool_call.name,
  callId: itemId,          -- WE generate this, not server's call_id
  input: tool_call.arguments
}
```

### The callId Mapping

```
Server sends: { call_id: "server_123", item_id: "item_456", ... }
We emit:      ToolCallPart { callId: "item_456", ... }

-- Why? Server can reuse call_id across different items.
-- item_id is unique within the response.
```

**Implication**: When we receive `A_back` on Turn N+1, the `callId` should be "item_456" (what we sent), NOT "server_123".

## 6. The Digest Function

### Naive Digest (may not be stable):

```
D_naive(T) = hash(serialize(T))
```

This fails if any field is unstable across turns.

### Normalized Digest:

```
D(T) = hash(serialize(normalize(T)))

normalize : Transcript → NormalizedTranscript

normalize(T) = map(normalizeMessage, T)

normalizeMessage(M) = {
  role: M.role,
  -- EXCLUDE: name (often empty/unreliable)
  content: map(normalizePart, M.content)
}

normalizePart(TextPart { value }) =
  TextNorm { value: stripOurAdditions(value) }

normalizePart(ToolCallPart { name, callId, input }) =
  ToolCallNorm { name, input }  -- EXCLUDE callId (may be unstable)

normalizePart(ToolResultPart { name, callId, result }) =
  ToolResultNorm { name, result }  -- EXCLUDE callId

normalizePart(DataPart { mimeType, data }) =
  DataNorm { mimeType, hash: hash(data) }  -- hash the bytes

stripOurAdditions(text) =
  stripCapsuleMarker(stripUrlAnnotations(text))
```

### The Equivalence Theorem

```
THEOREM (Digest Stability):

If the following assumptions hold:
  A1. VS Code preserves non-Assistant messages verbatim
  A2. VS Code preserves our streamed content verbatim
  A3. Our normalization correctly strips all our additions

Then:
  D(T_{N+1}[0..|T_N|-1]) = D(T_N)
```

**Proof sketch**:

1. For messages 0..k-1 (before our response):
   By A1, these are verbatim → normalize gives same result
2. For message k (last message of T_N, which is Uₙ):
   By A1, this is verbatim → normalize gives same result
3. QED

## 7. The Problem with Our Response

The theorem requires comparing `T_{N+1}[0..|T_N|-1]` with `T_N`.

But `|T_N|` includes the last user message, not our response. Our response `A_N` appears at index `|T_N|` in `T_{N+1}`.

**Refined model**:

```
Turn N receives:   T_N = [M₀, M₁, ..., Mₖ]  where Mₖ is user message
Turn N+1 receives: T_{N+1} = [M₀, M₁, ..., Mₖ, A_N, Mₖ₊₁]

Prefix comparison:
  T_{N+1}[0..k] ≟ T_N

This is exactly what we want! We're comparing:
  - Messages 0..k from T_{N+1}
  - Messages 0..k from T_N (which is all of T_N)
```

So our response `A_N` is NOT part of the prefix comparison. It's the first NEW message in `T_{N+1}`.

## 8. Determining "Which Messages Are New"

On Turn N+1, we receive `T_{N+1}`.

**Question**: How do we know which messages are "new" (need processing)?

**Answer**:

```
new_messages = T_{N+1}[|T_N|..]

-- But we don't know |T_N| on Turn N+1!
```

**Alternative**: Use digest to identify continuation point:

```
On Turn N:
  d_N = D(T_N)
  Store: d_N → { length: |T_N|, usage: ... }

On Turn N+1:
  For k from |T_{N+1}|-1 down to 0:
    d_k = D(T_{N+1}[0..k])
    If d_k exists in storage:
      -- Found the prefix! Messages k+1.. are new.
      return T_{N+1}[k+1..]
```

**Problem**: This is O(n) digest computations per turn.

**Optimization**: Incremental digest. If we use a Merkle-like structure:

```
D([M₀, M₁, ..., Mₖ]) = hash(D([M₀, ..., Mₖ₋₁]) ++ hash(Mₖ))
```

Then we can compute `D(T[0..k])` for all k in O(n) total.

## 9. Incremental Digest Optimization

The O(n) digest computation problem from Section 8 can be solved more elegantly.

### The (length, lastMsgHash) Index

**Observation**: In the common case (conversation continuation), we know exactly where the prefix ends:

```
|T_{N+1}| - 2
```

This is the index of the last message from `T_N` (before our response and the new user message).

**Storage structure**:

```
DigestEntry := {
  fullDigest: Hash,           -- D(T)
  length: Int,                -- |T|
  lastMessageHash: Hash,      -- h(T[|T|-1])
  usage: TokenRecord
}

Index: Map<(Int, Hash), DigestEntry>
  -- keyed by (length, lastMessageHash)
```

**Lookup algorithm (O(1) common case)**:

```
findPrefix(T_{N+1}):
  -- Expected prefix length
  k = |T_{N+1}| - 2

  -- Hash of what should be the last message of T_N
  lastHash = h(T_{N+1}[k])

  -- O(1) index lookup
  entry = Index.get((k + 1, lastHash))

  if entry exists:
    -- Verify with full digest (optional, for collision safety)
    if D(T_{N+1}[0..k]) = entry.fullDigest:
      return entry

  -- Fallback: scan backwards (handles summarization, edge cases)
  return scanBackwards(T_{N+1})
```

### Algebraic Property

```
LEMMA (Prefix Identification):

If T_{N+1} = T_N ++ [A_N] ++ [U_{N+1}], then:

  (|T_N|, h(T_N[|T_N|-1])) uniquely identifies the prefix T_N
  within a single conversation.

PROOF:
  1. |T_N| is the length of the prefix
  2. T_N[|T_N|-1] is the last user message before our response
  3. Within a conversation, message content is unique (users don't repeat exact messages)
  4. Therefore (length, lastHash) is a sufficient discriminator

CAVEAT: Across different conversations, collisions are possible.
         The full digest verification handles this.
```

### Summarization Handling

When VS Code summarizes the conversation:

```
T_{N+1} ≠ T_N ++ [A_N] ++ [U_{N+1}]
```

Instead:

```
T_{N+1} = [S_summary, U_{post-summary}...]
```

The O(1) lookup will fail (expected prefix length is wrong). The fallback scan will also fail (no matching prefix exists). This is correct — summarization creates a new "conversation" for token tracking purposes.

**Detection**: If no prefix match is found, we're in a new conversation context (either fresh start or post-summarization).

## 10. Assumptions Requiring Verification

| ID  | Assumption                                        | How to Verify                                          |
| --- | ------------------------------------------------- | ------------------------------------------------------ | --- | --- |
| A1  | VS Code preserves non-Assistant messages verbatim | Compare `T_N[i]` with `T_{N+1}[i]` for i <             | T_N |     |
| A2  | VS Code preserves our streamed content verbatim   | Compare what we streamed with what we receive back     |
| A3  | Our normalization strips all our additions        | Unit test `normalize(transform_out(x)) = normalize(x)` |
| A4  | Tool callId (itemId) is stable                    | Check if callId we sent matches callId we receive      |

## 11. Summary

**The Invariant**:

```
D(prefix(T_{N+1}, |T_N|)) = D(T_N)
```

**Requirements for D**:

1. Deterministic
2. Excludes unstable fields (name, callId)
3. Normalizes our additions (capsule, URL annotations)
4. Works on the raw VS Code message format

**Open Questions**:

1. Are A1-A4 actually true? (empirical verification needed)
2. What's the most efficient digest scheme? (Merkle vs flat hash)
3. How do we handle summarization? (prefix won't match — that's intentional)
