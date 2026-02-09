/**
 * Module augmentation for LanguageModelThinkingPart.
 *
 * This class exists at runtime in VS Code ≥1.108 (unconditionally on the
 * `vscode` namespace, no `enabledApiProposals` needed), but is NOT yet in
 * the stable `@types/vscode` declarations. We declare it ourselves so we
 * get type-safety without `as any` casts.
 *
 * Shape tracked against:
 *   microsoft/vscode  src/vscode-dts/vscode.proposed.languageModelThinkingPart.d.ts  (version: 1)
 *   microsoft/vscode  src/vs/workbench/api/common/extHostTypes.ts  LanguageModelThinkingPart class
 *
 * If the upstream shape changes, CI verification (Phase 5) will detect drift.
 */

declare module "vscode" {
  /**
   * A language model response part containing thinking/reasoning content.
   * Thinking tokens represent the model's internal reasoning process that
   * typically streams before the final response.
   */
  export class LanguageModelThinkingPart {
    /**
     * The thinking/reasoning text content.
     */
    value: string | string[];

    /**
     * Optional unique identifier for this thinking sequence.
     * This ID is typically provided at the end of the thinking stream
     * and can be used for retrieval or reference purposes.
     */
    id?: string;

    /**
     * Optional metadata associated with this thinking sequence.
     * Used to carry provider-specific data such as Anthropic signatures.
     */
    metadata?: { readonly [key: string]: unknown };

    /**
     * Construct a thinking part with the given content.
     * @param value The thinking text content.
     * @param id Optional unique identifier for this thinking sequence.
     * @param metadata Optional metadata associated with this thinking sequence.
     */
    constructor(
      value: string | string[],
      id?: string,
      metadata?: { readonly [key: string]: unknown },
    );
  }
}
