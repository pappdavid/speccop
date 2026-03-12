import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getOctokit, getPullRequest, getPullRequestDiff, postPRComment, createCommitStatus } from "@/lib/github";
import { generateComplianceReport, formatReportAsMarkdown } from "@/lib/ai";
import { getLinearIssue } from "@/lib/linear";
import { getJiraIssue, getJiraCloudId } from "@/lib/jira";

interface CheckRequestBody {
  ticketId: string;
  ticketSource: "linear" | "jira" | "manual";
  ticketTitle?: string;
  ticketBody?: string;
  prNumber: number;
  repoOwner: string;
  repoName: string;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const body: CheckRequestBody = await req.json();

  const { ticketId, ticketSource, prNumber, repoOwner, repoName } = body;

  if (!ticketId || !prNumber || !repoOwner || !repoName) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Check usage limits for free tier
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { integrations: true, accounts: { where: { provider: "github" } } },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (user.subscriptionTier === "FREE" && user.checksThisMonth >= 10) {
    return NextResponse.json(
      { error: "Monthly check limit reached. Upgrade to Pro for unlimited checks." },
      { status: 429 }
    );
  }

  const githubAccount = user.accounts[0];
  if (!githubAccount?.access_token) {
    return NextResponse.json({ error: "GitHub account not connected" }, { status: 400 });
  }

  // Fetch ticket details
  let ticketTitle = body.ticketTitle ?? "Unknown Ticket";
  let ticketBody = body.ticketBody ?? "";
  let ticketUrl: string | undefined;

  try {
    if (ticketSource === "linear") {
      const linearIntegration = user.integrations.find((i) => i.type === "LINEAR");
      if (!linearIntegration) {
        return NextResponse.json({ error: "Linear not connected" }, { status: 400 });
      }
      const issue = await getLinearIssue(linearIntegration.accessToken, ticketId);
      ticketTitle = issue.title;
      ticketBody = issue.description;
      ticketUrl = issue.url;
    } else if (ticketSource === "jira") {
      const jiraIntegration = user.integrations.find((i) => i.type === "JIRA");
      if (!jiraIntegration) {
        return NextResponse.json({ error: "Jira not connected" }, { status: 400 });
      }
      const cloudId = jiraIntegration.workspaceId ?? (await getJiraCloudId(jiraIntegration.accessToken));
      const issue = await getJiraIssue(jiraIntegration.accessToken, cloudId, ticketId);
      ticketTitle = issue.title;
      ticketBody = issue.description;
      ticketUrl = issue.url;
    }
  } catch (e) {
    return NextResponse.json({ error: `Failed to fetch ticket: ${(e as Error).message}` }, { status: 500 });
  }

  // Fetch PR details
  const octokit = getOctokit(githubAccount.access_token);
  let prData, diff;

  try {
    prData = await getPullRequest(octokit, repoOwner, repoName, prNumber);
    diff = await getPullRequestDiff(octokit, repoOwner, repoName, prNumber);
  } catch (e) {
    return NextResponse.json({ error: `Failed to fetch PR: ${(e as Error).message}` }, { status: 500 });
  }

  // Create check record
  const check = await prisma.complianceCheck.create({
    data: {
      userId,
      ticketId,
      ticketUrl,
      ticketTitle,
      ticketBody,
      prNumber,
      prUrl: prData.html_url,
      prTitle: prData.title,
      prBody: prData.body ?? "",
      repoOwner,
      repoName,
      status: "RUNNING",
    },
  });

  // Run check
  try {
    await createCommitStatus(
      octokit, repoOwner, repoName,
      prData.head.sha, "pending",
      "Spec.cop is analyzing your PR..."
    );

    const report = await generateComplianceReport({
      ticketTitle,
      ticketBody,
      prTitle: prData.title,
      prBody: prData.body ?? "",
      prDiff: diff,
    });

    const markdown = formatReportAsMarkdown(report, ticketUrl, prData.html_url);
    const commentId = await postPRComment(octokit, repoOwner, repoName, prNumber, markdown);

    const statusState = report.scopeCreepScore > 80 && user.subscriptionTier === "TEAM"
      ? "failure" as const
      : "success" as const;

    await createCommitStatus(
      octokit, repoOwner, repoName,
      prData.head.sha, statusState,
      `Spec.cop: ${report.scopeCreepScore}/100 scope creep`
    );

    await prisma.complianceCheck.update({
      where: { id: check.id },
      data: {
        status: "COMPLETED",
        report: report as object,
        scopeCreepScore: report.scopeCreepScore,
        prDiff: diff.slice(0, 50000),
        githubCommentId: String(commentId),
      },
    });

    await prisma.user.update({
      where: { id: userId },
      data: { checksThisMonth: { increment: 1 } },
    });

    return NextResponse.json({ checkId: check.id, report });
  } catch (e) {
    await prisma.complianceCheck.update({
      where: { id: check.id },
      data: { status: "FAILED" },
    });
    return NextResponse.json({ error: `Check failed: ${(e as Error).message}` }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (id) {
    const check = await prisma.complianceCheck.findFirst({ where: { id, userId } });
    if (!check) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(check);
  }

  const checks = await prisma.complianceCheck.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  return NextResponse.json(checks);
}
