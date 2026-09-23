import type { DataAdapter } from "obsidian";
import { shortDeviceId } from "./security";
import {
  sha256Canonical,
  signCanonicalValue,
  verifyCanonicalValue,
  verifyEnrollmentChain,
  type DeviceEnrollment,
  type LocalDeviceSigningRecord,
} from "./config-signing";

export const METRICS_DIRECTORY = ".tephramesh/metrics";
export const METRICS_MAX_BYTES = 256 * 1024;
export const METRICS_MIN_INTERVAL_MS = 60_000;

export interface MetricsPoint {
  measurement: "tephramesh_api" | "tephramesh_peer";
  tags: Record<string, string>;
  fields: Record<string, number>;
  timestamp: number;
}

export interface MetricsSummary {
  files: number;
  points: number;
  latestTimestamp?: number;
  apiAvailable: number;
  apiTotal: number;
  peersConnected: number;
  peersTotal: number;
  apiSeriesByInstance: Record<string, MetricsSeriesPoint[]>;
}

export interface MetricsSeriesPoint {
  timestamp: number;
  value: number;
}

export interface MetricsCrypto {
  encrypt(content: ArrayBuffer): Promise<ArrayBuffer>;
  decrypt(content: ArrayBuffer): Promise<ArrayBuffer>;
  signer?: LocalDeviceSigningRecord;
  rootKeyId?: string;
  enrollments?: DeviceEnrollment[];
  revokedEnrollmentKeyIds?: string[];
}

interface MetricsSignature {
  format: "tephramesh-metrics-signature-v1";
  path: string;
  contentHash: string;
  rootKeyId: string;
  signerKeyId: string;
  signedAt: string;
  signature: string;
}

export function formatMetricsPoint(point: MetricsPoint): string {
  const tags = Object.entries(point.tags)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${escapeToken(key)}=${escapeToken(value)}`)
    .join(",");
  const fields = Object.entries(point.fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${escapeToken(key)}=${Number.isInteger(value) ? `${value}i` : value}`)
    .join(",");
  return `${escapeToken(point.measurement)}${tags ? `,${tags}` : ""} ${fields} ${Math.floor(point.timestamp * 1_000_000)}\n`;
}

export class MetricsStore {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly adapter: DataAdapter) {}

  async append(deviceId: string, points: MetricsPoint[], crypto: MetricsCrypto): Promise<void> {
    const signer = crypto.signer;
    const rootKeyId = crypto.rootKeyId;
    if (!signer || !rootKeyId || signer.rootKeyId !== rootKeyId) return;
    this.crypto = crypto;
    if (points.length === 0) return;
    const path = normalizePath(`${METRICS_DIRECTORY}/${shortDeviceId(deviceId)}.age`);
    const signaturePath = `${path}.sig`;
    const previous = this.queues.get(path) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        if (!(await this.adapter.exists(METRICS_DIRECTORY))) {
          if (!(await this.adapter.exists(".tephramesh"))) await this.adapter.mkdir(".tephramesh");
          await this.adapter.mkdir(METRICS_DIRECTORY);
        }
        const existing = await this.adapter.exists(path)
          ? await this.adapter.readBinary(path)
          : new ArrayBuffer(0);
        const prior = existing.byteLength > 0
          ? new TextDecoder().decode(await crypto.decrypt(existing))
          : "";
        const content = `${prior}${points.map(formatMetricsPoint).join("")}`;
        const plainBytes = new TextEncoder().encode(content);
        const bytes = plainBytes;
        const retained = bytes.length <= METRICS_MAX_BYTES
          ? bytes
          : bytes.slice(bytes.length - METRICS_MAX_BYTES);
        const ciphertext = await crypto.encrypt(retained.buffer as ArrayBuffer);
        const signaturePayload = {
          format: "tephramesh-metrics-signature-v1" as const,
          path,
          contentHash: await sha256Canonical(Array.from(new Uint8Array(ciphertext))),
          rootKeyId,
          signerKeyId: signer.keyId,
          signedAt: new Date().toISOString(),
        };
        const signature: MetricsSignature = {
          ...signaturePayload,
          signature: await signCanonicalValue(signaturePayload, signer),
        };
        await this.adapter.writeBinary(path, ciphertext);
        await this.adapter.write(signaturePath, JSON.stringify(signature));
      } catch {
        // Metrics are best-effort and must never affect status polling.
      }
    });
    this.queues.set(path, next);
    await next;
    if (this.queues.get(path) === next) this.queues.delete(path);
  }

  async readSummary(deviceId?: string): Promise<MetricsSummary> {
    const summary: MetricsSummary = {
      files: 0,
      points: 0,
      apiAvailable: 0,
      apiTotal: 0,
      peersConnected: 0,
      peersTotal: 0,
      apiSeriesByInstance: {},
    };
    try {
      const listing = await this.adapter.list(METRICS_DIRECTORY);
      const files = listing.files
        .filter((path) => path.endsWith(".age") && (!deviceId || path.endsWith(`${shortDeviceId(deviceId)}.age`)));
      summary.files = files.length;
      for (const path of files) {
        const signaturePath = `${path}.sig`;
        if (!await this.adapter.exists(signaturePath)) continue;
        const signature = JSON.parse(await this.adapter.read(signaturePath)) as Partial<MetricsSignature>;
        const ciphertext = await this.adapter.readBinary(path);
        if (!await cryptoForSummaryIsValid(signature, path, ciphertext, this.crypto)) continue;
        const content = new TextDecoder().decode(await this.crypto!.decrypt(ciphertext));
        for (const line of content.split("\n")) {
          const point = parseMetricsPoint(line);
          if (!point) continue;
          summary.points += 1;
          summary.latestTimestamp = Math.max(summary.latestTimestamp ?? 0, point.timestamp);
          if (point.measurement === "tephramesh_api") {
            summary.apiTotal += 1;
            summary.apiAvailable += point.fields.available ?? 0;
            const instanceId = point.tags.instance;
            if (instanceId) {
              (summary.apiSeriesByInstance[instanceId] ??= []).push({
                timestamp: point.timestamp,
                value: point.fields.available ?? 0,
              });
            }
          } else {
            summary.peersTotal += 1;
            summary.peersConnected += point.fields.connected ?? 0;
          }
        }
      }
    } catch {
      // A missing or unavailable metrics directory is an empty history.
    }
    for (const series of Object.values(summary.apiSeriesByInstance)) {
      series.sort((left, right) => left.timestamp - right.timestamp);
    }
    return summary;
  }

  private crypto?: MetricsCrypto;

  setCrypto(crypto: MetricsCrypto): void {
    this.crypto = crypto;
  }
}

function escapeToken(value: string): string {
  return value.replace(/[ ,=]/g, (character) => `\\${character}`);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function parseMetricsPoint(line: string): MetricsPoint | undefined {
  const match = /^([^ ]+) ([^ ]+) ([0-9]+)$/.exec(line.trim());
  if (!match) return undefined;
  const measurementAndTags = match[1] ?? "";
  const fields = match[2] ?? "";
  const timestamp = match[3] ?? "";
  const [measurement, ...tagParts] = measurementAndTags.split(",");
  if (measurement !== "tephramesh_api" && measurement !== "tephramesh_peer") return undefined;
  const tags = Object.fromEntries(tagParts.map((part) => {
    const separator = part.indexOf("=");
    return [part.slice(0, separator), part.slice(separator + 1)];
  }));
  const parsedFields = Object.fromEntries(fields.split(",").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return [];
    const value = Number.parseFloat(part.slice(separator + 1).replace(/i$/, ""));
    return Number.isFinite(value) ? [[part.slice(0, separator), value]] : [];
  }));
  return {
    measurement,
    tags,
    fields: parsedFields,
    timestamp: Number(timestamp) / 1_000_000,
  };
}

async function cryptoForSummaryIsValid(
  signature: Partial<MetricsSignature>,
  path: string,
  ciphertext: ArrayBuffer,
  crypto: MetricsCrypto | undefined,
): Promise<boolean> {
  if (!crypto?.rootKeyId || !crypto.enrollments ||
      signature.format !== "tephramesh-metrics-signature-v1" ||
      signature.path !== path || signature.rootKeyId !== crypto.rootKeyId ||
      typeof signature.contentHash !== "string" ||
      typeof signature.signerKeyId !== "string" ||
      typeof signature.signedAt !== "string" ||
      typeof signature.signature !== "string") return false;
  const signer = crypto.enrollments.find((entry) => entry.keyId === signature.signerKeyId);
  if (!signer || crypto.revokedEnrollmentKeyIds?.includes(signer.keyId) ||
      signature.contentHash !== await sha256Canonical(Array.from(new Uint8Array(ciphertext)))) return false;
  try {
    await verifyEnrollmentChain(crypto.enrollments, crypto.rootKeyId);
    return await verifyCanonicalValue(
      {
        format: signature.format,
        path: signature.path,
        contentHash: signature.contentHash,
        rootKeyId: signature.rootKeyId,
        signerKeyId: signature.signerKeyId,
        signedAt: signature.signedAt,
      },
      signature.signature,
      signer.publicKey,
    );
  } catch {
    return false;
  }
}
