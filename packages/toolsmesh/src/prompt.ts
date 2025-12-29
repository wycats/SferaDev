import type { ToolRegistry, VirtualFilesystem } from "./types";

/**
 * Options for generating the system prompt.
 */
export type SystemPromptOptions = {
	/** Custom prefix to prepend to the prompt */
	prefix?: string;
	/** Custom suffix to append to the prompt */
	suffix?: string;
	/** Whether to include a tool summary in the prompt */
	includeSummary?: boolean;
	/** Maximum number of tools to list in the summary */
	summaryLimit?: number;
};

/**
 * Generate a concise tool summary for the system prompt.
 */
function generateToolSummary(tools: ToolRegistry, limit = 10): string {
	const entries = Object.entries(tools);
	const total = entries.length;

	if (total === 0) {
		return "No tools are currently registered.";
	}

	const shown = entries.slice(0, limit);
	const lines = shown.map(([name, tool]) => {
		// Truncate long descriptions
		const desc =
			tool.description.length > 80 ? `${tool.description.slice(0, 77)}...` : tool.description;
		return `  - ${name}: ${desc}`;
	});

	if (total > limit) {
		lines.push(`  ... and ${total - limit} more tools`);
	}

	return lines.join("\n");
}

/**
 * Generate the system prompt for the toolsmesh.
 */
export function generateSystemPrompt(
	tools: ToolRegistry,
	filesystem: VirtualFilesystem,
	options: SystemPromptOptions = {},
): string {
	const { prefix, suffix, includeSummary = true, summaryLimit = 10 } = options;

	const toolCount = Object.keys(tools).length;
	const root = filesystem.root;

	const sections: string[] = [];

	// Add prefix if provided
	if (prefix) {
		sections.push(prefix);
	}

	// Main toolsmesh section
	sections.push(`## Tool Discovery System

You have access to ${toolCount} tools organized in a virtual filesystem at \`${root}\`.
Instead of calling tools directly, you discover and execute them through a mesh interface.

### Available Mesh Tools

1. **mesh_bash** - Explore the tool filesystem using bash commands
   - Use \`ls\`, \`cat\`, \`grep\`, \`find\` to discover tools
   - Tool definitions are TypeScript files with full type information
   - Search descriptions with \`grep -r "keyword" ${root}\`

2. **mesh_exec** - Execute TypeScript code that calls tools
   - Tools are available as typed async functions
   - Full type safety with parameter validation
   - Chain multiple tools in a single execution

### Discovery Workflow

1. **Explore**: Use \`mesh_bash\` to understand available tools
   \`\`\`
   ls -la ${root}           # List all tools
   grep -r "api" ${root}    # Find API-related tools
   cat ${root}/index.ts     # Read the tool index
   \`\`\`

2. **Inspect**: Read specific tool definitions for full details
   \`\`\`
   cat ${root}/toolName.ts  # Full interface and schema
   \`\`\`

3. **Execute**: Use \`mesh_exec\` to run TypeScript code
   \`\`\`typescript
   const result = await toolName({
     param1: "value",
     param2: 123
   });
   return result;
   \`\`\``);

	// Add tool summary if requested
	if (includeSummary && toolCount > 0) {
		sections.push(`### Quick Reference

Available tools (${toolCount} total):
${generateToolSummary(tools, summaryLimit)}

Use \`grep\` to search by functionality or \`cat\` to see full definitions.`);
	}

	// Best practices section
	sections.push(`### Best Practices

- **Discover before executing**: Always explore the filesystem to find the right tool
- **Read the types**: Tool files contain TypeScript interfaces - use them for accuracy
- **Chain operations**: Use \`mesh_exec\` to combine multiple tool calls in one execution
- **Handle errors**: Wrap tool calls in try/catch within \`mesh_exec\`
- **Use grep wisely**: Search by functionality, not just tool names

### Example Session

\`\`\`
# Step 1: Find tools for user management
mesh_bash: grep -r "user" ${root}

# Step 2: Read the specific tool interface
mesh_bash: cat ${root}/createUser.ts

# Step 3: Execute with proper types
mesh_exec:
const user = await createUser({
  name: "John Doe",
  email: "john@example.com"
});
console.log("Created user:", user.id);
return user;
\`\`\``);

	// Add suffix if provided
	if (suffix) {
		sections.push(suffix);
	}

	return sections.join("\n\n");
}

/**
 * Generate a compact system prompt for token-constrained contexts.
 */
export function generateCompactPrompt(tools: ToolRegistry, filesystem: VirtualFilesystem): string {
	const toolCount = Object.keys(tools).length;
	const root = filesystem.root;

	return `## Toolsmesh

${toolCount} tools at \`${root}\`. Use \`mesh_bash\` to explore (ls, cat, grep, find) and \`mesh_exec\` to run TypeScript code calling tools as async functions.

Quick: \`grep -r "keyword" ${root}\` | \`cat ${root}/tool.ts\` | \`mesh_exec: await tool({...})\``;
}
