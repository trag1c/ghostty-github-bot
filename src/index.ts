import { Webhooks } from "@octokit/webhooks"
import SmeeClient from "smee-client"
import { type PullRequest, processPr } from "./ping-translators"

const PORT = 3000

const webhooks = new Webhooks({ secret: process.env.WEBHOOK_SECRET || "" })

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
