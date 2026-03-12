import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getOctokit, getPullRequest, getPullRequestDiff, postPRComment, createCommitStatus } from "@/lib/github";
import { generateComplianceReport, formatReportAsMarkdown } from "@/lib/ai";
import { getLinearIssue } from "@/lib/linear";
import { getJiraIssue, getJiraCloudId } from "@/lib/jira";
import crypto from "crypto";

function verifyGitHubSignature(body: string, signature: string | null): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("x-hub-signature-256");

  if (process.env.GITHUB_WEBHOOK_SECRET) {
    if (!verifyGitHubSignature(body, signature)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  const event = req.headers.get("x-github-event");
  if (event !== "pull_request") {
    return NextResponse.json({ ok: true, message: "Ignored event" });
  }

  const payload = JSON.parse(body);
  const action = payload.action;

  // Only handle opened, edited, reopened, synchronize
  if (!["opened", "edited", "reopened", "synchronize"].includes(action)) {
    return NextResponse.json({ ok: true, message: "Ignored action" });
  }

  const pr = payload.pull_request;
  const repo = payload.repository;

  // Find a user with access to this repo via their GitHub token
  const account = await prisma.account.findFirst({
    where: { provider: "github" },
    include: { user: { include: { integrations: true } } },
  });

  if (!account?.access_token) {
    return NextResponse.json({ error: "No GitHub account found" }, { status: 404 });
  }

  const user = account.user;
  const prBody: string = pr.body ?? "";

  // Try to extract ticket ID from PR body or title
  // Patterns: LINEAR-123, LIN-123, https://linear.app/.../issue/..., PROJ-123 (Jira)
  const linearIdMatch = prBody.match(/(?:LINEAR|LIN|[A-Z]{2,8})-\d+/i) || pr.title.match(/(?:LINEAR|LIN|[A-Z]{2,8})-\d+/i);
  const jiraKeyMatch = prBody.match(/[A-Z]{2,10}-\d+/) || pr.title.match(/[A-Z]{2,10}-\d+/);

  let ticketTitle = "Unknown Ticket";
  let ticketBody = "";
  let ticketId = "unknown";
  let ticketUrl: string | undefined;

  const linearIntegration = user.integrations.find((i) => i.type === "LINEAR");
  const jiraIntegration = user.integrations.find((i) => i.type === "JIRA");

  try {
    if (linearIntegration && linearIdMatch) {
      const issue = await getLinearIssue(linearIntegration.accessToken, linearIdMatch[0]);
      ticketTitle = issue.title;
      ticketBody = issue.description;
      ticketId = issue.id;
      ticketUrl = issue.url;
    } else if (jiraIntegration && jiraKeyMatch) {
      const cloudId = await getJiraCloudId(jiraIntegration.accessToken);
      const issue = await getJiraIssue(jiraIntegration.accessToken, cloudId, jiraKeyMatch[0]);
      ticketTitle = issue.title;
      ticketBody = issue.description;
      ticketId = issue.id;
      ticketUrl = issue.url;
    } else {
      // Fall back: use PR body as the "spec"
      ticketTitle = pr.title;
      ticketBody = pr.body ?? "No description provided";
      ticketId = `pr-${pr.number}`;
    }
  } catch (e) {
    console.error("Failed to fetch ticket:", e);
    ticketTitle = pr.title;
    ticketBody = pr.body ?? "";
    ticketId = `pr-${pr.number}`;
  }

  // Create the compliance check record
  const check = await prisma.complianceCheck.create({
    data: {
      userId: user.id,
      ticketId,
      ticketUrl,
      ticketTitle,
      ticketBody,
      prNumber: pr.number,
      prUrl: pr.html_url,
      prTitle: pr.title,
      prBody: pr.body ?? "",
      repoOwner: repo.owner.login,
      repoName: repo.name,
      status: "RUNNING",
    },
  });

  // Run compliance check asynchronously (fire and forget with error handling)
  runCheck(check.id, account.access_token, user, pr, repo, ticketTitle, ticketBody, ticketUrl).catch(
    async (err) => {
      console.error("Compliance check failed:", err);
      await prisma.complianceCheck.update({
        where: { id: check.id },
        data: { status: "FAILED" },
      });
    }
  );

  return NextResponse.json({ ok: true, checkId: check.id });
}

async function runCheck(
  checkId: string,
  accessToken: string,
  user: { id: string; subscriptionTier: string },
  pr: { number: number; html_url: string; title: string; body: string; head: { sha: string } },
  repo: { owner: { login: string }; name: string },
  ticketTitle: string,
  ticketBody: string,
  ticketUrl?: string
) {
  const octokit = getOctokit(accessToken);
  const owner = repo.owner.login;
  const repoName = repo.name;

  // Post "pending" status
  await createCommitStatus(octokit, owner, repoName, pr.head.sha, "pending", "Spec.cop is analyzing your PR...");

  // Get the diff
  const diff = await getPullRequestDiff(octokit, owner, repoName, pr.number);

  // Generate AI report
  const report = await generateComplianceReport({
    ticketTitle,
    ticketBody,
    prTitle: pr.title,
    prBody: pr.body ?? "",
    prDiff: diff,
  });

  // Format and post as PR comment
  const markdown = formatReportAsMarkdown(report, ticketUrl, pr.html_url);
  const commentId = await postPRComment(octokit, owner, repoName, pr.number, markdown);

  // Determine merge blocking (Team plan only)
  const threshold = 80; // Default threshold
  let statusState: "success" | "failure" = "success";
  let statusDescription = `Scope creep score: ${report.scopeCreepScore}/100 — Looking good!`;

  if (user.subscriptionTier === "TEAM" && report.scopeCreepScore > threshold) {
    statusState = "failure";
    statusDescription = `Scope creep score: ${report.scopeCreepScore}/100 — Above threshold (${threshold}). Merge blocked.`;
  } else if (report.scopeCreepScore > 60) {
    statusDescription = `Scope creep score: ${report.scopeCreepScore}/100 — You strayed. A lot.`;
  }

  await createCommitStatus(octokit, owner, repoName, pr.head.sha, statusState, statusDescription);

  // Update the check record
  await prisma.complianceCheck.update({
    where: { id: checkId },
    data: {
      status: "COMPLETED",
      report: report as object,
      scopeCreepScore: report.scopeCreepScore,
      prDiff: diff.slice(0, 50000),
      githubCommentId: String(commentId),
    },
  });

  // Increment usage counter
  await prisma.user.update({
    where: { id: user.id },
    data: { checksThisMonth: { increment: 1 } },
  });
}
