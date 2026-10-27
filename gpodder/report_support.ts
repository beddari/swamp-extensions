/**
 * What the two library reports share: the slice of swamp's method report
 * context they read, and reading back the record a method just wrote.
 *
 * @module
 */

/** A data handle as a report sees it. */
export interface ReportHandle {
  name: string;
  specName?: string;
  version?: number;
}

/** The subset of swamp's method-scope report context the reports use. */
export interface MethodReportContext {
  modelType: string;
  modelId: string;
  methodName: string;
  executionStatus: "succeeded" | "failed";
  errorMessage?: string;
  dataHandles: ReportHandle[];
  dataRepository: {
    getContent(
      type: string,
      modelId: string,
      name: string,
      version?: number,
    ): Promise<Uint8Array | null>;
  };
}

/** What a report returns. */
export interface ReportResult {
  markdown: string;
  json: Record<string, unknown>;
}

/** The record of `spec` this execution wrote, parsed, or null. */
export async function written(
  context: MethodReportContext,
  spec: string,
): Promise<Record<string, unknown> | null> {
  const handle = context.dataHandles.find((h) => h.specName === spec);
  if (!handle) return null;
  const raw = await context.dataRepository.getContent(
    context.modelType,
    context.modelId,
    handle.name,
    handle.version,
  );
  return raw ? JSON.parse(new TextDecoder().decode(raw)) : null;
}

/** The answer for a method the report is not about. */
export function notMine(method: string, about: string): ReportResult {
  return {
    markdown: `_${method} is not ${about}; nothing to report._\n`,
    json: { skipped: true, method },
  };
}
