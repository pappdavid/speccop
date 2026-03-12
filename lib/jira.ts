interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description?: {
      type: string;
      content: Array<{
        type: string;
        content?: Array<{ type: string; text?: string }>;
      }>;
    } | string | null;
    status: { name: string };
    assignee?: { displayName: string } | null;
  };
}

function extractJiraText(description: JiraIssue["fields"]["description"]): string {
  if (!description) return "";
  if (typeof description === "string") return description;
  // Atlassian Document Format (ADF) — flatten to plain text
  const lines: string[] = [];
  for (const block of description.content ?? []) {
    for (const inline of block.content ?? []) {
      if (inline.type === "text" && inline.text) {
        lines.push(inline.text);
      }
    }
    lines.push("\n");
  }
  return lines.join("").trim();
}

export async function getJiraIssue(
  accessToken: string,
  cloudId: string,
  issueKey: string,
  cloudUrl?: string
) {
  const url = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${issueKey}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Jira API error: ${response.status} ${response.statusText}`);
  }

  const issue: JiraIssue = await response.json();
  const baseUrl = cloudUrl ?? `https://api.atlassian.com/ex/jira/${cloudId}`;
  return {
    id: issue.id,
    key: issue.key,
    title: issue.fields.summary,
    description: extractJiraText(issue.fields.description),
    url: `${baseUrl}/browse/${issue.key}`,
    status: issue.fields.status.name,
  };
}

export async function getJiraCloudInfo(
  accessToken: string
): Promise<{ id: string; name: string; url: string }> {
  const response = await fetch(
    "https://api.atlassian.com/oauth/token/accessible-resources",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Jira accessible-resources error: ${response.status}`);
  }

  const resources: Array<{ id: string; name: string; url: string }> =
    await response.json();

  if (!resources.length) {
    throw new Error("No Jira cloud instances found for this account");
  }

  return resources[0];
}

export async function getJiraCloudId(accessToken: string): Promise<string> {
  const info = await getJiraCloudInfo(accessToken);
  return info.id;
}
