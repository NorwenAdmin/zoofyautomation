// US-1: the contract tests derive their scenarios from the SERVICE'S OWN live /openapi.json,
// not from a hand-maintained list — this fetches it once per test run and caches it.
let cached: { baseUrl: string; doc: any } | null = null;

export async function loadContract(baseUrl: string): Promise<any> {
  if (cached && cached.baseUrl === baseUrl) return cached.doc;
  const res = await fetch(`${baseUrl}/openapi.json`);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${baseUrl}/openapi.json: HTTP ${res.status}`);
  }
  const doc = await res.json();
  cached = { baseUrl, doc };
  return doc;
}

export function operationsForPrefix(doc: any, pathPrefix: string): Array<{ path: string; method: string; operation: any }> {
  const operations: Array<{ path: string; method: string; operation: any }> = [];
  for (const [path, pathItem] of Object.entries<any>(doc.paths ?? {})) {
    if (!path.startsWith(pathPrefix)) continue;
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      if (pathItem[method]) {
        operations.push({ path, method, operation: pathItem[method] });
      }
    }
  }
  return operations;
}

export function responseSchemaName(operation: any, statusCode = "200" as string): string | null {
  const content = operation.responses?.[statusCode]?.content?.["application/json"];
  const ref = content?.schema?.$ref ?? content?.schema?.items?.$ref;
  if (!ref) return null;
  return ref.split("/").pop() ?? null;
}
