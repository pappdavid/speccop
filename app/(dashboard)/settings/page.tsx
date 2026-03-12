import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Shield, ArrowLeft, Check, Github, Zap, AlertCircle } from "lucide-react";
import { randomUUID } from "crypto";

async function connectLinear(_formData: FormData) {
  "use server";
  // Redirect to Linear OAuth
  const state = randomUUID();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.LINEAR_CLIENT_ID ?? "",
    redirect_uri: `${process.env.NEXTAUTH_URL}/api/auth/linear/callback`,
    scope: "read",
    state,
  });
  redirect(`https://linear.app/oauth/authorize?${params}`);
}

export default async function SettingsPage() {
  const session = await auth();
  const userId = session!.user!.id;

  const [user, integrations] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true, image: true, subscriptionTier: true },
    }),
    prisma.integration.findMany({ where: { userId } }),
  ]);

  const linearIntegration = integrations.find((i) => i.type === "LINEAR");
  const jiraIntegration = integrations.find((i) => i.type === "JIRA");

  return (
    <div className="min-h-screen bg-black text-white">
      <nav className="border-b border-zinc-800 px-6 py-4 flex items-center gap-4">
        <Link href="/dashboard" className="text-zinc-400 hover:text-white transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <Link href="/" className="flex items-center gap-2 font-bold">
          <Shield className="w-5 h-5 text-red-400" />
          Spec.cop
        </Link>
      </nav>

      <div className="max-w-2xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-8">Settings</h1>

        {/* Profile */}
        <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4">Profile</h2>
          <div className="flex items-center gap-4">
            {user?.image && (
              <img src={user.image} alt={user.name ?? ""} className="w-12 h-12 rounded-full" />
            )}
            <div>
              <p className="font-medium">{user?.name}</p>
              <p className="text-zinc-400 text-sm">{user?.email}</p>
            </div>
          </div>
        </section>

        {/* Integrations */}
        <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-6">
          <h2 className="text-lg font-semibold mb-1">Integrations</h2>
          <p className="text-zinc-400 text-sm mb-6">
            Connect your project management tools to enable compliance checks.
          </p>

          <div className="space-y-4">
            {/* GitHub */}
            <div className="flex items-center justify-between p-4 bg-zinc-800 rounded-lg">
              <div className="flex items-center gap-3">
                <Github className="w-5 h-5" />
                <div>
                  <p className="font-medium">GitHub</p>
                  <p className="text-zinc-400 text-xs">Connected via OAuth</p>
                </div>
              </div>
              <span className="flex items-center gap-1 text-green-400 text-sm">
                <Check className="w-4 h-4" /> Connected
              </span>
            </div>

            {/* Linear */}
            <div className="flex items-center justify-between p-4 bg-zinc-800 rounded-lg">
              <div className="flex items-center gap-3">
                <Zap className="w-5 h-5 text-purple-400" />
                <div>
                  <p className="font-medium">Linear</p>
                  <p className="text-zinc-400 text-xs">
                    {linearIntegration
                      ? `Connected: ${linearIntegration.workspaceName ?? "Workspace"}`
                      : "Pull ticket details from Linear"}
                  </p>
                </div>
              </div>
              {linearIntegration ? (
                <span className="flex items-center gap-1 text-green-400 text-sm">
                  <Check className="w-4 h-4" /> Connected
                </span>
              ) : (
                <form action={connectLinear}>
                  <button
                    type="submit"
                    className="text-sm bg-purple-600 hover:bg-purple-700 text-white px-3 py-1.5 rounded-lg transition-colors"
                  >
                    Connect
                  </button>
                </form>
              )}
            </div>

            {/* Jira */}
            <div className="flex items-center justify-between p-4 bg-zinc-800 rounded-lg">
              <div className="flex items-center gap-3">
                <AlertCircle className="w-5 h-5 text-blue-400" />
                <div>
                  <p className="font-medium">Jira</p>
                  <p className="text-zinc-400 text-xs">
                    {jiraIntegration
                      ? `Connected: ${jiraIntegration.workspaceName ?? "Workspace"}`
                      : user?.subscriptionTier === "FREE"
                        ? "Pro plan required"
                        : "Pull ticket details from Jira"}
                  </p>
                </div>
              </div>
              {jiraIntegration ? (
                <span className="flex items-center gap-1 text-green-400 text-sm">
                  <Check className="w-4 h-4" /> Connected
                </span>
              ) : user?.subscriptionTier === "FREE" ? (
                <Link
                  href="/pricing"
                  className="text-sm bg-zinc-700 hover:bg-zinc-600 text-zinc-300 px-3 py-1.5 rounded-lg transition-colors"
                >
                  Upgrade
                </Link>
              ) : (
                <a
                  href={`https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id=${process.env.JIRA_CLIENT_ID}&scope=read%3Ajira-work&redirect_uri=${process.env.NEXTAUTH_URL}/api/auth/jira/callback&response_type=code&prompt=consent`}
                  className="text-sm bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg transition-colors"
                >
                  Connect
                </a>
              )}
            </div>
          </div>
        </section>

        {/* Webhook */}
        <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-6">
          <h2 className="text-lg font-semibold mb-1">GitHub Webhook</h2>
          <p className="text-zinc-400 text-sm mb-4">
            Add this webhook to your GitHub repository to automatically run compliance checks when PRs are opened.
          </p>
          <div className="bg-zinc-800 rounded-lg p-3 font-mono text-sm text-zinc-300 break-all">
            {process.env.NEXTAUTH_URL ?? "https://your-domain.com"}/api/webhook/github
          </div>
          <p className="text-zinc-500 text-xs mt-2">
            Set the content type to <code className="text-zinc-300">application/json</code> and select
            the <code className="text-zinc-300">Pull requests</code> event.
          </p>
        </section>

        {/* Subscription */}
        <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-1">Subscription</h2>
          <p className="text-zinc-400 text-sm mb-4">
            Current plan:{" "}
            <span className="text-white font-medium capitalize">
              {user?.subscriptionTier?.toLowerCase()}
            </span>
          </p>
          {user?.subscriptionTier === "FREE" && (
            <Link
              href="/pricing"
              className="inline-flex items-center gap-2 bg-red-500 hover:bg-red-600 text-white font-semibold px-4 py-2 rounded-lg transition-colors text-sm"
            >
              Upgrade Plan
            </Link>
          )}
        </section>
      </div>
    </div>
  );
}
