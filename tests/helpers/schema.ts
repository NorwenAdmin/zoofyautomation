import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

// OpenAPI 3.1 schemas are (almost) JSON Schema, but FastAPI emits "anyOf" nullable unions
// (e.g. {"anyOf": [{"type": "string"}, {"type": "null"}]}) instead of "nullable: true" — AJV in
// strict mode chokes on a few OpenAPI-only keywords (like "example"), so strict is off here.
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

let compiledForDoc: unknown;

export function validatorFor(openapiDoc: any, schemaName: string): ValidateFunction {
  const schemaId = "https://zoofyautomation/openapi-components";
  if (compiledForDoc !== openapiDoc) {
    if (ajv.getSchema(schemaId)) {
      ajv.removeSchema(schemaId);
    }
    ajv.addSchema({ $id: schemaId, ...openapiDoc.components }, schemaId);
    compiledForDoc = openapiDoc;
  }
  const validate = ajv.getSchema(`${schemaId}#/schemas/${schemaName}`);
  if (!validate) {
    throw new Error(`No schema named "${schemaName}" found in components.schemas`);
  }
  return validate;
}

export function assertMatchesSchema(openapiDoc: any, schemaName: string, data: unknown): void {
  const validate = validatorFor(openapiDoc, schemaName);
  const valid = validate(data);
  if (!valid) {
    throw new Error(
      `Response body does not match schema "${schemaName}":\n${JSON.stringify(validate.errors, null, 2)}\n\nReceived:\n${JSON.stringify(data, null, 2)}`
    );
  }
}
