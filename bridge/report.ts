/**
 * Feature-request / bug-report forwarding. The eve agent's
 * `report-feature-request` tool POSTs here via the bridge's `/report` route;
 * the bridge DMs the configured maintainer. These pure helpers (dedup key,
 * message text) are split out so they're unit-testable without the socket.
 */

export interface FeatureReport {
  kind: "feature" | "bug";
  summary: string;
  details?: string;
  requestedBy?: string;
}

/**
 * Stable dedup key for a report: kind plus the whitespace-normalised, lowercased
 * summary. Lets the bridge drop a repeat of the same request without re-DMing.
 */
export const reportDedupKey = (report: FeatureReport): string =>
  `${report.kind}:${report.summary.toLowerCase().replaceAll(/\s+/gu, " ").trim()}`;

/** Render a report as the plain-text WhatsApp DM the maintainer receives. */
export const buildReportMessage = (
  report: FeatureReport,
  botName: string
): string => {
  const label = report.kind === "bug" ? "Bug report" : "Feature request";
  const from = report.requestedBy?.trim() || "someone";
  const lines = [
    `${label} via @${botName}`,
    `From: ${from}`,
    "",
    report.summary.trim(),
  ];
  const details = report.details?.trim();
  if (details) {
    lines.push("", details);
  }
  return lines.join("\n");
};
