---
"vscode-extension-vercel-ai": minor
---

feat(vscode-ai-gateway): token counting & logging improvements

- Add tool schema counting with GCMP formula (16 base + 8/tool + content × 1.1)
- Add system prompt counting with 28-token SDK overhead
- Add 5000-entry LRU text cache for tokenization performance
- Add reactive error learning from "input too long" errors
- Add structured logging with 5 levels (ERROR, WARN, INFO, DEBUG, TRACE)
- Add file-based logging for DEBUG/TRACE levels
- Add model enrichment with event-based capability refinement
- Add tool-call buffering for streaming fidelity
