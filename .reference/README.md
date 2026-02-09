# Reference Repositories

This directory contains external repositories used for forensic analysis, source code verification, and protocol reverse-engineering. These are **not** part of the build but serve as ground truth for understanding the behavior of VS Code and Copilot.

## Repositories

- **vscode**: The core Visual Studio Code repository (Microsoft). Used to verify internal data structures like `IChatMessage` and how extensions interact with the workbench.
- **vscode-copilot-chat**: The source code for the GitHub Copilot Chat extension. Used to trace how prompts are constructed and how messages are serialized before being sent to the LLM.
- **openresponses**: Reference implementation for the OpenResponses protocol.
- **ai-gateway**: Reference implementation or previous version of the AI Gateway logic.
- **GCMP**: Global Context Management Protocol (or similar reference).
