import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";

async function getChangeDiff(packagePath: string) {
	return new Promise<string>((resolve, reject) => {
		exec(
			`git diff --ignore-all-space --ignore-blank-lines --minimal -- ${packagePath}`,
			{ maxBuffer: 1024 * 1024 * 10 },
			(error, stdout) => {
				if (error) {
					reject(error);
				} else {
					resolve(stdout);
				}
			},
		);
	});
}

async function writeChangesetFile(projectName: string, type: string, description: string) {
	const rootDir = process.cwd();
	const changesetDir = path.join(rootDir, ".changeset");
	const randomName = Math.random().toString(36).substring(7);
	const changesetPath = path.join(changesetDir, `${randomName}.md`);
	const content = `---\n"${projectName}": ${type}\n---\n\n${description}`;

	if (!fs.existsSync(changesetDir)) {
		fs.mkdirSync(changesetDir);
	}

	fs.writeFileSync(changesetPath, content);
}

const changelogSchema = z.object({
	changes: z.array(
		z.object({
			description: z.string(),
			type: z.enum(["patch", "minor"]),
		}),
	),
});

async function main() {
	const projectName = process.argv[2];
	if (!projectName) throw new Error("Project name not provided");

	const packagePath = `packages/${projectName}`;

	try {
		const diff = await getChangeDiff(packagePath);
		if (diff.trim().length === 0) {
			console.log("No changes detected");
			return;
		}

		const prompt = `
    You are an assistant to a software developer working on a project called "${projectName}".
    The developer has asked you to write a changelog entry for the API they are working on.
    You need to document the changelog for the API from the git diff.
    You can create multiple changelog entries to match the number of changes in the API.
    Description must be a short sentence.
    If there's a breaking change, add "[BREAKING]" to the beginning of the description.
    Only use "patch" or "minor" changes in a 0.x.x semver versioning scheme. Unless it's a version bump, everything is a "patch".
  `;

		const { object } = await generateObject({
			model: openai("gpt-4.1"),
			schema: changelogSchema,
			system: prompt,
			prompt: diff,
		});

		for (const { type, description } of object.changes) {
			await writeChangesetFile(projectName, type, description);
		}
	} catch (error) {
		console.error(error);
	}
}

main();
