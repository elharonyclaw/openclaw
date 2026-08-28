// Fail-closed content scanning for the plugin paths that bypass the registry
// install gates: standalone plugin-file installs (scanFileInstallSourceRuntime)
// and config-declared plugins.load.paths entries auto-discovered at boot.
// Same rule engine and block semantics as the skill/install content scans:
// critical finding -> security_scan_blocked, scan error -> security_scan_failed,
// scannable-file cap -> security_scan_blocked (incomplete). The
// prompt-injection-system rule is demoted to avoid its known false-positive
// class. node_modules subtrees and per-file oversize files are skipped, matching
// the directory scanner facade defaults.
import fs from "node:fs";
import path from "node:path";
import { hasErrnoCode } from "../infra/errors.js";
import { isScannable, scanSource, type SkillScanFinding } from "../skills/security/scanner.js";
import type { InstallSecurityScanResult } from "./install-security-scan.js";

const PLUGIN_CONTENT_SCAN_MAX_FILE_BYTES = 5 * 1024 * 1024;
const PLUGIN_CONTENT_SCAN_MAX_FILES = 500;
const DEMOTED_RULE_IDS = new Set(["prompt-injection-system"]);

function blocked(reason: string, code: "security_scan_blocked" | "security_scan_failed") {
  return { blocked: { code, reason } };
}

function criticalFindings(findings: SkillScanFinding[]): SkillScanFinding[] {
  return findings.filter(
    (finding) => finding.severity === "critical" && !DEMOTED_RULE_IDS.has(finding.ruleId),
  );
}

function blockedByCriticalFinding(params: {
  label: string;
  findings: SkillScanFinding[];
  logger?: { warn?: (message: string) => void };
}): InstallSecurityScanResult {
  for (const finding of params.findings) {
    params.logger?.warn?.(`Plugin scanner: ${finding.message} (${finding.file}:${finding.line})`);
  }
  const first = params.findings[0];
  const firstMessage = first
    ? `${first.message} (${first.file}:${first.line})`
    : "critical finding";
  return blocked(
    `Plugin ${params.label} blocked: ${firstMessage}. ${params.findings.length} critical finding(s); run "openclaw security audit --deep" for the full report.`,
    "security_scan_blocked",
  );
}

/**
 * Content-scans one standalone plugin file before install (plugin-file gate).
 * Mirrors the directory gates: critical finding, oversize file, or read/scan
 * error all block; a clean file returns undefined so policy checks proceed.
 */
export async function scanPluginFileContent(params: {
  filePath: string;
  label: string;
  logger?: { warn?: (message: string) => void };
}): Promise<InstallSecurityScanResult | undefined> {
  let stat: Awaited<ReturnType<typeof fs.promises.stat>>;
  try {
    stat = await fs.promises.stat(params.filePath);
  } catch (error) {
    // A not-yet-materialized source mirrors the directory gates' missing-dir
    // case: skip the content scan and let install policy own existence.
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    return blocked(
      `Plugin ${params.label} blocked: content scan failed (${String(error)}).`,
      "security_scan_failed",
    );
  }
  try {
    if (stat.size > PLUGIN_CONTENT_SCAN_MAX_FILE_BYTES) {
      return blocked(
        `Plugin ${params.label} blocked: content scan incomplete (${params.filePath} exceeds the per-file scan cap). Run "openclaw security audit --deep".`,
        "security_scan_blocked",
      );
    }
    const source = await fs.promises.readFile(params.filePath, "utf8");
    const critical = criticalFindings(scanSource(source, params.filePath));
    if (critical.length > 0) {
      return blockedByCriticalFinding({
        label: params.label,
        findings: critical,
        logger: params.logger,
      });
    }
    return undefined;
  } catch (error) {
    return blocked(
      `Plugin ${params.label} blocked: content scan failed (${String(error)}).`,
      "security_scan_failed",
    );
  }
}

function collectScannableFilesSync(
  rootDir: string,
  maxFiles: number,
): {
  files: string[];
  truncated: boolean;
} {
  const files: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      break;
    }
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (entry.name === "node_modules") {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && isScannable(entry.name)) {
        files.push(fullPath);
        if (files.length >= maxFiles) {
          return { files, truncated: true };
        }
      }
    }
  }
  return { files, truncated: false };
}

/**
 * Content-scans one resolved plugins.load.paths entry (file or directory),
 * synchronously — the discovery scanner that consumes config load paths runs
 * on the synchronous loader path. Blocks with the same semantics as the
 * install gates; a missing path returns undefined so discovery emits its own
 * not-found diagnostic instead of masking it as a security failure.
 */
export function scanPluginLoadPathContentSync(params: {
  resolvedPath: string;
  label: string;
  logger?: { warn?: (message: string) => void };
}): InstallSecurityScanResult | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(params.resolvedPath);
  } catch {
    return undefined;
  }
  try {
    let files: string[];
    if (stat.isFile()) {
      files = isScannable(params.resolvedPath) ? [params.resolvedPath] : [];
    } else if (stat.isDirectory()) {
      const collected = collectScannableFilesSync(
        params.resolvedPath,
        PLUGIN_CONTENT_SCAN_MAX_FILES,
      );
      if (collected.truncated) {
        return blocked(
          `Plugin ${params.label} blocked: content scan incomplete (${params.resolvedPath} reached the scannable-file cap). Run "openclaw security audit --deep".`,
          "security_scan_blocked",
        );
      }
      files = collected.files;
    } else {
      return undefined;
    }
    for (const filePath of files) {
      const statFile = fs.statSync(filePath);
      if (statFile.size > PLUGIN_CONTENT_SCAN_MAX_FILE_BYTES) {
        continue;
      }
      const critical = criticalFindings(scanSource(fs.readFileSync(filePath, "utf8"), filePath));
      if (critical.length > 0) {
        return blockedByCriticalFinding({
          label: params.label,
          findings: critical,
          logger: params.logger,
        });
      }
    }
    return undefined;
  } catch (error) {
    return blocked(
      `Plugin ${params.label} blocked: content scan failed (${String(error)}).`,
      "security_scan_failed",
    );
  }
}
