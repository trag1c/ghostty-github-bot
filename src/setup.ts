import { Octokit } from "octokit"

export const ORG_NAME = process.env.ORG_NAME || ""
export const REPO_NAME = process.env.REPO_NAME || ""

export const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN || "" })
