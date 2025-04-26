import { Webhooks } from "@octokit/webhooks"
import type { PullRequestEvent } from "@octokit/webhooks-types"
import { Octokit } from "octokit"
import SmeeClient from "smee-client"

type PullRequest = PullRequestEvent["pull_request"]

const ORG_NAME = process.env.ORG_NAME || ""
const REPO_NAME = process.env.REPO_NAME || ""

const TEAM_NAME_PREFIX = `@${ORG_NAME}/`
const ALLOWED_PARENT_TEAM = "localization"
const LOCALIZATION_TEAM_NAME_PATTERN = /^[a-z]{2}_[A-Z]{2}$/

const PORT = 3000

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN || "" })
const webhooks = new Webhooks({ secret: process.env.WEBHOOK_SECRET || "" })

const getChangedFiles = async (prNumber: number): Promise<string[]> => {
	console.log("Gathering changed files...")
	const files = await octokit.rest.pulls.listFiles({
		owner: ORG_NAME,
		repo: REPO_NAME,
		pull_number: prNumber,
	})
	return files.data.map((file) => file.filename)
}

const fetchAndParseCodeowners = async (): Promise<Record<string, string>> => {
	console.log("Fetching CODEOWNERS file...")
	const content = (await octokit.rest.repos
		.getContent({
			owner: ORG_NAME,
			repo: REPO_NAME,
			path: "CODEOWNERS",
			headers: { accept: "application/vnd.github.raw+json" },
		})
		.then((res) => res.data)) as string
	console.log(content)
	console.log("Parsing CODEOWNERS file...")
	const codeowners: Record<string, string> = {}
	for (const line of content.split("\n")) {
		if (line.length === 0 || line.trimStart().startsWith("#")) {
			continue
		}

		// This assumes that all entries only list one owner
		// and that this owner is a team (ghostty-org/foobar)
		let [path, owner] = line.trim().split(/\s+/)
		path = path?.replace(/^\//, "") as string
		owner = owner?.startsWith(TEAM_NAME_PREFIX)
			? owner.slice(TEAM_NAME_PREFIX.length)
			: (owner as string)

		if (!LOCALIZATION_TEAM_NAME_PATTERN.test(owner)) {
			console.log(`Skipping non-l10n codeowner "${owner}" for ${path}`)
			continue
		}

		codeowners[path] = owner
		console.log(`Found codeowner "${owner}" for ${path}`)
	}
	return codeowners
}

const findOwners = (
	codeowners: Record<string, string>,
	changedFiles: string[],
): Set<string> => {
	const foundOwners = new Set<string>()
	for (const file of changedFiles) {
		console.log(`Finding owner for "${file}"...`)
		let match = false
		for (const [path, owner] of Object.entries(codeowners)) {
			if (file.startsWith(path)) {
				console.log(`Found owner: "${owner}"`)
				foundOwners.add(owner)
				match = true
			}
		}
		if (!match) {
			console.log("No owner found")
		}
	}
	return foundOwners
}

const getTeamMembers = async (teamName: string): Promise<string[]> => {
	console.log(`Fetching team "${teamName}"...`)
	const team = await octokit.rest.teams
		.getByName({
			org: ORG_NAME,
			team_slug: teamName,
		})
		.then((res) => res.data)

	if (team.parent?.slug !== ALLOWED_PARENT_TEAM) {
		console.warn(
			`Team "${teamName}" does not have "${ALLOWED_PARENT_TEAM}" as a parent`,
		)
		return []
	}

	console.log(`Fetching team "${teamName}" members...`)
	const members = await octokit.rest.teams
		.listMembersInOrg({
			org: ORG_NAME,
			team_slug: teamName,
		})
		.then((res) => res.data.map((u) => u.login))
	console.log(`Team ${teamName} members: ${members.join(", ")}`)
	return members
}

const findMentionedUsers = async (prNumber: number): Promise<Set<string>> => {
	console.log("Looking for previously mentioned users...")
	const comments = await octokit.rest.issues.listComments({
		owner: ORG_NAME,
		repo: REPO_NAME,
		issue_number: prNumber,
	})
	const mentionedUsers = new Set<string>()
	for (const comment of comments.data) {
		if (comment.user?.login !== "ghostty-bot") {
			continue
		}
		const matches = comment.body?.match(/@([a-zA-Z0-9_-]+)/g)
		for (const match of matches || []) {
			console.log(`Found mention: ${match}`)
			mentionedUsers.add(match.slice(1))
		}
	}
	if (mentionedUsers.size === 0) {
		console.log("No previously mentioned users found")
	}
	return mentionedUsers
}

const pingTranslators = async (
	prNumber: number,
	members: string[],
	prAuthor: string,
) => {
	let translators = new Set<string>(members)
	translators.delete(prAuthor)
	translators = translators.difference(await findMentionedUsers(prNumber))
	if (translators.size === 0) {
		console.log("No translators to ping")
		return
	}

	const pings = Array.from(translators)
		.map((m) => `@${m}`)
		.join(", ")
	console.log(`Pinging translators: ${pings}...`)

	await octokit.rest.issues.createComment({
		owner: ORG_NAME,
		repo: REPO_NAME,
		issue_number: prNumber,
		body: `Some \`.po\` files were changed, cc ${pings}`,
	})
}

const processPr = async (pr: PullRequest) => {
	console.log(`Processing PR #${pr.number}...`)

	const changedFiles = await getChangedFiles(pr.number)
	console.log(`Changed files: ${changedFiles.map((f) => `"${f}"`).join(", ")}`)

	const author = pr.user?.login
	console.log(`PR author: ${author}`)

	const codeowners = await fetchAndParseCodeowners()
	const foundOwners = findOwners(codeowners, changedFiles)

	const memberLists: string[] = await Promise.all(
		Array.from(foundOwners).map(async (owner) => getTeamMembers(owner)),
	).then((lists) => lists.flat())

	await pingTranslators(pr.number, memberLists, author)
}

webhooks.on("pull_request", async ({ payload }) => {
	console.log(payload.action)
	if (payload.action !== "opened" && payload.action !== "synchronize") return
	await processPr(payload.pull_request as PullRequest)
})

const server = Bun.serve({
	port: PORT,
	async fetch(req: Request) {
		if (req.method !== "POST")
			return new Response("method not allowed", { status: 405 })

		const payload = await req.text()
		const signature = req.headers.get("x-hub-signature-256") || ""
		const id = req.headers.get("x-github-delivery") || ""
		const name = req.headers.get("x-github-event") || ""

		try {
			await webhooks.verifyAndReceive({ id, name, signature, payload })
		} catch (err) {
			console.error("error handling webhook:", err)
			return new Response("bad request", { status: 400 })
		}
		return new Response("ok")
	},
})

const smee = new SmeeClient({
	source: process.env.WEBHOOK_URL || "",
	target: `http://localhost:${PORT}`,
	logger: console,
})

const events = smee.start()

process.on("SIGINT", () => {
	console.log("bye")
	events.close()
	server.stop()
})
