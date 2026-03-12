import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Shield, ArrowLeft, ExternalLink } from "lucide-react";
import ComplianceReport from "@/components/ComplianceReport";
import ScopeCreepScore from "@/components/ScopeCreepScore";
import type { ComplianceReport as ReportType } from "@/lib/ai";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function CheckDetailPage({ params }: PageProps) {
  const { id } = await params;
  const session = await auth();
  const userId = session!.user!.id;

  const check = await prisma.complianceCheck.findFirst({
    where: { id, userId },
  });

  if (!check) notFound();

  const report = check.report as ReportType | null;

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Nav */}
      <nav className="border-b border-zinc-800 px-6 py-4 flex items-center gap-4">
        <Link href="/dashboard" className="text-zinc-400 hover:text-white transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <Link href="/" className="flex items-center gap-2 font-bold">
          <Shield className="w-5 h-5 text-red-400" />
          Spec.cop
        </Link>
      </nav>

      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-2 text-zinc-500 text-sm mb-2">
            <span>{check.repoOwner}/{check.repoName}</span>
            <span>·</span>
            <span>PR #{check.prNumber}</span>
            <span>·</span>
            <span>{new Date(check.createdAt).toLocaleDateString()}</span>
          </div>
          <h1 className="text-2xl font-bold mb-4">{check.prTitle}</h1>

          <div className="flex flex-wrap gap-3">
            <a
              href={check.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300 transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              View PR
            </a>
            {check.ticketUrl && (
              <a
                href={check.ticketUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-purple-400 hover:text-purple-300 transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                View Ticket
              </a>
            )}
          </div>
        </div>

        {/* Status: pending / running */}
        {(check.status === "PENDING" || check.status === "RUNNING") && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 text-center">
            <div className="w-12 h-12 border-2 border-red-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-zinc-300 font-medium">Spec.cop is analyzing your PR...</p>
            <p className="text-zinc-500 text-sm mt-2">This usually takes 15–30 seconds. Brace yourself.</p>
          </div>
        )}

        {/* Status: failed */}
        {check.status === "FAILED" && (
          <div className="bg-red-950/30 border border-red-800/50 rounded-xl p-8 text-center">
            <p className="text-red-400 font-medium">Compliance check failed</p>
            <p className="text-zinc-400 text-sm mt-2">
              Something went wrong during analysis. Check your integrations in Settings.
            </p>
          </div>
        )}

        {/* Status: completed */}
        {check.status === "COMPLETED" && report && (
          <div className="space-y-6">
            {/* Score */}
            <ScopeCreepScore score={report.scopeCreepScore} />

            {/* Snark */}
            <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6">
              <p className="text-zinc-300 italic text-lg leading-relaxed">
                &ldquo;{report.snarkComment}&rdquo;
              </p>
            </div>

            {/* Full Report */}
            <ComplianceReport report={report} />
          </div>
        )}
      </div>
    </div>
  );
}
