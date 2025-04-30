import * as gettextParser from "gettext-parser"
import { multi } from "itertools-ts"
import { ORG_NAME, REPO_NAME, octokit } from "./setup"

const readPoFiles = async (): Promise<Record<string, string>> => {
	const poFilePaths = await octokit.rest.repos
		.getContent({
			owner: ORG_NAME,
			repo: REPO_NAME,
			path: "po",
			headers: { accept: "application/vnd.github.raw+json" },
		})
		.then((res) =>
			(res.data as { path: string }[])
				.map((file) => file.path)
				.filter((path) => path.endsWith(".po")),
		)
	const fileConents = await Promise.all(
		poFilePaths.map((path) =>
			octokit.rest.repos
				.getContent({
					owner: ORG_NAME,
					repo: REPO_NAME,
					path,
					headers: { accept: "application/vnd.github.raw+json" },
				})
				.then((res) => res.data as unknown as string),
		),
	)
	const poFiles: Record<string, string> = {}
	for (const [filePath, content] of multi.zip(poFilePaths, fileConents)) {
		poFiles[filePath] = content
	}
	return poFiles
}

const findMissingTranslations = async (
	poFiles: Record<string, string>,
): Promise<Record<string, string[]>> => {
	const missingTranslations: Record<string, string[]> = {}
	for (const [localeFile, fileContent] of Object.entries(poFiles)) {
		const locale = localeFile.slice(0, -3)
		missingTranslations[locale] ??= []

		const po = gettextParser.po.parse(fileContent)
		if (!po.translations[""]) {
			console.warn(`No translations found in ${localeFile}`)
			continue
		}

		for (const [key, value] of Object.entries(po.translations[""])) {
			if (value.msgstr[0] === "") {
				missingTranslations[locale].push(key)
			}
		}
	}
	return missingTranslations
}
